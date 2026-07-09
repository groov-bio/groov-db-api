import json
import os
import sys
import unittest
from unittest import mock

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(THIS_DIR, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "functions", "getProcessedTempV2"))

import getProcessedTemp as h  # noqa: E402


# `category` is no longer a query param — only `submissionUUID` is required.
# PK in DynamoDB is now the literal string 'PROCESSED'.
def base_event(**overrides):
    event = {
        "requestContext": {"http": {"method": "GET"}},
        "headers": {"origin": "https://groov.bio"},
        "queryStringParameters": {"submissionUUID": "uuid-1"},
    }
    event.update(overrides)
    return event


class TestGetProcessedTempV2(unittest.TestCase):
    def setUp(self):
        os.environ["PROCESSED_TEMP_TABLE_V2_NAME"] = "test-processed-v2-table"
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

    def test_200_with_mapped_row_on_happy_path(self):
        self.table.get_item.return_value = {"Item": {
            "PK": "PROCESSED", "SK": "uuid-1",
            "proposed_grv_id": "GRV-ABC",
            "data": {"id": None, "proteins": [{"uniprot_id": "P12345"}]},
        }}
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 200)
        body = json.loads(res["body"])
        self.assertEqual(body, {
            "submissionUUID": "uuid-1",
            "proposed_grv_id": "GRV-ABC",
            "isEdit": False,
            "editTarget": None,
            "data": {"id": None, "proteins": [{"uniprot_id": "P12345"}]},
            "previousData": None,
        })
        self.table.get_item.assert_called_with(Key={"PK": "PROCESSED", "SK": "uuid-1"})

    def test_returns_edit_row_with_is_edit_true_edit_target_and_previous_data(self):
        self.table.get_item.return_value = {"Item": {
            "PK": "PROCESSED", "SK": "EDIT#GRV-123",
            "isEdit": True,
            "editTarget": {"category": "category-x", "grv_id": "GRV-123"},
            "data": {"id": "GRV-123", "category": "category-x", "about": "new", "proteins": [{"uniprot_id": "P12345"}]},
            "previousData": {"id": "GRV-123", "category": "category-x", "about": "old", "proteins": [{"uniprot_id": "P12345"}]},
        }}
        res = h.lambda_handler(base_event(queryStringParameters={"submissionUUID": "EDIT#GRV-123"}))
        self.assertEqual(res["statusCode"], 200)
        body = json.loads(res["body"])
        self.assertEqual(body, {
            "submissionUUID": "EDIT#GRV-123",
            "isEdit": True,
            "editTarget": {"category": "category-x", "grv_id": "GRV-123"},
            "proposed_grv_id": None,
            "data": {"id": "GRV-123", "category": "category-x", "about": "new", "proteins": [{"uniprot_id": "P12345"}]},
            "previousData": {"id": "GRV-123", "category": "category-x", "about": "old", "proteins": [{"uniprot_id": "P12345"}]},
        })

    def test_404_when_row_not_found(self):
        self.table.get_item.return_value = {}
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 404)

    def test_500_when_dynamo_throws(self):
        self.table.get_item.side_effect = Exception("boom")
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 500)


if __name__ == "__main__":
    unittest.main()
