import json
import os

import boto3
import botocore.exceptions

import lambda_invoker
import s3_updater_v2

ALLOWED_ORIGINS = ["http://localhost:3000", "https://groov.bio", "https://www.groov.bio"]

# Per api_v2_docs/implementation_plans/add_sensor_insert_form/v2_sensor_pipeline_plan.md.
# Two-component sensors use prefix 'D' regardless of category (interim convention).
CATEGORY_PREFIX = {
    "AraC": "A",
    "GntR": "G",
    "IclR": "I",
    "LacI": "L",
    "LuxR": "X",
    "LysR": "Y",
    "MarR": "M",
    "Other": "Z",
    "TetR": "T",
}
TWO_COMPONENT_PREFIX = "D"


def _coalesce(*values):
    """Nullish-coalescing helper: first argument that is not None, else None."""
    for v in values:
        if v is not None:
            return v
    return None


def prefix_for(category, data):
    if (data or {}).get("type") == "Two Component":
        return TWO_COMPONENT_PREFIX
    return CATEGORY_PREFIX.get(category)


def _cors_headers(event, methods):
    headers = event.get("headers") or {}
    origin = headers.get("origin") or headers.get("Origin") or "http://localhost:3000"
    allowed_origin = origin if origin in ALLOWED_ORIGINS else "http://localhost:3000"
    return {
        "Access-Control-Allow-Origin": allowed_origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Headers": "Content-Type,content-type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
        "Access-Control-Allow-Methods": methods,
        "Access-Control-Max-Age": "86400",
    }


def _method(event):
    return ((event.get("requestContext") or {}).get("http") or {}).get("method")


_dynamodb = None


def _table(name):
    global _dynamodb
    if _dynamodb is None:
        kwargs = {"region_name": "us-east-2"}
        if os.environ.get("IS_LOCAL"):
            kwargs["endpoint_url"] = "http://host.docker.internal:8000"
        _dynamodb = boto3.resource("dynamodb", **kwargs)
    return _dynamodb.Table(name)


def _err(status_code, message, headers):
    return {
        "statusCode": status_code,
        "headers": headers,
        "body": json.dumps({"message": message}),
    }


def lambda_handler(event, context=None):
    cors_headers = _cors_headers(event, "POST,OPTIONS")

    if _method(event) == "OPTIONS":
        return {"statusCode": 200, "headers": cors_headers}

    try:
        body = json.loads(event.get("body") or "{}")
    except Exception:
        return _err(400, "Invalid JSON in request body", cors_headers)

    submission_uuid = body.get("submissionUUID")
    if not submission_uuid:
        return _err(400, "Missing required field: submissionUUID", cors_headers)

    processed_table_name = os.environ.get("PROCESSED_TEMP_TABLE_V2_NAME")
    prod_table_name = os.environ.get("PROD_TABLE_V2_NAME")

    # Processed-temp rows are keyed PK="PROCESSED", SK=submissionUUID (see addNewSensorV2).
    # The category is carried on the row's data blob, not the key.
    try:
        res = _table(processed_table_name).get_item(
            Key={"PK": "PROCESSED", "SK": submission_uuid}
        )
        processed_row = res.get("Item")
    except Exception as err:
        print(err)
        return _err(500, "Error reading from processed-temp table", cors_headers)

    if not processed_row:
        return _err(404, "Processed sensor not found", cors_headers)

    data = processed_row.get("data")
    if not data:
        return _err(500, "Processed-temp row missing data field", cors_headers)

    # ── Edit branch ──────────────────────────────────────────────────────────────
    # Edit rows written by editSensorV2 carry isEdit=true and already have data.id set.
    # Overwrite the existing prod row in place (same grv_id) — no minting required.
    if processed_row.get("isEdit"):
        edit_target = processed_row.get("editTarget") or {}
        grv_id = _coalesce(data.get("id"), edit_target.get("grv_id"))
        category = _coalesce(data.get("category"), edit_target.get("category"))

        if not grv_id or not category:
            return _err(400, "Edit row is missing grv_id or category", cors_headers)

        try:
            _table(prod_table_name).put_item(
                Item={"category": category, "grv_id": grv_id, "data": data},
                # Ensure we're overwriting an existing row, never creating one via this path.
                ConditionExpression="attribute_exists(grv_id)",
            )
        except botocore.exceptions.ClientError as err:
            print(err)
            if err.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return _err(
                    404,
                    f"No prod row found for {grv_id} — cannot apply edit",
                    cors_headers,
                )
            return _err(500, "Error writing to prod table", cors_headers)
        except Exception as err:
            print(err)
            return _err(500, "Error writing to prod table", cors_headers)

        try:
            _table(processed_table_name).delete_item(
                Key={"PK": "PROCESSED", "SK": submission_uuid}
            )
        except Exception as err:
            print("Failed to delete processed-temp edit row (prod write succeeded):", err)

        try:
            s3_updater_v2.regenerate_static_json(data, category, grv_id)
        except Exception as err:
            print("R2 static regen failed (prod write succeeded):", err)

        try:
            lambda_invoker.invoke_fingerprint_async(
                {"grv_id": grv_id, "category": category, "data": data}
            )
        except Exception as err:
            print("Fingerprint lambda invocation failed (prod write succeeded):", err)

        return {
            "statusCode": 200,
            "headers": cors_headers,
            "body": json.dumps(
                {"message": "Sensor edit approved", "grv_id": grv_id, "category": category}
            ),
        }

    # ── New-sensor branch (unchanged) ────────────────────────────────────────────
    if data.get("id"):
        return _err(409, f"Sensor already has id: {data.get('id')}", cors_headers)

    # constructV2Sensor stores the category per-protein as `family`, not at the top level.
    # Fall back to the first protein's family; tolerate a top-level `category` if present
    # (migrated data).
    proteins = data.get("proteins") or []
    first_family = proteins[0].get("family") if proteins else None
    category = _coalesce(data.get("category"), first_family)
    # Two-component sensors collapse into the single 'Dual' bucket (prefix 'D')
    # regardless of their per-protein structural families (e.g. OmpR, HisKA), so
    # those families need not appear in CATEGORY_PREFIX — only single-component
    # sensors must map to a known per-category prefix.
    is_two_component = data.get("type") == "Two Component"
    if not category or (not is_two_component and not CATEGORY_PREFIX.get(category)):
        return _err(
            400,
            f"Unknown or missing category on processed row: {category}",
            cors_headers,
        )

    prefix = prefix_for(category, data)
    if not prefix:
        return _err(
            400, f"Cannot determine GRV-ID prefix for category={category}", cors_headers
        )
    # Two-component sensors collapse into a single 'Dual' bucket in prod so the PK matches
    # the GRV-D prefix and R2 regen writes indexes/dual.json instead of per-category index files.
    prod_category = "Dual" if prefix == TWO_COMPONENT_PREFIX else category

    try:
        grv_id = s3_updater_v2.mint_next_grv_id(prefix)
    except Exception as err:
        print(err)
        return _err(500, "Error minting GRV-ID from R2 index", cors_headers)
    data["id"] = grv_id
    data["category"] = prod_category
    data.pop("proposed_grv_id", None)

    try:
        _table(prod_table_name).put_item(
            Item={"category": prod_category, "grv_id": grv_id, "data": data},
            ConditionExpression="attribute_not_exists(grv_id)",
        )
    except botocore.exceptions.ClientError as err:
        print(err)
        if err.response["Error"]["Code"] == "ConditionalCheckFailedException":
            return _err(409, f"Prod row already exists for {grv_id}", cors_headers)
        return _err(500, "Error writing to prod table", cors_headers)
    except Exception as err:
        print(err)
        return _err(500, "Error writing to prod table", cors_headers)

    try:
        _table(processed_table_name).delete_item(
            Key={"PK": "PROCESSED", "SK": submission_uuid}
        )
    except Exception as err:
        print("Failed to delete processed-temp row (prod write succeeded):", err)

    try:
        s3_updater_v2.regenerate_static_json(data, prod_category, grv_id)
    except Exception as err:
        print("R2 static regen failed (prod write succeeded):", err)

    try:
        lambda_invoker.invoke_fingerprint_async(
            {"grv_id": grv_id, "category": prod_category, "data": data}
        )
    except Exception as err:
        print("Fingerprint lambda invocation failed (prod write succeeded):", err)

    return {
        "statusCode": 200,
        "headers": cors_headers,
        "body": json.dumps(
            {"message": "Sensor approved", "grv_id": grv_id, "category": prod_category}
        ),
    }
