import copy
import json
import os
import sys
import unittest
from unittest import mock

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(THIS_DIR, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "functions", "editSensorV2"))

import editSensor as h  # noqa: E402


VALID_DATA = {
    "id": "GRV-123",
    "category": "TetR",
    "type": "One Component",
    "about": "Test sensor",
    "proteins": [
        {"uniprot_id": "P12345", "alias": "TestProtein", "family": "TetR"},
        {"uniprot_id": "P67890", "alias": "AnotherProtein", "family": "TetR"},
    ],
}

VALID_BODY = {
    "category": "TetR",
    "grv_id": "GRV-123",
    "data": VALID_DATA,
    "user": "testuser",
    "timeSubmit": 1640995200000,
}

# Prod row matches validData on all read-only fields (type + protein family);
# only the editable `alias` differs, which a valid edit is allowed to change.
PROD_ROW_WITH_SAME_PROTEINS = {
    "PK": {"category": "TetR", "grv_id": "GRV-123"},
    "SK": "GRV-123",
    "data": {
        "id": "GRV-123",
        "category": "TetR",
        "type": "One Component",
        "proteins": [
            {"uniprot_id": "P12345", "alias": "ProdVersion1", "family": "TetR"},
            {"uniprot_id": "P67890", "alias": "ProdVersion2", "family": "TetR"},
        ],
    },
}


def base_event(overrides=None):
    overrides = dict(overrides or {})
    event = {
        "requestContext": {"http": {"method": "POST"}},
        "headers": {"origin": "https://groov.bio"},
    }
    if isinstance(overrides.get("body"), str):
        event["body"] = overrides["body"]
    else:
        merged = copy.deepcopy(VALID_BODY)
        for k, v in overrides.items():
            if k != "body":
                merged[k] = v
        event["body"] = json.dumps(merged)
    event.update(overrides)
    return event


class EditSensorV2Test(unittest.TestCase):
    def setUp(self):
        os.environ["PROD_TABLE_V2_NAME"] = "test-prod-v2-table"
        os.environ["PROCESSED_TEMP_TABLE_V2_NAME"] = "test-processed-v2-table"
        self.table = mock.MagicMock()
        patcher = mock.patch.object(h, "_table", return_value=self.table)
        self.mock_table = patcher.start()
        self.addCleanup(patcher.stop)
        # Default: no item found / no error, tests override as needed.
        self.table.get_item.return_value = {}
        self.table.put_item.return_value = {}

    # -- basic request handling ------------------------------------------------

    def test_options_preflight_returns_200(self):
        res = h.lambda_handler(base_event({"requestContext": {"http": {"method": "OPTIONS"}}}))
        self.assertEqual(res["statusCode"], 200)

    def test_invalid_json_body_returns_400(self):
        res = h.lambda_handler(base_event({"body": "{not json}"}))
        self.assertEqual(res["statusCode"], 400)
        self.assertEqual(json.loads(res["body"])["message"], "Invalid JSON in request body")

    def test_missing_grv_id_in_body_returns_400_validation_error(self):
        body_no_grv_id = {k: v for k, v in VALID_BODY.items() if k != "grv_id"}
        res = h.lambda_handler(base_event({"body": json.dumps(body_no_grv_id)}))
        self.assertEqual(res["statusCode"], 400)
        body = json.loads(res["body"])
        self.assertEqual(body["type"], "Validation Error")
        self.assertIsInstance(body["errors"], list)

    def test_missing_category_in_body_returns_400_validation_error(self):
        body_no_category = {k: v for k, v in VALID_BODY.items() if k != "category"}
        res = h.lambda_handler(base_event({"body": json.dumps(body_no_category)}))
        self.assertEqual(res["statusCode"], 400)
        body = json.loads(res["body"])
        self.assertEqual(body["type"], "Validation Error")

    def test_empty_proteins_array_in_data_returns_400(self):
        res = h.lambda_handler(base_event({"data": {**VALID_DATA, "proteins": []}}))
        self.assertEqual(res["statusCode"], 400)
        body = json.loads(res["body"])
        self.assertEqual(body["type"], "Validation Error")

    def test_missing_data_id_returns_400(self):
        data_no_id = {k: v for k, v in VALID_DATA.items() if k != "id"}
        res = h.lambda_handler(base_event({"data": data_no_id}))
        self.assertEqual(res["statusCode"], 400)
        body = json.loads(res["body"])
        self.assertEqual(body["type"], "Validation Error")

    def test_missing_data_category_returns_400(self):
        data_no_category = {k: v for k, v in VALID_DATA.items() if k != "category"}
        res = h.lambda_handler(base_event({"data": data_no_category}))
        self.assertEqual(res["statusCode"], 400)
        body = json.loads(res["body"])
        self.assertEqual(body["type"], "Validation Error")

    def test_data_id_does_not_match_grv_id_returns_400(self):
        res = h.lambda_handler(base_event({"data": {**VALID_DATA, "id": "GRV-WRONG"}}))
        self.assertEqual(res["statusCode"], 400)
        body = json.loads(res["body"])
        self.assertIn("does not match grv_id", body["message"])

    def test_data_category_does_not_match_category_returns_400(self):
        res = h.lambda_handler(base_event({"data": {**VALID_DATA, "category": "LacI"}}))
        self.assertEqual(res["statusCode"], 400)
        body = json.loads(res["body"])
        self.assertIn("does not match category", body["message"])

    def test_prod_row_missing_returns_404(self):
        self.table.get_item.return_value = {}
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 404)
        body = json.loads(res["body"])
        self.assertIn("Sensor not found", body["message"])

    def test_protein_uniprot_ids_changed_vs_prod_row_returns_400(self):
        self.table.get_item.return_value = {
            "Item": {
                **PROD_ROW_WITH_SAME_PROTEINS,
                "data": {
                    **PROD_ROW_WITH_SAME_PROTEINS["data"],
                    "proteins": [
                        {"uniprot_id": "P12345", "alias": "ProdVersion1"},
                        {"uniprot_id": "P99999", "alias": "DifferentProtein"},  # Changed uniprot_id
                    ],
                },
            }
        }
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 400)
        body = json.loads(res["body"])
        self.assertIn("Protein uniprot_ids cannot be changed", body["message"])

    # -- read-only field enforcement -------------------------------------------

    def test_client_attempt_to_change_sensor_type_is_overwritten_with_prod_value(self):
        self.table.get_item.return_value = {"Item": PROD_ROW_WITH_SAME_PROTEINS}
        res = h.lambda_handler(base_event({"data": {**VALID_DATA, "type": "Two Component"}}))
        self.assertEqual(res["statusCode"], 202)
        put_item = self.table.put_item.call_args.kwargs["Item"]
        self.assertEqual(put_item["data"]["type"], "One Component")  # forced back to prod

    def test_client_attempt_to_change_read_only_protein_field_family_is_overwritten(self):
        self.table.get_item.return_value = {"Item": PROD_ROW_WITH_SAME_PROTEINS}
        res = h.lambda_handler(base_event({
            "data": {
                **VALID_DATA,
                "proteins": [
                    {"uniprot_id": "P12345", "alias": "TestProtein", "family": "MarR"},  # tampered
                    {"uniprot_id": "P67890", "alias": "AnotherProtein", "family": "TetR"},
                ],
            },
        }))
        self.assertEqual(res["statusCode"], 202)
        put_item = self.table.put_item.call_args.kwargs["Item"]
        p1 = next(p for p in put_item["data"]["proteins"] if p["uniprot_id"] == "P12345")
        self.assertEqual(p1["family"], "TetR")  # forced back to prod, not 'MarR'

    def test_editable_fields_alias_regulation_type_pass_through_unchanged(self):
        self.table.get_item.return_value = {"Item": PROD_ROW_WITH_SAME_PROTEINS}
        res = h.lambda_handler(base_event({
            "data": {
                **VALID_DATA,
                "proteins": [
                    {"uniprot_id": "P12345", "alias": "RenamedProtein", "family": "TetR", "regulation_type": "Activator"},
                    {"uniprot_id": "P67890", "alias": "AlsoRenamed", "family": "TetR"},
                ],
            },
        }))
        self.assertEqual(res["statusCode"], 202)
        put_item = self.table.put_item.call_args.kwargs["Item"]
        p1 = next(p for p in put_item["data"]["proteins"] if p["uniprot_id"] == "P12345")
        self.assertEqual(p1["alias"], "RenamedProtein")
        self.assertEqual(p1["regulation_type"], "Activator")

    def test_read_only_field_drift_prod_sequence_differs_but_user_did_not_touch_it(self):
        self.table.get_item.return_value = {
            "Item": {
                **PROD_ROW_WITH_SAME_PROTEINS,
                "data": {
                    **PROD_ROW_WITH_SAME_PROTEINS["data"],
                    "proteins": [
                        {"uniprot_id": "P12345", "alias": "ProdVersion1", "family": "TetR", "sequence": "PRODSEQ"},
                        {"uniprot_id": "P67890", "alias": "ProdVersion2", "family": "TetR"},
                    ],
                },
            }
        }
        # Client submits the copy it loaded (a different sequence), unchanged by the user.
        res = h.lambda_handler(base_event({
            "data": {
                **VALID_DATA,
                "proteins": [
                    {"uniprot_id": "P12345", "alias": "TestProtein", "family": "TetR", "sequence": "LOADEDSEQ"},
                    {"uniprot_id": "P67890", "alias": "AnotherProtein", "family": "TetR"},
                ],
            },
        }))
        self.assertEqual(res["statusCode"], 202)
        put_item = self.table.put_item.call_args.kwargs["Item"]
        p1 = next(p for p in put_item["data"]["proteins"] if p["uniprot_id"] == "P12345")
        self.assertEqual(p1["sequence"], "PRODSEQ")  # forced to prod value, no false rejection

    def test_references_are_editable_corrected_doi_author_saved_interaction_preserved(self):
        prod_references = [{
            "title": "A paper",
            "doi": "10.1/OLD",
            "authors": [{"last_name": "Smith", "first_name": "A"}],
            # Legacy dead data: interaction is an array of rich objects in prod. The
            # edit form leaves it untouched, so a genuine edit must carry it through.
            "interaction": [{"figure": "Figure 1", "interaction_type": "Stimulus", "method": "EMSA"}],
        }]
        self.table.get_item.return_value = {
            "Item": {
                **PROD_ROW_WITH_SAME_PROTEINS,
                "data": {
                    **PROD_ROW_WITH_SAME_PROTEINS["data"],
                    "proteins": [
                        {"uniprot_id": "P12345", "alias": "ProdVersion1", "family": "TetR", "references": prod_references},
                        {"uniprot_id": "P67890", "alias": "ProdVersion2", "family": "TetR"},
                    ],
                },
            }
        }
        # The edit corrects the DOI and adds a co-author, leaving interaction as-is.
        edited_references = [{
            "title": "A paper",
            "doi": "10.1/CORRECTED",
            "authors": [{"last_name": "Smith", "first_name": "A"}, {"last_name": "Jones", "first_name": "B"}],
            "interaction": [{"figure": "Figure 1", "interaction_type": "Stimulus", "method": "EMSA"}],
        }]
        res = h.lambda_handler(base_event({
            "data": {
                **VALID_DATA,
                "proteins": [
                    {"uniprot_id": "P12345", "alias": "TestProtein", "family": "TetR", "references": edited_references},
                    {"uniprot_id": "P67890", "alias": "AnotherProtein", "family": "TetR"},
                ],
            },
        }))
        self.assertEqual(res["statusCode"], 202)
        put_item = self.table.put_item.call_args.kwargs["Item"]
        p1 = next(p for p in put_item["data"]["proteins"] if p["uniprot_id"] == "P12345")
        # The corrected references are saved (not forced back to prod), and the
        # deprecated interaction array rides along unchanged.
        self.assertEqual(p1["references"], edited_references)

    def test_references_with_rich_object_interaction_accepted_and_preserved(self):
        # The edit form now loads/submits interaction untouched as the legacy rich
        # objects (no longer flattened to strings). The schema must accept them and
        # the prod array must round-trip unchanged so a no-op edit diffs cleanly.
        prod_references = [{
            "title": "A paper",
            "doi": "10.1/x",
            "interaction": [{"figure": "Figure 1", "interaction_type": "Stimulus", "method": "S1 nuclease mapping"}],
        }]
        self.table.get_item.return_value = {
            "Item": {
                **PROD_ROW_WITH_SAME_PROTEINS,
                "data": {
                    **PROD_ROW_WITH_SAME_PROTEINS["data"],
                    "proteins": [
                        {"uniprot_id": "P12345", "alias": "ProdVersion1", "family": "TetR", "references": prod_references},
                        {"uniprot_id": "P67890", "alias": "ProdVersion2", "family": "TetR"},
                    ],
                },
            }
        }
        res = h.lambda_handler(base_event({
            "data": {
                **VALID_DATA,
                "proteins": [
                    {
                        "uniprot_id": "P12345", "alias": "TestProtein", "family": "TetR",
                        # Submitted with interaction as the untouched rich objects.
                        "references": [{
                            "title": "A paper", "doi": "10.1/x",
                            "interaction": [{"figure": "Figure 1", "interaction_type": "Stimulus", "method": "S1 nuclease mapping"}],
                        }],
                    },
                    {"uniprot_id": "P67890", "alias": "AnotherProtein", "family": "TetR"},
                ],
            },
        }))
        self.assertEqual(res["statusCode"], 202)
        put_item = self.table.put_item.call_args.kwargs["Item"]
        p1 = next(p for p in put_item["data"]["proteins"] if p["uniprot_id"] == "P12345")
        self.assertEqual(p1["references"], prod_references)

    def test_origin_and_mutations_are_forced_back_to_prod(self):
        prod_origin = [{"type": "wild-type", "organism_name": "E. coli", "organism_id": 562}]
        prod_mutations = [{"mutations": ["A1B"], "ref_type": "UniProt", "ref_id": "P12345"}]
        self.table.get_item.return_value = {
            "Item": {
                **PROD_ROW_WITH_SAME_PROTEINS,
                "data": {
                    **PROD_ROW_WITH_SAME_PROTEINS["data"],
                    "proteins": [
                        {
                            "uniprot_id": "P12345", "alias": "ProdVersion1", "family": "TetR",
                            "origin": prod_origin, "mutations": prod_mutations,
                        },
                        {"uniprot_id": "P67890", "alias": "ProdVersion2", "family": "TetR"},
                    ],
                },
            }
        }
        res = h.lambda_handler(base_event({
            "data": {
                **VALID_DATA,
                "proteins": [
                    {
                        "uniprot_id": "P12345", "alias": "TestProtein", "family": "TetR",
                        # Attempt to change origin and mutations — both must be reverted.
                        "origin": [{"type": "engineered", "organism_name": "Synthetic", "organism_id": 999}],
                        "mutations": [{"mutations": ["Z9Y"], "ref_type": "UniProt", "ref_id": "P12345"}],
                    },
                    {"uniprot_id": "P67890", "alias": "AnotherProtein", "family": "TetR"},
                ],
            },
        }))
        self.assertEqual(res["statusCode"], 202)
        put_item = self.table.put_item.call_args.kwargs["Item"]
        p1 = next(p for p in put_item["data"]["proteins"] if p["uniprot_id"] == "P12345")
        self.assertEqual(p1["origin"], prod_origin)
        self.assertEqual(p1["mutations"], prod_mutations)

    def test_origin_and_mutations_absent_in_prod_are_stripped(self):
        self.table.get_item.return_value = {"Item": PROD_ROW_WITH_SAME_PROTEINS}
        res = h.lambda_handler(base_event({
            "data": {
                **VALID_DATA,
                "proteins": [
                    {
                        "uniprot_id": "P12345", "alias": "TestProtein", "family": "TetR",
                        "origin": [{"type": "wild-type", "organism_name": "E. coli"}],
                        "mutations": [{"mutations": ["A1B"], "ref_type": "UniProt", "ref_id": "P12345"}],
                    },
                    {"uniprot_id": "P67890", "alias": "AnotherProtein", "family": "TetR"},
                ],
            },
        }))
        self.assertEqual(res["statusCode"], 202)
        put_item = self.table.put_item.call_args.kwargs["Item"]
        p1 = next(p for p in put_item["data"]["proteins"] if p["uniprot_id"] == "P12345")
        self.assertNotIn("origin", p1)
        self.assertNotIn("mutations", p1)

    # -- happy paths -------------------------------------------------------------

    def test_happy_path_valid_edit_submission_returns_202(self):
        self.table.get_item.return_value = {"Item": PROD_ROW_WITH_SAME_PROTEINS}
        res = h.lambda_handler(base_event())

        self.assertEqual(res["statusCode"], 202)
        body = json.loads(res["body"])
        self.assertEqual(body["submissionUUID"], "EDIT#GRV-123")
        self.assertIn("Edit submitted for admin review", body["message"])

        self.assertEqual(self.table.put_item.call_count, 1)
        put_item = self.table.put_item.call_args.kwargs["Item"]
        # TableName is implicit in which _table() call produced self.table; verify
        # _table was invoked with the processed-temp table name for the put.
        table_call_names = [c.args[0] for c in self.mock_table.call_args_list]
        self.assertIn("test-processed-v2-table", table_call_names)
        self.assertEqual(put_item["PK"], "PROCESSED")
        self.assertEqual(put_item["SK"], "EDIT#GRV-123")
        self.assertIs(put_item["isEdit"], True)
        self.assertEqual(put_item["editTarget"], {"category": "TetR", "grv_id": "GRV-123"})
        self.assertIsNone(put_item["proposed_grv_id"])
        self.assertEqual(put_item["user"], "testuser")
        self.assertEqual(put_item["editTimestamp"], 1640995200000)
        self.assertEqual(put_item["data"], VALID_DATA)
        # Pre-edit baseline snapshot for the admin diff view.
        self.assertEqual(put_item["previousData"], PROD_ROW_WITH_SAME_PROTEINS["data"])

    def test_happy_path_preserves_data_fields_exactly_stimulus_type(self):
        data_with_stimulus_type = {**VALID_DATA, "stimulus_type": [{"small_molecule": []}]}
        body_with_stimulus = {**VALID_BODY, "data": data_with_stimulus_type}

        self.table.get_item.return_value = {"Item": PROD_ROW_WITH_SAME_PROTEINS}

        res = h.lambda_handler(base_event(body_with_stimulus))

        self.assertEqual(res["statusCode"], 202)
        put_item = self.table.put_item.call_args.kwargs["Item"]
        self.assertEqual(put_item["data"]["stimulus_type"], [{"small_molecule": []}])

    def test_prod_row_get_item_uses_correct_key_structure(self):
        self.table.get_item.return_value = {"Item": PROD_ROW_WITH_SAME_PROTEINS}

        h.lambda_handler(base_event())

        self.assertEqual(self.table.get_item.call_count, 1)
        get_kwargs = self.table.get_item.call_args.kwargs
        self.assertEqual(get_kwargs["Key"], {"category": "TetR", "grv_id": "GRV-123"})
        table_call_names = [c.args[0] for c in self.mock_table.call_args_list]
        self.assertIn("test-prod-v2-table", table_call_names)

    def test_multiple_proteins_with_same_uniprot_id_set_matches_exactly(self):
        three_protein_data = {
            **VALID_DATA,
            "proteins": [
                {"uniprot_id": "P11111", "alias": "Protein1"},
                {"uniprot_id": "P22222", "alias": "Protein2"},
                {"uniprot_id": "P33333", "alias": "Protein3"},
            ],
        }

        self.table.get_item.return_value = {
            "Item": {
                **PROD_ROW_WITH_SAME_PROTEINS,
                "data": {
                    **PROD_ROW_WITH_SAME_PROTEINS["data"],
                    "proteins": [
                        {"uniprot_id": "P33333", "alias": "ProdProtein3"},
                        {"uniprot_id": "P11111", "alias": "ProdProtein1"},
                        {"uniprot_id": "P22222", "alias": "ProdProtein2"},
                    ],  # Order differs but set is same
                },
            }
        }

        res = h.lambda_handler(base_event({"data": three_protein_data}))

        self.assertEqual(res["statusCode"], 202)

    def test_prod_row_with_missing_proteins_field_treats_as_empty_array(self):
        prod_data_no_proteins = {k: v for k, v in PROD_ROW_WITH_SAME_PROTEINS["data"].items() if k != "proteins"}
        self.table.get_item.return_value = {
            "Item": {**PROD_ROW_WITH_SAME_PROTEINS, "data": prod_data_no_proteins}
        }

        # Edit also has proteins, so uniprot_id sets don't match → should fail
        res = h.lambda_handler(base_event())

        self.assertEqual(res["statusCode"], 400)
        body = json.loads(res["body"])
        self.assertIn("Protein uniprot_ids cannot be changed", body["message"])

    def test_dynamodb_get_item_error_returns_500(self):
        self.table.get_item.side_effect = Exception("DynamoDB error")
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 500)
        body = json.loads(res["body"])
        self.assertIn("Error reading prod table", body["message"])

    def test_dynamodb_put_item_error_returns_500(self):
        self.table.get_item.return_value = {"Item": PROD_ROW_WITH_SAME_PROTEINS}
        self.table.put_item.side_effect = Exception("Write failed")
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 500)
        body = json.loads(res["body"])
        self.assertIn("Error writing to processed-temp table", body["message"])

    def test_body_without_user_or_timesubmit_uses_null_and_now_defaults(self):
        body_no_user_or_time = {
            "category": "TetR",
            "grv_id": "GRV-123",
            "data": VALID_DATA,
        }

        self.table.get_item.return_value = {"Item": PROD_ROW_WITH_SAME_PROTEINS}

        res = h.lambda_handler(base_event({"body": json.dumps(body_no_user_or_time)}))

        self.assertEqual(res["statusCode"], 202)
        put_item = self.table.put_item.call_args.kwargs["Item"]
        self.assertIsNone(put_item["user"])
        self.assertIsInstance(put_item["editTimestamp"], int)
        self.assertGreater(put_item["editTimestamp"], 0)


if __name__ == "__main__":
    unittest.main()
