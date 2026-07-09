import json
import os
import sys
import unittest
from decimal import Decimal
from unittest import mock

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(THIS_DIR, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "functions", "getTempSensorV2"))

import getTempSensor as h  # noqa: E402


def base_event(**overrides):
    event = {
        "requestContext": {"http": {"method": "GET"}},
        "headers": {"origin": "https://groov.bio"},
        "queryStringParameters": {"submissionUUID": "uuid-1"},
    }
    event.update(overrides)
    return event


class TestGetTempSensorV2(unittest.TestCase):
    def setUp(self):
        os.environ["TEMP_TABLE_V2_NAME"] = "test-temp-v2-table"
        self.table = mock.MagicMock()
        self._patch = mock.patch.object(h, "_table", return_value=self.table)
        self._patch.start()
        self.addCleanup(self._patch.stop)

    def test_options_preflight_returns_200(self):
        res = h.lambda_handler(base_event(requestContext={"http": {"method": "OPTIONS"}}))
        self.assertEqual(res["statusCode"], 200)

    def test_400_when_submission_uuid_missing(self):
        res = h.lambda_handler(base_event(queryStringParameters={}))
        self.assertEqual(res["statusCode"], 400)
        self.assertIn("submissionUUID", json.loads(res["body"])["message"])

    def test_400_when_query_params_absent(self):
        res = h.lambda_handler(base_event(queryStringParameters=None))
        self.assertEqual(res["statusCode"], 400)

    def test_200_happy_path(self):
        # Numbers come back from DynamoDB as Decimal — integral Decimals must
        # serialize as ints and fractional ones as floats (see _json_default).
        self.table.get_item.return_value = {"Item": {
            "PK": "TEMP", "SK": "uuid-1", "user": "alice", "timeSubmit": Decimal("1700000000"),
            "sensor": {"category": "TetR", "proteins": [
                {"uniProtID": "P12345", "wavelength": Decimal("500"), "kd": Decimal("0.5")}
            ]},
        }}
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 200)
        self.assertEqual(json.loads(res["body"]), {
            "submissionUUID": "uuid-1", "user": "alice", "timeSubmit": 1700000000,
            "sensor": {"category": "TetR", "proteins": [
                {"uniProtID": "P12345", "wavelength": 500, "kd": 0.5}
            ]},
        })
        self.table.get_item.assert_called_with(Key={"PK": "TEMP", "SK": "uuid-1"})

    def test_404_when_not_found(self):
        self.table.get_item.return_value = {}
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 404)

    def test_500_when_dynamo_throws(self):
        self.table.get_item.side_effect = Exception("boom")
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 500)


if __name__ == "__main__":
    unittest.main()
