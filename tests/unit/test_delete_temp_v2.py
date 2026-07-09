import json
import os
import sys
import unittest
from unittest import mock

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(THIS_DIR, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "functions", "deleteTempV2"))

import deleteTemp as h  # noqa: E402


def base_event(**overrides):
    event = {
        "requestContext": {"http": {"method": "POST"}},
        "headers": {"origin": "https://groov.bio"},
        "body": json.dumps({"submissionUUID": "uuid-1"}),
    }
    event.update(overrides)
    return event


class TestDeleteTempV2(unittest.TestCase):
    def setUp(self):
        os.environ["TEMP_TABLE_V2_NAME"] = "test-temp-v2-table"
        self.table = mock.MagicMock()
        self._patch = mock.patch.object(h, "_table", return_value=self.table)
        self._patch.start()
        self.addCleanup(self._patch.stop)

    def test_options_preflight_returns_200_with_post_options_allowed(self):
        res = h.lambda_handler(base_event(requestContext={"http": {"method": "OPTIONS"}}))
        self.assertEqual(res["statusCode"], 200)
        self.assertEqual(res["headers"]["Access-Control-Allow-Methods"], "POST,OPTIONS")

    def test_400_on_invalid_json(self):
        res = h.lambda_handler(base_event(body="{not json"))
        self.assertEqual(res["statusCode"], 400)
        self.assertIn("invalid json", json.loads(res["body"])["message"].lower())

    def test_400_when_submission_uuid_missing_from_body(self):
        res = h.lambda_handler(base_event(body=json.dumps({})))
        self.assertEqual(res["statusCode"], 400)
        self.assertIn("submissionUUID", json.loads(res["body"])["message"])

    def test_400_when_body_is_null(self):
        res = h.lambda_handler(base_event(body=None))
        self.assertEqual(res["statusCode"], 400)

    def test_204_on_successful_delete_and_uses_correct_key(self):
        self.table.delete_item.return_value = {"Attributes": {"PK": "TEMP", "SK": "uuid-1", "sensor": {}}}
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 204)
        self.assertNotIn("body", res)
        self.table.delete_item.assert_called_with(
            Key={"PK": "TEMP", "SK": "uuid-1"}, ReturnValues="ALL_OLD"
        )

    def test_404_when_no_row_was_deleted(self):
        self.table.delete_item.return_value = {}
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 404)
        self.assertIn("not found", json.loads(res["body"])["message"].lower())

    def test_500_when_dynamo_throws(self):
        self.table.delete_item.side_effect = Exception("boom")
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 500)


if __name__ == "__main__":
    unittest.main()
