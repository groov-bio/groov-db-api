import gzip
import json
import logging
import os
import tempfile

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

try:
    from rdkit import Chem
    from rdkit.Chem import rdFingerprintGenerator

    morgan_generator = rdFingerprintGenerator.GetMorganGenerator(radius=2, fpSize=2048)
except ImportError as e:
    logger.fatal(f"RDKit import failed: {e}")
    morgan_generator = None


def _get_s3_client():
    if os.environ.get("IS_LOCAL"):
        return boto3.client(
            "s3",
            region_name="us-east-2",
            endpoint_url="http://host.docker.internal:9090",
            aws_access_key_id="test",
            aws_secret_access_key="test",
        ), os.environ.get("BUCKET_NAME", "my-test-bucket")
    return boto3.client(
        "s3",
        region_name="auto",
        endpoint_url=os.environ.get("R2_ENDPOINT"),
        aws_access_key_id=os.environ.get("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("R2_SECRET_ACCESS_KEY"),
    ), os.environ.get("R2_BUCKET_NAME")


def download_file(s3_client, bucket, key, local_path):
    try:
        logger.info(f"Downloading {key}")
        s3_client.download_file(bucket, key, local_path)
        return True
    except Exception as e:
        logger.error(f"Error downloading {key}: {e}")
        return False


def upload_file(s3_client, bucket, local_path, key, content_type=None):
    try:
        logger.info(f"Uploading {key}")
        extra_args = {"ContentType": content_type} if content_type else {}
        s3_client.upload_file(local_path, bucket, key, ExtraArgs=extra_args)
        return True
    except Exception as e:
        logger.error(f"Error uploading {key}: {e}")
        return False


def iter_small_molecules(sensor):
    """Yield {name, smiles} dicts from a V2 sensor across all proteins/stimuli."""
    for protein in sensor.get("proteins") or []:
        for stim in protein.get("stimulus") or []:
            # Tolerate both stimulusType (addNewSensorV2 output) and stimulus_type (migrated rows)
            types = stim.get("stimulusType") or stim.get("stimulus_type") or []
            for t in types:
                for mol in t.get("small_molecule") or []:
                    if mol:
                        yield mol


def generate_fingerprints(all_sensors_path):
    with open(all_sensors_path, "r") as f:
        all_sensors_data = json.load(f)

    sensors = all_sensors_data.get("sensors", [])
    logger.info(f"Processing {len(sensors)} sensors")

    fingerprints = []
    next_ligand_id = 1
    seen_smiles = {}
    errors = 0

    for sensor in sensors:
        sensor_id = sensor.get("id")
        if not sensor_id:
            continue
        for mol in iter_small_molecules(sensor):
            smiles = mol.get("smiles") or mol.get("SMILES")
            if not smiles:
                continue
            if smiles in seen_smiles:
                ligand_id = seen_smiles[smiles]
            else:
                ligand_id = f"LIG{next_ligand_id:05d}"
                next_ligand_id += 1
                seen_smiles[smiles] = ligand_id
                try:
                    parsed = Chem.MolFromSmiles(smiles)
                    if parsed is None:
                        logger.warning(f"Could not parse SMILES: {smiles}")
                        errors += 1
                        continue
                    fp = morgan_generator.GetFingerprint(parsed)
                    fingerprints.append(
                        (fp.ToBitString(), ligand_id, sensor_id, mol.get("name", "Unknown"))
                    )
                except Exception as e:
                    logger.error(f"Error generating fingerprint for {smiles}: {e}")
                    errors += 1

    logger.info(f"Generated {len(fingerprints)} fingerprints, {errors} errors")
    return fingerprints


def save_fingerprints(s3_client, bucket, fingerprints, work_dir):
    fp_path = os.path.join(work_dir, "fingerprints.json")
    gz_path = os.path.join(work_dir, "fingerprints.json.gz")
    with open(fp_path, "w") as f:
        json.dump(fingerprints, f)
    with open(fp_path, "rb") as f_in, gzip.open(gz_path, "wb") as f_out:
        f_out.write(f_in.read())
    # V2 fingerprints live under the v2/ prefix so they don't clobber the live
    # V1 fingerprints that the current ligandSearch serves from the bucket root.
    ok1 = upload_file(s3_client, bucket, fp_path, "v2/fingerprints.json", "application/json")
    ok2 = upload_file(s3_client, bucket, gz_path, "v2/fingerprints.json.gz", "application/gzip")
    return ok1 and ok2


def _extract_payload(event):
    """Accept both direct Lambda payload and API-Gateway-style event."""
    if isinstance(event, str):
        event = json.loads(event)
    if isinstance(event, dict) and event.get("body"):
        return json.loads(event["body"])
    return event or {}


def lambda_handler(event, context=None):
    if morgan_generator is None:
        return {"statusCode": 500, "body": json.dumps({"error": "RDKit not available"})}
    try:
        payload = _extract_payload(event)
        if not payload.get("grv_id") or not payload.get("category"):
            return {
                "statusCode": 400,
                "body": json.dumps({"error": "Missing required parameters: grv_id, category"}),
            }

        s3_client, bucket = _get_s3_client()

        with tempfile.TemporaryDirectory() as work_dir:
            all_sensors_path = os.path.join(work_dir, "all-sensors.json")
            # V2 sensor dump lives under the v2/ prefix on R2.
            if not download_file(s3_client, bucket, "v2/all-sensors.json", all_sensors_path):
                return {
                    "statusCode": 500,
                    "body": json.dumps({"error": "Failed to download all-sensors.json"}),
                }

            fingerprints = generate_fingerprints(all_sensors_path)
            if not fingerprints:
                logger.warning("No fingerprints generated")
                return {
                    "statusCode": 200,
                    "body": json.dumps({"message": "No fingerprints generated"}),
                }

            if not save_fingerprints(s3_client, bucket, fingerprints, work_dir):
                return {
                    "statusCode": 500,
                    "body": json.dumps({"error": "Failed to save fingerprints"}),
                }

            return {
                "statusCode": 200,
                "body": json.dumps(
                    {"message": "Fingerprint update completed", "count": len(fingerprints)}
                ),
            }
    except Exception as e:
        logger.error(f"Error in lambda_handler: {e}")
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}
