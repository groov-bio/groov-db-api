import json
import os
import sys
import unittest
from unittest import mock

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(THIS_DIR, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "functions", "getAllProcessedTempV2"))

import getAllProcessedTemp as h  # noqa: E402


def base_event(**overrides):
    event = {
        "requestContext": {"http": {"method": "GET"}},
        "headers": {"origin": "https://groov.bio"},
    }
    event.update(overrides)
    return event


# PK for all processed rows is now the literal 'PROCESSED'.
# Mapped response shape: { submissionUUID, proposed_grv_id, data } — no `category` field.
class TestGetAllProcessedTempV2(unittest.TestCase):
    def setUp(self):
        os.environ["PROCESSED_TEMP_TABLE_V2_NAME"] = "test-processed-v2-table"
        self.table = mock.MagicMock()
        self._patch = mock.patch.object(h, "_table", return_value=self.table)
        self._patch.start()
        self.addCleanup(self._patch.stop)

    def test_options_preflight_returns_200(self):
        res = h.lambda_handler(base_event(requestContext={"http": {"method": "OPTIONS"}}))
        self.assertEqual(res["statusCode"], 200)

    def test_200_with_mapped_processed_rows(self):
        self.table.scan.return_value = {
            "Items": [
                {
                    "PK": "PROCESSED", "SK": "uuid-1", "proposed_grv_id": None,
                    "data": {"id": None, "type": "One Component", "proteins": []},
                },
                {
                    "PK": "PROCESSED", "SK": "uuid-2", "proposed_grv_id": "GRV-XYZ",
                    "data": {"id": None, "type": "Two Component", "proteins": []},
                },
            ],
        }
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 200)
        body = json.loads(res["body"])
        self.assertEqual(len(body["processed"]), 2)
        self.assertEqual(body["processed"][0], {
            "submissionUUID": "uuid-1",
            "proposed_grv_id": None,
            "isEdit": False,
            "editTarget": None,
            "data": {"id": None, "type": "One Component", "proteins": []},
            "previousData": None,
        })
        self.assertEqual(body["processed"][1]["proposed_grv_id"], "GRV-XYZ")
        self.table.scan.assert_called_with()

    def test_204_when_table_is_empty(self):
        self.table.scan.return_value = {"Items": []}
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 204)

    def test_paginates_through_last_evaluated_key(self):
        self.table.scan.side_effect = [
            {
                "Items": [{"PK": "PROCESSED", "SK": "uuid-1", "data": {}}],
                "LastEvaluatedKey": {"PK": "PROCESSED", "SK": "uuid-1"},
            },
            {
                "Items": [{"PK": "PROCESSED", "SK": "uuid-2", "data": {}}],
            },
        ]
        res = h.lambda_handler(base_event())
        body = json.loads(res["body"])
        self.assertEqual(len(body["processed"]), 2)
        self.assertEqual(self.table.scan.call_count, 2)
        second_call_kwargs = self.table.scan.call_args_list[1].kwargs
        self.assertEqual(second_call_kwargs["ExclusiveStartKey"], {"PK": "PROCESSED", "SK": "uuid-1"})

    def test_includes_edit_rows_with_is_edit_true_and_edit_target_set(self):
        self.table.scan.return_value = {
            "Items": [
                {
                    "PK": "PROCESSED", "SK": "uuid-regular", "proposed_grv_id": None,
                    "data": {"id": None, "type": "One Component", "proteins": []},
                },
                {
                    "PK": "PROCESSED", "SK": "EDIT#GRV-123",
                    "isEdit": True,
                    "editTarget": {"category": "category-x", "grv_id": "GRV-123"},
                    "data": {"id": "GRV-123", "category": "category-x", "about": "new", "proteins": []},
                    "previousData": {"id": "GRV-123", "category": "category-x", "about": "old", "proteins": []},
                },
            ],
        }
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 200)
        body = json.loads(res["body"])
        self.assertEqual(len(body["processed"]), 2)
        self.assertEqual(body["processed"][1], {
            "submissionUUID": "EDIT#GRV-123",
            "isEdit": True,
            "editTarget": {"category": "category-x", "grv_id": "GRV-123"},
            "proposed_grv_id": None,
            "data": {"id": "GRV-123", "category": "category-x", "about": "new", "proteins": []},
            "previousData": {"id": "GRV-123", "category": "category-x", "about": "old", "proteins": []},
        })

    def test_500_when_scan_throws(self):
        self.table.scan.side_effect = Exception("boom")
        res = h.lambda_handler(base_event())
        self.assertEqual(res["statusCode"], 500)

    def test_handles_missing_proposed_grv_id_and_data_fields_by_emitting_null(self):
        self.table.scan.return_value = {"Items": [{"PK": "PROCESSED", "SK": "uuid-1"}]}
        res = h.lambda_handler(base_event())
        body = json.loads(res["body"])
        self.assertEqual(body["processed"][0], {
            "submissionUUID": "uuid-1",
            "proposed_grv_id": None,
            "isEdit": False,
            "editTarget": None,
            "data": None,
            "previousData": None,
        })


if __name__ == "__main__":
    unittest.main()
