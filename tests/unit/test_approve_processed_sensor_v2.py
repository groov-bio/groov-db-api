import json
import os
import sys
import unittest
from decimal import Decimal
from unittest import mock

import botocore.exceptions

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(THIS_DIR, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "functions", "approveProcessedSensorV2"))

import approveProcessedSensor as h  # noqa: E402
import lambda_invoker  # noqa: E402
import s3_updater_v2  # noqa: E402


def sample_data(**overrides):
    data = {
        "id": None,
        "proposed_grv_id": None,
        "type": "One Component",
        "category": "TetR",
        "about": "test",
        "proteins": [
            {
                "alias": "TestProtein",
                "uniprot_id": "P00001",
                "kegg_id": None,
                "origin": [{"organism_name": "E. coli"}],
                "stimulus": [],
            }
        ],
    }
    data.update(overrides)
    return data


def base_event(**overrides):
    event = {
        "requestContext": {"http": {"method": "POST"}},
        "headers": {"origin": "https://groov.bio"},
        "body": json.dumps({"category": "TetR", "submissionUUID": "uuid-1"}),
    }
    event.update(overrides)
    return event


def client_error(code, message="error", operation="Operation"):
    return botocore.exceptions.ClientError(
        {"Error": {"Code": code, "Message": message}}, operation
    )


def conditional_check_failed():
    return client_error("ConditionalCheckFailedException", "The conditional request failed")


class ApproveProcessedSensorV2Test(unittest.TestCase):
    def setUp(self):
        os.environ["PROCESSED_TEMP_TABLE_V2_NAME"] = "test-processed-v2"
        os.environ["PROD_TABLE_V2_NAME"] = "groov_db_table_v2"
        os.environ["FINGERPRINT_LAMBDA_NAME"] = "test-fingerprint-v2"

        self.addCleanup(mock.patch.stopall)

        self.processed_table = mock.MagicMock()
        self.prod_table = mock.MagicMock()
        self.processed_table.get_item.return_value = {}
        self.processed_table.delete_item.return_value = {}
        self.prod_table.put_item.return_value = {}

        def table_side_effect(name):
            if name == os.environ["PROCESSED_TEMP_TABLE_V2_NAME"]:
                return self.processed_table
            if name == os.environ["PROD_TABLE_V2_NAME"]:
                return self.prod_table
            return mock.MagicMock()

        mock.patch.object(h, "_table", side_effect=table_side_effect).start()

        self.mock_regen = mock.patch.object(
            s3_updater_v2, "regenerate_static_json", return_value=None
        ).start()
        self.mock_mint = mock.patch.object(
            s3_updater_v2, "mint_next_grv_id", return_value="GRV-T00007"
        ).start()
        self.mock_invoke = mock.patch.object(
            lambda_invoker, "invoke_fingerprint_async", return_value=None
        ).start()

    def _prod_put_item(self):
        return self.prod_table.put_item.call_args.kwargs

    def _processed_delete_item(self):
        return self.processed_table.delete_item.call_args.kwargs

    # ── module-level constants / helpers ──────────────────────────────────

    def test_category_prefix_covers_all_v2_categories(self):
        for c in ["AraC", "GntR", "IclR", "LacI", "LuxR", "LysR", "MarR", "Other", "TetR"]:
            self.assertIsNotNone(h.CATEGORY_PREFIX.get(c))

    def test_two_component_prefix_is_d(self):
        self.assertEqual(h.TWO_COMPONENT_PREFIX, "D")

    def test_prefix_for_returns_d_for_two_component_category_prefix_otherwise(self):
        self.assertEqual(h.prefix_for("TetR", {"type": "Two Component"}), "D")
        self.assertEqual(h.prefix_for("LuxR", {"type": "Two Component"}), "D")
        self.assertEqual(h.prefix_for("TetR", {"type": "One Component"}), "T")
        self.assertEqual(h.prefix_for("LuxR", {"type": "One Component"}), "X")
        self.assertEqual(h.prefix_for("Other", {"type": "Riboswitch"}), "Z")

    # ── basic request handling ────────────────────────────────────────────

    def test_options_preflight_returns_200_with_v2_cors(self):
        res = h.lambda_handler(
            base_event(requestContext={"http": {"method": "OPTIONS"}})
        )
        self.assertEqual(res["statusCode"], 200)
        self.assertEqual(res["headers"]["Access-Control-Allow-Methods"], "POST,OPTIONS")

    def test_400_on_invalid_json(self):
        res = h.lambda_handler(base_event(body="{not json"))
        self.assertEqual(res["statusCode"], 400)

    def test_400_when_submission_uuid_missing(self):
        res = h.lambda_handler(base_event(body=json.dumps({})))
        self.assertEqual(res["statusCode"], 400)

    def test_400_when_processed_row_has_unknown_category(self):
        self.processed_table.get_item.return_value = {
            "Item": {"PK": "PROCESSED", "SK": "uuid-1", "data": sample_data(category="Bogus")}
        }
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 400)

    def test_400_when_processed_row_is_missing_a_category(self):
        self.processed_table.get_item.return_value = {
            "Item": {"PK": "PROCESSED", "SK": "uuid-1", "data": sample_data(category=None)}
        }
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 400)

    def test_404_when_processed_temp_row_is_missing(self):
        self.processed_table.get_item.return_value = {}
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 404)

    def test_500_when_processed_row_missing_data_field(self):
        self.processed_table.get_item.return_value = {
            "Item": {"PK": "PROCESSED", "SK": "uuid-1"}
        }
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 500)

    def test_409_when_data_id_is_already_set(self):
        data = sample_data()
        data["id"] = "GRV-T00001"
        self.processed_table.get_item.return_value = {
            "Item": {"PK": "TetR", "SK": "uuid-1", "data": data}
        }
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 409)

    # ── happy path (new sensor) ────────────────────────────────────────────

    def test_happy_path_one_component(self):
        self.processed_table.get_item.return_value = {
            "Item": {"PK": "TetR", "SK": "uuid-1", "data": sample_data()}
        }

        res = h.lambda_handler(base_event())

        self.assertEqual(res["statusCode"], 200)
        body = json.loads(res["body"])
        self.assertEqual(body["grv_id"], "GRV-T00007")
        self.assertEqual(body["category"], "TetR")

        self.mock_mint.assert_called_once_with("T")

        put_kwargs = self._prod_put_item()
        self.assertEqual(put_kwargs["Item"]["category"], "TetR")
        self.assertEqual(put_kwargs["Item"]["grv_id"], "GRV-T00007")
        self.assertEqual(put_kwargs["Item"]["data"]["id"], "GRV-T00007")
        self.assertNotIn("proposed_grv_id", put_kwargs["Item"]["data"])
        self.assertEqual(put_kwargs["ConditionExpression"], "attribute_not_exists(grv_id)")

        delete_kwargs = self._processed_delete_item()
        self.assertEqual(delete_kwargs["Key"], {"PK": "PROCESSED", "SK": "uuid-1"})

        self.mock_regen.assert_called_once()
        self.mock_invoke.assert_called_once()

    def test_two_component_sensor_mints_with_prefix_d_and_writes_category_dual(self):
        self.mock_mint.return_value = "GRV-D00003"
        proteins = sample_data()["proteins"]
        data = sample_data(
            type="Two Component",
            proteins=[proteins[0], {**proteins[0], "alias": "P2"}],
        )
        self.processed_table.get_item.return_value = {
            "Item": {"PK": "TetR", "SK": "uuid-1", "data": data}
        }

        res = h.lambda_handler(base_event())

        self.assertEqual(res["statusCode"], 200)
        body = json.loads(res["body"])
        self.assertEqual(body["grv_id"], "GRV-D00003")
        self.assertEqual(body["category"], "Dual")
        self.mock_mint.assert_called_once_with("D")

        put_kwargs = self._prod_put_item()
        self.assertEqual(put_kwargs["Item"]["category"], "Dual")
        self.assertEqual(put_kwargs["Item"]["data"]["category"], "Dual")

        self.assertEqual(self.mock_regen.call_args.args[1], "Dual")
        self.assertEqual(self.mock_invoke.call_args.args[0]["category"], "Dual")

    def test_derives_category_from_proteins_family_when_top_level_category_absent(self):
        self.mock_mint.return_value = "GRV-D00004"
        data = {
            "id": None,
            "proposed_grv_id": None,
            "type": "Two Component",
            "about": "test",
            "proteins": [
                {
                    "alias": "BqsS",
                    "family": "Other",
                    "uniprot_id": "Q9I0I2",
                    "origin": [{"organism_name": "P. aeruginosa"}],
                    "stimulus": [],
                },
                {
                    "alias": "BqrR",
                    "family": "Other",
                    "uniprot_id": "Q9I0I1",
                    "origin": [{"organism_name": "P. aeruginosa"}],
                    "stimulus": [],
                },
            ],
        }
        self.processed_table.get_item.return_value = {
            "Item": {"PK": "PROCESSED", "SK": "uuid-1", "data": data}
        }

        res = h.lambda_handler(base_event())

        self.assertEqual(res["statusCode"], 200)
        body = json.loads(res["body"])
        self.assertEqual(body["grv_id"], "GRV-D00004")
        self.assertEqual(body["category"], "Dual")
        self.mock_mint.assert_called_once_with("D")
        self.assertEqual(self._prod_put_item()["Item"]["category"], "Dual")

    def test_two_component_sensor_with_ompr_hiska_families_approves_into_dual_bucket(self):
        self.mock_mint.return_value = "GRV-D00005"
        data = {
            "id": None,
            "proposed_grv_id": None,
            "type": "Two Component",
            "about": "test",
            "proteins": [
                {
                    "alias": "EnvZ",
                    "family": "HisKA",
                    "uniprot_id": "P0AEJ4",
                    "origin": [{"organism_name": "E. coli"}],
                    "stimulus": [],
                },
                {
                    "alias": "OmpR",
                    "family": "OmpR",
                    "uniprot_id": "P0AA16",
                    "origin": [{"organism_name": "E. coli"}],
                    "stimulus": [],
                },
            ],
        }
        self.processed_table.get_item.return_value = {
            "Item": {"PK": "PROCESSED", "SK": "uuid-1", "data": data}
        }

        res = h.lambda_handler(base_event())

        self.assertEqual(res["statusCode"], 200)
        body = json.loads(res["body"])
        self.assertEqual(body["grv_id"], "GRV-D00005")
        self.assertEqual(body["category"], "Dual")
        self.mock_mint.assert_called_once_with("D")
        self.assertEqual(self._prod_put_item()["Item"]["category"], "Dual")

    def test_single_component_preserves_original_category_in_prod_and_data(self):
        self.processed_table.get_item.return_value = {
            "Item": {"PK": "TetR", "SK": "uuid-1", "data": sample_data()}
        }

        res = h.lambda_handler(base_event())
        self.assertEqual(json.loads(res["body"])["category"], "TetR")
        put_kwargs = self._prod_put_item()
        self.assertEqual(put_kwargs["Item"]["category"], "TetR")
        self.assertEqual(put_kwargs["Item"]["data"]["category"], "TetR")

    def test_500_when_get_item_throws(self):
        self.processed_table.get_item.side_effect = Exception("ddb down")
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 500)

    def test_500_when_mint_next_grv_id_throws(self):
        self.processed_table.get_item.return_value = {
            "Item": {"PK": "TetR", "SK": "uuid-1", "data": sample_data()}
        }
        self.mock_mint.side_effect = Exception("r2 down")
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 500)

    def test_500_when_prod_write_fails_non_conditional(self):
        self.processed_table.get_item.return_value = {
            "Item": {"PK": "TetR", "SK": "uuid-1", "data": sample_data()}
        }
        self.prod_table.put_item.side_effect = Exception("prod boom")
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 500)

    def test_409_when_prod_conditional_check_failed(self):
        self.processed_table.get_item.return_value = {
            "Item": {"PK": "TetR", "SK": "uuid-1", "data": sample_data()}
        }
        self.prod_table.put_item.side_effect = conditional_check_failed()
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 409)

    def test_200_even_when_delete_temp_throws(self):
        self.processed_table.get_item.return_value = {
            "Item": {"PK": "TetR", "SK": "uuid-1", "data": sample_data()}
        }
        self.processed_table.delete_item.side_effect = Exception("temp delete boom")
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 200)

    def test_200_even_when_r2_regen_throws(self):
        self.processed_table.get_item.return_value = {
            "Item": {"PK": "TetR", "SK": "uuid-1", "data": sample_data()}
        }
        self.mock_regen.side_effect = Exception("r2 boom")
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 200)

    def test_200_even_when_fingerprint_invoke_fails(self):
        self.processed_table.get_item.return_value = {
            "Item": {"PK": "TetR", "SK": "uuid-1", "data": sample_data()}
        }
        self.mock_invoke.side_effect = Exception("lambda boom")
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 200)

    # ── edit branch ──────────────────────────────────────────────────────

    def test_edit_approving_edit_row_overwrites_prod_no_minting_returns_200(self):
        edit_data = {
            "id": "GRV-T00001",
            "category": "TetR",
            "type": "One Component",
            "about": "updated about",
            "proteins": [
                {
                    "alias": "UpdatedProtein",
                    "uniprot_id": "P00001",
                    "kegg_id": "some_updated_kegg",
                    "origin": [{"organism_name": "E. coli"}],
                    "stimulus": [],
                }
            ],
        }
        self.processed_table.get_item.return_value = {
            "Item": {
                "PK": "PROCESSED",
                "SK": "EDIT#GRV-T00001",
                "isEdit": True,
                "editTarget": {"category": "TetR", "grv_id": "GRV-T00001"},
                "data": edit_data,
            }
        }

        res = h.lambda_handler(
            base_event(body=json.dumps({"submissionUUID": "EDIT#GRV-T00001"}))
        )

        self.assertEqual(res["statusCode"], 200)
        body = json.loads(res["body"])
        self.assertEqual(body["message"], "Sensor edit approved")
        self.assertEqual(body["grv_id"], "GRV-T00001")
        self.assertEqual(body["category"], "TetR")

        self.mock_mint.assert_not_called()

        put_kwargs = self._prod_put_item()
        self.assertEqual(put_kwargs["Item"]["category"], "TetR")
        self.assertEqual(put_kwargs["Item"]["grv_id"], "GRV-T00001")
        self.assertEqual(put_kwargs["Item"]["data"], edit_data)
        self.assertEqual(put_kwargs["ConditionExpression"], "attribute_exists(grv_id)")

        delete_kwargs = self._processed_delete_item()
        self.assertEqual(delete_kwargs["Key"], {"PK": "PROCESSED", "SK": "EDIT#GRV-T00001"})

        self.mock_regen.assert_called_once_with(edit_data, "TetR", "GRV-T00001")
        self.mock_invoke.assert_called_once_with(
            {"grv_id": "GRV-T00001", "category": "TetR", "data": edit_data}
        )

    def test_edit_row_with_data_id_set_uses_that_id_directly(self):
        edit_data = {
            "id": "GRV-X00099",
            "category": "LuxR",
            "type": "One Component",
            "proteins": [{"uniprot_id": "P12345", "alias": "TestAlias", "family": "LuxR"}],
        }
        self.processed_table.get_item.return_value = {
            "Item": {
                "PK": "PROCESSED",
                "SK": "EDIT#GRV-X00099",
                "isEdit": True,
                "editTarget": {"category": "LuxR", "grv_id": "GRV-X00099"},
                "data": edit_data,
            }
        }

        res = h.lambda_handler(
            base_event(body=json.dumps({"submissionUUID": "EDIT#GRV-X00099"}))
        )

        self.assertEqual(res["statusCode"], 200)
        body = json.loads(res["body"])
        self.assertEqual(body["grv_id"], "GRV-X00099")
        self.assertEqual(body["category"], "LuxR")
        self.assertEqual(self._prod_put_item()["Item"]["grv_id"], "GRV-X00099")

    def test_edit_row_with_missing_grv_id_in_data_falls_back_to_edit_target(self):
        edit_data = {
            "category": "TetR",
            "type": "One Component",
            "proteins": [{"uniprot_id": "P12345", "alias": "TestAlias"}],
        }
        self.processed_table.get_item.return_value = {
            "Item": {
                "PK": "PROCESSED",
                "SK": "EDIT#GRV-FALLBACK",
                "isEdit": True,
                "editTarget": {"category": "TetR", "grv_id": "GRV-FALLBACK"},
                "data": edit_data,
            }
        }

        res = h.lambda_handler(
            base_event(body=json.dumps({"submissionUUID": "EDIT#GRV-FALLBACK"}))
        )

        self.assertEqual(res["statusCode"], 200)
        body = json.loads(res["body"])
        self.assertEqual(body["grv_id"], "GRV-FALLBACK")
        self.assertEqual(self._prod_put_item()["Item"]["grv_id"], "GRV-FALLBACK")

    def test_edit_branch_returns_404_when_prod_row_does_not_exist(self):
        self.processed_table.get_item.return_value = {
            "Item": {
                "PK": "PROCESSED",
                "SK": "EDIT#GRV-NONEXISTENT",
                "isEdit": True,
                "editTarget": {"category": "TetR", "grv_id": "GRV-NONEXISTENT"},
                "data": {
                    "id": "GRV-NONEXISTENT",
                    "category": "TetR",
                    "proteins": [{"uniprot_id": "P12345", "alias": "TestAlias"}],
                },
            }
        }
        self.prod_table.put_item.side_effect = conditional_check_failed()

        res = h.lambda_handler(
            base_event(body=json.dumps({"submissionUUID": "EDIT#GRV-NONEXISTENT"}))
        )

        self.assertEqual(res["statusCode"], 404)
        body = json.loads(res["body"])
        self.assertIn("No prod row found", body["message"])

    def test_edit_branch_returns_500_when_put_throws_non_conditional_error(self):
        self.processed_table.get_item.return_value = {
            "Item": {
                "PK": "PROCESSED",
                "SK": "EDIT#GRV-T00001",
                "isEdit": True,
                "editTarget": {"category": "TetR", "grv_id": "GRV-T00001"},
                "data": {
                    "id": "GRV-T00001",
                    "category": "TetR",
                    "proteins": [{"uniprot_id": "P12345", "alias": "TestAlias"}],
                },
            }
        }
        self.prod_table.put_item.side_effect = Exception("prod write boom")

        res = h.lambda_handler(
            base_event(body=json.dumps({"submissionUUID": "EDIT#GRV-T00001"}))
        )

        self.assertEqual(res["statusCode"], 500)
        body = json.loads(res["body"])
        self.assertIn("Error writing to prod table", body["message"])

    def test_edit_branch_returns_200_even_when_delete_temp_throws(self):
        self.processed_table.get_item.return_value = {
            "Item": {
                "PK": "PROCESSED",
                "SK": "EDIT#GRV-T00001",
                "isEdit": True,
                "editTarget": {"category": "TetR", "grv_id": "GRV-T00001"},
                "data": {
                    "id": "GRV-T00001",
                    "category": "TetR",
                    "proteins": [{"uniprot_id": "P12345", "alias": "TestAlias"}],
                },
            }
        }
        self.processed_table.delete_item.side_effect = Exception("delete boom")

        res = h.lambda_handler(
            base_event(body=json.dumps({"submissionUUID": "EDIT#GRV-T00001"}))
        )

        self.assertEqual(res["statusCode"], 200)
        self.prod_table.put_item.assert_called_once()

    def test_edit_branch_returns_200_even_when_r2_regen_throws(self):
        self.processed_table.get_item.return_value = {
            "Item": {
                "PK": "PROCESSED",
                "SK": "EDIT#GRV-T00001",
                "isEdit": True,
                "editTarget": {"category": "TetR", "grv_id": "GRV-T00001"},
                "data": {
                    "id": "GRV-T00001",
                    "category": "TetR",
                    "proteins": [{"uniprot_id": "P12345", "alias": "TestAlias"}],
                },
            }
        }
        self.mock_regen.side_effect = Exception("r2 boom")

        res = h.lambda_handler(
            base_event(body=json.dumps({"submissionUUID": "EDIT#GRV-T00001"}))
        )

        self.assertEqual(res["statusCode"], 200)
        self.prod_table.put_item.assert_called_once()

    def test_edit_branch_returns_200_even_when_fingerprint_invoke_throws(self):
        self.processed_table.get_item.return_value = {
            "Item": {
                "PK": "PROCESSED",
                "SK": "EDIT#GRV-T00001",
                "isEdit": True,
                "editTarget": {"category": "TetR", "grv_id": "GRV-T00001"},
                "data": {
                    "id": "GRV-T00001",
                    "category": "TetR",
                    "proteins": [{"uniprot_id": "P12345", "alias": "TestAlias"}],
                },
            }
        }
        self.mock_invoke.side_effect = Exception("lambda boom")

        res = h.lambda_handler(
            base_event(body=json.dumps({"submissionUUID": "EDIT#GRV-T00001"}))
        )

        self.assertEqual(res["statusCode"], 200)
        self.prod_table.put_item.assert_called_once()


class MintNextGrvIdAndRegenerateStaticJsonTest(unittest.TestCase):
    """Focused unit tests for s3_updater_v2.mint_next_grv_id / regenerate_static_json,
    driven directly against a mocked S3/R2 client (patching _s3_client)."""

    def setUp(self):
        os.environ["R2_BUCKET_NAME"] = "test-bucket"
        os.environ.pop("IS_LOCAL", None)
        self.addCleanup(mock.patch.stopall)

    def _not_found(self):
        return client_error("NoSuchKey", "not found", "GetObject")

    def _body(self, obj):
        body = mock.MagicMock()
        body.read.return_value = json.dumps(obj).encode()
        return {"Body": body}

    def test_mints_first_id_when_index_missing(self):
        client = mock.MagicMock()
        client.get_object.side_effect = self._not_found()
        mock.patch.object(s3_updater_v2, "_s3_client", return_value=client).start()

        self.assertEqual(s3_updater_v2.mint_next_grv_id("T"), "GRV-T00001")

    def test_mints_next_id_from_existing_index(self):
        client = mock.MagicMock()
        index = {
            "sensors": [
                {"id": "GRV-T00003"},
                {"id": "GRV-T00007"},
                {"id": "GRV-X00099"},
            ]
        }
        client.get_object.return_value = self._body(index)
        mock.patch.object(s3_updater_v2, "_s3_client", return_value=client).start()

        self.assertEqual(s3_updater_v2.mint_next_grv_id("T"), "GRV-T00008")

    def test_reraises_non_not_found_errors(self):
        client = mock.MagicMock()
        client.get_object.side_effect = client_error("InternalError", "boom", "GetObject")
        mock.patch.object(s3_updater_v2, "_s3_client", return_value=client).start()

        with self.assertRaises(botocore.exceptions.ClientError):
            s3_updater_v2.mint_next_grv_id("T")

    def test_regenerate_static_json_writes_all_four_files_with_v2_prefix(self):
        client = mock.MagicMock()
        client.get_object.side_effect = self._not_found()
        mock.patch.object(s3_updater_v2, "_s3_client", return_value=client).start()

        # Real DynamoDB data carries Decimals (kd here); _put_json must
        # serialize integral Decimals as int and fractional ones as float
        # rather than raising "Object of type Decimal is not JSON serializable".
        data = {
            "id": "GRV-T00001",
            "proteins": [
                {
                    "alias": "A",
                    "uniprot_id": "P1",
                    "origin": [{"organism_name": "E. coli"}],
                    "stimulus": [{"kd": Decimal("0.5"), "wavelength": Decimal("500")}],
                }
            ],
        }
        s3_updater_v2.regenerate_static_json(data, "TetR", "GRV-T00001")

        put_keys = [c.kwargs["Key"] for c in client.put_object.call_args_list]
        self.assertEqual(
            put_keys,
            [
                "v2/index.json",
                "v2/indexes/tetr.json",
                "v2/sensors/tetr/GRV-T00001.json",
                "v2/all-sensors.json",
            ],
        )
        # The sensor file is the raw data dump — its Decimals must round-trip as
        # plain JSON numbers (int for integral, float for fractional).
        sensor_body = json.loads(
            next(
                c.kwargs["Body"]
                for c in client.put_object.call_args_list
                if c.kwargs["Key"] == "v2/sensors/tetr/GRV-T00001.json"
            )
        )
        stim = sensor_body["proteins"][0]["stimulus"][0]
        self.assertEqual(stim, {"kd": 0.5, "wavelength": 500})
        # index.json body reflects the new sensor with recomputed stats
        index_body = json.loads(
            next(
                c.kwargs["Body"]
                for c in client.put_object.call_args_list
                if c.kwargs["Key"] == "v2/index.json"
            )
        )
        self.assertEqual(index_body["stats"], {"regulators": 1, "ligands": 0})
        self.assertEqual(index_body["sensors"][0]["id"], "GRV-T00001")

    def test_regenerate_static_json_upserts_existing_entry_by_id(self):
        client = mock.MagicMock()
        existing_index = {
            "stats": {"regulators": 1, "ligands": 0},
            "sensors": [{"id": "GRV-T00001", "alias": "Old", "ligands": []}],
        }

        def fake_get_object(Bucket, Key):
            if Key == "v2/index.json":
                return self._body(existing_index)
            raise self._not_found()

        client.get_object.side_effect = fake_get_object
        mock.patch.object(s3_updater_v2, "_s3_client", return_value=client).start()

        data = {
            "id": "GRV-T00001",
            "proteins": [{"alias": "New", "uniprot_id": "P1", "origin": [], "stimulus": []}],
        }
        s3_updater_v2.regenerate_static_json(data, "TetR", "GRV-T00001")

        index_body = json.loads(
            next(
                c.kwargs["Body"]
                for c in client.put_object.call_args_list
                if c.kwargs["Key"] == "v2/index.json"
            )
        )
        self.assertEqual(len(index_body["sensors"]), 1)
        self.assertEqual(index_body["sensors"][0]["alias"], "New")


class LambdaInvokerDecimalTest(unittest.TestCase):
    def test_invoke_fingerprint_serializes_decimal_data(self):
        # The fingerprint payload carries the sensor `data` read from DynamoDB,
        # whose numbers are Decimal. Regression: json.dumps used to raise on
        # them, and the caller swallowed it — so fingerprints silently never
        # regenerated on approval. Integral -> int, fractional -> float.
        payload = {
            "grv_id": "GRV-T00001", "category": "TetR",
            "data": {"proteins": [{"kd": Decimal("0.5"), "wavelength": Decimal("500")}]},
        }
        fake_client = mock.MagicMock()
        with mock.patch.dict(os.environ, {"FINGERPRINT_LAMBDA_NAME": "fp-fn"}), \
                mock.patch.object(lambda_invoker.boto3, "client", return_value=fake_client):
            lambda_invoker.invoke_fingerprint_async(payload)
        sent = json.loads(fake_client.invoke.call_args.kwargs["Payload"].decode())
        self.assertEqual(sent["data"]["proteins"][0], {"kd": 0.5, "wavelength": 500})


if __name__ == "__main__":
    unittest.main()
