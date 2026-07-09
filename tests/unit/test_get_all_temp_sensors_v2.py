import json
import os
import sys
import unittest
from unittest import mock

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(THIS_DIR, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "functions", "getAllTempSensorsV2"))

from boto3.dynamodb.conditions import Key  # noqa: E402

import getAllTempSensors as h  # noqa: E402


def base_event(**overrides):
    event = {
        "requestContext": {"http": {"method": "GET"}},
        "headers": {"origin": "https://groov.bio"},
    }
    event.update(overrides)
    return event


class TestGetAllTempSensorsV2(unittest.TestCase):
    def setUp(self):
        os.environ["TEMP_TABLE_V2_NAME"] = "test-temp-v2-table"
        self.table = mock.MagicMock()
        self._patch = mock.patch.object(h, "_table", return_value=self.table)
        self._patch.start()
        self.addCleanup(self._patch.stop)

    def test_options_preflight_returns_200_with_cors_headers(self):
        res = h.lambda_handler(base_event(requestContext={"http": {"method": "OPTIONS"}}))
        self.assertEqual(res["statusCode"], 200)
        self.assertEqual(res["headers"]["Access-Control-Allow-Origin"], "https://groov.bio")
        self.assertEqual(res["headers"]["Access-Control-Allow-Methods"], "GET,OPTIONS")

    def test_200_with_mapped_submissions_on_happy_path(self):
        self.table.query.return_value = {
            "Items": [
                {
                    "PK": "TEMP", "SK": "uuid-1", "user": "alice", "timeSubmit": 1700000000,
                    "sensor": {"category": "TetR", "proteins": [{"uniProtID": "P12345"}]},
                },
                {
                    "PK": "TEMP", "SK": "uuid-2", "user": "bob", "timeSubmit": 1700000001,
                    "sensor": {"category": "LysR", "proteins": [{"uniProtID": "Q67890"}]},
                },
            ],
        }
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 200)
        body = json.loads(res["body"])
        self.assertEqual(len(body["submissions"]), 2)
        self.assertEqual(body["submissions"][0], {
            "submissionUUID": "uuid-1", "user": "alice", "timeSubmit": 1700000000,
            "sensor": {"category": "TetR", "proteins": [{"uniProtID": "P12345"}]},
        })
        self.assertEqual(body["submissions"][1]["submissionUUID"], "uuid-2")
        self.table.query.assert_called_with(KeyConditionExpression=Key("PK").eq("TEMP"))

    def test_204_when_table_is_empty(self):
        self.table.query.return_value = {"Items": []}
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 204)
        self.assertNotIn("body", res)

    def test_paginates_through_last_evaluated_key_and_merges_all_items(self):
        self.table.query.side_effect = [
            {
                "Items": [{"PK": "TEMP", "SK": "uuid-1", "sensor": {"category": "TetR"}}],
                "LastEvaluatedKey": {"PK": "TEMP", "SK": "uuid-1"},
            },
            {
                "Items": [{"PK": "TEMP", "SK": "uuid-2", "sensor": {"category": "LysR"}}],
            },
        ]
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 200)
        body = json.loads(res["body"])
        self.assertEqual(len(body["submissions"]), 2)
        self.assertEqual(self.table.query.call_count, 2)
        second_call_kwargs = self.table.query.call_args_list[1].kwargs
        self.assertEqual(second_call_kwargs["ExclusiveStartKey"], {"PK": "TEMP", "SK": "uuid-1"})

    def test_500_when_dynamo_throws(self):
        self.table.query.side_effect = Exception("boom")
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 500)
        self.assertIn("error", json.loads(res["body"])["message"].lower())

    def test_disallowed_origin_falls_back_to_localhost_default(self):
        self.table.query.return_value = {"Items": []}
        res = h.lambda_handler(base_event(headers={"origin": "https://evil.com"}))
        self.assertEqual(res["headers"]["Access-Control-Allow-Origin"], "http://localhost:3000")

    def test_null_user_time_submit_sensor_are_returned_as_nulls(self):
        self.table.query.return_value = {"Items": [{"PK": "TEMP", "SK": "uuid-only"}]}
        res = h.lambda_handler(base_event())
        body = json.loads(res["body"])
        self.assertEqual(body["submissions"][0], {
            "submissionUUID": "uuid-only", "user": None, "timeSubmit": None, "sensor": None,
        })


if __name__ == "__main__":
    unittest.main()
