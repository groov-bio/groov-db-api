# Python port of adminAuthorizer.js for the local (Floci) emulation stack.
#
# Behavior mirrors the Node handler (aws-jwt-verify + CognitoJwtVerifier):
#   - Verify the raw JWT's RS256 signature against the pool's JWKS.
#   - Require token_use == "id" (this authorizer only accepts ID tokens).
#   - Require the audience (aud, or client_id on access tokens) to match
#     USER_POOL_CLIENT_ID.
#   - Require the issuer to match COGNITO_ISSUER.
#   - Require ADMIN_GROUP to be present in the token's cognito:groups claim.
# On ANY failure (missing token, bad signature, expired, wrong pool/client,
# not an admin, network error fetching JWKS, ...) this returns
# {"isAuthorized": False} rather than raising, since API Gateway's REQUEST
# authorizer treats an unhandled exception as a 500, not a clean 401/403.
#
# JWT verification uses python-jose. The shared python-v2 Lambda layer
# installs python-jose WITHOUT the `cryptography` extra, so it falls back to
# its pure-Python RSA backend (jose.backends.rsa_backend, built on the pure-
# Python `rsa`/`pyasn1`/`ecdsa` packages) — this avoids the architecture-
# specific native wheels that `cryptography` (and PyJWT[crypto]) would need,
# which is what makes this safe to import inside the Floci Lambda container
# regardless of what host built the layer.

import json
import os
import urllib.request

from jose import jwt

# Process-lifetime JWKS cache, keyed by "<endpoint>/<userPoolId>". Floci/Lambda
# hot-reload starts a fresh container per invocation in some configurations,
# so this cache is a best-effort optimization (saves a round trip when the
# container is reused), not a correctness requirement.
_JWKS_CACHE = {}


def _jwks_url(endpoint, user_pool_id):
    return f"{endpoint}/{user_pool_id}/.well-known/jwks.json"


def _fetch_jwks(endpoint, user_pool_id):
    url = _jwks_url(endpoint, user_pool_id)
    with urllib.request.urlopen(url, timeout=5) as resp:  # noqa: S310 (internal Floci endpoint only)
        return json.loads(resp.read())


def _get_jwks(endpoint, user_pool_id, force_refresh=False):
    cache_key = f"{endpoint}/{user_pool_id}"
    if force_refresh or cache_key not in _JWKS_CACHE:
        _JWKS_CACHE[cache_key] = _fetch_jwks(endpoint, user_pool_id)
    return _JWKS_CACHE[cache_key]


def _find_key(jwks, kid):
    for key in jwks.get("keys", []) or []:
        if key.get("kid") == kid:
            return key
    return None


def _get_token(event):
    headers = event.get("headers") or {}
    # HTTP API v2 lowercases header keys, but fall back to the capitalized
    # form for safety (e.g. direct Lambda invokes during testing).
    return headers.get("authorization") or headers.get("Authorization")


def _resolve_signing_key(token, endpoint, user_pool_id):
    unverified_header = jwt.get_unverified_header(token)
    kid = unverified_header.get("kid")
    if not kid:
        return None

    jwks = _get_jwks(endpoint, user_pool_id)
    key = _find_key(jwks, kid)
    if key is not None:
        return key

    # kid not found: could be a stale cache after key rotation. Refresh once
    # and retry before giving up.
    jwks = _get_jwks(endpoint, user_pool_id, force_refresh=True)
    return _find_key(jwks, kid)


def handler(event, context=None):
    try:
        token = _get_token(event)
        if not token:
            return {"isAuthorized": False}

        endpoint = os.environ.get("AWS_ENDPOINT_URL")
        user_pool_id = os.environ.get("USER_POOL_ID")
        client_id = os.environ.get("USER_POOL_CLIENT_ID")
        admin_group = os.environ.get("ADMIN_GROUP")
        issuer = os.environ.get("COGNITO_ISSUER")

        if not endpoint or not user_pool_id or not client_id or not issuer:
            print("adminAuthorizer: missing required env var(s)")
            return {"isAuthorized": False}

        signing_key = _resolve_signing_key(token, endpoint, user_pool_id)
        if signing_key is None:
            print("adminAuthorizer: no matching JWKS key for token 'kid'")
            return {"isAuthorized": False}

        # jwt.decode verifies the RS256 signature and, because audience/issuer
        # are passed, also verifies the aud and iss claims — any mismatch (or
        # a bad signature, or expiry) raises and is caught below.
        claims = jwt.decode(
            token,
            signing_key,
            algorithms=["RS256"],
            audience=client_id,
            issuer=issuer,
        )

        if claims.get("token_use") != "id":
            return {"isAuthorized": False}

        # Belt-and-suspenders: decode() above already enforced aud==client_id
        # for ID tokens; also accept the access-token-style `client_id` claim
        # shape in case this authorizer is ever pointed at one.
        token_client_id = claims.get("aud") or claims.get("client_id")
        if token_client_id != client_id:
            return {"isAuthorized": False}

        groups = claims.get("cognito:groups") or []
        if admin_group not in groups:
            return {"isAuthorized": False}

        return {"isAuthorized": True}
    except Exception as err:  # noqa: BLE001 — never throw from an authorizer
        print(f"adminAuthorizer error: {err}")
        return {"isAuthorized": False}
