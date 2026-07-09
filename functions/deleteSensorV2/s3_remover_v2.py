import datetime
import json
import os

import boto3
import botocore.exceptions

# V2 published statics live under the `v2/` key prefix on R2 (bucket root holds V1).
V2_PREFIX = "v2/"


def _s3_client():
    if os.environ.get("IS_LOCAL"):
        return boto3.client(
            "s3",
            region_name="us-east-2",
            endpoint_url="http://host.docker.internal:9090",
            aws_access_key_id="test",
            aws_secret_access_key="test",
        )
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


def _get_json(key):
    client = _s3_client()
    resp = client.get_object(Bucket=_bucket(), Key=key)
    return json.loads(resp["Body"].read())


def _put_json(key, obj):
    client = _s3_client()
    client.put_object(
        Bucket=_bucket(),
        Key=key,
        Body=json.dumps(obj, indent=2),
        ContentType="application/json",
    )


def _delete_object(key):
    client = _s3_client()
    client.delete_object(Bucket=_bucket(), Key=key)


def _is_not_found(err):
    if not isinstance(err, botocore.exceptions.ClientError):
        return False
    code = err.response.get("Error", {}).get("Code")
    if code in ("NoSuchKey", "404"):
        return True
    return err.response.get("ResponseMetadata", {}).get("HTTPStatusCode") == 404


def remove_static_json(category, grv_id):
    errors = []

    # 1. index.json — filter out the sensor, recompute stats
    try:
        try:
            index = _get_json(f"{V2_PREFIX}index.json")
        except Exception as err:
            if _is_not_found(err):
                print("index.json not found, skipping")
                index = None
            else:
                raise
        if index is not None:
            sensors = [s for s in (index.get("sensors") or []) if s.get("id") != grv_id]
            all_ligands = set()
            for s in sensors:
                for ligand in s.get("ligands") or []:
                    all_ligands.add(ligand)
            index["sensors"] = sensors
            index["stats"] = {"regulators": len(sensors), "ligands": len(all_ligands)}
            _put_json(f"{V2_PREFIX}index.json", index)
    except Exception as err:
        print(f"Failed to update index.json: {err}")
        errors.append(err)

    # 2. indexes/{category}.json — filter out the sensor, recompute count
    try:
        key = f"{V2_PREFIX}indexes/{category.lower()}.json"
        try:
            family_index = _get_json(key)
        except Exception as err:
            if _is_not_found(err):
                print(f"{key} not found, skipping")
                family_index = None
            else:
                raise
        if family_index is not None:
            items = [s for s in (family_index.get("data") or []) if s.get("id") != grv_id]
            family_index["data"] = items
            family_index["count"] = len(items)
            _put_json(key, family_index)
    except Exception as err:
        print(f"Failed to update indexes/{category.lower()}.json: {err}")
        errors.append(err)

    # 3. sensors/{category}/{grv_id}.json — delete the object
    try:
        key = f"{V2_PREFIX}sensors/{category.lower()}/{grv_id}.json"
        try:
            _delete_object(key)
        except Exception as err:
            if _is_not_found(err):
                print(f"{key} not found, nothing to delete")
            else:
                raise
    except Exception as err:
        print(f"Failed to delete sensors/{category.lower()}/{grv_id}.json: {err}")
        errors.append(err)

    # 4. all-sensors.json — filter out the sensor, recompute count and version
    try:
        try:
            all_sensors = _get_json(f"{V2_PREFIX}all-sensors.json")
        except Exception as err:
            if _is_not_found(err):
                print("all-sensors.json not found, skipping")
                all_sensors = None
            else:
                raise
        if all_sensors is not None:
            sensors = [s for s in (all_sensors.get("sensors") or []) if s.get("id") != grv_id]
            all_sensors["sensors"] = sensors
            all_sensors["count"] = len(sensors)
            all_sensors["version"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            _put_json(f"{V2_PREFIX}all-sensors.json", all_sensors)
    except Exception as err:
        print(f"Failed to update all-sensors.json: {err}")
        errors.append(err)

    if errors:
        raise Exception(
            f"R2 removal completed with {len(errors)} error(s); see logs for details"
        )
