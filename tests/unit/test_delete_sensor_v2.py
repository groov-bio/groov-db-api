import json
import os
import sys
import unittest
from decimal import Decimal
from unittest import mock

import botocore.exceptions

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(THIS_DIR, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "functions", "deleteSensorV2"))

import deleteSensor as h  # noqa: E402
import lambda_invoker  # noqa: E402
import s3_remover_v2  # noqa: E402


def base_event(**overrides):
    event = {
        "requestContext": {"http": {"method": "POST"}},
        "headers": {"origin": "https://groov.bio"},
        "body": json.dumps({"category": "TetR", "grv_id": "GRV-T00001"}),
    }
    event.update(overrides)
    return event


def client_error(code, message="error", operation="Operation"):
    return botocore.exceptions.ClientError(
        {"Error": {"Code": code, "Message": message}}, operation
    )


class DeleteSensorV2Test(unittest.TestCase):
    def setUp(self):
        os.environ["PROD_TABLE_V2_NAME"] = "groov_db_table_v2"
        os.environ["FINGERPRINT_LAMBDA_NAME"] = "test-fingerprint-v2"

        self.addCleanup(mock.patch.stopall)

        self.prod_table = mock.MagicMock()
        self.prod_table.get_item.return_value = {}
        self.prod_table.delete_item.return_value = {}

        mock.patch.object(h, "_table", return_value=self.prod_table).start()
        self.mock_remove = mock.patch.object(
            s3_remover_v2, "remove_static_json", return_value=None
        ).start()
        self.mock_invoke = mock.patch.object(
            lambda_invoker, "invoke_fingerprint_async", return_value=None
        ).start()

    # ── basic request handling ────────────────────────────────────────────

    def test_options_preflight_returns_200_with_v2_cors(self):
        res = h.lambda_handler(
            base_event(requestContext={"http": {"method": "OPTIONS"}})
        )
        self.assertEqual(res["statusCode"], 200)
        self.assertEqual(res["headers"]["Access-Control-Allow-Methods"], "POST,OPTIONS")
        self.assertNotIn("body", res)

    def test_cors_reflects_allowed_origin(self):
        res = h.lambda_handler(base_event(headers={"origin": "https://www.groov.bio"}))
        self.assertEqual(res["headers"]["Access-Control-Allow-Origin"], "https://www.groov.bio")

    def test_cors_falls_back_to_localhost_for_disallowed_origin(self):
        res = h.lambda_handler(base_event(headers={"origin": "https://evil.example.com"}))
        self.assertEqual(res["headers"]["Access-Control-Allow-Origin"], "http://localhost:3000")

    def test_400_on_invalid_json(self):
        res = h.lambda_handler(base_event(body="{not json"))
        self.assertEqual(res["statusCode"], 400)
        self.assertEqual(json.loads(res["body"])["message"], "Invalid JSON in request body")

    def test_400_when_category_missing(self):
        res = h.lambda_handler(base_event(body=json.dumps({"grv_id": "GRV-T00001"})))
        self.assertEqual(res["statusCode"], 400)
        self.assertIn("category", json.loads(res["body"])["message"])

    def test_400_when_grv_id_missing(self):
        res = h.lambda_handler(base_event(body=json.dumps({"category": "TetR"})))
        self.assertEqual(res["statusCode"], 400)

    def test_400_when_both_missing(self):
        res = h.lambda_handler(base_event(body=json.dumps({})))
        self.assertEqual(res["statusCode"], 400)

    # ── prod read ──────────────────────────────────────────────────────────

    def test_500_when_prod_read_errors(self):
        self.prod_table.get_item.side_effect = Exception("ddb down")
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 500)
        self.assertEqual(
            json.loads(res["body"])["message"], "Error reading from prod table"
        )

    def test_404_when_sensor_not_found(self):
        self.prod_table.get_item.return_value = {}
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 404)
        self.assertEqual(json.loads(res["body"])["message"], "Sensor not found")
        self.prod_table.delete_item.assert_not_called()
        self.mock_remove.assert_not_called()
        self.mock_invoke.assert_not_called()

    # ── prod delete ────────────────────────────────────────────────────────

    def test_500_when_prod_delete_errors(self):
        self.prod_table.get_item.return_value = {
            "Item": {"category": "TetR", "grv_id": "GRV-T00001", "data": {"id": "GRV-T00001"}}
        }
        self.prod_table.delete_item.side_effect = Exception("delete boom")
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 500)
        self.assertEqual(
            json.loads(res["body"])["message"], "Error deleting from prod table"
        )
        # R2 cleanup / fingerprint should not run if prod delete failed
        self.mock_remove.assert_not_called()
        self.mock_invoke.assert_not_called()

    # ── happy path ─────────────────────────────────────────────────────────

    def test_happy_path_200_deletes_removes_r2_and_invokes_fingerprint(self):
        data = {"id": "GRV-T00001", "category": "TetR", "proteins": []}
        self.prod_table.get_item.return_value = {
            "Item": {"category": "TetR", "grv_id": "GRV-T00001", "data": data}
        }

        res = h.lambda_handler(base_event())

        self.assertEqual(res["statusCode"], 200)
        self.assertEqual(
            json.loads(res["body"]),
            {"message": "Sensor deleted", "grv_id": "GRV-T00001", "category": "TetR"},
        )

        self.prod_table.get_item.assert_called_once_with(
            Key={"category": "TetR", "grv_id": "GRV-T00001"}
        )
        self.prod_table.delete_item.assert_called_once_with(
            Key={"category": "TetR", "grv_id": "GRV-T00001"}
        )
        self.mock_remove.assert_called_once_with("TetR", "GRV-T00001")
        self.mock_invoke.assert_called_once_with(
            {"grv_id": "GRV-T00001", "category": "TetR", "data": data}
        )

    # ── post-delete side effects are swallowed ──────────────────────────────

    def test_200_even_when_r2_removal_fails_after_successful_prod_delete(self):
        self.prod_table.get_item.return_value = {
            "Item": {"category": "TetR", "grv_id": "GRV-T00001", "data": {}}
        }
        self.mock_remove.side_effect = Exception("r2 boom")

        res = h.lambda_handler(base_event())

        self.assertEqual(res["statusCode"], 200)
        self.prod_table.delete_item.assert_called_once()
        # fingerprint invoke should still be attempted even though R2 removal failed
        self.mock_invoke.assert_called_once()

    def test_200_even_when_fingerprint_invoke_fails_after_successful_prod_delete(self):
        self.prod_table.get_item.return_value = {
            "Item": {"category": "TetR", "grv_id": "GRV-T00001", "data": {}}
        }
        self.mock_invoke.side_effect = Exception("lambda boom")

        res = h.lambda_handler(base_event())

        self.assertEqual(res["statusCode"], 200)
        self.prod_table.delete_item.assert_called_once()
        self.mock_remove.assert_called_once()

    def test_200_even_when_both_r2_and_fingerprint_fail(self):
        self.prod_table.get_item.return_value = {
            "Item": {"category": "TetR", "grv_id": "GRV-T00001", "data": {}}
        }
        self.mock_remove.side_effect = Exception("r2 boom")
        self.mock_invoke.side_effect = Exception("lambda boom")

        res = h.lambda_handler(base_event())

        self.assertEqual(res["statusCode"], 200)
        self.assertEqual(
            json.loads(res["body"]),
            {"message": "Sensor deleted", "grv_id": "GRV-T00001", "category": "TetR"},
        )


class RemoveStaticJsonTest(unittest.TestCase):
    """Focused unit tests for s3_remover_v2.remove_static_json, driven directly
    against a mocked S3/R2 client (patching _s3_client)."""

    def setUp(self):
        os.environ["R2_BUCKET_NAME"] = "test-bucket"
        os.environ.pop("IS_LOCAL", None)
        self.addCleanup(mock.patch.stopall)

    def _not_found(self, operation="GetObject"):
        return client_error("NoSuchKey", "not found", operation)

    def _body(self, obj):
        body = mock.MagicMock()
        body.read.return_value = json.dumps(obj).encode()
        return {"Body": body}

    def test_no_op_when_all_files_missing(self):
        client = mock.MagicMock()
        client.get_object.side_effect = self._not_found()
        client.delete_object.side_effect = self._not_found("DeleteObject")
        mock.patch.object(s3_remover_v2, "_s3_client", return_value=client).start()

        s3_remover_v2.remove_static_json("TetR", "GRV-T00001")
        client.put_object.assert_not_called()

    def test_removes_sensor_from_index_and_recomputes_stats(self):
        client = mock.MagicMock()
        index = {
            "sensors": [
                {"id": "GRV-T00001", "ligands": ["A", "B"]},
                {"id": "GRV-T00002", "ligands": ["B", "C"]},
            ]
        }

        def fake_get_object(Bucket, Key):
            if Key == "v2/index.json":
                return self._body(index)
            raise self._not_found()

        client.get_object.side_effect = fake_get_object
        client.delete_object.side_effect = self._not_found("DeleteObject")
        mock.patch.object(s3_remover_v2, "_s3_client", return_value=client).start()

        s3_remover_v2.remove_static_json("TetR", "GRV-T00001")

        put_calls = {c.kwargs["Key"]: c.kwargs["Body"] for c in client.put_object.call_args_list}
        self.assertIn("v2/index.json", put_calls)
        updated_index = json.loads(put_calls["v2/index.json"])
        self.assertEqual([s["id"] for s in updated_index["sensors"]], ["GRV-T00002"])
        self.assertEqual(updated_index["stats"], {"regulators": 1, "ligands": 2})

    def test_removes_sensor_from_family_index_and_recomputes_count(self):
        client = mock.MagicMock()
        family_index = {
            "count": 2,
            "data": [{"id": "GRV-T00001"}, {"id": "GRV-T00002"}],
        }

        def fake_get_object(Bucket, Key):
            if Key == "v2/indexes/tetr.json":
                return self._body(family_index)
            raise self._not_found()

        client.get_object.side_effect = fake_get_object
        client.delete_object.side_effect = self._not_found("DeleteObject")
        mock.patch.object(s3_remover_v2, "_s3_client", return_value=client).start()

        s3_remover_v2.remove_static_json("TetR", "GRV-T00001")

        put_calls = {c.kwargs["Key"]: c.kwargs["Body"] for c in client.put_object.call_args_list}
        updated = json.loads(put_calls["v2/indexes/tetr.json"])
        self.assertEqual([s["id"] for s in updated["data"]], ["GRV-T00002"])
        self.assertEqual(updated["count"], 1)

    def test_deletes_sensor_file(self):
        client = mock.MagicMock()
        client.get_object.side_effect = self._not_found()
        client.delete_object.return_value = {}
        mock.patch.object(s3_remover_v2, "_s3_client", return_value=client).start()

        s3_remover_v2.remove_static_json("TetR", "GRV-T00001")

        client.delete_object.assert_any_call(
            Bucket=mock.ANY, Key="v2/sensors/tetr/GRV-T00001.json"
        )

    def test_skips_delete_when_sensor_file_already_missing(self):
        client = mock.MagicMock()
        client.get_object.side_effect = self._not_found()
        client.delete_object.side_effect = self._not_found("DeleteObject")
        mock.patch.object(s3_remover_v2, "_s3_client", return_value=client).start()

        # Should not raise even though delete_object 404s.
        s3_remover_v2.remove_static_json("TetR", "GRV-T00001")

    def test_updates_all_sensors_and_recomputes_count_and_version(self):
        client = mock.MagicMock()
        all_sensors = {
            "version": "2020-01-01T00:00:00.000Z",
            "count": 2,
            "sensors": [{"id": "GRV-T00001"}, {"id": "GRV-T00002"}],
        }

        def fake_get_object(Bucket, Key):
            if Key == "v2/all-sensors.json":
                return self._body(all_sensors)
            raise self._not_found()

        client.get_object.side_effect = fake_get_object
        client.delete_object.side_effect = self._not_found("DeleteObject")
        mock.patch.object(s3_remover_v2, "_s3_client", return_value=client).start()

        s3_remover_v2.remove_static_json("TetR", "GRV-T00001")

        put_calls = {c.kwargs["Key"]: c.kwargs["Body"] for c in client.put_object.call_args_list}
        updated = json.loads(put_calls["v2/all-sensors.json"])
        self.assertEqual([s["id"] for s in updated["sensors"]], ["GRV-T00002"])
        self.assertEqual(updated["count"], 1)
        self.assertNotEqual(updated["version"], "2020-01-01T00:00:00.000Z")

    def test_raises_after_accumulating_errors_from_all_steps(self):
        client = mock.MagicMock()
        boom = client_error("InternalError", "boom", "GetObject")
        client.get_object.side_effect = boom
        client.delete_object.side_effect = boom
        mock.patch.object(s3_remover_v2, "_s3_client", return_value=client).start()

        with self.assertRaises(Exception) as ctx:
            s3_remover_v2.remove_static_json("TetR", "GRV-T00001")
        self.assertIn("R2 removal completed with 4 error(s)", str(ctx.exception))


class LambdaInvokerDecimalTest(unittest.TestCase):
    def test_invoke_fingerprint_serializes_decimal_data(self):
        # The fingerprint payload carries the sensor `data` read from DynamoDB,
        # whose numbers are Decimal. Regression: json.dumps used to raise on
        # them, and the caller swallowed it — so fingerprints silently never
        # regenerated on delete. Integral -> int, fractional -> float.
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
