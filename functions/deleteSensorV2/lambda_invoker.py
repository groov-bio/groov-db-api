import json
import os
from decimal import Decimal

import boto3


def _json_default(value):
    # The payload carries the sensor `data` read from DynamoDB, whose numbers
    # are Decimal — json.dumps can't serialize those. Emit integral values as
    # int and the rest as float, matching JS JSON.stringify.
    if isinstance(value, Decimal):
        return int(value) if value % 1 == 0 else float(value)
    raise TypeError(f"Object of type {type(value).__name__} is not JSON serializable")


def invoke_fingerprint_async(payload):
    fn_name = os.environ.get("FINGERPRINT_LAMBDA_NAME")
    if not fn_name:
        print("FINGERPRINT_LAMBDA_NAME not set, skipping fingerprint invocation")
        return
    # No region_name override for IS_LOCAL: Floci scopes Lambda functions (like
    # DynamoDB tables) per-region, and the local updateFingerprintV2 function is
    # deployed in whatever region the Lambda runtime's own AWS_REGION reports
    # (us-east-1 in this stack) -- hardcoding "us-east-2" here would target a
    # region where the local function doesn't exist and the invoke would silently
    # no-op the fingerprint pipeline. Prod is unaffected (its account's Lambda
    # functions really do live in us-east-2).
    kwargs = {} if os.environ.get("IS_LOCAL") else {"region_name": "us-east-2"}
    lambda_client = boto3.client("lambda", **kwargs)
    lambda_client.invoke(
        FunctionName=fn_name,
        InvocationType="Event",
        Payload=json.dumps(payload, default=_json_default).encode(),
    )
