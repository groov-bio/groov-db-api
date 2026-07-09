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
    cors = _cors_headers(event, "POST,OPTIONS")

    if _method(event) == "OPTIONS":
        return {"statusCode": 200, "headers": cors}

    try:
        body = json.loads(event.get("body") or "{}")
    except json.JSONDecodeError:
        return {
            "statusCode": 400,
            "headers": cors,
            "body": json.dumps({"message": "Invalid JSON in request body"}),
        }

    submission_uuid = body.get("submissionUUID")
    if not submission_uuid:
        return {
            "statusCode": 400,
            "headers": cors,
            "body": json.dumps({"message": "Missing required field: submissionUUID"}),
        }

    try:
        result = _table(os.environ["TEMP_TABLE_V2_NAME"]).delete_item(
            Key={"PK": "TEMP", "SK": submission_uuid},
            ReturnValues="ALL_OLD",
        )
        if not result.get("Attributes"):
            return {
                "statusCode": 404,
                "headers": cors,
                "body": json.dumps({"message": "Submission not found"}),
            }
        return {"statusCode": 204, "headers": cors}
    except Exception as err:  # noqa: BLE001
        print(err)
        return {
            "statusCode": 500,
            "headers": cors,
            "body": json.dumps({"message": "Error deleting V2 temp sensor"}),
        }
