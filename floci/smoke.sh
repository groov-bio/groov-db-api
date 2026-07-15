#!/usr/bin/env bash
#
# floci/smoke.sh — smoke test for the local groov-db-api stack.
#
# HOW TO RUN
#   1. Bring the local stack up (Floci / docker compose) and let
#      provisioning finish, so the `floci_shared` docker volume has been
#      populated with `ui.env` and the seeded Cognito users exist.
#   2. From the repo root:
#         bash floci/smoke.sh
#
# Requires: bash, curl, docker (to read the shared volume). Uses `jq` for
# JSON parsing if present, otherwise falls back to `python3`. The
# wrong-audience negative-matrix check additionally uses the `aws` CLI if
# present (see NEGATIVE MATRIX (c) below); it degrades to a clearly-marked
# TODO/SKIP if `aws` isn't available or the pool only has one app client.
#
# WHAT THIS DOES
#   1. Reads REACT_APP_API_BASE / REACT_APP_COGNITO_CLIENT_ID /
#      REACT_APP_COGNITO_USER_POOL_ID from the floci_shared volume's
#      ui.env.
#   2. Logs in as the seeded admin (admin@groov.local) via Cognito
#      InitiateAuth (USER_PASSWORD_AUTH) and gets an ID token.
#   3. HAPPY PATH: hits all 12 V2 routes with that admin token.
#        - GET routes: asserts a 2xx response.
#        - POST routes: asserts the response is NOT 401/403. These
#          endpoints validate their body (Pydantic), so an empty `{}`
#          body legitimately 400/422s — that still proves the request got
#          *past* the authorizer, which is what this check is for. Routes
#          are labelled below so it's clear which kind of assertion
#          applies to which.
#   4. NEGATIVE MATRIX: on one representative JWT route
#      (GET /v2/doiLookup) and one representative ADMIN route
#      (GET /v2/getAllTempSensors), asserts 401/403 for: no auth header,
#      a garbage token, a wrong-audience token (if mintable), and a
#      valid-but-non-admin user token against the ADMIN route.
#   5. Prints a PASS/FAIL line per assertion and a summary; exits
#      non-zero if anything failed.
#
# ASSUMPTIONS (see report back to orchestrator for the full list):
#   - GET /v2/doiLookup, /v2/getTempSensor, /v2/getProcessedTemp are
#     called with no query parameters. If the live handlers require one
#     (e.g. a doi/id) to return a real 2xx, those specific checks may
#     fail here even though auth is working correctly — that's a
#     query-param gap in this script, not an auth regression. Not
#     guessing param names since they aren't documented in the task
#     facts; flagging instead.
#   - LocalStack Cognito is reachable at http://localhost:4566.
#   - The `aws` CLI (if used for the wrong-audience check) authenticates
#     against LocalStack with the conventional dummy credentials
#     (AWS_ACCESS_KEY_ID=test / AWS_SECRET_ACCESS_KEY=test); real
#     credentials in the environment are used instead if already set.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COGNITO_ENDPOINT="http://localhost:4566"
ADMIN_USERNAME="admin@groov.local"
ADMIN_PASSWORD="GroovLocal1!"
NONADMIN_USERNAME="user@groov.local"
NONADMIN_PASSWORD="GroovLocal1!"
CURL_MAX_TIME=15

PASS_COUNT=0
FAIL_COUNT=0
RESULTS=()

record() {
  local status="$1" name="$2"
  RESULTS+=("${status}|${name}")
  if [[ "$status" == "PASS" ]]; then
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
  echo "[$status] $name"
}

fail_hard() {
  echo "FATAL: $1" >&2
  echo ""
  echo "== Summary =="
  echo "Passed: $PASS_COUNT  Failed: $((FAIL_COUNT + 1))"
  exit 1
}

# ---------------------------------------------------------------------------
# JSON helpers: prefer jq, fall back to python3.
# ---------------------------------------------------------------------------

have_jq() { command -v jq >/dev/null 2>&1; }
have_python3() { command -v python3 >/dev/null 2>&1; }

# Extract AuthenticationResult.IdToken from a Cognito InitiateAuth response.
extract_id_token() {
  local json="$1"
  if have_jq; then
    echo "$json" | jq -r '.AuthenticationResult.IdToken // empty' 2>/dev/null
  elif have_python3; then
    python3 -c '
import json, sys
try:
    d = json.loads(sys.argv[1])
    print(d.get("AuthenticationResult", {}).get("IdToken", "") or "")
except Exception:
    print("")
' "$json"
  else
    echo ""
  fi
}

# Extract a short error message/code from a Cognito error response, for
# clearer failure output.
extract_cognito_error() {
  local json="$1"
  if have_jq; then
    echo "$json" | jq -r '(.__type // "UnknownError") + ": " + (.message // "")' 2>/dev/null
  elif have_python3; then
    python3 -c '
import json, sys
try:
    d = json.loads(sys.argv[1])
    err_type = d.get("__type", "UnknownError")
    message = d.get("message", "")
    print(f"{err_type}: {message}")
except Exception:
    print("could not parse error body")
' "$json"
  else
    echo "$json"
  fi
}

# ---------------------------------------------------------------------------
# Step 1: read API base + Cognito ids from the floci_shared volume.
# ---------------------------------------------------------------------------

echo "== Step 1: reading floci_shared/ui.env =="

if ! command -v docker >/dev/null 2>&1; then
  fail_hard "docker is not available - cannot read the floci_shared volume"
fi

UI_ENV="$(docker run --rm -v groov-db-api_floci_shared:/s alpine cat /s/ui.env 2>/dev/null)"
if [[ -z "$UI_ENV" ]]; then
  fail_hard "could not read /s/ui.env from the groov-db-api_floci_shared volume - is the stack up and has provisioning finished? (docker run --rm -v groov-db-api_floci_shared:/s alpine cat /s/ui.env)"
fi

get_env_value() {
  local key="$1"
  echo "$UI_ENV" | grep "^${key}=" | head -n1 | cut -d= -f2-
}

API_BASE="$(get_env_value REACT_APP_API_BASE)"
CLIENT_ID="$(get_env_value REACT_APP_COGNITO_CLIENT_ID)"
USER_POOL_ID="$(get_env_value REACT_APP_COGNITO_USER_POOL_ID)"

if [[ -z "$API_BASE" || -z "$CLIENT_ID" || -z "$USER_POOL_ID" ]]; then
  echo "ui.env contents was:" >&2
  echo "$UI_ENV" >&2
  fail_hard "ui.env is missing REACT_APP_API_BASE / REACT_APP_COGNITO_CLIENT_ID / REACT_APP_COGNITO_USER_POOL_ID"
fi

# Strip any trailing slash so route paths (which start with /) join cleanly.
API_BASE="${API_BASE%/}"

echo "  API_BASE=$API_BASE"
echo "  CLIENT_ID=$CLIENT_ID"
echo "  USER_POOL_ID=$USER_POOL_ID"

# ---------------------------------------------------------------------------
# Step 2: log in as admin.
# ---------------------------------------------------------------------------

echo ""
echo "== Step 2: admin login (InitiateAuth) =="

cognito_login() {
  local username="$1" password="$2" client_id="$3"
  curl -sS --max-time "$CURL_MAX_TIME" -X POST "${COGNITO_ENDPOINT}/" \
    -H 'Content-Type: application/x-amz-json-1.1' \
    -H 'X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth' \
    -d "{\"AuthFlow\":\"USER_PASSWORD_AUTH\",\"ClientId\":\"${client_id}\",\"AuthParameters\":{\"USERNAME\":\"${username}\",\"PASSWORD\":\"${password}\"}}"
}

ADMIN_LOGIN_RESP="$(cognito_login "$ADMIN_USERNAME" "$ADMIN_PASSWORD" "$CLIENT_ID")"
ADMIN_TOKEN="$(extract_id_token "$ADMIN_LOGIN_RESP")"

if [[ -z "$ADMIN_TOKEN" ]]; then
  fail_hard "could not obtain an ID token for ${ADMIN_USERNAME}: $(extract_cognito_error "$ADMIN_LOGIN_RESP")"
fi
echo "  got admin ID token (${#ADMIN_TOKEN} chars)"

# ---------------------------------------------------------------------------
# HTTP helper.
# ---------------------------------------------------------------------------

# http_status METHOD PATH AUTH_HEADER_VALUE_OR_EMPTY [BODY]
# Returns just the numeric HTTP status code (or 000 on a curl-level
# failure, e.g. connection refused).
http_status() {
  local method="$1" path="$2" auth="$3" body="${4:-}"
  local args=(-sS --max-time "$CURL_MAX_TIME" -o /dev/null -w '%{http_code}' -X "$method" "${API_BASE}${path}")
  if [[ -n "$auth" ]]; then
    args+=(-H "Authorization: ${auth}")
  fi
  if [[ -n "$body" ]]; then
    args+=(-H "Content-Type: application/json" -d "$body")
  fi
  curl "${args[@]}" 2>/dev/null || echo "000"
}

is_2xx() { [[ "$1" =~ ^2[0-9][0-9]$ ]]; }
is_401_or_403() { [[ "$1" == "401" || "$1" == "403" ]]; }

# ---------------------------------------------------------------------------
# Step 3: happy path - all 12 V2 routes with the admin token.
# ---------------------------------------------------------------------------

echo ""
echo "== Step 3: happy path (12 V2 routes, admin token) =="

# GET routes with NO required query param - full 2xx expected.
GET_2XX_ROUTES=(
  "/v2/getAllTempSensors"
  "/v2/getAllProcessedTemp"
)

# GET routes that REQUIRE a query param (doi / submissionUUID / id) to return
# 2xx. Called here with no query string, so they legitimately return 400 once
# auth clears - so treat them as auth-only checks (like the POSTs below): a
# non-401/403 response proves the request cleared the authorizer, which is what
# this suite guards. A full happy-path 2xx would need seeded known ids or an
# outbound DOI lookup - out of scope for a deterministic auth smoke.
GET_AUTHONLY_ROUTES=(
  "/v2/doiLookup"
  "/v2/getTempSensor"
  "/v2/getProcessedTemp"
)

# POST routes: auth-only checks. An empty JSON body will typically fail
# Pydantic validation (400/422) - that is a PASS here, because it proves
# the request cleared the authorizer. Only 401/403 counts as a failure.
POST_ROUTES=(
  "/v2/insertForm"
  "/v2/editSensor"
  "/v2/deleteTemp"
  "/v2/addNewSensor"
  "/v2/approveProcessedSensor"
  "/v2/rejectProcessedSensor"
  "/v2/deleteSensor"
)

for route in "${GET_2XX_ROUTES[@]}"; do
  code="$(http_status GET "$route" "$ADMIN_TOKEN")"
  if is_2xx "$code"; then
    record PASS "GET ${route} -> ${code} (2xx)"
  else
    record FAIL "GET ${route} -> ${code} (expected 2xx)"
  fi
done

for route in "${GET_AUTHONLY_ROUTES[@]}"; do
  code="$(http_status GET "$route" "$ADMIN_TOKEN")"
  if ! is_401_or_403 "$code"; then
    record PASS "GET ${route} -> ${code} (auth passed; needs query param for 2xx)"
  else
    record FAIL "GET ${route} -> ${code} (expected auth to pass, got 401/403)"
  fi
done

for route in "${POST_ROUTES[@]}"; do
  code="$(http_status POST "$route" "$ADMIN_TOKEN" '{}')"
  if ! is_401_or_403 "$code"; then
    record PASS "POST ${route} -> ${code} (auth passed, i.e. not 401/403)"
  else
    record FAIL "POST ${route} -> ${code} (expected auth to pass, got 401/403)"
  fi
done

# ---------------------------------------------------------------------------
# Step 4: negative matrix on one representative JWT route and one
# representative ADMIN route.
# ---------------------------------------------------------------------------

echo ""
echo "== Step 4: negative matrix =="

JWT_ROUTE="/v2/doiLookup"           # representative CognitoJwtAuthorizer route
ADMIN_ROUTE="/v2/getAllTempSensors" # representative AdminAuthorizer route

# (a) no Authorization header.
code="$(http_status GET "$JWT_ROUTE" "")"
if is_401_or_403 "$code"; then
  record PASS "JWT route (${JWT_ROUTE}), no auth header -> ${code}"
else
  record FAIL "JWT route (${JWT_ROUTE}), no auth header -> ${code} (expected 401/403)"
fi

code="$(http_status GET "$ADMIN_ROUTE" "")"
if is_401_or_403 "$code"; then
  record PASS "ADMIN route (${ADMIN_ROUTE}), no auth header -> ${code}"
else
  record FAIL "ADMIN route (${ADMIN_ROUTE}), no auth header -> ${code} (expected 401/403)"
fi

# (b) malformed / garbage token.
GARBAGE_TOKEN="not-a-real.jwt-token.garbage-value"

code="$(http_status GET "$JWT_ROUTE" "$GARBAGE_TOKEN")"
if is_401_or_403 "$code"; then
  record PASS "JWT route (${JWT_ROUTE}), garbage token -> ${code}"
else
  record FAIL "JWT route (${JWT_ROUTE}), garbage token -> ${code} (expected 401/403)"
fi

code="$(http_status GET "$ADMIN_ROUTE" "$GARBAGE_TOKEN")"
if is_401_or_403 "$code"; then
  record PASS "ADMIN route (${ADMIN_ROUTE}), garbage token -> ${code}"
else
  record FAIL "ADMIN route (${ADMIN_ROUTE}), garbage token -> ${code} (expected 401/403)"
fi

# (c) wrong-audience token. Feasible only if the user pool has a second
# app client we can mint against; discovered via `aws cognito-idp
# list-user-pool-clients`. If that's not possible, this is left as a
# clearly-marked TODO rather than guessed/faked.
OTHER_CLIENT_ID=""
if command -v aws >/dev/null 2>&1; then
  CLIENTS_JSON="$(AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}" AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}" AWS_REGION="${AWS_REGION:-us-east-1}" \
    aws cognito-idp list-user-pool-clients --user-pool-id "$USER_POOL_ID" --endpoint-url "$COGNITO_ENDPOINT" --output json 2>/dev/null || true)"
  if [[ -n "$CLIENTS_JSON" ]]; then
    if have_jq; then
      OTHER_CLIENT_ID="$(echo "$CLIENTS_JSON" | jq -r --arg cid "$CLIENT_ID" '[.UserPoolClients[].ClientId] | map(select(. != $cid)) | .[0] // empty' 2>/dev/null)"
    elif have_python3; then
      OTHER_CLIENT_ID="$(python3 -c '
import json, sys
try:
    d = json.loads(sys.argv[1])
    cid = sys.argv[2]
    for c in d.get("UserPoolClients", []):
        if c.get("ClientId") != cid:
            print(c["ClientId"])
            break
except Exception:
    pass
' "$CLIENTS_JSON" "$CLIENT_ID")"
    fi
  fi
fi

if [[ -n "$OTHER_CLIENT_ID" ]]; then
  OTHER_LOGIN_RESP="$(cognito_login "$ADMIN_USERNAME" "$ADMIN_PASSWORD" "$OTHER_CLIENT_ID")"
  WRONG_AUD_TOKEN="$(extract_id_token "$OTHER_LOGIN_RESP")"
  if [[ -n "$WRONG_AUD_TOKEN" ]]; then
    code="$(http_status GET "$JWT_ROUTE" "$WRONG_AUD_TOKEN")"
    if is_401_or_403 "$code"; then
      record PASS "JWT route (${JWT_ROUTE}), wrong-audience token (client ${OTHER_CLIENT_ID}) -> ${code}"
    else
      record FAIL "JWT route (${JWT_ROUTE}), wrong-audience token (client ${OTHER_CLIENT_ID}) -> ${code} (expected 401/403)"
    fi
  else
    echo "SKIP: found a second app client (${OTHER_CLIENT_ID}) but could not mint a token against it for ${ADMIN_USERNAME}: $(extract_cognito_error "$OTHER_LOGIN_RESP")"
  fi
else
  cat <<'TODO'
TODO (wrong-audience check not run): could not discover a second Cognito
app client for this user pool via `aws cognito-idp list-user-pool-clients`
(either the `aws` CLI is unavailable, or the pool genuinely only has the
one app client that ui.env publishes). Reasoning: the JWT authorizer
(template.yaml CognitoJwtAuthorizer) validates the token's `aud` claim
against UserPoolClientId; producing a token with a different `aud` requires
a real InitiateAuth call against a *different, real* app client in the same
pool - hand-crafting/forging a JWT would not exercise the real
Cognito-issuance path this authorizer expects, so it isn't a substitute.
Revisit this check if/when a second app client is provisioned for local
dev (e.g. a "test-wrong-audience" client), or wire it up to create one as
part of provisioning.
TODO
fi

# (d) valid token for a non-admin user hitting an ADMIN route -> 403.
NONADMIN_LOGIN_RESP="$(cognito_login "$NONADMIN_USERNAME" "$NONADMIN_PASSWORD" "$CLIENT_ID")"
NONADMIN_TOKEN="$(extract_id_token "$NONADMIN_LOGIN_RESP")"

if [[ -z "$NONADMIN_TOKEN" ]]; then
  record FAIL "could not obtain an ID token for ${NONADMIN_USERNAME}: $(extract_cognito_error "$NONADMIN_LOGIN_RESP") (this user is expected to be seeded separately - see smoke.sh header / task CONTRACT; if it's missing, that's the seeding step's gap, not this script's)"
else
  code="$(http_status GET "$ADMIN_ROUTE" "$NONADMIN_TOKEN")"
  if [[ "$code" == "403" ]]; then
    record PASS "non-admin user (${NONADMIN_USERNAME}) on ADMIN route (${ADMIN_ROUTE}) -> 403"
  else
    record FAIL "non-admin user (${NONADMIN_USERNAME}) on ADMIN route (${ADMIN_ROUTE}) -> ${code} (expected 403)"
  fi
fi

# ---------------------------------------------------------------------------
# Summary.
# ---------------------------------------------------------------------------

echo ""
echo "== Summary =="
for r in "${RESULTS[@]}"; do
  status="${r%%|*}"
  name="${r#*|}"
  printf '  [%s] %s\n' "$status" "$name"
done
echo ""
echo "Passed: ${PASS_COUNT}  Failed: ${FAIL_COUNT}"

if [[ "$FAIL_COUNT" -gt 0 ]]; then
  exit 1
fi
exit 0
