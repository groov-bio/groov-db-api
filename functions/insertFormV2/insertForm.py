import json
import os
import uuid

import boto3
from boto3.dynamodb.conditions import Key
from groov_models import INSERT_FORM_PAYLOAD, TWO_COMPONENT_ONLY_FAMILIES, validate  # noqa: E402  (shared python-v2 layer)

ALLOWED_ORIGINS = ["http://localhost:3000", "https://groov.bio", "https://www.groov.bio"]


def _cors_headers(event, methods):
    headers = event.get("headers") or {}
    origin = headers.get("origin") or headers.get("Origin") or "http://localhost:3000"
    allowed_origin = origin if origin in ALLOWED_ORIGINS else "http://localhost:3000"
    return {"Access-Control-Allow-Origin": allowed_origin, "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Headers": "Content-Type,content-type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
            "Access-Control-Allow-Methods": methods, "Access-Control-Max-Age": "86400"}


def _method(event):
    return (((event.get("requestContext") or {}).get("http") or {}).get("method"))


_dynamodb = None


def _table(name):
    global _dynamodb
    if _dynamodb is None:
        # No endpoint_url override for IS_LOCAL: boto3 auto-targets the
        # Floci-injected AWS_ENDPOINT_URL env var when present inside the
        # Lambda container. Prod is unaffected (that env var is unset there).
        kwargs = {"region_name": "us-east-2"}
        _dynamodb = boto3.resource("dynamodb", **kwargs)
    return _dynamodb.Table(name)


def _validate_main(body):
    # The full Joi->Pydantic schema now lives in the shared python-v2 layer
    # (groov_models.INSERT_FORM_PAYLOAD). This endpoint's profile forbids
    # unknown keys, requires sensor.mechanism, enforces the DOI pattern on
    # references, and requires >=1 non-empty stimulus group per protein.
    # Returns a list of error strings (empty == valid) — same contract as before.
    return validate(INSERT_FORM_PAYLOAD, body)


# ---------------------------------------------------------------------------
# Prod duplicate detection
# ---------------------------------------------------------------------------

def _is_two_component_submission(proteins):
    return len(proteins) >= 2 or any(p.get("family") in TWO_COMPONENT_ONLY_FAMILIES for p in proteins)


def _prod_categories_for(proteins):
    if _is_two_component_submission(proteins):
        return ["Dual"]
    return list(dict.fromkeys(p.get("family") for p in proteins))


def _collect_prod_uniprot_ids(table, category):
    ids = set()
    last_key = None
    while True:
        kwargs = {"KeyConditionExpression": Key("category").eq(category)}
        if last_key is not None:
            kwargs["ExclusiveStartKey"] = last_key
        res = table.query(**kwargs)
        for item in (res or {}).get("Items", []) or []:
            for protein in (item.get("data") or {}).get("proteins", []) or []:
                uid = protein.get("uniprot_id") if isinstance(protein, dict) else None
                if uid:
                    ids.add(uid)
        last_key = (res or {}).get("LastEvaluatedKey")
        if not last_key:
            break
    return ids


def _find_prod_duplicate(table, proteins):
    existing = set()
    for category in _prod_categories_for(proteins):
        existing |= _collect_prod_uniprot_ids(table, category)
    for p in proteins:
        if p.get("uniProtID") in existing:
            return p.get("uniProtID")
    return None


def _write_to_temp(table, submission_uuid, body):
    item = {"PK": "TEMP", "SK": submission_uuid, **body}
    table.put_item(Item=item)


def lambda_handler(event, context=None):
    cors_headers = _cors_headers(event, "POST,OPTIONS")

    if _method(event) == "OPTIONS":
        return {"statusCode": 200, "headers": cors_headers}

    try:
        body = json.loads(event.get("body"))
    except (json.JSONDecodeError, TypeError):
        return {
            "statusCode": 400,
            "headers": cors_headers,
            "body": json.dumps({"message": "Invalid JSON in request body"}),
        }

    errors = _validate_main(body)
    if errors:
        return {
            "statusCode": 400,
            "headers": cors_headers,
            "body": json.dumps({"type": "Validation Error", "errors": errors}),
        }

    proteins = body["sensor"]["proteins"]

    try:
        prod_table = _table(os.environ.get("PROD_TABLE_V2_NAME"))
        duplicate_id = _find_prod_duplicate(prod_table, proteins)
        if duplicate_id:
            return {
                "statusCode": 409,
                "headers": cors_headers,
                "body": json.dumps({
                    "message": f"The uniProtID {duplicate_id} already exists in our database. "
                               f"If there's an issue, please submit a bug report."
                }),
            }
    except Exception:
        return {
            "statusCode": 500,
            "headers": cors_headers,
            "body": json.dumps({"message": "Error checking for duplicate submission. Please notify the administrators."}),
        }

    submission_uuid = str(uuid.uuid4())

    try:
        temp_table = _table(os.environ.get("TEMP_TABLE_V2_NAME"))
        _write_to_temp(temp_table, submission_uuid, body)
    except Exception:
        return {
            "statusCode": 500,
            "headers": cors_headers,
            "body": json.dumps({"message": "Error processing submission. Please notify the administrators."}),
        }

    return {
        "statusCode": 202,
        "headers": cors_headers,
        "body": json.dumps({"submissionUUID": submission_uuid}),
    }
