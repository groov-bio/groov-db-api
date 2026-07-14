#!/bin/bash
# floci/provision.sh
#
# One-shot provisioning for the local V2-only, Python-only groov-db-api
# emulation running on Floci (a LocalStack-community-compatible drop-in).
# Run by the `floci-init` service in docker-compose.yml. This is a THIN
# mirror of the V2-relevant slice of template.yaml -- it deliberately does
# NOT re-derive resource shapes; every table/route/env block below carries a
# comment pointing at the template.yaml resource it mirrors, so drift is easy
# to spot on a diff. If you change a V2 resource in template.yaml, update the
# matching block here.
#
# Scope: exactly the 12 V2 HTTP routes + the ported Python admin authorizer +
# updateFingerprintV2 (invoked-only, no HTTP route). No V1/Node functions.
#
# Runs inside the `floci-init` one-shot container (image: public.ecr.aws/aws-cli/aws-cli).
# Expects:
#   - AWS_ENDPOINT_URL, AWS_DEFAULT_REGION=us-east-1, AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY=test
#   - HOST_API_DIR = the absolute path to the repo root ON THE DOCKER HOST (used
#     only to build hot-reload S3Key values -- Floci bind-mounts that path via
#     the HOST docker daemon, not via this container's filesystem).
#   - The repo root bind-mounted read-only at /workspace (for reading fixtures
#     and pre-built layer zips from THIS container's own filesystem).
#   - The `floci_shared` volume mounted at /shared (to publish ui.env).
set -euo pipefail

WORKSPACE=/workspace
: "${HOST_API_DIR:?HOST_API_DIR must be set (absolute host path to the repo root)}"
: "${AWS_ENDPOINT_URL:?AWS_ENDPOINT_URL must be set}"

FLOCI_HOST_URL="${AWS_ENDPOINT_URL}"          # e.g. http://floci:4566 (docker-network hostname)
BROWSER_URL="http://localhost:4566"           # what the host/browser/UI uses -- Cognito issuer + API base use this

echo "=================================================================="
echo " groov-db-api local (Floci) provisioning"
echo "=================================================================="

# ---------------------------------------------------------------------------
# a. Wait for Floci to be healthy
# ---------------------------------------------------------------------------
echo "--- Waiting for Floci at ${FLOCI_HOST_URL} ..."
tries=0
until curl -sf "${FLOCI_HOST_URL}/_localstack/health" >/dev/null 2>&1; do
  tries=$((tries + 1))
  if [ "$tries" -ge 90 ]; then
    echo "ERROR: Floci did not become healthy in time" >&2
    exit 1
  fi
  sleep 2
done
echo "Floci is healthy."

# ---------------------------------------------------------------------------
# b. DynamoDB tables (mirrors template.yaml GroovTempTableV2 ~L136,
#    GroovTempTableV2Processed ~L152, and the prod V2 table groov_db_table_v2
#    -- prod table key schema inferred from the handler code: every V2 handler
#    that reads/writes it (editSensorV2.py, approveProcessedSensorV2/*.py,
#    deleteSensorV2/*.py, insertFormV2/insertForm.py) keys it on
#    Key={"category": ..., "grv_id": ...}.)
# ---------------------------------------------------------------------------
echo "--- Creating DynamoDB tables ..."

# NOTE ON REGION: unlike API Gateway invoke (which only resolves for
# us-east-1) and S3 (region-agnostic in Floci -- verified empirically), Floci
# DOES scope DynamoDB tables per-region: a table created under us-east-1 is
# invisible to a query issued with region_name=us-east-2, and vice versa
# (reproduced directly against a live Floci: `aws dynamodb list-tables`
# returns the tables under us-east-1 but an empty list under us-east-2).
# Every V2 handler's `_table()` helper hardcodes `region_name="us-east-2"` in
# its boto3.resource("dynamodb", ...) call (left as-is per the "hardcoded
# region is fine, don't hard-assert a DIFFERENT one" guidance -- prod already
# depends on that exact value), so these tables must be created in us-east-2
# to be visible to that code, even though the rest of this stack (API
# Gateway, Cognito) is pinned to us-east-1.
DDB_REGION=us-east-2

create_table() {
  local name="$1" hash_attr="$2" range_attr="$3"
  if aws dynamodb describe-table --table-name "$name" --region "$DDB_REGION" >/dev/null 2>&1; then
    echo "  DynamoDB table $name already exists, skipping"
    return
  fi
  aws dynamodb create-table \
    --table-name "$name" \
    --region "$DDB_REGION" \
    --attribute-definitions AttributeName="$hash_attr",AttributeType=S AttributeName="$range_attr",AttributeType=S \
    --key-schema AttributeName="$hash_attr",KeyType=HASH AttributeName="$range_attr",KeyType=RANGE \
    --billing-mode PAY_PER_REQUEST >/dev/null
  echo "  Created table: $name (HASH=$hash_attr, RANGE=$range_attr, region=$DDB_REGION)"
}

create_table GroovTempTableV2 PK SK
create_table GroovTempTableV2Processed PK SK
create_table groov_db_table_v2 category grv_id

# ---------------------------------------------------------------------------
# c. S3: one bucket serves two purposes locally --
#      1) S3_BUCKET_NAME/BUCKET_NAME target for approveProcessedSensorV2 /
#         deleteSensorV2 / updateFingerprintV2's IS_LOCAL S3 writes
#         (functions/*/s3_updater_v2.py, s3_remover_v2.py, updateFingerprint.py)
#      2) the seeded static-browse fixture the UI reads offline instead of
#         https://groov-api.com (path-style: http://localhost:4566/<bucket>/...)
#    Using ONE bucket for both means approving/rejecting/deleting a sensor
#    through the local API actually updates what the UI browses -- not a
#    second, disconnected copy.
# ---------------------------------------------------------------------------
STATIC_BUCKET="groov-local-static"
DEPLOY_BUCKET="groov-local-deploy"   # private staging bucket for the layer zip (>50MB direct-upload limit)

echo "--- Creating S3 buckets ..."
aws s3api create-bucket --bucket "$STATIC_BUCKET" >/dev/null 2>&1 || echo "  Bucket $STATIC_BUCKET already exists, skipping"
aws s3api create-bucket --bucket "$DEPLOY_BUCKET" >/dev/null 2>&1 || echo "  Bucket $DEPLOY_BUCKET already exists, skipping"

echo "--- Configuring $STATIC_BUCKET for public, cross-origin GET (browser fetches it directly) ..."
cat > /tmp/cors.json <<'EOF'
{
  "CORSRules": [
    {
      "AllowedOrigins": ["http://localhost:3000"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": ["*"],
      "MaxAgeSeconds": 3600
    }
  ]
}
EOF
aws s3api put-bucket-cors --bucket "$STATIC_BUCKET" --cors-configuration file:///tmp/cors.json

cat > /tmp/bucket-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "PublicReadGetObject",
      "Effect": "Allow",
      "Principal": "*",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::${STATIC_BUCKET}/*"
    }
  ]
}
EOF
aws s3api put-bucket-policy --bucket "$STATIC_BUCKET" --policy file:///tmp/bucket-policy.json

echo "--- Seeding $STATIC_BUCKET with the V2 static-browse fixture (scripts/s3_v2/) ..."
# scripts/s3_v2/ is a previously-generated real V2 export (index.json, per-family
# indexes, all-sensors.json, and 253 per-sensor JSON files) already shaped exactly
# like what s3_updater_v2.regenerate_static_json() produces -- reused as-is per
# the "SEEDING tools are fine to run outside the Python-only V2 API runtime" rule.
# Mirrors the key layout the UI fetches under https://groov-api.com/v2/... (see
# SensorPageV2.js, SensorTableV2.js, EditSensorV2.js, DownloadAllSensors.js,
# Search.js, lib/api/v2Admin.js).
if [ -d "${WORKSPACE}/scripts/s3_v2" ]; then
  aws s3 cp "${WORKSPACE}/scripts/s3_v2/" "s3://${STATIC_BUCKET}/v2/" \
    --recursive --exclude ".DS_Store" --content-type "application/json" >/dev/null
  echo "  Seeded v2/ browse fixture."
  # Root-level (non-v2) copies too: some UI code paths read /index.json and
  # /all-sensors.json at the bucket root (V1-shaped legacy paths). We have no
  # real V1 fixture, so mirror the V2 export there rather than 404 -- good
  # enough for "resolves to valid JSON offline", which is all those code
  # paths need when the v2 feature flags (below) are the ones actually driving
  # the UI.
  aws s3 cp "${WORKSPACE}/scripts/s3_v2/index.json" "s3://${STATIC_BUCKET}/index.json" \
    --content-type "application/json" >/dev/null
  aws s3 cp "${WORKSPACE}/scripts/s3_v2/all-sensors.json" "s3://${STATIC_BUCKET}/all-sensors.json" \
    --content-type "application/json" >/dev/null
else
  echo "  WARNING: scripts/s3_v2 not found, skipping static-browse seed" >&2
fi

# Seed the prod V2 table (groov_db_table_v2). The S3 fixture above only powers
# BROWSE; every WRITE path reads DynamoDB. editSensorV2/approveProcessedSensorV2
# get_item(Key={category, grv_id}) the prod row first, so an empty table makes
# every edit 404 ("Sensor not found") even though the sensor is browseable.
# Rows mirror what approveProcessedSensorV2 writes: {category, grv_id, data},
# where data is the full sensor object (identical to the per-sensor detail JSON
# the edit form loads). Sourced from all-sensors.json (same 252 objects) and
# marshalled with the image's stdlib python3 (no boto3 in the aws-cli image);
# batch-write-item caps at 25 items/call, so we chunk.
ALL_SENSORS_JSON="${WORKSPACE}/scripts/s3_v2/all-sensors.json"
if [ -f "$ALL_SENSORS_JSON" ]; then
  echo "--- Seeding groov_db_table_v2 from all-sensors.json ..."
  rm -f /tmp/ddb_seed_batch_*.json
  python3 - "$ALL_SENSORS_JSON" <<'PY'
import json, sys
sensors = json.load(open(sys.argv[1]))["sensors"]

def marshal(v):
    if isinstance(v, bool):   return {"BOOL": v}
    if v is None:             return {"NULL": True}
    if isinstance(v, str):    return {"S": v}
    if isinstance(v, (int, float)): return {"N": repr(v)}
    if isinstance(v, list):   return {"L": [marshal(x) for x in v]}
    if isinstance(v, dict):   return {"M": {k: marshal(x) for k, x in v.items()}}
    raise TypeError(f"unmarshalable: {type(v)}")

reqs = [{"PutRequest": {"Item": marshal(
            {"category": s["category"], "grv_id": s["id"], "data": s})}}
        for s in sensors]
for i in range(0, len(reqs), 25):
    with open(f"/tmp/ddb_seed_batch_{i//25:03d}.json", "w") as f:
        json.dump({"groov_db_table_v2": reqs[i:i+25]}, f)
print(f"  Marshalled {len(reqs)} items into {(len(reqs)+24)//25} batches.")
PY
  for batch in /tmp/ddb_seed_batch_*.json; do
    aws dynamodb batch-write-item --region "$DDB_REGION" \
      --request-items "file://${batch}" >/dev/null
  done
  rm -f /tmp/ddb_seed_batch_*.json
  echo "  Seeded groov_db_table_v2 (prod V2 rows for edit/approve paths)."
else
  echo "  WARNING: $ALL_SENSORS_JSON not found, skipping prod-table seed" >&2
fi

# feature-flags.json: REQUIRED for the UI to render any V2 surface -- without
# it resolving, the app falls back to all-flags-off and no V2 UI appears.
# The UI reader (useFeatureFlag) selects per-environment via `flag[env]`, so
# the file MUST use the nested {local,prod} shape that prod serves -- a flat
# boolean resolves `flag['local']` to undefined and silently falls back to
# off, which regresses browse to the V1 SensorTable against V2-shaped data
# (every row id becomes `row-undefined`). Seed the canonical
# api_v2_docs/feature-flags.json verbatim so local matches prod and stays the
# single source of truth.
FEATURE_FLAGS_SRC="${WORKSPACE}/api_v2_docs/feature-flags.json"
if [ -f "${FEATURE_FLAGS_SRC}" ]; then
  aws s3 cp "${FEATURE_FLAGS_SRC}" "s3://${STATIC_BUCKET}/feature-flags.json" \
    --content-type "application/json" >/dev/null
  echo "  Seeded feature-flags.json (nested {local,prod} shape, local V2 flags enabled)."
else
  echo "  WARNING: ${FEATURE_FLAGS_SRC} not found, skipping feature-flags seed" >&2
fi

# ---------------------------------------------------------------------------
# d. Cognito: pool/client/group/seeded-admin per the shared UI contract.
# ---------------------------------------------------------------------------
echo "--- Setting up Cognito ..."

EXISTING_POOL=$(aws cognito-idp list-user-pools --max-results 20 \
  --query "UserPools[?Name=='groov-local'].Id | [0]" --output text 2>/dev/null || echo "None")

if [ "$EXISTING_POOL" != "None" ] && [ -n "$EXISTING_POOL" ]; then
  POOL_ID="$EXISTING_POOL"
  echo "  User pool groov-local already exists ($POOL_ID), reusing"
  CLIENT_ID=$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL_ID" \
    --query "UserPoolClients[?ClientName=='groov-web'].ClientId | [0]" --output text)
else
  POOL_ID=$(aws cognito-idp create-user-pool --pool-name groov-local --query UserPool.Id --output text)
  CLIENT_ID=$(aws cognito-idp create-user-pool-client --user-pool-id "$POOL_ID" --client-name groov-web \
    --explicit-auth-flows ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH \
    --query UserPoolClient.ClientId --output text)
  aws cognito-idp create-group --user-pool-id "$POOL_ID" --group-name Admin >/dev/null
  aws cognito-idp admin-create-user --user-pool-id "$POOL_ID" --username admin@groov.local --message-action SUPPRESS \
    --user-attributes Name=email,Value=admin@groov.local Name=email_verified,Value=true \
      Name=given_name,Value=Admin Name=family_name,Value=User Name=name,Value="Admin User" >/dev/null
  aws cognito-idp admin-set-user-password --user-pool-id "$POOL_ID" --username admin@groov.local \
    --password 'GroovLocal1!' --permanent >/dev/null
  aws cognito-idp admin-add-user-to-group --user-pool-id "$POOL_ID" --username admin@groov.local --group-name Admin >/dev/null
  echo "  Created user pool $POOL_ID, client $CLIENT_ID, group Admin, user admin@groov.local"
fi

COGNITO_ISSUER="${BROWSER_URL}/${POOL_ID}"

# ---------------------------------------------------------------------------
# e (part 1). Publish the shared Lambda layers.
#
#    groov-python-v2-deps: requests + pydantic + groov_models (the V2 shared
#    schema module, template.yaml's PythonV2Layer ~L82) + python-jose (used
#    only by adminAuthorizer.py). Pre-built at layers/python-v2/layer.zip by
#    running `pip install -r requirements.txt -t python/` INSIDE the
#    public.ecr.aws/lambda/python:3.13 base image (so wheels match the
#    container Lambda arch regardless of host) -- see
#    layers/python-v2/build.sh for the exact command to rebuild it.
#
#    groov-rdkit: rdkit + numpy + Pillow (manylinux2014_aarch64 cp312 wheels)
#    for updateFingerprintV2. Pre-built at layers/rdkit/layer.zip -- see
#    layers/rdkit/build.sh. Published via S3 (the zip is ~51MB, over the
#    Lambda API's 50MB direct-upload limit).
# ---------------------------------------------------------------------------
echo "--- Publishing Lambda layers ..."

PYV2_LAYER_ZIP="${WORKSPACE}/layers/python-v2/layer.zip"
if [ ! -f "$PYV2_LAYER_ZIP" ]; then
  echo "ERROR: $PYV2_LAYER_ZIP not found. Run layers/python-v2/build.sh first." >&2
  exit 1
fi
PYV2_LAYER_ARN=$(aws lambda publish-layer-version \
  --layer-name groov-python-v2-deps \
  --description "requests+pydantic+groov_models+python-jose for V2 Python functions" \
  --zip-file "fileb://${PYV2_LAYER_ZIP}" \
  --compatible-runtimes python3.13 \
  --query LayerVersionArn --output text)
echo "  $PYV2_LAYER_ARN"

RDKIT_LAYER_ZIP="${WORKSPACE}/layers/rdkit/layer.zip"
if [ ! -f "$RDKIT_LAYER_ZIP" ]; then
  echo "ERROR: $RDKIT_LAYER_ZIP not found. Run layers/rdkit/build.sh first." >&2
  exit 1
fi
aws s3 cp "$RDKIT_LAYER_ZIP" "s3://${DEPLOY_BUCKET}/rdkit-layer.zip" >/dev/null
RDKIT_LAYER_ARN=$(aws lambda publish-layer-version \
  --layer-name groov-rdkit \
  --description "rdkit+numpy+Pillow (aarch64 manylinux wheels) for updateFingerprintV2" \
  --content "S3Bucket=${DEPLOY_BUCKET},S3Key=rdkit-layer.zip" \
  --compatible-runtimes python3.12 \
  --query LayerVersionArn --output text)
echo "  $RDKIT_LAYER_ARN"

# ---------------------------------------------------------------------------
# e (part 2). Lambda functions -- all hot-reloaded from functions/<name> via
#    S3Bucket=hot-reload,S3Key=<HOST_ABS_PATH>. FunctionName == the
#    functions/<name> directory name throughout, for a 1:1 mapping (cosmetic
#    deviation from template.yaml's ${Env}-x-y-function naming, intentional
#    for local simplicity).
# ---------------------------------------------------------------------------
echo "--- Creating Lambda functions (hot-reload) ..."

env_vars() {
  # Builds an `--environment` shorthand value: Variables={K=V,K2=V2,...}
  local out="Variables={" first=1 kv
  for kv in "$@"; do
    [ "$first" -eq 0 ] && out="${out},"
    out="${out}${kv}"
    first=0
  done
  echo "${out}}"
}

create_fn() {
  # $1 name  $2 handler  $3 runtime  $4 timeout  $5 memory  $6 layer_arn (or "")  $7 env (from env_vars, or "Variables={}")
  local name="$1" handler="$2" runtime="$3" timeout="$4" memory="$5" layer_arn="$6" env="$7"
  local code_dir="${HOST_API_DIR}/functions/${name}"
  local layer_args=()
  [ -n "$layer_arn" ] && layer_args=(--layers "$layer_arn")

  if aws lambda get-function --function-name "$name" >/dev/null 2>&1; then
    echo "  $name already exists, updating code + config"
    aws lambda update-function-code --function-name "$name" \
      --s3-bucket hot-reload --s3-key "$code_dir" >/dev/null
    aws lambda update-function-configuration --function-name "$name" \
      --handler "$handler" --timeout "$timeout" --memory-size "$memory" \
      --environment "$env" "${layer_args[@]}" >/dev/null
  else
    aws lambda create-function --function-name "$name" \
      --runtime "$runtime" \
      --role arn:aws:iam::000000000000:role/lambda-role \
      --handler "$handler" \
      --code S3Bucket=hot-reload,S3Key="$code_dir" \
      --timeout "$timeout" --memory-size "$memory" \
      --architectures arm64 \
      "${layer_args[@]}" \
      --environment "$env" >/dev/null
    echo "  Created $name ($runtime, handler=$handler)"
  fi
}

# -- Admin authorizer (Python port of adminAuthorizer.js) --------------------
create_fn adminAuthorizer adminAuthorizer.handler python3.13 10 128 "$PYV2_LAYER_ARN" \
  "$(env_vars USER_POOL_ID="$POOL_ID" USER_POOL_CLIENT_ID="$CLIENT_ID" ADMIN_GROUP=Admin COGNITO_ISSUER="$COGNITO_ISSUER")"

# -- JWT-authorized routes -----------------------------------------------
# InsertFormV2Function (template.yaml ~L209)
create_fn insertFormV2 insertForm.lambda_handler python3.13 10 128 "$PYV2_LAYER_ARN" \
  "$(env_vars IS_LOCAL=true TEMP_TABLE_V2_NAME=GroovTempTableV2 PROD_TABLE_V2_NAME=groov_db_table_v2)"

# EditSensorV2Function (template.yaml ~L248) -- boto3 only, no shared layer needed
create_fn editSensorV2 editSensor.lambda_handler python3.13 10 128 "" \
  "$(env_vars IS_LOCAL=true PROD_TABLE_V2_NAME=groov_db_table_v2 PROCESSED_TEMP_TABLE_V2_NAME=GroovTempTableV2Processed)"

# DoiLookupV2Function (template.yaml ~L285) -- no env vars read by doiLookup.py
create_fn doiLookupV2 doiLookup.lambda_handler python3.13 15 256 "$PYV2_LAYER_ARN" "Variables={}"

# -- Admin-authorized routes -----------------------------------------------
# AddNewSensorV2Function (template.yaml ~L446)
create_fn addNewSensorV2 addNewSensor.lambda_handler python3.13 240 3008 "$PYV2_LAYER_ARN" \
  "$(env_vars IS_LOCAL=true TEMP_TABLE_V2_NAME=GroovTempTableV2 PROCESSED_TEMP_TABLE_V2_NAME=GroovTempTableV2Processed)"

# GetAllTempSensorsV2Function (template.yaml ~L963)
create_fn getAllTempSensorsV2 getAllTempSensors.lambda_handler python3.13 10 256 "" \
  "$(env_vars IS_LOCAL=true TEMP_TABLE_V2_NAME=GroovTempTableV2)"

# GetTempSensorV2Function (template.yaml ~L997)
create_fn getTempSensorV2 getTempSensor.lambda_handler python3.13 10 128 "" \
  "$(env_vars IS_LOCAL=true TEMP_TABLE_V2_NAME=GroovTempTableV2)"

# DeleteTempV2Function (template.yaml ~L1031)
create_fn deleteTempV2 deleteTemp.lambda_handler python3.13 10 128 "" \
  "$(env_vars IS_LOCAL=true TEMP_TABLE_V2_NAME=GroovTempTableV2)"

# GetAllProcessedTempV2Function (template.yaml ~L1065)
create_fn getAllProcessedTempV2 getAllProcessedTemp.lambda_handler python3.13 10 256 "" \
  "$(env_vars IS_LOCAL=true PROCESSED_TEMP_TABLE_V2_NAME=GroovTempTableV2Processed)"

# GetProcessedTempV2Function (template.yaml ~L1099)
create_fn getProcessedTempV2 getProcessedTemp.lambda_handler python3.13 10 128 "" \
  "$(env_vars IS_LOCAL=true PROCESSED_TEMP_TABLE_V2_NAME=GroovTempTableV2Processed)"

# ApproveProcessedSensorV2Function (template.yaml ~L1133). FINGERPRINT_LAMBDA_NAME
# is wired for real locally (scope addition: rdkit fingerprinting is no longer
# stubbed) -- points at the updateFingerprintV2 function created below.
create_fn approveProcessedSensorV2 approveProcessedSensor.lambda_handler python3.13 30 256 "" \
  "$(env_vars IS_LOCAL=true PROCESSED_TEMP_TABLE_V2_NAME=GroovTempTableV2Processed PROD_TABLE_V2_NAME=groov_db_table_v2 S3_BUCKET_NAME="$STATIC_BUCKET" FINGERPRINT_LAMBDA_NAME=updateFingerprintV2)"

# RejectProcessedSensorV2Function (template.yaml ~L1181)
create_fn rejectProcessedSensorV2 rejectProcessedSensor.lambda_handler python3.13 10 128 "" \
  "$(env_vars IS_LOCAL=true PROCESSED_TEMP_TABLE_V2_NAME=GroovTempTableV2Processed)"

# DeleteSensorV2Function (template.yaml ~L1215)
create_fn deleteSensorV2 deleteSensor.lambda_handler python3.13 30 256 "" \
  "$(env_vars IS_LOCAL=true PROD_TABLE_V2_NAME=groov_db_table_v2 S3_BUCKET_NAME="$STATIC_BUCKET" FINGERPRINT_LAMBDA_NAME=updateFingerprintV2)"

# -- Invoked-only (no HTTP route): UpdateFingerprintV2Function (template.yaml
#    ~L1260). Kept on python3.12 (its original template runtime) for rdkit
#    manylinux/aarch64 wheel availability -- see layers/rdkit/build.sh.
create_fn updateFingerprintV2 updateFingerprint.lambda_handler python3.12 120 512 "$RDKIT_LAYER_ARN" \
  "$(env_vars IS_LOCAL=true BUCKET_NAME="$STATIC_BUCKET")"

# ---------------------------------------------------------------------------
# f. HTTP API + integrations + routes + authorizers + stage
# ---------------------------------------------------------------------------
echo "--- Creating HTTP API ..."
API_ID=$(aws apigatewayv2 create-api --name groov-local --protocol-type HTTP --query ApiId --output text)
echo "  ApiId: $API_ID"

JWT_AUTHORIZER_ID=$(aws apigatewayv2 create-authorizer --api-id "$API_ID" --authorizer-type JWT \
  --identity-source '$request.header.Authorization' --name groov-jwt \
  --jwt-configuration Issuer="$COGNITO_ISSUER",Audience="$CLIENT_ID" \
  --query AuthorizerId --output text)
echo "  JWT authorizer: $JWT_AUTHORIZER_ID (issuer=$COGNITO_ISSUER)"

ADMIN_AUTHORIZER_ID=$(aws apigatewayv2 create-authorizer --api-id "$API_ID" --authorizer-type REQUEST \
  --identity-source '$request.header.Authorization' --name groov-admin \
  --authorizer-uri "arn:aws:apigateway:us-east-1:lambda:path/2015-03-31/functions/arn:aws:lambda:us-east-1:000000000000:function:adminAuthorizer/invocations" \
  --authorizer-payload-format-version 2.0 --enable-simple-responses \
  --query AuthorizerId --output text)
echo "  Admin (Lambda) authorizer: $ADMIN_AUTHORIZER_ID"

aws lambda add-permission --function-name adminAuthorizer \
  --statement-id apigw-invoke --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:us-east-1:000000000000:${API_ID}/*" >/dev/null 2>&1 || true

# Adds one authenticated route + one unauthenticated OPTIONS route (CORS
# preflight) for a single Lambda integration, and grants API Gateway
# permission to invoke it.
#   $1 fn name   $2 method   $3 path   $4 auth type ("JWT" | "CUSTOM" | "")
add_route() {
  local fn="$1" method="$2" path="$3" auth_type="$4"
  local fn_arn="arn:aws:lambda:us-east-1:000000000000:function:${fn}"
  local integration_id auth_args=()

  integration_id=$(aws apigatewayv2 create-integration --api-id "$API_ID" \
    --integration-type AWS_PROXY --integration-uri "$fn_arn" \
    --payload-format-version 2.0 --integration-method POST \
    --query IntegrationId --output text)

  if [ "$auth_type" = "JWT" ]; then
    auth_args=(--authorization-type JWT --authorizer-id "$JWT_AUTHORIZER_ID")
  elif [ "$auth_type" = "CUSTOM" ]; then
    auth_args=(--authorization-type CUSTOM --authorizer-id "$ADMIN_AUTHORIZER_ID")
  fi

  aws apigatewayv2 create-route --api-id "$API_ID" --route-key "${method} ${path}" \
    --target "integrations/${integration_id}" "${auth_args[@]}" >/dev/null
  aws apigatewayv2 create-route --api-id "$API_ID" --route-key "OPTIONS ${path}" \
    --target "integrations/${integration_id}" >/dev/null

  aws lambda add-permission --function-name "$fn" \
    --statement-id apigw-invoke --action lambda:InvokeFunction \
    --principal apigateway.amazonaws.com \
    --source-arn "arn:aws:execute-api:us-east-1:000000000000:${API_ID}/*" >/dev/null 2>&1 || true

  echo "  ${method} ${path} -> ${fn} (${auth_type:-none}) [+ OPTIONS ${path}]"
}

echo "--- Creating routes (exactly the 12 V2 routes) ..."
# JWT authorizer routes
add_route insertFormV2   POST /v2/insertForm JWT
add_route editSensorV2   POST /v2/editSensor  JWT
add_route doiLookupV2    GET  /v2/doiLookup   JWT
# Admin (Lambda) authorizer routes
add_route getAllTempSensorsV2      GET  /v2/getAllTempSensors      CUSTOM
add_route getTempSensorV2          GET  /v2/getTempSensor          CUSTOM
add_route deleteTempV2             POST /v2/deleteTemp             CUSTOM
add_route getAllProcessedTempV2    GET  /v2/getAllProcessedTemp    CUSTOM
add_route getProcessedTempV2       GET  /v2/getProcessedTemp       CUSTOM
add_route addNewSensorV2           POST /v2/addNewSensor           CUSTOM
add_route approveProcessedSensorV2 POST /v2/approveProcessedSensor CUSTOM
add_route rejectProcessedSensorV2  POST /v2/rejectProcessedSensor  CUSTOM
add_route deleteSensorV2           POST /v2/deleteSensor           CUSTOM

aws apigatewayv2 create-stage --api-id "$API_ID" --stage-name dev --auto-deploy >/dev/null
echo "  Stage 'dev' deployed."

# ---------------------------------------------------------------------------
# g. Publish runtime values for the UI + print a summary
# ---------------------------------------------------------------------------
API_BASE="${BROWSER_URL}/execute-api/${API_ID}/dev"

cat > /shared/ui.env <<EOF
REACT_APP_API_BASE=${API_BASE}
REACT_APP_COGNITO_USER_POOL_ID=${POOL_ID}
REACT_APP_COGNITO_CLIENT_ID=${CLIENT_ID}
EOF

echo "=================================================================="
echo " groov-db-api local (Floci) provisioning complete"
echo "=================================================================="
echo " API base:        ${API_BASE}"
echo " Cognito pool:     ${POOL_ID}  (client ${CLIENT_ID})"
echo " Cognito issuer:   ${COGNITO_ISSUER}"
echo " Seeded admin:     admin@groov.local / GroovLocal1!  (group: Admin)"
echo " Static bucket:    ${STATIC_BUCKET}  (public-read, path-style)"
echo "   base URL:       ${BROWSER_URL}/${STATIC_BUCKET}"
echo "   seeded keys:    v2/index.json, v2/indexes/<family>.json,"
echo "                   v2/sensors/<family>/<GRV-ID>.json, v2/all-sensors.json,"
echo "                   feature-flags.json"
echo " Wrote /shared/ui.env:"
sed 's/^/   /' /shared/ui.env
echo "=================================================================="
