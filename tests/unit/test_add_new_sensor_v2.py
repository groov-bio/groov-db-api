"""1:1 port of tests/unit/addNewSensorV2.test.js.

The JS test mocks node-fetch (global fetch) and citation-js. Here we instead
mock at the module-function seams (h.callUniProtAPI, h.callDOI,
h.processPDBId, h.callOperonLambda, h._table) per the porting instructions —
this is cleaner and deterministic in Python, but every observable assertion
from the JS suite (status codes, response bodies, the 409 dupe path, the
enrichment-failure status codes, and the exact structure/values of the V2
sensor object passed to the processed-temp put_item) is preserved.
"""

import copy
import json
import os
import sys
import unittest
from unittest import mock

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(THIS_DIR, "..", ".."))
FUNC_DIR = os.path.join(ROOT, "functions", "addNewSensorV2")
UTILS_DIR = os.path.join(FUNC_DIR, "utils")
sys.path.insert(0, FUNC_DIR)
sys.path.insert(0, UTILS_DIR)

import addNewSensor as h  # noqa: E402
import operon  # noqa: E402


SUB_UUID = "sub-uuid-123"


def valid_protein():
    return {
        "alias": "TestAlias",
        "uniProtID": "P12345",
        "accession": "TEST_ACC",
        "family": "TetR",
        "ligands": [{
            "doi": "10.1234/ligand",
            "method": "EMSA",
            "ref_figure": "Figure 2",
            "name": "TestLigand",
            "SMILES": "CCO",
        }],
        "operators": [{
            "doi": "10.1234/test",
            "method": "EMSA",
            "ref_figure": "Figure 1",
            "sequence": "ATCGATCG",
        }],
    }


def valid_body():
    return {
        "sensor": {
            "mechanism": "Apo-repressor",
            "about": "Test sensor description",
            "proteins": [valid_protein()],
        },
        "user": "testuser",
        "timeSubmit": 1640995200000,
        "submissionUUID": SUB_UUID,
    }


MOCK_UNIPROT_RESPONSE = {
    "results": [{
        "primaryAccession": "P12345",
        "organism": {"scientificName": "Escherichia coli", "taxonId": 511145},
        "genes": [{"geneName": {"value": "testGene"}}],
        "sequence": {"value": "MKVLWAALLVTFLAGCQAKVE"},
        "uniProtKBCrossReferences": [
            {"database": "RefSeq", "id": "NP_414542.1"},
            {"database": "PDB", "id": "1ABC"},
            {"database": "KEGG", "id": "eco:b0001"},
        ],
    }],
}

# addNewSensor's callDOI returns camelCase author keys + year as-is; this is
# the *return value* of callDOI (already parsed), matching what enrichDOI
# stores under `fullDOI`.
MOCK_FULL_DOI = {
    "title": "Test Paper Title",
    "authors": [{"lastName": "Smith", "firstName": "John"}],
    "year": 2023,
    "journal": "Test Journal",
    "doi": "10.1234/test",
    "url": "https://doi.org/10.1234/test",
}

MOCK_PDB_RESULT = {"doi": "10.1234/structure", "method": "X-RAY DIFFRACTION", "PDB_code": "1ABC"}

# acc2operon/callOperonLambda returns the parsed operon object directly (no Lambda envelope).
MOCK_OPERON_RESPONSE = {
    "operon": [{"link": "g1", "start": 1, "Stop": 100, "description": "d", "direction": "+"}],
    "regIndex": 0,
    "genome": "NC_TEST.1",
}

_UNSET = object()


def event_for(body=_UNSET, method="POST", origin="https://groov.bio"):
    event = {"requestContext": {"http": {"method": method}}, "headers": {"origin": origin}}
    if body is not _UNSET:
        event["body"] = body if isinstance(body, str) else json.dumps(body)
    return event


class FakeTable:
    """Stands in for a boto3 DynamoDB Table resource."""

    def __init__(self):
        self.items = {}
        self.get_calls = []
        self.put_calls = []

    def get_item(self, Key):
        self.get_calls.append(Key)
        item = self.items.get((Key["PK"], Key["SK"]))
        return {"Item": item} if item is not None else {}

    def put_item(self, Item):
        self.put_calls.append(Item)
        self.items[(Item["PK"], Item["SK"])] = Item
        return {}


class FakeTableProvider:
    """Callable stand-in for h._table — one FakeTable per table name, like the
    real DynamoDB resource returns one Table object per name."""

    def __init__(self):
        self.tables = {}

    def __call__(self, name):
        if name not in self.tables:
            self.tables[name] = FakeTable()
        return self.tables[name]


class AddNewSensorV2TestCase(unittest.TestCase):
    """Base class replicating the JS suite's beforeEach/afterEach env setup."""

    def setUp(self):
        os.environ["TEMP_TABLE_V2_NAME"] = "test-temp-v2-table"
        os.environ["PROCESSED_TEMP_TABLE_V2_NAME"] = "test-processed-temp-v2-table"
        os.environ["GET_OPERON_FUNCTION_ARN"] = "test-operon-arn"
        os.environ.pop("IS_LOCAL", None)

        self.tables = FakeTableProvider()
        self._patches = [mock.patch.object(h, "_table", side_effect=self.tables)]
        for p in self._patches:
            p.start()
        self.addCleanup(mock.patch.stopall)

    # --- helpers mirroring the JS setupSuccessfulMocks() ---------------------

    def mock_uniprot_ok(self, response=None):
        return mock.patch.object(h, "callUniProtAPI", return_value=response or copy.deepcopy(MOCK_UNIPROT_RESPONSE))

    def mock_doi_ok(self, response=None):
        return mock.patch.object(h, "callDOI", return_value=response or copy.deepcopy(MOCK_FULL_DOI))

    def mock_pdb_ok(self, response=None):
        return mock.patch.object(h, "processPDBId", return_value=response or copy.deepcopy(MOCK_PDB_RESULT))

    def mock_operon_ok(self, response=None):
        return mock.patch.object(h, "callOperonLambda", return_value=response or copy.deepcopy(MOCK_OPERON_RESPONSE))

    def setup_successful_mocks(self):
        # Mirrors the JS setupSuccessfulMocks(), which unconditionally
        # re-stubs GetCommand to resolve with no Item every time it's called
        # (aws-sdk-client-mock doesn't simulate real persistence) — so a
        # dupe-check never sees a previous test's/iteration's write. Our
        # FakeTable *does* simulate real persistence (get_item reflects prior
        # put_item calls), so we explicitly clear it here to match.
        for t in self.tables.tables.values():
            t.items.clear()
        patches = [self.mock_uniprot_ok(), self.mock_doi_ok(), self.mock_pdb_ok(), self.mock_operon_ok()]
        mocks = [p.start() for p in patches]
        self.addCleanup(mock.patch.stopall)
        return mocks  # [uniprot_mock, doi_mock, pdb_mock, operon_mock]


class TestCorsHandling(AddNewSensorV2TestCase):
    def test_should_handle_options_request(self):
        result = h.lambda_handler(event_for(method="OPTIONS"))
        self.assertEqual(result["statusCode"], 200)
        self.assertEqual(result["headers"]["Access-Control-Allow-Origin"], "https://groov.bio")
        self.assertEqual(result["body"], "")

    def test_should_use_allowed_origin_for_groov_bio(self):
        self.setup_successful_mocks()
        result = h.lambda_handler(event_for(valid_body()))
        self.assertEqual(result["statusCode"], 202)
        self.assertEqual(result["headers"]["Access-Control-Allow-Origin"], "https://groov.bio")

    def test_should_fall_back_to_localhost_for_disallowed_origins(self):
        self.setup_successful_mocks()
        result = h.lambda_handler(event_for(valid_body(), "POST", "https://evil.example.com"))
        self.assertEqual(result["headers"]["Access-Control-Allow-Origin"], "http://localhost:3000")


class TestRequestValidation(AddNewSensorV2TestCase):
    def test_should_return_400_for_missing_request_body(self):
        result = h.lambda_handler(event_for())
        self.assertEqual(result["statusCode"], 400)
        self.assertEqual(json.loads(result["body"])["message"], "Missing request body")

    def test_should_return_400_for_invalid_json(self):
        result = h.lambda_handler(event_for('{"invalid": json}'))
        self.assertEqual(result["statusCode"], 400)
        self.assertEqual(json.loads(result["body"])["message"], "Invalid JSON in request body")

    def test_should_return_validation_error_for_malformed_sensor(self):
        result = h.lambda_handler(event_for({
            "sensor": {"mechanism": "Apo-repressor"},
            "submissionUUID": SUB_UUID,
        }))
        self.assertEqual(result["statusCode"], 400)
        body = json.loads(result["body"])
        self.assertEqual(body["type"], "Validation Error")
        self.assertIsInstance(body["errors"], list)

    def test_should_return_validation_error_for_invalid_mechanism(self):
        body = valid_body()
        body["sensor"]["mechanism"] = "INVALID_MECHANISM"
        result = h.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 400)
        self.assertEqual(json.loads(result["body"])["type"], "Validation Error")

    def test_should_return_400_if_submission_uuid_not_supplied_inline(self):
        self.setup_successful_mocks()
        body = valid_body()
        del body["submissionUUID"]
        result = h.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 400)
        self.assertIn("submissionUUID is required", json.loads(result["body"])["message"])


class TestSupplementaryRefFigure(AddNewSensorV2TestCase):
    def test_should_accept_supplementary_figure_and_table(self):
        for ref_figure in ["Supplementary Figure 1", "Supplementary Figure 2A", "Supplementary Table 3"]:
            self.setup_successful_mocks()
            body = valid_body()
            protein = valid_protein()
            protein["operators"][0]["ref_figure"] = ref_figure
            protein["ligands"][0]["ref_figure"] = ref_figure
            body["sensor"]["proteins"] = [protein]
            result = h.lambda_handler(event_for(body))
            self.assertEqual(result["statusCode"], 202, msg=f"ref_figure={ref_figure!r}")


class TestSubmissionUUIDModes(AddNewSensorV2TestCase):
    def test_should_fetch_raw_temp_row_when_called_with_only_submission_uuid(self):
        # setup_successful_mocks() clears table state (mirrors the JS mock's
        # per-call GetCommand reset) — seed the temp row *after* calling it.
        self.setup_successful_mocks()
        temp_table = self.tables("test-temp-v2-table")
        temp_table.items[("TEMP", SUB_UUID)] = {
            "PK": "TEMP", "SK": SUB_UUID,
            "sensor": valid_body()["sensor"], "user": "testuser", "timeSubmit": 1,
        }
        result = h.lambda_handler(event_for({"submissionUUID": SUB_UUID}))
        self.assertEqual(result["statusCode"], 202)

    def test_should_return_404_when_raw_temp_row_missing(self):
        result = h.lambda_handler(event_for({"submissionUUID": "unknown-uuid"}))
        self.assertEqual(result["statusCode"], 404)
        self.assertEqual(json.loads(result["body"])["message"], "No submission found for the provided UUID")


class TestDuplicateChecking(AddNewSensorV2TestCase):
    def test_should_return_409_when_processed_entry_exists(self):
        processed_table = self.tables("test-processed-temp-v2-table")
        processed_table.items[("PROCESSED", SUB_UUID)] = {"PK": "PROCESSED", "SK": SUB_UUID}
        result = h.lambda_handler(event_for(valid_body()))
        self.assertEqual(result["statusCode"], 409)
        self.assertEqual(json.loads(result["body"])["message"], "A processed entry already exists for this submission")

    def test_should_query_processed_temp_table_with_pk_processed(self):
        self.setup_successful_mocks()
        h.lambda_handler(event_for(valid_body()))
        processed_table = self.tables("test-processed-temp-v2-table")
        self.assertTrue(any(k == {"PK": "PROCESSED", "SK": SUB_UUID} for k in processed_table.get_calls))


class TestUniProtIntegration(AddNewSensorV2TestCase):
    def test_should_successfully_call_uniprot_api(self):
        uniprot_mock, *_ = self.setup_successful_mocks()
        result = h.lambda_handler(event_for(valid_body()))
        self.assertEqual(result["statusCode"], 202)
        uniprot_mock.assert_called_with("P12345")

    def test_should_return_400_when_uniprot_returns_no_results(self):
        with mock.patch.object(h, "callUniProtAPI", return_value={"results": []}):
            result = h.lambda_handler(event_for(valid_body()))
        self.assertEqual(result["statusCode"], 400)
        self.assertIn("No UniProt results for P12345", json.loads(result["body"])["message"])

    def test_should_return_500_when_uniprot_api_returns_non_ok_status(self):
        with mock.patch.object(h, "callUniProtAPI", side_effect=Exception("UniProt API error: 500")):
            result = h.lambda_handler(event_for(valid_body()))
        self.assertEqual(result["statusCode"], 500)
        self.assertIn("UniProt API error", json.loads(result["body"])["message"])


class TestPDBIntegration(AddNewSensorV2TestCase):
    def test_should_query_pdb_with_cross_referenced_pdb_id(self):
        _, _, pdb_mock, _ = self.setup_successful_mocks()
        result = h.lambda_handler(event_for(valid_body()))
        self.assertEqual(result["statusCode"], 202)
        pdb_mock.assert_called_with("1ABC")

    def test_should_return_500_when_pdb_api_errors(self):
        with mock.patch.object(h, "callUniProtAPI", return_value=copy.deepcopy(MOCK_UNIPROT_RESPONSE)), \
             mock.patch.object(h, "callDOI", return_value=copy.deepcopy(MOCK_FULL_DOI)), \
             mock.patch.object(h, "callOperonLambda", return_value=copy.deepcopy(MOCK_OPERON_RESPONSE)), \
             mock.patch.object(h, "processPDBId", side_effect=Exception("PDB API error: 500")):
            result = h.lambda_handler(event_for(valid_body()))
        self.assertEqual(result["statusCode"], 500)
        self.assertIn("PDB API error", json.loads(result["body"])["message"])


class TestOperonIntegration(AddNewSensorV2TestCase):
    def test_should_call_operon_with_user_provided_accession(self):
        _, _, _, operon_mock = self.setup_successful_mocks()
        h.lambda_handler(event_for(valid_body()))
        operon_mock.assert_called_with("TEST_ACC")

    def test_should_propagate_operon_resolver_errors_as_500(self):
        with mock.patch.object(h, "callUniProtAPI", return_value=copy.deepcopy(MOCK_UNIPROT_RESPONSE)), \
             mock.patch.object(h, "callDOI", return_value=copy.deepcopy(MOCK_FULL_DOI)), \
             mock.patch.object(h, "processPDBId", return_value=copy.deepcopy(MOCK_PDB_RESULT)), \
             mock.patch.object(h, "callOperonLambda", side_effect=Exception("Operon resolver error")):
            result = h.lambda_handler(event_for(valid_body()))
        self.assertEqual(result["statusCode"], 500)
        self.assertEqual(json.loads(result["body"])["message"], "Operon resolver error")


class TestDatabaseWriteOperations(AddNewSensorV2TestCase):
    def test_should_write_single_put_row_with_pk_processed(self):
        self.setup_successful_mocks()
        result = h.lambda_handler(event_for(valid_body()))
        self.assertEqual(result["statusCode"], 202)
        self.assertEqual(json.loads(result["body"])["message"], "Processing completed successfully")

        processed_table = self.tables("test-processed-temp-v2-table")
        self.assertEqual(len(processed_table.put_calls), 1)
        item = processed_table.put_calls[0]
        self.assertEqual(item["PK"], "PROCESSED")
        self.assertEqual(item["SK"], SUB_UUID)
        self.assertIsNone(item["proposed_grv_id"])
        self.assertIsNotNone(item["data"])

    def test_should_write_v2_shaped_sensor_object(self):
        self.setup_successful_mocks()
        h.lambda_handler(event_for(valid_body()))
        written = self.tables("test-processed-temp-v2-table").put_calls[0]["data"]

        self.assertIsNone(written["id"])
        self.assertIsNone(written["proposed_grv_id"])
        self.assertEqual(written["type"], "One Component")
        self.assertIsInstance(written["proteins"], list)
        self.assertEqual(written["proteins"][0]["uniprot_id"], "P12345")
        self.assertEqual(written["proteins"][0]["refseq_id"], "TEST_ACC")
        self.assertIsInstance(written["proteins"][0]["stimulus"], list)
        self.assertIsInstance(written["proteins"][0]["dna"], list)
        self.assertIsInstance(written["proteins"][0]["references"], list)
        self.assertIsInstance(written["proteins"][0]["structures"], list)
        self.assertIsInstance(written["proteins"][0]["origin"], list)
        # Stimulus uses snake_case stimulus_type (matches the V2 contract), never
        # the legacy camelCase stimulusType.
        self.assertNotIn('"stimulusType"', json.dumps(written))
        for stim in written["proteins"][0]["stimulus"]:
            if "small_molecule" in stim or "light" in stim or "temperature" in stim:
                continue
            self.assertIsInstance(stim["stimulus_type"], list)
        # interaction is deprecated dead data — new sensors no longer populate it.
        for ref in written["proteins"][0]["references"]:
            self.assertEqual(ref["interaction"], [])

    def test_should_infer_two_component_with_2_proteins(self):
        self.setup_successful_mocks()
        body = valid_body()
        second = valid_protein()
        second["alias"] = "TestAlias2"
        second["uniProtID"] = "P67890"
        second["accession"] = "TEST_ACC2"
        body["sensor"]["proteins"] = [valid_protein(), second]
        result = h.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 202)
        written = self.tables("test-processed-temp-v2-table").put_calls[0]["data"]
        self.assertEqual(written["type"], "Two Component")
        self.assertEqual(len(written["proteins"]), 2)

    def test_should_accept_signal_transduction_for_two_component(self):
        self.setup_successful_mocks()
        body = valid_body()
        body["sensor"]["mechanism"] = "Signal transduction"
        p1 = valid_protein()
        p1["family"] = "HisKA"
        p2 = valid_protein()
        p2["alias"] = "TestAlias2"
        p2["uniProtID"] = "P67890"
        p2["accession"] = "TEST_ACC2"
        p2["family"] = "OmpR"
        body["sensor"]["proteins"] = [p1, p2]
        result = h.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 202)
        written = self.tables("test-processed-temp-v2-table").put_calls[0]["data"]
        self.assertEqual(written["type"], "Two Component")

    def test_should_reject_ompr_hiska_on_single_protein(self):
        self.setup_successful_mocks()
        body = valid_body()
        protein = valid_protein()
        protein["family"] = "OmpR"
        body["sensor"]["proteins"] = [protein]
        result = h.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 400)
        self.assertEqual(json.loads(result["body"])["type"], "Validation Error")

    def test_should_return_500_when_dynamodb_write_fails(self):
        self.setup_successful_mocks()
        processed_table = self.tables("test-processed-temp-v2-table")

        def failing_put(Item):
            raise Exception("DynamoDB error")

        processed_table.put_item = failing_put
        result = h.lambda_handler(event_for(valid_body()))
        self.assertEqual(result["statusCode"], 500)
        self.assertEqual(json.loads(result["body"])["message"], "Error writing processed sensor row")


class TestCompleteFlowIntegration(AddNewSensorV2TestCase):
    def test_should_make_exactly_1_get_and_1_put(self):
        self.setup_successful_mocks()
        h.lambda_handler(event_for(valid_body()))
        total_gets = sum(len(t.get_calls) for t in self.tables.tables.values())
        total_puts = sum(len(t.put_calls) for t in self.tables.tables.values())
        self.assertEqual(total_gets, 1)
        self.assertEqual(total_puts, 1)

    def test_should_handle_protein_without_optional_ligands_operators(self):
        self.setup_successful_mocks()
        minimal_body = {
            "sensor": {
                "mechanism": "Apo-repressor",
                "about": "",
                "proteins": [{
                    "alias": "TestAlias",
                    "uniProtID": "P12345",
                    "accession": "TEST_ACC",
                    "family": "TetR",
                }],
            },
            "user": "testuser",
            "timeSubmit": 1640995200000,
            "submissionUUID": SUB_UUID,
        }
        result = h.lambda_handler(event_for(minimal_body))
        self.assertEqual(result["statusCode"], 202)


class TestUniProtRequiredRefSeqOptional(AddNewSensorV2TestCase):
    def test_should_reject_protein_with_no_uniprotid_before_enrichment(self):
        with mock.patch.object(h, "callUniProtAPI") as uniprot_mock:
            body = valid_body()
            protein = valid_protein()
            del protein["uniProtID"]
            body["sensor"]["proteins"] = [protein]
            result = h.lambda_handler(event_for(body))
            self.assertEqual(result["statusCode"], 400)
            self.assertEqual(json.loads(result["body"])["type"], "Validation Error")
            uniprot_mock.assert_not_called()

    def test_should_reject_empty_string_uniprotid(self):
        body = valid_body()
        protein = valid_protein()
        protein["uniProtID"] = ""
        body["sensor"]["proteins"] = [protein]
        result = h.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 400)
        self.assertEqual(json.loads(result["body"])["type"], "Validation Error")

    def test_should_still_process_protein_with_no_accession(self):
        self.setup_successful_mocks()
        body = valid_body()
        protein = valid_protein()
        del protein["accession"]
        body["sensor"]["proteins"] = [protein]
        result = h.lambda_handler(event_for(body))
        self.assertEqual(result["statusCode"], 202)


class TestEnvironmentConfiguration(AddNewSensorV2TestCase):
    def test_should_use_processed_temp_table_v2_name_for_dupe_check_and_write(self):
        os.environ["PROCESSED_TEMP_TABLE_V2_NAME"] = "custom-processed-table"
        self.setup_successful_mocks()
        h.lambda_handler(event_for(valid_body()))
        custom_table = self.tables("custom-processed-table")
        self.assertGreaterEqual(len(custom_table.get_calls), 1)
        self.assertEqual(len(custom_table.put_calls), 1)


# ---- Focused operon tests ---------------------------------------------------


class TestFasta2MetaData(unittest.TestCase):
    def test_parses_plus_strand_gene(self):
        fasta = ">lcl|NC_000913.3_cds_NP_414542.1_1 [locus_tag=b0001] [protein=thr operon leader peptide] [protein_id=NP_414542.1] [location=1..255]\nMKR...\n"
        meta = operon.fasta2MetaData(fasta)
        self.assertEqual(meta["alias"], "b0001")
        self.assertEqual(meta["description"], "thr operon leader peptide")
        self.assertEqual(meta["link"], "NP_414542.1")
        self.assertEqual(meta["direction"], "+")
        self.assertEqual(meta["start"], 1)
        self.assertEqual(meta["stop"], 255)

    def test_parses_complement_strand_gene(self):
        fasta = ">lcl|NC_000913.3_cds_NP_414543.1_2 [locus_tag=b0002] [protein=DNA-binding transcriptional dual regulator] [protein_id=NP_414543.1] [location=complement(337..2799)]\nMVK...\n"
        meta = operon.fasta2MetaData(fasta)
        self.assertEqual(meta["alias"], "b0002")
        self.assertEqual(meta["direction"], "-")
        self.assertEqual(meta["start"], 337)
        self.assertEqual(meta["stop"], 2799)

    def test_defaults_link_to_empty_string_when_missing(self):
        fasta = ">lcl|no_protein_id [locus_tag=b9999] [protein=hypothetical] [location=1..10]\n"
        meta = operon.fasta2MetaData(fasta)
        self.assertEqual(meta["link"], "")


class TestParseGenome(unittest.TestCase):
    def test_finds_matching_gene_index(self):
        genome = [
            ">gene0 [location=1..100]\n",
            "SEQ0\n",
            ">gene1 [location=200..300]\n",
            "SEQ1\n",
            ">gene2 [location=400..500]\n",
            "SEQ2\n",
        ]
        result = operon.parseGenome(genome, "200", "300")
        self.assertEqual(result["regIndex"], 1)
        self.assertEqual(len(result["allGenes"]), 3)

    def test_raises_when_no_gene_matches(self):
        genome = [">gene0 [location=1..100]\n", "SEQ0\n"]
        with self.assertRaises(Exception):
            operon.parseGenome(genome, "9999", "9999")


class TestGetOperonWalk(unittest.TestCase):
    def _gene_line(self, locus, start, stop, direction="+"):
        loc = f"complement({start}..{stop})" if direction == "-" else f"{start}..{stop}"
        return f">x [locus_tag={locus}] [protein=p] [protein_id={locus}_id] [location={loc}]"

    def test_walks_up_and_down_within_8kb_same_strand(self):
        genes = [
            self._gene_line("down1", 100, 200, "+"),
            self._gene_line("reg", 1000, 1100, "+"),
            self._gene_line("up1", 2000, 2100, "+"),
        ]
        result = operon.getOperonWalk(genes, 1, 1000, "+")
        aliases = [g["alias"] for g in result["operon"]]
        self.assertIn("reg", aliases)
        self.assertEqual(aliases[result["regulatorIndex"]], "reg")
        self.assertIn("down1", aliases)
        self.assertIn("up1", aliases)

    def test_excludes_genes_beyond_8kb_cutoff(self):
        # The immediately-adjacent down/up gene is always taken regardless of
        # distance ("always take immediately adjacent genes" — see the
        # original getOperon docstring); the 8kb cutoff only bounds the walk
        # *beyond* that immediate neighbor. So to exercise the cutoff we need
        # a near neighbor (always included) and a far one two steps away
        # (excluded by distance).
        genes = [
            self._gene_line("far_down", 100, 190, "+"),
            self._gene_line("near_down", 19900, 19990, "+"),
            self._gene_line("reg", 20000, 20100, "+"),
            self._gene_line("near_up", 20200, 20300, "+"),
            self._gene_line("far_up", 40000, 40100, "+"),
        ]
        result = operon.getOperonWalk(genes, 2, 20000, "+")
        aliases = [g["alias"] for g in result["operon"]]
        self.assertIn("near_down", aliases)
        self.assertIn("near_up", aliases)
        self.assertIn("reg", aliases)
        self.assertNotIn("far_down", aliases)
        self.assertNotIn("far_up", aliases)

    def test_single_gene_genome_returns_only_regulator(self):
        genes = [self._gene_line("only", 10, 20, "+")]
        result = operon.getOperonWalk(genes, 0, 10, "+")
        self.assertEqual(len(result["operon"]), 1)
        self.assertEqual(result["regulatorIndex"], 0)


if __name__ == "__main__":
    unittest.main()
