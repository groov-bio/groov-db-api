import copy
import json
import os
import sys
import unittest
from unittest import mock

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(THIS_DIR, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "functions", "insertFormV2"))

import insertForm as insert_form  # noqa: E402


def event_for(body, method="POST", origin="https://groov.bio"):
    return {
        "requestContext": {"http": {"method": method}},
        "headers": {"origin": origin},
        "body": body if isinstance(body, str) else json.dumps(body),
    }


def prod_row_with(uniprot_id, category="TetR", grv_id="GRV-T00001"):
    return {
        "category": category,
        "grv_id": grv_id,
        "data": {"proteins": [{"uniprot_id": uniprot_id}]},
    }


VALID_PROTEIN = {
    "alias": "TestAlias",
    "uniProtID": "P12345",
    "accession": "TEST_ACC",
    "family": "TetR",
    "ligands": [
        {
            "doi": "10.1234/ligand",
            "method": "EMSA",
            "ref_figure": "Figure 2",
            "name": "TestLigand",
            "SMILES": "CCO",
        }
    ],
    "operators": [
        {
            "doi": "10.1234/test",
            "method": "EMSA",
            "ref_figure": "Figure 1",
            "sequence": "ATCGATCG",
        }
    ],
}

VALID_BODY = {
    "sensor": {
        "mechanism": "Apo-repressor",
        "about": "Test sensor description",
        "proteins": [VALID_PROTEIN],
    },
    "user": "testuser",
    "timeSubmit": 1640995200000,
}


class InsertFormV2TestCase(unittest.TestCase):
    def setUp(self):
        os.environ["TEMP_TABLE_V2_NAME"] = "test-temp-v2-table"
        os.environ["PROD_TABLE_V2_NAME"] = "test-prod-v2-table"
        os.environ.pop("IS_LOCAL", None)

        # Single fake "table" double shared across TableName requests; mirrors
        # aws-sdk-client-mock's docClientMock which is command-based (not
        # table-name based). We separately track which table names were
        # requested via _table() for TableName-equivalent assertions.
        self.table = mock.MagicMock()
        self.table.query.return_value = {"Items": []}
        self.table.put_item.return_value = {}

        self.table_names_requested = []

        def fake_table(name):
            self.table_names_requested.append(name)
            return self.table

        patcher = mock.patch.object(insert_form, "_table", side_effect=fake_table)
        self.mock_table_fn = patcher.start()
        self.addCleanup(patcher.stop)

    # ---- CORS handling ----

    def test_should_handle_options_request(self):
        result = insert_form.lambda_handler({
            "requestContext": {"http": {"method": "OPTIONS"}},
            "headers": {"origin": "https://groov.bio"},
        })
        self.assertEqual(result["statusCode"], 200)
        self.assertEqual(result["headers"]["Access-Control-Allow-Origin"], "https://groov.bio")

    def test_should_use_allowed_origin_for_groov_bio(self):
        result = insert_form.lambda_handler(event_for(VALID_BODY))
        self.assertEqual(result["statusCode"], 202)
        self.assertEqual(result["headers"]["Access-Control-Allow-Origin"], "https://groov.bio")

    def test_should_fall_back_to_localhost_for_disallowed_origins(self):
        result = insert_form.lambda_handler(event_for(VALID_BODY, "POST", "https://evil.example.com"))
        self.assertEqual(result["headers"]["Access-Control-Allow-Origin"], "http://localhost:3000")

    # ---- Request validation ----

    def test_should_accept_valid_sensor_shaped_form_data(self):
        result = insert_form.lambda_handler(event_for(VALID_BODY))
        self.assertEqual(result["statusCode"], 202)
        body = json.loads(result["body"])
        self.assertIsInstance(body["submissionUUID"], str)
        self.assertGreater(len(body["submissionUUID"]), 0)

    def test_should_return_400_for_invalid_json_body(self):
        result = insert_form.lambda_handler(event_for("{not json}"))
        self.assertEqual(result["statusCode"], 400)
        self.assertEqual(json.loads(result["body"])["message"], "Invalid JSON in request body")

    def test_should_return_validation_error_for_missing_sensor(self):
        result = insert_form.lambda_handler(event_for({"user": "testuser"}))
        self.assertEqual(result["statusCode"], 400)
        body = json.loads(result["body"])
        self.assertEqual(body["type"], "Validation Error")
        self.assertIsInstance(body["errors"], list)

    def test_should_return_validation_error_for_invalid_mechanism(self):
        body = copy.deepcopy(VALID_BODY)
        body["sensor"]["mechanism"] = "INVALID"
        result = insert_form.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 400)
        self.assertEqual(json.loads(result["body"])["type"], "Validation Error")

    def test_should_return_validation_error_for_empty_proteins(self):
        body = copy.deepcopy(VALID_BODY)
        body["sensor"]["proteins"] = []
        result = insert_form.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 400)

    def test_should_reject_protein_with_no_stimuli(self):
        body = {
            "sensor": {
                "mechanism": "Apo-activator",
                "about": "test",
                "proteins": [
                    {"alias": "test", "uniProtID": "test", "accession": "test", "family": "MarR"},
                    {"alias": "test2", "uniProtID": "test2", "accession": "test2", "family": "MarR"},
                ],
            },
        }
        result = insert_form.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 400)
        self.assertEqual(json.loads(result["body"])["type"], "Validation Error")

    def test_should_reject_protein_missing_family(self):
        protein_no_family = {k: v for k, v in VALID_PROTEIN.items() if k != "family"}
        body = copy.deepcopy(VALID_BODY)
        body["sensor"]["proteins"] = [protein_no_family]
        result = insert_form.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 400)

    def test_should_reject_protein_with_empty_ligands_operators_arrays(self):
        body = copy.deepcopy(VALID_BODY)
        protein = copy.deepcopy(VALID_PROTEIN)
        protein["ligands"] = []
        protein["operators"] = []
        body["sensor"]["proteins"] = [protein]
        result = insert_form.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 400)

    def test_should_accept_protein_with_only_light_stimuli(self):
        protein_no_lig_op = {k: v for k, v in VALID_PROTEIN.items() if k not in ("ligands", "operators")}
        protein_no_lig_op["light_stimuli"] = [{
            "wavelength": 470,
            "regulatory_effect": "activates",
            "doi": "10.1234/light",
            "method": "EMSA",
            "ref_figure": "Figure 3",
        }]
        body = copy.deepcopy(VALID_BODY)
        body["sensor"]["proteins"] = [protein_no_lig_op]
        result = insert_form.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 202)

    def test_should_return_validation_error_for_invalid_ref_figure_format(self):
        body = copy.deepcopy(VALID_BODY)
        protein = copy.deepcopy(VALID_PROTEIN)
        protein["operators"] = [{**VALID_PROTEIN["operators"][0], "ref_figure": "Invalid Figure Format"}]
        body["sensor"]["proteins"] = [protein]
        result = insert_form.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 400)

    # ---- v2 schema: Supplementary ref_figure formats ----

    def test_should_accept_supplementary_ref_figure_formats(self):
        for ref_figure in ["Supplementary Figure 1", "Supplementary Figure 2A", "Supplementary Table 1"]:
            with self.subTest(ref_figure=ref_figure):
                self.table.reset_mock()
                self.table.query.return_value = {"Items": []}
                self.table.put_item.return_value = {}
                body = copy.deepcopy(VALID_BODY)
                protein = copy.deepcopy(VALID_PROTEIN)
                protein["operators"] = [{**VALID_PROTEIN["operators"][0], "ref_figure": ref_figure}]
                protein["ligands"] = [{**VALID_PROTEIN["ligands"][0], "ref_figure": ref_figure}]
                body["sensor"]["proteins"] = [protein]
                result = insert_form.lambda_handler(event_for(body))
                self.assertEqual(result["statusCode"], 202)

    # ---- v2 schema: new optional fields ----

    def test_should_accept_ligand_regulatory_effect_and_kd(self):
        body = copy.deepcopy(VALID_BODY)
        protein = copy.deepcopy(VALID_PROTEIN)
        protein["ligands"] = [{**VALID_PROTEIN["ligands"][0], "regulatory_effect": "activates", "kd": 1.5}]
        body["sensor"]["proteins"] = [protein]
        result = insert_form.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 202)

    def test_should_accept_operator_kd(self):
        body = copy.deepcopy(VALID_BODY)
        protein = copy.deepcopy(VALID_PROTEIN)
        protein["operators"] = [{**VALID_PROTEIN["operators"][0], "kd": 2.0}]
        body["sensor"]["proteins"] = [protein]
        result = insert_form.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 202)

    def test_should_accept_light_temperature_stimuli_and_mutations(self):
        body = copy.deepcopy(VALID_BODY)
        protein = copy.deepcopy(VALID_PROTEIN)
        protein["light_stimuli"] = [{
            "wavelength": 470,
            "regulatory_effect": "activates",
            "doi": "10.1234/light",
            "method": "EMSA",
            "ref_figure": "Figure 3",
        }]
        protein["temperature_stimuli"] = [{
            "temperature": 37,
            "regulatory_effect": "activates",
            "doi": "10.1234/temp",
            "method": "EMSA",
            "ref_figure": "Figure 4",
        }]
        protein["mutations"] = [{"mutations": ["A23T", "L45F"], "ref_type": "UniProt", "ref_id": "P12345"}]
        body["sensor"]["proteins"] = [protein]
        result = insert_form.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 202)

    def test_should_reject_protein_with_no_uniprotid(self):
        protein_no_uniprot = {k: v for k, v in VALID_PROTEIN.items() if k != "uniProtID"}
        body = copy.deepcopy(VALID_BODY)
        body["sensor"]["proteins"] = [protein_no_uniprot]
        result = insert_form.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 400)
        self.assertEqual(json.loads(result["body"])["type"], "Validation Error")

    def test_should_reject_an_empty_string_uniprotid(self):
        body = copy.deepcopy(VALID_BODY)
        protein = copy.deepcopy(VALID_PROTEIN)
        protein["uniProtID"] = ""
        body["sensor"]["proteins"] = [protein]
        result = insert_form.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 400)
        self.assertEqual(json.loads(result["body"])["type"], "Validation Error")

    def test_should_accept_missing_empty_accession(self):
        protein_no_accession = {k: v for k, v in VALID_PROTEIN.items() if k != "accession"}
        protein_no_accession["accession"] = ""
        body = copy.deepcopy(VALID_BODY)
        body["sensor"]["proteins"] = [protein_no_accession]
        result = insert_form.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 202)

    def test_should_still_reject_a_malformed_uniprotid(self):
        body = copy.deepcopy(VALID_BODY)
        protein = copy.deepcopy(VALID_PROTEIN)
        protein["uniProtID"] = "bad id!"
        body["sensor"]["proteins"] = [protein]
        result = insert_form.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 400)
        self.assertEqual(json.loads(result["body"])["type"], "Validation Error")

    def test_should_accept_multi_protein_submission(self):
        body = copy.deepcopy(VALID_BODY)
        second = copy.deepcopy(VALID_PROTEIN)
        second["alias"] = "TestAlias2"
        second["uniProtID"] = "P67890"
        second["accession"] = "TEST_ACC2"
        body["sensor"]["proteins"] = [copy.deepcopy(VALID_PROTEIN), second]
        result = insert_form.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 202)

    # ---- v2 schema: new experimental method ----

    def test_should_accept_autophosphorylation_assay_as_ligand_method(self):
        body = copy.deepcopy(VALID_BODY)
        protein = copy.deepcopy(VALID_PROTEIN)
        protein["ligands"] = [{**VALID_PROTEIN["ligands"][0], "method": "Autophosphorylation assay"}]
        body["sensor"]["proteins"] = [protein]
        result = insert_form.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 202)

    # ---- v2 schema: two-component-only families (OmpR/HisKA) ----

    def two_component_body(self, families):
        body = copy.deepcopy(VALID_BODY)
        body["sensor"]["mechanism"] = "Signal transduction"
        proteins = []
        for i, family in enumerate(families):
            protein = copy.deepcopy(VALID_PROTEIN)
            protein["alias"] = f"TestAlias{i + 1}"
            protein["uniProtID"] = f"P0000{i + 1}"
            protein["accession"] = f"TEST_ACC{i + 1}"
            protein["family"] = family
            proteins.append(protein)
        body["sensor"]["proteins"] = proteins
        return body

    def test_should_accept_ompr_hiska_with_two_proteins(self):
        result = insert_form.lambda_handler(event_for(self.two_component_body(["HisKA", "OmpR"])))
        self.assertEqual(result["statusCode"], 202)

    def test_should_reject_ompr_on_single_protein_submission(self):
        result = insert_form.lambda_handler(event_for(self.two_component_body(["OmpR"])))
        self.assertEqual(result["statusCode"], 400)
        self.assertEqual(json.loads(result["body"])["type"], "Validation Error")

    def test_should_reject_hiska_on_single_protein_submission(self):
        result = insert_form.lambda_handler(event_for(self.two_component_body(["HisKA"])))
        self.assertEqual(result["statusCode"], 400)
        self.assertEqual(json.loads(result["body"])["type"], "Validation Error")

    # ---- Database write operations ----

    def test_should_write_single_put_with_pk_temp_and_sk_submission_uuid(self):
        result = insert_form.lambda_handler(event_for(VALID_BODY))
        self.assertEqual(result["statusCode"], 202)
        submission_uuid = json.loads(result["body"])["submissionUUID"]

        self.assertEqual(self.table.put_item.call_count, 1)
        item = self.table.put_item.call_args.kwargs["Item"]
        self.assertEqual(item["PK"], "TEMP")
        self.assertEqual(item["SK"], submission_uuid)
        self.assertIsNotNone(item.get("sensor"))
        self.assertEqual(item["sensor"]["mechanism"], "Apo-repressor")
        self.assertIn("test-temp-v2-table", self.table_names_requested)

    def test_should_preserve_user_supplied_fields_in_written_row(self):
        insert_form.lambda_handler(event_for(VALID_BODY))
        item = self.table.put_item.call_args.kwargs["Item"]
        self.assertEqual(item["user"], "testuser")
        self.assertEqual(item["timeSubmit"], 1640995200000)
        self.assertEqual(item["sensor"]["proteins"][0]["uniProtID"], "P12345")

    def test_should_return_500_when_dynamodb_write_fails(self):
        self.table.put_item.side_effect = Exception("Write failed")
        result = insert_form.lambda_handler(event_for(VALID_BODY))
        self.assertEqual(result["statusCode"], 500)
        self.assertEqual(
            json.loads(result["body"])["message"],
            "Error processing submission. Please notify the administrators.",
        )

    # ---- Duplicate detection (prod) ----

    def test_rejects_with_409_when_protein_already_exists_in_prod(self):
        self.table.query.return_value = {"Items": [prod_row_with("U2Y8G0")]}
        body = copy.deepcopy(VALID_BODY)
        protein = copy.deepcopy(VALID_PROTEIN)
        protein["uniProtID"] = "U2Y8G0"
        body["sensor"]["proteins"] = [protein]
        result = insert_form.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 409)
        self.assertIn("U2Y8G0", json.loads(result["body"])["message"])
        self.assertEqual(self.table.put_item.call_count, 0)

    def test_queries_the_submitted_proteins_family_category_partition(self):
        insert_form.lambda_handler(event_for(VALID_BODY))
        self.assertEqual(self.table.query.call_count, 1)
        cond = self.table.query.call_args.kwargs["KeyConditionExpression"]
        self.assertEqual(cond.get_expression()["values"][1], "TetR")
        self.assertIn("test-prod-v2-table", self.table_names_requested)

    def test_two_component_submissions_dedupe_against_dual_partition(self):
        body = copy.deepcopy(VALID_BODY)
        body["sensor"]["mechanism"] = "Signal transduction"
        p1 = {**copy.deepcopy(VALID_PROTEIN), "uniProtID": "P00001", "alias": "A1", "accession": "ACC1", "family": "HisKA"}
        p2 = {**copy.deepcopy(VALID_PROTEIN), "uniProtID": "P00002", "alias": "A2", "accession": "ACC2", "family": "OmpR"}
        body["sensor"]["proteins"] = [p1, p2]
        insert_form.lambda_handler(event_for(body))
        self.assertEqual(self.table.query.call_count, 1)
        cond = self.table.query.call_args.kwargs["KeyConditionExpression"]
        self.assertEqual(cond.get_expression()["values"][1], "Dual")

    def test_rejects_two_component_submission_whose_protein_exists_in_dual(self):
        self.table.query.return_value = {"Items": [prod_row_with("P00002", "Dual", "GRV-D00001")]}
        body = copy.deepcopy(VALID_BODY)
        body["sensor"]["mechanism"] = "Signal transduction"
        p1 = {**copy.deepcopy(VALID_PROTEIN), "uniProtID": "P00001", "alias": "A1", "accession": "ACC1", "family": "HisKA"}
        p2 = {**copy.deepcopy(VALID_PROTEIN), "uniProtID": "P00002", "alias": "A2", "accession": "ACC2", "family": "OmpR"}
        body["sensor"]["proteins"] = [p1, p2]
        result = insert_form.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 409)
        self.assertIn("P00002", json.loads(result["body"])["message"])

    def test_paginates_the_prod_query_via_last_evaluated_key(self):
        self.table.query.side_effect = [
            {"Items": [prod_row_with("OTHER1")], "LastEvaluatedKey": {"category": "TetR", "grv_id": "GRV-T00001"}},
            {"Items": [prod_row_with("U2Y8G0")]},
        ]
        body = copy.deepcopy(VALID_BODY)
        protein = copy.deepcopy(VALID_PROTEIN)
        protein["uniProtID"] = "U2Y8G0"
        body["sensor"]["proteins"] = [protein]
        result = insert_form.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 409)
        self.assertEqual(self.table.query.call_count, 2)

    def test_returns_500_when_prod_dedup_query_fails(self):
        self.table.query.side_effect = Exception("Query failed")
        result = insert_form.lambda_handler(event_for(VALID_BODY))
        self.assertEqual(result["statusCode"], 500)
        self.assertEqual(
            json.loads(result["body"])["message"],
            "Error checking for duplicate submission. Please notify the administrators.",
        )
        self.assertEqual(self.table.put_item.call_count, 0)

    # ---- Environment configuration ----

    def test_should_use_temp_table_v2_name_from_environment_for_write(self):
        os.environ["TEMP_TABLE_V2_NAME"] = "custom-temp-v2-table"
        insert_form.lambda_handler(event_for(VALID_BODY))
        self.assertIn("custom-temp-v2-table", self.table_names_requested)


if __name__ == "__main__":
    unittest.main()
