import json
import os

import boto3

import lambda_invoker
import s3_remover_v2

ALLOWED_ORIGINS = ["http://localhost:3000", "https://groov.bio", "https://www.groov.bio"]


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
        # No endpoint_url override for IS_LOCAL: boto3 auto-targets the
        # Floci-injected AWS_ENDPOINT_URL env var when present inside the
        # Lambda container. Prod is unaffected (that env var is unset there).
        kwargs = {"region_name": "us-east-2"}
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

    category = body.get("category")
    grv_id = body.get("grv_id")
    if not category or not grv_id:
        return _err(400, "Missing required fields: category, grv_id", cors_headers)

    prod_table_name = os.environ.get("PROD_TABLE_V2_NAME")

    try:
        res = _table(prod_table_name).get_item(Key={"category": category, "grv_id": grv_id})
        existing_row = res.get("Item")
    except Exception as err:
        print(err)
        return _err(500, "Error reading from prod table", cors_headers)

    if not existing_row:
        return _err(404, "Sensor not found", cors_headers)

    data = existing_row.get("data")

    try:
        _table(prod_table_name).delete_item(Key={"category": category, "grv_id": grv_id})
    except Exception as err:
        print(err)
        return _err(500, "Error deleting from prod table", cors_headers)

    try:
        s3_remover_v2.remove_static_json(category, grv_id)
    except Exception as err:
        print("R2 cleanup failed (prod delete succeeded):", err)

    try:
        lambda_invoker.invoke_fingerprint_async(
            {"grv_id": grv_id, "category": category, "data": data}
        )
    except Exception as err:
        print("Fingerprint lambda invocation failed (prod delete succeeded):", err)

    return {
        "statusCode": 200,
        "headers": cors_headers,
        "body": json.dumps({"message": "Sensor deleted", "grv_id": grv_id, "category": category}),
    }
