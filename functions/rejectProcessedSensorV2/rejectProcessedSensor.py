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
        # No endpoint_url override for IS_LOCAL: boto3 auto-targets the
        # Floci-injected AWS_ENDPOINT_URL env var when present inside the
        # Lambda container. Prod is unaffected (that env var is unset there).
        kwargs = {"region_name": "us-east-2"}
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
        # Processed-temp rows are keyed PK="PROCESSED", SK=submissionUUID (see addNewSensorV2).
        result = _table(os.environ["PROCESSED_TEMP_TABLE_V2_NAME"]).delete_item(
            Key={"PK": "PROCESSED", "SK": submission_uuid},
            ReturnValues="ALL_OLD",
        )
        if not result.get("Attributes"):
            return {
                "statusCode": 404,
                "headers": cors,
                "body": json.dumps({"message": "Processed sensor not found"}),
            }
    except Exception as err:  # noqa: BLE001
        print(err)
        return {
            "statusCode": 500,
            "headers": cors,
            "body": json.dumps({"message": "Error rejecting V2 processed sensor"}),
        }

    # Also remove the raw staged submission (PK="TEMP", SK=submissionUUID) that
    # insertFormV2 wrote to the staging table, mirroring approveProcessedSensorV2's
    # cleanup — otherwise a rejected sensor's staged row lingers in
    # getAllTempSensorsV2 forever. Best-effort: the processed row is already gone,
    # so a staging-cleanup failure must not turn a successful reject into a 500.
    temp_table_name = os.environ.get("TEMP_TABLE_V2_NAME")
    if temp_table_name:
        try:
            _table(temp_table_name).delete_item(
                Key={"PK": "TEMP", "SK": submission_uuid}
            )
        except Exception as err:  # noqa: BLE001
            print("Failed to delete staged temp row (processed row already rejected):", err)

    return {"statusCode": 204, "headers": cors}
