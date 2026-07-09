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
    lambda_client = boto3.client("lambda", region_name="us-east-2")
    lambda_client.invoke(
        FunctionName=fn_name,
        InvocationType="Event",
        Payload=json.dumps(payload, default=_json_default).encode(),
    )
