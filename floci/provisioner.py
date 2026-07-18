#!/usr/bin/env python3
"""
floci/provisioner.py

Derives the local Floci (LocalStack-community-compatible) stack for
groov-db-api's V2 API directly from template.yaml -- the single source of
truth -- instead of hand-mirroring it in a parallel shell script. Replaces
the old floci/provision.sh.

DERIVE, DON'T MIRROR
---------------------
template.yaml is parsed with PyYAML + tiny constructors that turn the CFN
intrinsics used in this template (!Ref, !Sub, !GetAtt) into marker objects
(Ref/Sub/GetAtt below). A resolver then evaluates those intrinsics against a
symbol table = local parameter values (floci/local_parameters.json) + the
physical names/ARNs of resources this provisioner itself creates locally +
three pseudo-parameters (AWS::Region=us-east-1, AWS::AccountId=000000000000,
AWS::Partition=aws).

Anything the resolver can't map -- a Ref/GetAtt/Sub token with no entry in
the symbol table -- raises DriftError and the whole run aborts. That failure
IS the drift alarm: it means template.yaml changed in a way this derive
doesn't understand yet, and it is never silently skipped.

SCOPE
-----
"In scope" = every AWS::Serverless::Function with a Python Runtime and at
least one HttpApi Event whose Path starts with "/v2/", PLUS anything
transitively reachable from those functions (and from the HttpApi's Auth
block) via !Ref/!GetAtt. This is computed generically by walking Properties
trees (see compute_scope) -- there is no hardcoded function list. It happens
to pull in exactly: the 12 V2 route functions, AdminAuthorizerFunction (via
GroovApi's Auth.AdminAuthorizer.FunctionArn), and UpdateFingerprintV2Function
(via FINGERPRINT_LAMBDA_NAME on the approve/delete functions). V1/Node
functions (docs, contactForm, ligandSearch, ligifyLigandSearch, ligifyBlast,
getOperon) fall out naturally because they have no /v2/* route and nothing
in scope references them.

LOCAL OVERLAY (the only places local semantics deliberately differ from
template.yaml -- everything else is derived as-is)
-----------------------------------------------------------------------
  - IS_LOCAL=true injected into every provisioned function's Environment.
  - FunctionName = the functions/<dir> basename (CodeUri's last path
    component), not the template's ${Env}-x-y-function naming.
  - Code = hot-reload (S3Bucket=hot-reload, S3Key=<HOST_API_DIR>/functions/<dir>).
  - Runtime kept as template-declares, EXCEPT AdminAuthorizerFunction: the
    template has it as nodejs24.x, but locally it's a Python port -- runtime
    is overridden to python3.14, with a fully-overridden Environment
    ({USER_POOL_ID, USER_POOL_CLIENT_ID, ADMIN_GROUP, COGNITO_ISSUER}; the
    template's Node env used REGION instead of COGNITO_ISSUER -- deliberate
    local fork) and the python-v2 layer instead of the template's NodeLayer.
  - Architecture: host arch (uname -m) for every function, overriding
    whatever Architectures the template declares (this is why the old
    mirror created updateFingerprintV2 as arm64 when the template says
    x86_64 -- it must be host-arch locally).
  - Layers: PythonV2Layer -> locally-published groov-python-v2-deps.
    UpdateFingerprintV2Function's template Layers entry (!Ref PythonLayer)
    is overridden to the local rdkit stand-in (groov-rdkit) instead --
    the generic prod PythonLayer content isn't what a local rdkit build
    needs. Prod PythonLayer/NodeLayer are otherwise NOT provisioned (their
    other consumers -- docs, contactForm, getOperon, ligandSearch,
    ligifyLigandSearch -- are out of scope).
  - R2 -> S3 stand-in: the template's R2_* env vars have no local
    counterpart. For ApproveProcessedSensorV2Function and
    DeleteSensorV2Function, the four R2_* vars are dropped and
    S3_BUCKET_NAME=groov-local-static is added. For
    UpdateFingerprintV2Function, the four R2_* vars are dropped and
    BUCKET_NAME=groov-local-static is added (yes, a different var name --
    that's what updateFingerprint.py reads).
  - JWT authorizer issuer is the LOCAL Floci issuer
    http://localhost:4566/<poolId>, not the template's real Cognito issuer
    (Floci issues tokens with the localhost issuer). Audience = clientId.
    AdminAuthorizerFunction's COGNITO_ISSUER env uses the same local issuer.
  - DynamoDB tables live in us-east-2 (every V2 handler hardcodes
    region_name="us-east-2"); API Gateway / Cognito / Lambda stay
    us-east-1. Floci scopes DynamoDB per-region, so this split is load
    bearing, not cosmetic.

BOOTSTRAP (no template.yaml counterpart -- explicit local code)
-----------------------------------------------------------------
Cognito pool/client/group/seeded users, the groov_db_table_v2 prod table
(created outside SAM in the real stack), the two S3 buckets, and
/shared/ui.env are not in template.yaml at all and are created directly by
this script. See bootstrap_cognito(), upsert_bucket(), and the `apply()`
orchestration below.

IDEMPOTENCY
-----------
Every create_* call here is really a get-or-create: tables/buckets/pool
reused if present, Lambda functions get update-function-code +
update-function-configuration if they exist, layer publishing is skipped
when the zip's sha256 is unchanged (hash stashed as a marker object in
groov-local-deploy), and the HTTP API is looked up by name and reused --
routes/integrations/authorizers are reconciled rather than recreated. This
is what makes `docker compose up floci-init` a safe re-sync instead of
requiring `down -v && up`.
"""

import argparse
import decimal
import hashlib
import json
import os
import platform
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import yaml
from botocore.exceptions import ClientError

WORKSPACE = Path(os.environ.get("WORKSPACE", "/workspace"))
TEMPLATE_PATH = WORKSPACE / "template.yaml"
LOCAL_PARAMETERS_PATH = Path(__file__).resolve().parent / "local_parameters.json"
HOST_API_DIR = os.environ.get("HOST_API_DIR", "")

PSEUDO_PARAMS = {
    "AWS::Region": "us-east-1",
    "AWS::AccountId": "000000000000",
    "AWS::Partition": "aws",
}

DDB_REGION = "us-east-2"   # V2 handlers hardcode region_name="us-east-2"
API_REGION = "us-east-1"   # API Gateway / Cognito / Lambda
STATIC_BUCKET = "groov-local-static"
DEPLOY_BUCKET = "groov-local-deploy"
PROD_TABLE_NAME = "groov_db_table_v2"   # bootstrap-only; not in template.yaml
API_NAME = "groov-local"
SEED_PASSWORD = "GroovLocal1!"

# Locally-published layer definitions. Keys are tokens used by
# FUNCTION_LAYER_OVERRIDE and function_layers(); "PythonV2Layer" also
# doubles as the logical LayerVersion id it's derived from.
LAYER_DEFS = {
    "PythonV2Layer": {
        "layer_name": "groov-python-v2-deps",
        "zip_path": "layers/python-v2/layer.zip",
        "compatible_runtimes": ["python3.14"],
        "description": "requests+pydantic+groov_models+python-jose for V2 Python functions",
        "staged_via_s3": False,
    },
    "__RDKIT__": {
        "layer_name": "groov-rdkit",
        "zip_path": "layers/rdkit/layer.zip",
        "compatible_runtimes": ["python3.12"],
        "description": "rdkit+numpy+Pillow (host-arch manylinux wheels) for updateFingerprintV2",
        "staged_via_s3": True,   # zip is >50MB, over the Lambda API's direct-upload limit
    },
}

# Named local-overlay exceptions: these two functions' template Layers refs
# (NodeLayer, PythonLayer respectively) are deliberately NOT what gets
# attached locally -- see module docstring.
FUNCTION_LAYER_OVERRIDE = {
    "AdminAuthorizerFunction": ["PythonV2Layer"],
    "UpdateFingerprintV2Function": ["__RDKIT__"],
}

R2_ENV_KEYS = {"R2_BUCKET_NAME", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_ENDPOINT"}

# Per-function R2->S3 local overlay: which var replaces the dropped R2_* block.
R2_OVERLAY = {
    "ApproveProcessedSensorV2Function": {"S3_BUCKET_NAME": STATIC_BUCKET},
    "DeleteSensorV2Function": {"S3_BUCKET_NAME": STATIC_BUCKET},
    "UpdateFingerprintV2Function": {"BUCKET_NAME": STATIC_BUCKET},
}

PLAN_PLACEHOLDERS = {
    "pool_id": "<bootstrap:UserPoolId>",
    "client_id": "<bootstrap:UserPoolClientId>",
    "layer_arns": {
        "PythonV2Layer": "<publish:groov-python-v2-deps>",
        "__RDKIT__": "<publish:groov-rdkit>",
    },
}


class DriftError(RuntimeError):
    """Raised when template.yaml references a symbol this derive doesn't
    know how to resolve. This IS the drift alarm -- never caught and
    skipped, only ever surfaced and aborted on."""


# ---------------------------------------------------------------------------
# YAML loading: turn the three CFN intrinsics this template actually uses
# into marker objects.
# ---------------------------------------------------------------------------
class Ref:
    def __init__(self, name):
        self.name = name

    def __repr__(self):
        return f"Ref({self.name})"


class GetAtt:
    def __init__(self, target):
        if isinstance(target, str):
            logical_id, _, attr = target.partition(".")
        else:
            logical_id, attr = target[0], target[1]
        self.logical_id = logical_id
        self.attr = attr

    def __repr__(self):
        return f"GetAtt({self.logical_id}.{self.attr})"


class Sub:
    def __init__(self, value):
        self.value = value

    def __repr__(self):
        return f"Sub({self.value!r})"


def _construct_ref(loader, node):
    return Ref(loader.construct_scalar(node))


def _construct_getatt(loader, node):
    if isinstance(node, yaml.ScalarNode):
        return GetAtt(loader.construct_scalar(node))
    return GetAtt(loader.construct_sequence(node))


def _construct_sub(loader, node):
    if isinstance(node, yaml.ScalarNode):
        return Sub(loader.construct_scalar(node))
    # 2-arg !Sub [str, {vars}] form isn't used anywhere in template.yaml;
    # fail loudly rather than silently drop the variable map if it ever is.
    raise DriftError("2-arg !Sub form encountered but not supported by this derive")


class CfnLoader(yaml.SafeLoader):
    pass


CfnLoader.add_constructor("!Ref", _construct_ref)
CfnLoader.add_constructor("!GetAtt", _construct_getatt)
CfnLoader.add_constructor("!Sub", _construct_sub)


def load_template():
    with open(TEMPLATE_PATH) as f:
        template = yaml.load(f, Loader=CfnLoader)
    globals_fn = template.get("Globals", {}).get("Function", {})
    if globals_fn:
        for res in template["Resources"].values():
            if res.get("Type") == "AWS::Serverless::Function":
                props = res.setdefault("Properties", {})
                for k, v in globals_fn.items():
                    props.setdefault(k, v)
    return template


# ---------------------------------------------------------------------------
# Resolver
# ---------------------------------------------------------------------------
_SUB_TOKEN_RE = re.compile(r"\$\{([^}]+)\}")


def resolve(node, symbols, path="<root>"):
    """Recursively resolve Ref/GetAtt/Sub against `symbols`. Raises
    DriftError on any token not present in symbols -- never skips silently."""
    if isinstance(node, Ref):
        if node.name not in symbols:
            raise DriftError(f"{path}: unresolved !Ref {node.name}")
        return symbols[node.name]
    if isinstance(node, GetAtt):
        key = f"{node.logical_id}.{node.attr}"
        if key in symbols:
            return symbols[key]
        if node.logical_id in symbols:
            return symbols[node.logical_id]
        raise DriftError(f"{path}: unresolved !GetAtt {key}")
    if isinstance(node, Sub):
        def _replace(m):
            token = m.group(1).strip()
            if token in symbols:
                return str(symbols[token])
            if "." in token:
                logical_id, _, attr = token.partition(".")
                key = f"{logical_id}.{attr}"
                if key in symbols:
                    return str(symbols[key])
                if logical_id in symbols:
                    return str(symbols[logical_id])
            raise DriftError(f"{path}: unresolved !Sub token '{token}'")
        return _SUB_TOKEN_RE.sub(_replace, node.value)
    if isinstance(node, dict):
        return {k: resolve(v, symbols, f"{path}.{k}") for k, v in node.items()}
    if isinstance(node, list):
        return [resolve(v, symbols, f"{path}[{i}]") for i, v in enumerate(node)]
    return node


def collect_ref_tokens(node, out):
    """Lightweight walk (no symbol table needed) used only for scope
    discovery: collects every Ref/GetAtt/Sub target name referenced under
    `node`, whether it turns out to be a Parameter, a pseudo-param, or a
    Resource logical id."""
    if isinstance(node, Ref):
        out.add(node.name)
    elif isinstance(node, GetAtt):
        out.add(node.logical_id)
    elif isinstance(node, Sub):
        for m in _SUB_TOKEN_RE.finditer(node.value):
            out.add(m.group(1).strip().split(".")[0])
    elif isinstance(node, dict):
        for v in node.values():
            collect_ref_tokens(v, out)
    elif isinstance(node, list):
        for v in node:
            collect_ref_tokens(v, out)


# ---------------------------------------------------------------------------
# Scope
# ---------------------------------------------------------------------------
def is_v2_route_function(res):
    if res.get("Type") != "AWS::Serverless::Function":
        return False
    props = res.get("Properties", {})
    if not props.get("Runtime", "").startswith("python"):
        return False
    for ev in props.get("Events", {}).values():
        if ev.get("Type") == "HttpApi" and ev.get("Properties", {}).get("Path", "").startswith("/v2/"):
            return True
    return False


def compute_scope(template):
    resources = template["Resources"]
    seed = {lid for lid, res in resources.items() if is_v2_route_function(res)}
    visited = set(seed)
    frontier = list(seed)
    if "GroovApi" in resources:
        # Seed the HttpApi resource explicitly: every in-scope route's
        # ApiId: !Ref GroovApi would pull it in anyway, but seeding it
        # directly guarantees the Auth block (and thus AdminAuthorizerFunction)
        # is reached even if that weren't the case.
        frontier.append("GroovApi")
        visited.add("GroovApi")
    while frontier:
        lid = frontier.pop()
        res = resources.get(lid)
        if res is None:
            continue
        tokens = set()
        collect_ref_tokens(res.get("Properties", {}), tokens)
        for tok in tokens:
            if tok in resources and tok not in visited:
                visited.add(tok)
                frontier.append(tok)
    return {
        "route_functions": sorted(seed),
        "all_functions": sorted(
            lid for lid in visited if resources[lid]["Type"] == "AWS::Serverless::Function"
        ),
        "tables": sorted(
            lid for lid in visited if resources[lid]["Type"] == "AWS::DynamoDB::Table"
        ),
        "visited": visited,
    }


# ---------------------------------------------------------------------------
# Derive: tables, functions, routes, authorizers
# ---------------------------------------------------------------------------
def host_architecture():
    m = platform.machine().lower()
    if m in ("arm64", "aarch64"):
        return "arm64"
    if m in ("x86_64", "amd64"):
        return "x86_64"
    raise DriftError(f"Unrecognized host architecture: {m!r} (uname -m)")


def dir_name_of(props):
    return props["CodeUri"].rstrip("/").split("/")[-1]


def build_tables(template, base_symbols, scope):
    resources = template["Resources"]
    tables = []
    for lid in scope["tables"]:
        props = resources[lid]["Properties"]
        table_name = resolve(props["TableName"], base_symbols, path=f"{lid}.TableName")
        tables.append({
            "logical_id": lid,
            "table_name": table_name,
            "key_schema": props["KeySchema"],
            "attribute_definitions": props["AttributeDefinitions"],
            "billing_mode": props.get("BillingMode", "PAY_PER_REQUEST"),
            "bootstrap_only": False,
        })
    # groov_db_table_v2: created outside SAM in prod, has no template.yaml
    # resource. Key schema per the bootstrap contract: category (HASH) /
    # grv_id (RANGE).
    tables.append({
        "logical_id": "__bootstrap__ProdTableV2",
        "table_name": PROD_TABLE_NAME,
        "key_schema": [
            {"AttributeName": "category", "KeyType": "HASH"},
            {"AttributeName": "grv_id", "KeyType": "RANGE"},
        ],
        "attribute_definitions": [
            {"AttributeName": "category", "AttributeType": "S"},
            {"AttributeName": "grv_id", "AttributeType": "S"},
        ],
        "billing_mode": "PAY_PER_REQUEST",
        "bootstrap_only": True,
    })
    return tables


def function_layers(logical_id, props):
    if logical_id in FUNCTION_LAYER_OVERRIDE:
        return FUNCTION_LAYER_OVERRIDE[logical_id]
    tokens = []
    for l in props.get("Layers", []):
        if isinstance(l, Ref) and l.name in LAYER_DEFS:
            tokens.append(l.name)
        else:
            ref_name = l.name if isinstance(l, Ref) else repr(l)
            raise DriftError(
                f"{logical_id}: Layers entry '{ref_name}' has no local overlay mapping "
                "(add one to LAYER_DEFS/FUNCTION_LAYER_OVERRIDE)"
            )
    return tokens


def build_function_manifest(template, symbols, scope):
    resources = template["Resources"]
    arch = host_architecture()
    functions = {}
    for lid in scope["all_functions"]:
        props = resources[lid]["Properties"]
        if "CodeUri" not in props:
            raise DriftError(f"{lid}: no CodeUri (PackageType=Image functions are out of scope)")
        dir_name = dir_name_of(props)
        handler = props["Handler"]
        runtime = props["Runtime"]
        # AWS Lambda defaults when template.yaml omits these (as it does for
        # AdminAuthorizerFunction): Timeout=3s, MemorySize=128MB.
        timeout = props.get("Timeout", 3)
        memory_size = props.get("MemorySize", 128)

        if lid == "AdminAuthorizerFunction":
            runtime = "python3.14"   # template says nodejs24.x; locally it's the Python port
            env = {
                "USER_POOL_ID": symbols["UserPoolId"],
                "USER_POOL_CLIENT_ID": symbols["UserPoolClientId"],
                "ADMIN_GROUP": symbols["AdminGroup"],
                "COGNITO_ISSUER": symbols["__CognitoIssuer__"],
            }
        else:
            raw_vars = props.get("Environment", {}).get("Variables", {})
            # Drop R2_* keys pre-resolution for the functions with an R2->S3
            # overlay -- they have no local counterpart, so never try to
            # resolve them (that would be a spurious DriftError, not a real
            # drift signal).
            filtered = {
                k: v for k, v in raw_vars.items()
                if not (k in R2_ENV_KEYS and lid in R2_OVERLAY)
            }
            env = resolve(filtered, symbols, path=f"{lid}.Environment.Variables")
            if lid in R2_OVERLAY:
                env.update(R2_OVERLAY[lid])

        env["IS_LOCAL"] = "true"   # uniform local overlay, every function

        layer_tokens = function_layers(lid, props)
        layer_arns = [symbols[f"__layer_arn__:{t}"] for t in layer_tokens]

        functions[lid] = {
            "logical_id": lid,
            "function_name": dir_name,
            "dir": dir_name,
            "handler": handler,
            "runtime": runtime,
            "timeout": timeout,
            "memory_size": memory_size,
            "architecture": arch,
            "environment": env,
            "layer_tokens": layer_tokens,
            "layer_arns": layer_arns,
            "logging_config": props.get("LoggingConfig"),
        }
    return functions


AUTH_MAP = {"CognitoJwtAuthorizer": "JWT", "AdminAuthorizer": "ADMIN"}


def build_routes(template, scope):
    resources = template["Resources"]
    routes = []
    for lid in scope["route_functions"]:
        props = resources[lid]["Properties"]
        dir_name = dir_name_of(props)
        for ev in props.get("Events", {}).values():
            if ev.get("Type") != "HttpApi":
                continue
            ep = ev["Properties"]
            path = ep["Path"]
            if not path.startswith("/v2/"):
                continue
            authorizer = ep.get("Auth", {}).get("Authorizer")
            routes.append({
                "function": dir_name,
                "method": ep["Method"].upper(),
                "path": path,
                "auth": AUTH_MAP.get(authorizer, "NONE") if authorizer else "NONE",
            })
    return routes


def build_authorizers(template, symbols):
    props = template["Resources"]["GroovApi"]["Properties"]
    authz = props["Auth"]["Authorizers"]

    jwt_cfg = authz["CognitoJwtAuthorizer"]
    jwt = {
        "name": "groov-jwt",
        # Literal in template.yaml; both JWT and the admin REQUEST authorizer
        # use the same identity source in practice.
        "identity_source": jwt_cfg["IdentitySource"],
        # OVERLAY: Floci issues tokens with issuer http://localhost:4566/<poolId>,
        # not template.yaml's real cognito-idp.<region>.amazonaws.com issuer.
        "issuer": symbols["__CognitoIssuer__"],
        "audience": [symbols["UserPoolClientId"]],
    }

    admin_cfg = authz["AdminAuthorizer"]
    admin = {
        "name": "groov-admin",
        "identity_source": admin_cfg["Identity"]["Headers"],
        "enable_simple_responses": admin_cfg["EnableSimpleResponses"],
        "payload_format_version": admin_cfg["AuthorizerPayloadFormatVersion"],
        # OVERLAY: local adminAuthorizer function, not the template's GetAtt
        # (same logical target, different physical ARN locally).
        "function_name": symbols["AdminAuthorizerFunction"],
    }
    return {"jwt": jwt, "admin": admin}


def local_parameters():
    # Only what the V2 slice actually needs: TempTableName/TableName/R2*/
    # InterAuthKey/FromEmail/SendToEmail/TurnstileSecretKey are template
    # Parameters consumed exclusively by out-of-scope V1/Node functions (or,
    # for R2*, dropped pre-resolution by the R2->S3 overlay) and are
    # deliberately absent here -- if a future in-scope function ever needs
    # one, resolve() will DriftError rather than silently using a fabricated
    # placeholder.
    return json.loads(LOCAL_PARAMETERS_PATH.read_text())


def build_symbols(scope, resources, pool_id, client_id, layer_arns, table_names):
    symbols = dict(PSEUDO_PARAMS)
    symbols.update(local_parameters())
    symbols["UserPoolId"] = pool_id
    symbols["UserPoolClientId"] = client_id
    symbols["__CognitoIssuer__"] = f"http://localhost:4566/{pool_id}"
    for lid in scope["all_functions"]:
        symbols[lid] = dir_name_of(resources[lid]["Properties"])
    symbols["AdminAuthorizerFunction.Arn"] = (
        f"arn:aws:lambda:{API_REGION}:{PSEUDO_PARAMS['AWS::AccountId']}:function:{symbols['AdminAuthorizerFunction']}"
    )
    symbols.update(table_names)
    for token, arn in layer_arns.items():
        symbols[f"__layer_arn__:{token}"] = arn
    return symbols


def derive(template, pool_id, client_id, layer_arns):
    scope = compute_scope(template)
    resources = template["Resources"]

    base_symbols = dict(PSEUDO_PARAMS)
    base_symbols.update(local_parameters())
    tables = build_tables(template, base_symbols, scope)
    table_names = {t["logical_id"]: t["table_name"] for t in tables if not t["bootstrap_only"]}

    symbols = build_symbols(scope, resources, pool_id, client_id, layer_arns, table_names)

    functions = build_function_manifest(template, symbols, scope)
    routes = build_routes(template, scope)
    authorizers = build_authorizers(template, symbols)

    return {
        "scope": scope,
        "functions": functions,
        "routes": routes,
        "tables": tables,
        "authorizers": authorizers,
        "architecture": host_architecture(),
    }


# ---------------------------------------------------------------------------
# --plan
# ---------------------------------------------------------------------------
def cmd_plan():
    template = load_template()
    manifest = derive(
        template,
        pool_id=PLAN_PLACEHOLDERS["pool_id"],
        client_id=PLAN_PLACEHOLDERS["client_id"],
        layer_arns=dict(PLAN_PLACEHOLDERS["layer_arns"]),
    )
    out = {
        "architecture": manifest["architecture"],
        "functions": {
            lid: {
                "function_name": f["function_name"],
                "handler": f["handler"],
                "runtime": f["runtime"],
                "architecture": f["architecture"],
                "timeout": f["timeout"],
                "memory_size": f["memory_size"],
                "environment": f["environment"],
                "layers": f["layer_arns"],
            }
            for lid, f in manifest["functions"].items()
        },
        "routes": manifest["routes"],
        "tables": [
            {
                "table_name": t["table_name"],
                "key_schema": t["key_schema"],
                "bootstrap_only": t["bootstrap_only"],
            }
            for t in manifest["tables"]
        ],
        "authorizers": manifest["authorizers"],
        "layer_defs": {token: defn["layer_name"] for token, defn in LAYER_DEFS.items()},
    }
    print(json.dumps(out, indent=2, sort_keys=True))


# ---------------------------------------------------------------------------
# Floci health
# ---------------------------------------------------------------------------
def wait_for_floci(endpoint_url, tries=90, delay=2):
    print(f"--- Waiting for Floci at {endpoint_url} ...")
    health_url = f"{endpoint_url}/_localstack/health"
    for _ in range(tries):
        try:
            with urllib.request.urlopen(health_url, timeout=3) as resp:
                if resp.status == 200:
                    print("Floci is healthy.")
                    return
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(delay)
    raise RuntimeError(f"Floci did not become healthy in time ({endpoint_url})")


# ---------------------------------------------------------------------------
# Cognito bootstrap
# ---------------------------------------------------------------------------
def _create_user(cognito, pool_id, username, given_name, family_name, group):
    cognito.admin_create_user(
        UserPoolId=pool_id, Username=username, MessageAction="SUPPRESS",
        UserAttributes=[
            {"Name": "email", "Value": username},
            {"Name": "email_verified", "Value": "true"},
            {"Name": "given_name", "Value": given_name},
            {"Name": "family_name", "Value": family_name},
            {"Name": "name", "Value": f"{given_name} {family_name}"},
        ],
    )
    cognito.admin_set_user_password(
        UserPoolId=pool_id, Username=username, Password=SEED_PASSWORD, Permanent=True,
    )
    if group:
        cognito.admin_add_user_to_group(UserPoolId=pool_id, Username=username, GroupName=group)


SEED_USERS = [
    # (username, given_name, family_name, group)
    ("admin@groov.local", "Admin", "User", "Admin"),
    # No group: smoke-test contract for the "authenticated-but-not-admin ->
    # 403" case against admin-authorized routes.
    ("user@groov.local", "NonAdmin", "User", None),
]


def _ensure_seed_users(cognito, pool_id):
    for username, given, family, group in SEED_USERS:
        try:
            cognito.admin_get_user(UserPoolId=pool_id, Username=username)
        except cognito.exceptions.UserNotFoundException:
            _create_user(cognito, pool_id, username, given, family, group)
            print(f"  Seeded missing user {username}")


def bootstrap_cognito(cognito):
    resp = cognito.list_user_pools(MaxResults=20)
    pool = next((p for p in resp["UserPools"] if p["Name"] == "groov-local"), None)
    if pool:
        pool_id = pool["Id"]
        clients = cognito.list_user_pool_clients(UserPoolId=pool_id, MaxResults=20)
        client = next((c for c in clients["UserPoolClients"] if c["ClientName"] == "groov-web"), None)
        client_id = client["ClientId"]
        print(f"  User pool groov-local already exists ({pool_id}), reusing")
        _ensure_seed_users(cognito, pool_id)
        return pool_id, client_id

    pool_id = cognito.create_user_pool(PoolName="groov-local")["UserPool"]["Id"]
    client_id = cognito.create_user_pool_client(
        UserPoolId=pool_id, ClientName="groov-web",
        ExplicitAuthFlows=["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"],
    )["UserPoolClient"]["ClientId"]
    cognito.create_group(UserPoolId=pool_id, GroupName="Admin")
    for username, given, family, group in SEED_USERS:
        _create_user(cognito, pool_id, username, given, family, group)
    print(
        f"  Created user pool {pool_id}, client {client_id}, group Admin, "
        f"users admin@groov.local (Admin) + user@groov.local (no group)"
    )
    return pool_id, client_id


# ---------------------------------------------------------------------------
# DynamoDB
# ---------------------------------------------------------------------------
def upsert_table(ddb, table):
    name = table["table_name"]
    try:
        ddb.describe_table(TableName=name)
        print(f"  DynamoDB table {name} already exists, skipping")
        return
    except ddb.exceptions.ResourceNotFoundException:
        pass
    ddb.create_table(
        TableName=name,
        AttributeDefinitions=table["attribute_definitions"],
        KeySchema=table["key_schema"],
        BillingMode=table.get("billing_mode", "PAY_PER_REQUEST"),
    )
    ddb.get_waiter("table_exists").wait(TableName=name)
    print(f"  Created table: {name}")


def wipe_table(ddb_resource, table):
    name = table["table_name"]
    t = ddb_resource.Table(name)
    try:
        t.load()
    except ClientError:
        print(f"  {name}: does not exist, nothing to wipe")
        return
    key_names = [k["AttributeName"] for k in table["key_schema"]]
    deleted = 0
    with t.batch_writer() as batch:
        resp = t.scan(ProjectionExpression=", ".join(key_names))
        while True:
            for item in resp["Items"]:
                batch.delete_item(Key={k: item[k] for k in key_names})
                deleted += 1
            if "LastEvaluatedKey" not in resp:
                break
            resp = t.scan(
                ProjectionExpression=", ".join(key_names),
                ExclusiveStartKey=resp["LastEvaluatedKey"],
            )
    print(f"  {name}: wiped {deleted} items")


# ---------------------------------------------------------------------------
# S3
# ---------------------------------------------------------------------------
def upsert_bucket(s3, name):
    try:
        s3.head_bucket(Bucket=name)
        print(f"  Bucket {name} already exists, skipping create")
    except ClientError:
        s3.create_bucket(Bucket=name)
        print(f"  Created bucket {name}")


def configure_static_bucket(s3, name):
    s3.put_bucket_cors(Bucket=name, CORSConfiguration={
        "CORSRules": [{
            "AllowedOrigins": ["http://localhost:3000"],
            "AllowedMethods": ["GET", "HEAD"],
            "AllowedHeaders": ["*"],
            "MaxAgeSeconds": 3600,
        }]
    })
    policy = {
        "Version": "2012-10-17",
        "Statement": [{
            "Sid": "PublicReadGetObject", "Effect": "Allow", "Principal": "*",
            "Action": "s3:GetObject", "Resource": f"arn:aws:s3:::{name}/*",
        }],
    }
    s3.put_bucket_policy(Bucket=name, Policy=json.dumps(policy))


def seed_static_bucket(s3):
    src = WORKSPACE / "scripts" / "s3_v2"
    if not src.is_dir():
        print(f"  WARNING: {src} not found, skipping static-browse seed", file=sys.stderr)
        return
    count = 0
    for path in src.rglob("*"):
        if path.is_file() and path.name != ".DS_Store":
            key = f"v2/{path.relative_to(src).as_posix()}"
            s3.upload_file(str(path), STATIC_BUCKET, key, ExtraArgs={"ContentType": "application/json"})
            count += 1
    print(f"  Seeded v2/ browse fixture ({count} files).")
    # Root-level (non-v2) copies: some UI code paths read /index.json and
    # /all-sensors.json at the bucket root (V1-shaped legacy paths). We have
    # no real V1 fixture, so mirror the V2 export there rather than 404.
    for root_file in ("index.json", "all-sensors.json"):
        p = src / root_file
        if p.is_file():
            s3.upload_file(str(p), STATIC_BUCKET, root_file, ExtraArgs={"ContentType": "application/json"})
    print("  Seeded root-level index.json / all-sensors.json (legacy V1-shaped paths).")


def wipe_bucket(s3, bucket):
    paginator = s3.get_paginator("list_objects_v2")
    deleted = 0
    for page in paginator.paginate(Bucket=bucket):
        objs = page.get("Contents", [])
        if not objs:
            continue
        s3.delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": o["Key"]} for o in objs]})
        deleted += len(objs)
    print(f"  {bucket}: wiped {deleted} objects")


def _load_all_sensors():
    # parse_float=Decimal because DynamoDB rejects Python floats. Returned
    # objects are reused verbatim as row payloads (prod table `data`, and the
    # pending/processed `sensor`), so they must stay DynamoDB-marshalable.
    all_sensors = WORKSPACE / "scripts" / "s3_v2" / "all-sensors.json"
    if not all_sensors.is_file():
        print(f"  WARNING: {all_sensors} not found", file=sys.stderr)
        return None
    return json.loads(all_sensors.read_text(), parse_float=decimal.Decimal)["sensors"]


def seed_prod_table(ddb_resource):
    # Rows mirror what approveProcessedSensorV2 writes: {category, grv_id,
    # data}, where data is the full sensor object.
    sensors = _load_all_sensors()
    if sensors is None:
        print("  Skipping prod-table seed", file=sys.stderr)
        return
    table = ddb_resource.Table(PROD_TABLE_NAME)
    with table.batch_writer() as batch:
        for s in sensors:
            batch.put_item(Item={"category": s["category"], "grv_id": s["id"], "data": s})
    print(f"  Seeded {PROD_TABLE_NAME} ({len(sensors)} rows).")


# Fixed timestamp so re-seeding produces byte-identical rows (idempotent).
SEED_TIMESTAMP = "2026-01-01T12:00:00Z"
SEED_USER = "admin@groov.local"


def seed_review_queues(ddb_resource, temp_table_name, processed_table_name):
    """Populate the admin review queues (3.3b) so they're non-empty right
    after `up`. Deterministic SKs (seed-pending-*, seed-processed-*) keep this
    a pure upsert -- re-running overwrites the same rows instead of piling up
    duplicates.

    TEMP row shape is authoritative from insertFormV2
    (item = {"PK":"TEMP","SK":<uuid>, **body}) and getAllTempSensorsV2
    (queries Key("PK").eq("TEMP"), returns {submissionUUID: SK, user,
    timeSubmit, sensor}). PROCESSED mirrors it under PK="PROCESSED"
    (getAllProcessedTempV2 scans the whole table, no key filter). `sensor` is
    a real, richly-shaped V2 object from all-sensors.json so both the queue
    list and the detail view render."""
    sensors = _load_all_sensors()
    if sensors is None:
        print("  Skipping review-queue seed", file=sys.stderr)
        return
    if len(sensors) < 2:
        print("  WARNING: fewer than 2 sensors available, skipping review-queue seed", file=sys.stderr)
        return

    temp = ddb_resource.Table(temp_table_name)
    pending_rows = [
        {"PK": "TEMP", "SK": "seed-pending-0001", "user": SEED_USER,
         "timeSubmit": SEED_TIMESTAMP, "sensor": sensors[0]},
        {"PK": "TEMP", "SK": "seed-pending-0002", "user": SEED_USER,
         "timeSubmit": SEED_TIMESTAMP, "sensor": sensors[1]},
    ]
    with temp.batch_writer() as batch:
        for row in pending_rows:
            batch.put_item(Item=row)
    print(f"  Seeded {len(pending_rows)} pending rows into {temp_table_name} (PK=TEMP, SK=seed-pending-*).")

    processed = ddb_resource.Table(processed_table_name)
    processed.put_item(Item={
        "PK": "PROCESSED", "SK": "seed-processed-0001", "user": SEED_USER,
        "timeSubmit": SEED_TIMESTAMP, "sensor": sensors[0],
    })
    print(f"  Seeded 1 processed row into {processed_table_name} (PK=PROCESSED, SK=seed-processed-0001).")


# ---------------------------------------------------------------------------
# Lambda layers (idempotent: skip publish when the zip hash is unchanged)
# ---------------------------------------------------------------------------
def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def publish_layer_if_changed(lambda_client, s3, defn):
    zip_path = WORKSPACE / defn["zip_path"]
    if not zip_path.is_file():
        raise DriftError(f"{zip_path} not found -- build it first (see {zip_path.parent}/build.sh)")
    digest = sha256_of(zip_path)
    marker_key = f"layer-hashes/{defn['layer_name']}.json"

    existing = None
    try:
        obj = s3.get_object(Bucket=DEPLOY_BUCKET, Key=marker_key)
        existing = json.loads(obj["Body"].read())
    except ClientError:
        pass

    if existing and existing.get("sha256") == digest and existing.get("arn"):
        print(f"  {defn['layer_name']}: unchanged (sha256={digest[:12]}...), reusing {existing['arn']}")
        return existing["arn"]

    if defn["staged_via_s3"]:
        s3_key = f"{defn['layer_name']}.zip"
        s3.upload_file(str(zip_path), DEPLOY_BUCKET, s3_key)
        content = {"S3Bucket": DEPLOY_BUCKET, "S3Key": s3_key}
    else:
        content = {"ZipFile": zip_path.read_bytes()}

    resp = lambda_client.publish_layer_version(
        LayerName=defn["layer_name"], Description=defn["description"],
        Content=content, CompatibleRuntimes=defn["compatible_runtimes"],
    )
    arn = resp["LayerVersionArn"]
    s3.put_object(Bucket=DEPLOY_BUCKET, Key=marker_key,
                   Body=json.dumps({"sha256": digest, "arn": arn}).encode())
    print(f"  {defn['layer_name']}: published {arn} (sha256={digest[:12]}...)")
    return arn


# ---------------------------------------------------------------------------
# Lambda functions (idempotent: update in place; recreate only if the
# architecture changed, since Lambda doesn't support updating that in place)
# ---------------------------------------------------------------------------
def upsert_function(lambda_client, fn):
    name = fn["function_name"]
    code = {"S3Bucket": "hot-reload", "S3Key": f"{HOST_API_DIR}/functions/{fn['dir']}"}
    config_kwargs = dict(
        FunctionName=name, Handler=fn["handler"], Runtime=fn["runtime"],
        Timeout=fn["timeout"], MemorySize=fn["memory_size"],
        Environment={"Variables": fn["environment"]},
    )
    if fn["layer_arns"]:
        config_kwargs["Layers"] = fn["layer_arns"]
    if fn.get("logging_config"):
        config_kwargs["LoggingConfig"] = fn["logging_config"]

    existing = None
    try:
        existing = lambda_client.get_function(FunctionName=name)
    except lambda_client.exceptions.ResourceNotFoundException:
        pass

    if existing:
        current_arch = existing["Configuration"].get("Architectures", ["x86_64"])[0]
        if current_arch != fn["architecture"]:
            # Architectures is create-only in the real Lambda API -- recreate
            # just this one function rather than tearing down the stack.
            print(f"  {name}: architecture changed ({current_arch} -> {fn['architecture']}), recreating")
            lambda_client.delete_function(FunctionName=name)
            existing = None

    if existing:
        lambda_client.update_function_code(FunctionName=name, **code)
        lambda_client.update_function_configuration(**config_kwargs)
        print(f"  {name}: updated (code + config)")
    else:
        lambda_client.create_function(
            Role="arn:aws:iam::000000000000:role/lambda-role",
            Code=code, Architectures=[fn["architecture"]], **config_kwargs,
        )
        print(f"  {name}: created ({fn['runtime']}, {fn['architecture']}, handler={fn['handler']})")


# ---------------------------------------------------------------------------
# HTTP API (idempotent: reuse by name, reconcile routes/integrations/authorizers)
# ---------------------------------------------------------------------------
def get_or_create_api(apigw):
    apis = apigw.get_apis(MaxResults="100")["Items"]
    existing = next((a for a in apis if a["Name"] == API_NAME), None)
    if existing:
        print(f"  API {API_NAME} already exists ({existing['ApiId']}), reusing")
        return existing["ApiId"]
    # NOTE (3.4): if a future Floci release honors LocalStack's `_custom_id_`
    # tag on create_api, the dynamic ui.env dance (re-writing the freshly
    # created ApiId to /shared/ui.env on every run) could become a static,
    # committed API base instead. Retest this on Floci upgrades.
    api = apigw.create_api(Name=API_NAME, ProtocolType="HTTP")
    print(f"  Created API {API_NAME} ({api['ApiId']})")
    return api["ApiId"]


def get_or_create_authorizer(apigw, api_id, name, **kwargs):
    existing_list = apigw.get_authorizers(ApiId=api_id, MaxResults="100")["Items"]
    existing = next((a for a in existing_list if a["Name"] == name), None)
    if existing:
        apigw.update_authorizer(ApiId=api_id, AuthorizerId=existing["AuthorizerId"], Name=name, **kwargs)
        return existing["AuthorizerId"]
    resp = apigw.create_authorizer(ApiId=api_id, Name=name, **kwargs)
    return resp["AuthorizerId"]


def reconcile_routes(apigw, lambda_client, api_id, routes, jwt_id, admin_id):
    existing_routes = {
        r["RouteKey"]: r
        for r in apigw.get_routes(ApiId=api_id, MaxResults="200")["Items"]
    }
    integration_by_uri = {
        i["IntegrationUri"]: i["IntegrationId"]
        for i in apigw.get_integrations(ApiId=api_id, MaxResults="200")["Items"]
    }
    permissioned = set()

    for route in routes:
        fn = route["function"]
        fn_arn = f"arn:aws:lambda:{API_REGION}:000000000000:function:{fn}"
        route_key = f"{route['method']} {route['path']}"

        integration_id = integration_by_uri.get(fn_arn)
        if not integration_id:
            resp = apigw.create_integration(
                ApiId=api_id, IntegrationType="AWS_PROXY", IntegrationUri=fn_arn,
                PayloadFormatVersion="2.0", IntegrationMethod="POST",
            )
            integration_id = resp["IntegrationId"]
            integration_by_uri[fn_arn] = integration_id

        target = f"integrations/{integration_id}"
        if route["auth"] == "JWT":
            want_auth_type, want_auth_id = "JWT", jwt_id
        elif route["auth"] == "ADMIN":
            want_auth_type, want_auth_id = "CUSTOM", admin_id
        else:
            want_auth_type, want_auth_id = "NONE", None

        existing = existing_routes.get(route_key)
        if existing is None:
            kwargs = {"ApiId": api_id, "RouteKey": route_key, "Target": target}
            if want_auth_type != "NONE":
                kwargs.update(AuthorizationType=want_auth_type, AuthorizerId=want_auth_id)
            apigw.create_route(**kwargs)
            print(f"  created route {route_key} -> {fn} ({route['auth']})")
        elif (
            existing.get("Target") != target
            or existing.get("AuthorizationType", "NONE") != want_auth_type
            or (want_auth_type != "NONE" and existing.get("AuthorizerId") != want_auth_id)
        ):
            # Re-target/re-auth a DRIFTED existing route. The old code skipped
            # every route that already existed, so after a function rename the
            # route kept pointing at the stale (now empty/removed) Lambda
            # forever. Real `sam deploy`/CloudFormation reconciles this; so do we.
            update_kwargs = {
                "ApiId": api_id, "RouteId": existing["RouteId"],
                "Target": target, "AuthorizationType": want_auth_type,
            }
            if want_auth_type != "NONE":
                update_kwargs["AuthorizerId"] = want_auth_id
            try:
                apigw.update_route(**update_kwargs)
                print(f"  re-targeted route {route_key} -> {fn} ({route['auth']})")
            except ClientError as e:
                # Fall back to a clean recreate if update_route can't reconcile
                # the change (e.g. clearing an authorizer).
                apigw.delete_route(ApiId=api_id, RouteId=existing["RouteId"])
                create_kwargs = {"ApiId": api_id, "RouteKey": route_key, "Target": target}
                if want_auth_type != "NONE":
                    create_kwargs.update(AuthorizationType=want_auth_type, AuthorizerId=want_auth_id)
                apigw.create_route(**create_kwargs)
                print(f"  recreated route {route_key} -> {fn} ({route['auth']}) [{type(e).__name__}]")
        else:
            print(f"  route {route_key} already correct, skipping")

        if fn not in permissioned:
            permissioned.add(fn)
            try:
                lambda_client.add_permission(
                    FunctionName=fn, StatementId="apigw-invoke", Action="lambda:InvokeFunction",
                    Principal="apigateway.amazonaws.com",
                    SourceArn=f"arn:aws:execute-api:{API_REGION}:000000000000:{api_id}/*",
                )
            except lambda_client.exceptions.ResourceConflictException:
                pass


def prune_orphans(apigw, lambda_client, api_id, manifest):
    """Delete Floci resources no longer in the derived manifest: orphaned
    routes, their now-unreferenced integrations, and out-of-scope Lambda
    functions (e.g. left behind after a rename). Mirrors CloudFormation's
    delete/replace semantics, which the create/update-only reconcile above
    lacks. Off by default -- run `floci-init --prune`.

    Order is routes -> integrations -> functions: APIGW won't delete an
    integration that still has routes, and a function shouldn't be removed
    while a route still targets it. reconcile_routes has already re-pointed the
    live routes at the current integrations by the time this runs, so a stale
    integration/function is genuinely unreferenced here.

    Safe because every function/route/integration in this local stack is
    provisioner-created (a fresh Floci emulator has no user-made Lambdas)."""
    keep_route_keys = {f"{r['method']} {r['path']}" for r in manifest["routes"]}
    keep_integration_uris = {
        f"arn:aws:lambda:{API_REGION}:000000000000:function:{r['function']}"
        for r in manifest["routes"]
    }
    keep_fn_names = {
        manifest["functions"][lid]["function_name"]
        for lid in manifest["scope"]["all_functions"]
    }
    keep_fn_names.add(manifest["authorizers"]["admin"]["function_name"])

    pruned = 0

    for r in apigw.get_routes(ApiId=api_id, MaxResults="200")["Items"]:
        if r["RouteKey"] not in keep_route_keys:
            apigw.delete_route(ApiId=api_id, RouteId=r["RouteId"])
            print(f"  pruned route {r['RouteKey']}")
            pruned += 1

    for i in apigw.get_integrations(ApiId=api_id, MaxResults="200")["Items"]:
        if i.get("IntegrationUri") not in keep_integration_uris:
            try:
                apigw.delete_integration(ApiId=api_id, IntegrationId=i["IntegrationId"])
                print(f"  pruned integration -> {i.get('IntegrationUri')}")
                pruned += 1
            except ClientError as e:
                print(f"  skipped integration {i['IntegrationId']} ({type(e).__name__})")

    existing_fn_names = []
    for page in lambda_client.get_paginator("list_functions").paginate():
        existing_fn_names += [f["FunctionName"] for f in page["Functions"]]
    for name in existing_fn_names:
        if name not in keep_fn_names:
            lambda_client.delete_function(FunctionName=name)
            print(f"  pruned function {name}")
            pruned += 1

    print(f"  prune complete ({pruned} resource(s) removed)")


def ensure_stage(apigw, api_id):
    try:
        apigw.get_stage(ApiId=api_id, StageName="dev")
        print("  Stage 'dev' already exists, skipping")
    except apigw.exceptions.NotFoundException:
        apigw.create_stage(ApiId=api_id, StageName="dev", AutoDeploy=True)
        print("  Created stage 'dev' (auto-deploy)")


def write_ui_env(shared_dir, api_id, pool_id, client_id):
    api_base = f"http://localhost:4566/execute-api/{api_id}/dev"
    content = (
        f"REACT_APP_API_BASE={api_base}\n"
        f"REACT_APP_COGNITO_USER_POOL_ID={pool_id}\n"
        f"REACT_APP_COGNITO_CLIENT_ID={client_id}\n"
    )
    shared_dir.mkdir(parents=True, exist_ok=True)
    (shared_dir / "ui.env").write_text(content)
    return api_base, content


# ---------------------------------------------------------------------------
# apply / reseed
# ---------------------------------------------------------------------------
def make_client(boto3, service, region, endpoint_url):
    return boto3.client(service, region_name=region, endpoint_url=endpoint_url)


def apply(prune=False):
    import boto3

    endpoint_url = os.environ["AWS_ENDPOINT_URL"]
    cognito = make_client(boto3, "cognito-idp", API_REGION, endpoint_url)
    s3 = make_client(boto3, "s3", API_REGION, endpoint_url)
    lambda_client = make_client(boto3, "lambda", API_REGION, endpoint_url)
    apigw = make_client(boto3, "apigatewayv2", API_REGION, endpoint_url)
    ddb = make_client(boto3, "dynamodb", DDB_REGION, endpoint_url)
    ddb_resource = boto3.resource("dynamodb", region_name=DDB_REGION, endpoint_url=endpoint_url)

    print("==================================================================")
    print(" groov-db-api local (Floci) provisioning")
    print("==================================================================")

    print("--- Cognito ---")
    pool_id, client_id = bootstrap_cognito(cognito)

    print("--- S3 buckets ---")
    upsert_bucket(s3, STATIC_BUCKET)
    configure_static_bucket(s3, STATIC_BUCKET)
    upsert_bucket(s3, DEPLOY_BUCKET)

    print("--- Lambda layers ---")
    layer_arns = {}
    for token, defn in LAYER_DEFS.items():
        layer_arns[token] = publish_layer_if_changed(lambda_client, s3, defn)

    template = load_template()
    manifest = derive(template, pool_id, client_id, layer_arns)

    print("--- DynamoDB tables ---")
    for table in manifest["tables"]:
        upsert_table(ddb, table)

    print("--- Seeding ---")
    seed_static_bucket(s3)
    seed_prod_table(ddb_resource)
    table_by_lid = {t["logical_id"]: t["table_name"] for t in manifest["tables"]}
    seed_review_queues(
        ddb_resource,
        table_by_lid["GroovTempTableV2"],
        table_by_lid["GroovTempTableV2Processed"],
    )

    print("--- Lambda functions ---")
    for lid in manifest["scope"]["all_functions"]:
        upsert_function(lambda_client, manifest["functions"][lid])

    print("--- HTTP API ---")
    api_id = get_or_create_api(apigw)

    jwt_cfg = manifest["authorizers"]["jwt"]
    jwt_id = get_or_create_authorizer(
        apigw, api_id, jwt_cfg["name"],
        AuthorizerType="JWT",
        IdentitySource=[jwt_cfg["identity_source"]],
        JwtConfiguration={"Issuer": jwt_cfg["issuer"], "Audience": jwt_cfg["audience"]},
    )
    print(f"  JWT authorizer: {jwt_id} (issuer={jwt_cfg['issuer']})")

    admin_cfg = manifest["authorizers"]["admin"]
    admin_fn_arn = f"arn:aws:lambda:{API_REGION}:000000000000:function:{admin_cfg['function_name']}"
    admin_id = get_or_create_authorizer(
        apigw, api_id, admin_cfg["name"],
        AuthorizerType="REQUEST",
        # SAM's `Identity: Headers: [...]` shorthand transforms to APIGWv2's
        # "$request.header.<Name>" IdentitySource syntax at deploy time; that
        # transform is replicated explicitly here.
        IdentitySource=[f"$request.header.{h}" for h in admin_cfg["identity_source"]],
        AuthorizerUri=f"arn:aws:apigateway:{API_REGION}:lambda:path/2015-03-31/functions/{admin_fn_arn}/invocations",
        AuthorizerPayloadFormatVersion=admin_cfg["payload_format_version"],
        EnableSimpleResponses=admin_cfg["enable_simple_responses"],
    )
    print(f"  Admin (Lambda) authorizer: {admin_id}")
    try:
        lambda_client.add_permission(
            FunctionName=admin_cfg["function_name"], StatementId="apigw-invoke-authorizer",
            Action="lambda:InvokeFunction", Principal="apigateway.amazonaws.com",
            SourceArn=f"arn:aws:execute-api:{API_REGION}:000000000000:{api_id}/*",
        )
    except lambda_client.exceptions.ResourceConflictException:
        pass

    reconcile_routes(apigw, lambda_client, api_id, manifest["routes"], jwt_id, admin_id)
    if prune:
        print("--- Pruning orphaned resources (--prune) ---")
        prune_orphans(apigw, lambda_client, api_id, manifest)
    ensure_stage(apigw, api_id)

    api_base, content = write_ui_env(Path("/shared"), api_id, pool_id, client_id)

    print("==================================================================")
    print(" groov-db-api local (Floci) provisioning complete")
    print("==================================================================")
    print(" UI:              http://localhost:3000  (sign in: admin@groov.local / GroovLocal1!)")
    print(f" API base:        {api_base}")
    print(f" Cognito pool:     {pool_id}  (client {client_id})")
    print(f" Cognito issuer:   http://localhost:4566/{pool_id}")
    print(" Seeded users:     admin@groov.local / GroovLocal1!  (group: Admin)")
    print("                   user@groov.local / GroovLocal1!  (no group)")
    print(f" Static bucket:    {STATIC_BUCKET}  (public-read, path-style)")
    print(" Wrote /shared/ui.env:")
    for line in content.splitlines():
        print(f"   {line}")
    print("==================================================================")


def reseed():
    import boto3

    endpoint_url = os.environ["AWS_ENDPOINT_URL"]
    s3 = make_client(boto3, "s3", API_REGION, endpoint_url)
    ddb_resource = boto3.resource("dynamodb", region_name=DDB_REGION, endpoint_url=endpoint_url)

    template = load_template()
    scope = compute_scope(template)
    base_symbols = dict(PSEUDO_PARAMS)
    base_symbols.update(local_parameters())
    tables = build_tables(template, base_symbols, scope)

    print("--- Wiping tables ---")
    for table in tables:
        wipe_table(ddb_resource, table)

    print("--- Wiping static bucket ---")
    wipe_bucket(s3, STATIC_BUCKET)

    table_by_lid = {t["logical_id"]: t["table_name"] for t in tables}

    print("--- Reseeding ---")
    configure_static_bucket(s3, STATIC_BUCKET)
    seed_static_bucket(s3)
    seed_prod_table(ddb_resource)

    print("--- Seeding review queues (3.3b) ---")
    seed_review_queues(
        ddb_resource,
        table_by_lid["GroovTempTableV2"],
        table_by_lid["GroovTempTableV2Processed"],
    )


# ---------------------------------------------------------------------------
# main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", action="store_true", help="Print the derived manifest only; no AWS calls.")
    parser.add_argument("--reseed", action="store_true", help="Wipe+reseed tables/buckets only.")
    parser.add_argument(
        "--prune", action="store_true",
        help="After provisioning, delete Floci resources (routes, integrations, "
             "Lambdas) no longer in template.yaml -- mirrors CloudFormation "
             "delete/replace. Off by default.",
    )
    args = parser.parse_args()

    if args.plan:
        cmd_plan()
        return

    endpoint_url = os.environ.get("AWS_ENDPOINT_URL")
    if not endpoint_url:
        raise SystemExit("AWS_ENDPOINT_URL must be set")

    if args.reseed:
        wait_for_floci(endpoint_url)
        reseed()
        return

    if not HOST_API_DIR:
        raise SystemExit("HOST_API_DIR must be set (absolute host path to the repo root)")
    wait_for_floci(endpoint_url)
    apply(prune=args.prune)


if __name__ == "__main__":
    try:
        main()
    except DriftError as e:
        print(f"DRIFT ERROR: {e}", file=sys.stderr)
        print(
            "template.yaml referenced something this derive doesn't understand -- "
            "fix the provisioner (or the template), don't silently skip.",
            file=sys.stderr,
        )
        sys.exit(1)
