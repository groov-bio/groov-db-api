import json
import os

import boto3


def invoke_fingerprint_async(payload):
    fn_name = os.environ.get("FINGERPRINT_LAMBDA_NAME")
    if not fn_name:
        print("FINGERPRINT_LAMBDA_NAME not set, skipping fingerprint invocation")
        return
    lambda_client = boto3.client("lambda", region_name="us-east-2")
    lambda_client.invoke(
        FunctionName=fn_name,
        InvocationType="Event",
        Payload=json.dumps(payload).encode(),
    )
