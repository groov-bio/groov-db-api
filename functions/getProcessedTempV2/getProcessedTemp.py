import json
import os

import boto3

ALLOWED_ORIGINS = [
    "http://localhost:3000",
    "https://groov.bio",
    "https://www.groov.bio",
]


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
    return (((event.get("requestContext") or {}).get("http") or {}).get("method"))


_dynamodb = None


def _table(name):
    """Lazily build a DynamoDB Table resource. Patch this in tests."""
    global _dynamodb
    if _dynamodb is None:
        kwargs = {"region_name": "us-east-2"}
        if os.environ.get("IS_LOCAL"):
            kwargs["endpoint_url"] = "http://host.docker.internal:8000"
        _dynamodb = boto3.resource("dynamodb", **kwargs)
    return _dynamodb.Table(name)


def lambda_handler(event, context=None):
    cors = _cors_headers(event, "GET,OPTIONS")

    if _method(event) == "OPTIONS":
        return {"statusCode": 200, "headers": cors}

    params = event.get("queryStringParameters") or {}
    submission_uuid = params.get("submissionUUID")
    if not submission_uuid:
        return {
            "statusCode": 400,
            "headers": cors,
            "body": json.dumps({"message": "Missing required parameter: submissionUUID"}),
        }

    try:
        result = _table(os.environ["PROCESSED_TEMP_TABLE_V2_NAME"]).get_item(
            Key={"PK": "PROCESSED", "SK": submission_uuid}
        )
        item = result.get("Item")
        if not item:
            return {
                "statusCode": 404,
                "headers": cors,
                "body": json.dumps({"message": "Processed entry not found"}),
            }
        is_edit = item.get("isEdit")
        return {
            "statusCode": 200,
            "headers": cors,
            "body": json.dumps({
                "submissionUUID": item["SK"],
                "proposed_grv_id": item.get("proposed_grv_id"),
                "isEdit": is_edit if is_edit is not None else False,
                "editTarget": item.get("editTarget"),
                "data": item.get("data"),
                # Pre-edit baseline for the admin diff view (edit rows only; null otherwise).
                "previousData": item.get("previousData"),
            }),
        }
    except Exception as err:  # noqa: BLE001
        print(err)
        return {
            "statusCode": 500,
            "headers": cors,
            "body": json.dumps({"message": "Error fetching V2 processed temp sensor"}),
        }
