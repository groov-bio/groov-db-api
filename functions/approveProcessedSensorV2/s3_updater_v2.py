import datetime
import json
import os
import re
from decimal import Decimal

import boto3
import botocore.exceptions

# V2 published statics live under the `v2/` key prefix on R2 (the FE reads
# https://groov-api.com/v2/index.json etc.). The bucket root holds the V1
# files, so every V2 key must carry this prefix.
V2_PREFIX = "v2/"


def _s3_client():
    if os.environ.get("IS_LOCAL"):
        # No endpoint_url override: boto3 auto-targets the Floci-injected
        # AWS_ENDPOINT_URL env var, and credentials come from the Lambda
        # runtime's own credential provider (also Floci-injected) — same
        # pattern as the DynamoDB clients in this codebase.
        return boto3.client("s3", region_name="us-east-2")
    return boto3.client(
        "s3",
        region_name="auto",
        endpoint_url=os.environ.get("R2_ENDPOINT"),
        aws_access_key_id=os.environ.get("R2_ACCESS_KEY_ID"),
        aws_secret_access_key=os.environ.get("R2_SECRET_ACCESS_KEY"),
    )


def _bucket():
    if os.environ.get("IS_LOCAL"):
        return os.environ.get("S3_BUCKET_NAME") or "my-test-bucket"
    return os.environ.get("R2_BUCKET_NAME")


def _coalesce(*values):
    """Nullish-coalescing helper: first argument that is not None, else None."""
    for v in values:
        if v is not None:
            return v
    return None


def _get_json(key):
    client = _s3_client()
    resp = client.get_object(Bucket=_bucket(), Key=key)
    return json.loads(resp["Body"].read())


def _json_default(value):
    # The published statics are built from the sensor `data` read out of
    # DynamoDB, whose numbers are Decimal — json.dumps can't serialize those.
    # Emit integral values as int and the rest as float, matching JS
    # JSON.stringify so the FE sees plain numbers.
    if isinstance(value, Decimal):
        return int(value) if value % 1 == 0 else float(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def _put_json(key, obj):
    client = _s3_client()
    client.put_object(
        Bucket=_bucket(),
        Key=key,
        Body=json.dumps(obj, indent=2, default=_json_default),
        ContentType="application/json",
    )


def _is_not_found(err):
    if not isinstance(err, botocore.exceptions.ClientError):
        return False
    code = err.response.get("Error", {}).get("Code")
    if code in ("NoSuchKey", "404"):
        return True
    return err.response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 404


# Walk V2 sensor proteins and collect unique ligand names (insertion order,
# mirroring the JS Set -> [...names] behavior).
def _collect_ligand_names(data):
    names = []
    seen = set()
    for protein in data.get("proteins") or []:
        for stim in protein.get("stimulus") or []:
            # Tolerate both stimulusType (camelCase, written by addNewSensorV2)
            # and stimulus_type (snake_case, migrated data).
            types = _coalesce(stim.get("stimulusType"), stim.get("stimulus_type"), [])
            for t in types:
                for m in t.get("small_molecule") or []:
                    name = (m or {}).get("name")
                    if name and name not in seen:
                        seen.add(name)
                        names.append(name)
    return names


def _build_index_entry(data, category, grv_id):
    proteins = data.get("proteins") or []
    first = proteins[0] if proteins else {}
    origin = first.get("origin") or []
    organism_name = _coalesce(origin[0].get("organism_name") if origin else None, "")
    return {
        "id": grv_id,
        "alias": _coalesce(first.get("alias"), ""),
        "uniprot_id": _coalesce(first.get("uniprot_id"), ""),
        "organism_name": organism_name,
        "category": category,
        "ligands": _collect_ligand_names(data),
    }


def _build_family_index_entry(data, grv_id):
    proteins = data.get("proteins") or []
    first = proteins[0] if proteins else {}
    origin = first.get("origin") or []
    organism_name = _coalesce(origin[0].get("organism_name") if origin else None, "")
    return {
        "id": grv_id,
        "alias": _coalesce(first.get("alias"), ""),
        "uniprot_id": _coalesce(first.get("uniprot_id"), ""),
        "kegg_id": _coalesce(first.get("kegg_id"), None),
        "organism_name": organism_name,
        "ligands": _collect_ligand_names(data),
    }


def _update_main_index(data, category, grv_id):
    try:
        index = _get_json(f"{V2_PREFIX}index.json")
    except Exception as err:
        if not _is_not_found(err):
            raise
        index = {"stats": {"regulators": 0, "ligands": 0}, "sensors": []}
    if not isinstance(index.get("sensors"), list):
        index["sensors"] = []
    sensors = index["sensors"]
    entry = _build_index_entry(data, category, grv_id)
    existing_idx = next((i for i, s in enumerate(sensors) if s.get("id") == grv_id), -1)
    if existing_idx >= 0:
        sensors[existing_idx] = entry
    else:
        sensors.append(entry)

    all_ligands = set()
    for s in sensors:
        for ligand in s.get("ligands") or []:
            all_ligands.add(ligand)
    index["stats"] = {"regulators": len(sensors), "ligands": len(all_ligands)}

    _put_json(f"{V2_PREFIX}index.json", index)


def _update_family_index(data, category, grv_id):
    key = f"{V2_PREFIX}indexes/{category.lower()}.json"
    try:
        family_index = _get_json(key)
    except Exception as err:
        if not _is_not_found(err):
            raise
        family_index = {"count": 0, "data": []}
    items = family_index.get("data") or []
    entry = _build_family_index_entry(data, grv_id)
    existing_idx = next((i for i, s in enumerate(items) if s.get("id") == grv_id), -1)
    if existing_idx >= 0:
        items[existing_idx] = entry
    else:
        items.append(entry)
    family_index["data"] = items
    family_index["count"] = len(items)
    _put_json(key, family_index)


def _save_sensor_file(data, category, grv_id):
    _put_json(f"{V2_PREFIX}sensors/{category.lower()}/{grv_id}.json", data)


def _update_all_sensors(data):
    try:
        all_sensors = _get_json(f"{V2_PREFIX}all-sensors.json")
    except Exception as err:
        if not _is_not_found(err):
            raise
        all_sensors = {
            "version": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "count": 0,
            "sensors": [],
        }
    sensors = all_sensors.get("sensors") or []
    existing_idx = next((i for i, s in enumerate(sensors) if s.get("id") == data.get("id")), -1)
    if existing_idx >= 0:
        sensors[existing_idx] = data
    else:
        sensors.append(data)
    all_sensors["sensors"] = sensors
    all_sensors["count"] = len(sensors)
    all_sensors["version"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    _put_json(f"{V2_PREFIX}all-sensors.json", all_sensors)


def _zero_pad(n, width):
    return str(n).zfill(width)


# Returns the next GRV-ID for the given single-character prefix by scanning R2 index.json.
# Per-prefix counters live implicitly in the index — one prefix per category for single-component
# sensors, plus prefix 'D' shared by all two-component sensors.
def mint_next_grv_id(prefix):
    try:
        index = _get_json(f"{V2_PREFIX}index.json")
    except Exception as err:
        if not _is_not_found(err):
            raise
        index = {"sensors": []}
    pattern = re.compile(rf"^GRV-{re.escape(prefix)}(\d{{5}})$")
    max_n = 0
    for s in index.get("sensors") or []:
        sid = s.get("id") if s else None
        if sid:
            m = pattern.match(sid)
            if m:
                n = int(m.group(1))
                if n > max_n:
                    max_n = n
    return f"GRV-{prefix}{_zero_pad(max_n + 1, 5)}"


def regenerate_static_json(data, category, grv_id):
    _update_main_index(data, category, grv_id)
    _update_family_index(data, category, grv_id)
    _save_sensor_file(data, category, grv_id)
    _update_all_sensors(data)
