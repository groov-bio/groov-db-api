#!/usr/bin/env python3
"""check_iam_parity.py — heuristic IAM-parity lint for template.yaml.

WHY THIS EXISTS
----------------
Local dev runs the same Lambda code against LocalStack's IAM emulation,
which is much more permissive than real AWS IAM. A function whose code
depends on a resource (a DynamoDB table, an S3/R2 bucket, another Lambda
function) but whose SAM ``Policies:`` block doesn't actually grant access
to that resource can work fine locally and then fail with AccessDenied the
moment it hits real AWS. This script is a cheap, static (no Docker, no
AWS calls) tripwire for that class of drift: it looks at what each
``AWS::Serverless::Function`` *says* it needs (via naming patterns in its
``Environment.Variables``) and checks whether its ``Policies:`` block
mentions the same resource anywhere.

HOW IT WORKS
------------
1. Parse template.yaml with PyYAML's SafeLoader, using a generic
   multi-constructor so CloudFormation short-hand tags (!Ref, !GetAtt,
   !Sub, !Join, ...) round-trip into the same dict shapes
   (``{"Ref": ...}``, ``{"Fn::GetAtt": ...}``, ...) that the equivalent
   JSON template would produce, instead of raising "could not determine
   a constructor" errors.
2. For every ``AWS::Serverless::Function`` resource, walk
   ``Properties.Environment.Variables``. An env var is treated as a
   *resource reference* if its key contains (case-insensitively) one of
   the substrings ``TABLE``, ``BUCKET``, or ``LAMBDA`` — the naming
   convention this template already follows (``TEMP_TABLE_V2_NAME``,
   ``R2_BUCKET_NAME``, ``FINGERPRINT_LAMBDA_NAME``, ...).
3. For each such env var, resolve its value to one or more candidate
   "tokens": the logical id for a ``!Ref``, the target logical id for a
   ``!GetAtt``, the ``${...}`` interpolations for a ``!Sub``, or the
   literal string itself.
4. The function's own ``Policies:`` block is serialized to JSON and
   searched (plain substring) for each candidate token. If none of a
   variable's tokens appear anywhere in the policies, the function is
   flagged: it references a resource by name but nothing in its IAM
   grants mentions that resource.

THIS IS A HEURISTIC — READ THIS BEFORE ACTING ON FINDINGS
-----------------------------------------------------------
* It is a naming-convention check, not a type-aware one. It never looks
  at what a ``!Ref`` target's ``Type:`` actually is — a ``TABLE``-pattern
  env var that ``!Ref``s a *Parameter* (e.g. this template's
  ``TempTableName``/``TableName`` params for the legacy V1 tables) is
  treated exactly like a ``!Ref`` to a real ``AWS::DynamoDB::Table``
  resource. It cannot tell "this points at a resource this template
  provisions" from "this points at a name passed in from outside."
* Known false-positive class in *this* template: R2 (Cloudflare object
  storage) is accessed over an S3-compatible HTTP API using access-key /
  secret credentials carried as plain env vars (``R2_ACCESS_KEY_ID`` /
  ``R2_SECRET_ACCESS_KEY``) — it is not an AWS resource and is not (and
  cannot be) governed by an AWS IAM policy statement. Any
  ``R2_BUCKET_NAME``-style env var will only look "covered" if some
  *other* statement in that function's Policies block happens to also
  mention the ``R2BucketName`` token (e.g. an ``s3:GetObject`` statement
  templated against the same parameter, which some functions have and
  others don't) — that match/mismatch is IAM-shaped noise, not a real
  AWS permissions gap, since R2 auth never goes through AWS IAM. Treat
  any finding whose token is ``R2BucketName`` as expected/ignorable
  unless R2 is ever replaced by native S3.
* Substring matching only proves the token appears *somewhere* in the
  policies block — not that the granted action set (Read vs Crud vs
  Invoke) is sufficient, and not that the match isn't coincidental
  (e.g. a table's logical id appearing inside an unrelated ARN string).
  A "not flagged" result is not a guarantee of correct least-privilege
  IAM; it only rules out the "zero grants reference this resource at
  all" failure mode.
* Functions that use ``Role:`` instead of ``Policies:`` (none currently
  do) would always be flagged for any resource-shaped env var, since
  there is no Policies block to search.
* ``!Sub`` resolution only extracts simple ``${Token}`` interpolations
  from the template string; it does not evaluate ``!If``/``!FindInMap``
  or nested intrinsic functions beyond one level.

USAGE
-----
    python scripts/check_iam_parity.py [path/to/template.yaml]

Defaults to ``template.yaml`` next to this script's repo root. Prints one
line per finding, grouped by function, and exits non-zero if any findings
exist. This is intentionally a *report*, not an enforcement gate — wire it
into CI as a non-blocking (``continue-on-error: true``) step until the
false-positive rate above has been reviewed by a human.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import yaml

# Env var *key* substrings (case-insensitive) that mark it as referencing
# a named AWS/external resource this script knows how to reason about.
CATEGORY_PATTERNS = (
    ("TABLE", "dynamodb"),
    ("BUCKET", "s3"),
    ("LAMBDA", "lambda-invoke"),
)

SUB_TOKEN_RE = re.compile(r"\$\{([^}!]+)\}")

# CloudFormation pseudo parameters never need (or can have) an IAM policy
# grant keyed off their own name — skip them so they don't create noise.
PSEUDO_PARAMS = {
    "AWS::Region",
    "AWS::AccountId",
    "AWS::Partition",
    "AWS::StackName",
    "AWS::StackId",
    "AWS::URLSuffix",
    "AWS::NoValue",
}


def _cfn_multi_constructor(loader: yaml.SafeLoader, tag_suffix: str, node: yaml.Node):
    """Turn any `!Xxx` short-hand tag into the equivalent {"Fn::Xxx": ...}
    dict shape (or {"Ref": ...} / {"Fn::GetAtt": ...} for those two),
    so downstream code can treat a parsed template uniformly regardless
    of whether the author used short-hand or long-form intrinsics.
    """
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node)
    elif isinstance(node, yaml.MappingNode):
        value = loader.construct_mapping(node)
    else:  # pragma: no cover - defensive
        value = None

    if tag_suffix == "Ref":
        return {"Ref": value}
    if tag_suffix == "GetAtt":
        return {"Fn::GetAtt": value}
    return {f"Fn::{tag_suffix}": value}


def _make_loader() -> type[yaml.SafeLoader]:
    loader_cls = type("IamParityLoader", (yaml.SafeLoader,), {})
    loader_cls.add_multi_constructor("!", _cfn_multi_constructor)
    return loader_cls


def load_template(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as fh:
        return yaml.load(fh, Loader=_make_loader())


def categorize(env_key: str) -> str | None:
    upper = env_key.upper()
    for pattern, category in CATEGORY_PATTERNS:
        if pattern in upper:
            return category
    return None


def resolve_tokens(value) -> list[str]:
    """Best-effort extraction of candidate identifier strings from a
    (already yaml-constructed) CloudFormation value."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        if "Ref" in value and isinstance(value["Ref"], str):
            return [value["Ref"]]
        if "Fn::GetAtt" in value:
            target = value["Fn::GetAtt"]
            if isinstance(target, str):
                return [target.split(".")[0]]
            if isinstance(target, list) and target:
                return [str(target[0])]
        if "Fn::Sub" in value:
            sub = value["Fn::Sub"]
            template_str = sub[0] if isinstance(sub, list) else sub
            if isinstance(template_str, str):
                return SUB_TOKEN_RE.findall(template_str)
    return []


def find_findings(template: dict) -> list[dict]:
    resources = template.get("Resources") or {}
    findings = []

    for logical_id, resource in resources.items():
        if not isinstance(resource, dict):
            continue
        if resource.get("Type") != "AWS::Serverless::Function":
            continue

        props = resource.get("Properties") or {}
        env_vars = ((props.get("Environment") or {}).get("Variables")) or {}
        policies = props.get("Policies") or []
        policies_haystack = json.dumps(policies, default=str)

        for env_key, env_value in env_vars.items():
            category = categorize(env_key)
            if category is None:
                continue

            tokens = [
                token
                for token in resolve_tokens(env_value)
                if token not in PSEUDO_PARAMS
            ]
            if not tokens:
                # Unresolvable (e.g. a bare literal that isn't a
                # resource-shaped identifier, or a construct we don't
                # unpack) - nothing to cross-reference, skip rather than
                # risk a false positive.
                continue

            if not any(token in policies_haystack for token in tokens):
                findings.append(
                    {
                        "function": logical_id,
                        "env_var": env_key,
                        "category": category,
                        "tokens": tokens,
                    }
                )

    return findings


def main(argv: list[str]) -> int:
    default_template = Path(__file__).resolve().parent.parent / "template.yaml"
    template_path = Path(argv[1]) if len(argv) > 1 else default_template

    if not template_path.is_file():
        print(f"check_iam_parity: template not found: {template_path}", file=sys.stderr)
        return 2

    template = load_template(template_path)
    findings = find_findings(template)

    if not findings:
        print(f"check_iam_parity: OK - no IAM-parity gaps found in {template_path}")
        return 0

    print(
        f"check_iam_parity: {len(findings)} potential IAM-parity gap(s) in "
        f"{template_path} (heuristic - see module docstring for false-positive caveats)\n"
    )
    by_function: dict[str, list[dict]] = {}
    for finding in findings:
        by_function.setdefault(finding["function"], []).append(finding)

    for function_name in sorted(by_function):
        print(f"  {function_name}:")
        for finding in by_function[function_name]:
            tokens = ", ".join(finding["tokens"])
            print(
                f"    - {finding['env_var']} ({finding['category']}) references "
                f"[{tokens}] but no Policies entry for this function mentions it"
            )
    print(
        "\nNote: R2BucketName findings are expected/ignorable - R2 access is "
        "credential-based (access key/secret), not AWS-IAM-governed. See the "
        "module docstring for the full false-positive discussion."
    )

    return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
