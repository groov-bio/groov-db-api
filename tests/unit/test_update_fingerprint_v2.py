import json
import os
import sys
import tempfile
import unittest
from unittest import mock

fake_fp = mock.MagicMock()
fake_fp.ToBitString.return_value = "0101"
fake_morgan = mock.MagicMock()
fake_morgan.GetFingerprint.return_value = fake_fp

fake_rdkit = mock.MagicMock()
fake_rdkit.Chem.MolFromSmiles.side_effect = lambda s: None if s == "BAD" else mock.MagicMock()
fake_rdkit.Chem.rdFingerprintGenerator.GetMorganGenerator.return_value = fake_morgan

sys.modules.setdefault("rdkit", fake_rdkit)
sys.modules.setdefault("rdkit.Chem", fake_rdkit.Chem)
sys.modules.setdefault("rdkit.Chem.rdFingerprintGenerator", fake_rdkit.Chem.rdFingerprintGenerator)

THIS_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(THIS_DIR, "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "functions", "updateFingerprintV2"))

import updateFingerprint as uf  # noqa: E402


def _sensor(sid, ligands, key="stimulusType"):
    return {
        "id": sid,
        "category": "TetR",
        "proteins": [
            {
                "alias": "p1",
                "uniprot_id": "P1",
                "stimulus": [
                    {key: [{"small_molecule": ligands, "light": None, "temperature": None}]}
                ],
            }
        ],
    }


class TestIterSmallMolecules(unittest.TestCase):
    def test_camel_and_snake_case(self):
        snake = _sensor("X", [{"name": "n", "smiles": "CCO"}], key="stimulus_type")
        camel = _sensor("Y", [{"name": "n", "smiles": "CCC"}])
        self.assertEqual([m["smiles"] for m in uf.iter_small_molecules(snake)], ["CCO"])
        self.assertEqual([m["smiles"] for m in uf.iter_small_molecules(camel)], ["CCC"])


class TestGenerateFingerprints(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def _write(self, data):
        path = os.path.join(self.tmp.name, "all-sensors.json")
        with open(path, "w") as f:
            json.dump(data, f)
        return path

    def test_dedupes_smiles_across_sensors(self):
        path = self._write({
            "sensors": [
                _sensor("GRV-T00001", [{"name": "A", "smiles": "CCO"}]),
                _sensor("GRV-T00002", [{"name": "A2", "smiles": "CCO"}]),
                _sensor("GRV-T00003", [{"name": "B", "smiles": "CCN"}]),
            ]
        })
        fps = uf.generate_fingerprints(path)
        self.assertEqual(len(fps), 2)
        self.assertEqual([t[1] for t in fps], ["LIG00001", "LIG00002"])

    def test_skips_missing_smiles(self):
        path = self._write({
            "sensors": [
                _sensor("S1", [{"name": "no smiles"}]),
                _sensor("S2", [{"name": "ok", "smiles": "CCO"}]),
            ]
        })
        self.assertEqual(len(uf.generate_fingerprints(path)), 1)

    def test_handles_bad_smiles(self):
        path = self._write({"sensors": [_sensor("S1", [{"name": "bad", "smiles": "BAD"}])]})
        self.assertEqual(uf.generate_fingerprints(path), [])


class TestLambdaHandler(unittest.TestCase):
    def test_400_on_missing_payload(self):
        self.assertEqual(uf.lambda_handler({})["statusCode"], 400)

    def test_happy_path(self):
        s3_mock = mock.MagicMock()

        def fake_download(bucket, key, local_path):
            with open(local_path, "w") as f:
                json.dump(
                    {"sensors": [_sensor("GRV-T00001", [{"name": "A", "smiles": "CCO"}])]}, f
                )

        s3_mock.download_file.side_effect = fake_download
        s3_mock.upload_file.return_value = None

        with mock.patch.object(uf, "_get_s3_client", return_value=(s3_mock, "test-bucket")):
            res = uf.lambda_handler({"grv_id": "GRV-T00001", "category": "TetR", "data": {}})

        self.assertEqual(res["statusCode"], 200)
        self.assertEqual(json.loads(res["body"])["count"], 1)
        self.assertEqual(s3_mock.upload_file.call_count, 2)

    def test_500_on_download_failure(self):
        s3_mock = mock.MagicMock()
        s3_mock.download_file.side_effect = Exception("network down")
        with mock.patch.object(uf, "_get_s3_client", return_value=(s3_mock, "test-bucket")):
            res = uf.lambda_handler({"grv_id": "GRV-T00001", "category": "TetR"})
        self.assertEqual(res["statusCode"], 500)

    def test_accepts_apigw_body(self):
        s3_mock = mock.MagicMock()

        def fake_download(bucket, key, local_path):
            with open(local_path, "w") as f:
                json.dump({"sensors": []}, f)

        s3_mock.download_file.side_effect = fake_download
        with mock.patch.object(uf, "_get_s3_client", return_value=(s3_mock, "test-bucket")):
            res = uf.lambda_handler(
                {"body": json.dumps({"grv_id": "GRV-T00001", "category": "TetR"})}
            )
        self.assertEqual(res["statusCode"], 200)


if __name__ == "__main__":
    unittest.main()
