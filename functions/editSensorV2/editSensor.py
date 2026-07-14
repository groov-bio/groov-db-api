import json, os, time
import boto3

ALLOWED_ORIGINS = ["http://localhost:3000", "https://groov.bio", "https://www.groov.bio"]

def _cors_headers(event, methods):
    headers = event.get("headers") or {}
    origin = headers.get("origin") or headers.get("Origin") or "http://localhost:3000"
    allowed_origin = origin if origin in ALLOWED_ORIGINS else "http://localhost:3000"
    return {"Access-Control-Allow-Origin": allowed_origin, "Access-Control-Allow-Credentials": "true",
            "Access-Control-Allow-Headers": "Content-Type,content-type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
            "Access-Control-Allow-Methods": methods, "Access-Control-Max-Age": "86400"}

def _method(event):
    return (((event.get("requestContext") or {}).get("http") or {}).get("method"))

_dynamodb = None
def _table(name):
    global _dynamodb
    if _dynamodb is None:
        # No endpoint_url override for IS_LOCAL: boto3 auto-targets the
        # Floci-injected AWS_ENDPOINT_URL env var when present inside the
        # Lambda container. Prod is unaffected (that env var is unset there).
        kwargs = {"region_name": "us-east-2"}
        _dynamodb = boto3.resource("dynamodb", **kwargs)
    return _dynamodb.Table(name)


# ── Response helpers ─────────────────────────────────────────────────────────

def _err_body(status_code, message, headers):
    body = {"message": message} if isinstance(message, str) else message
    return {"statusCode": status_code, "headers": headers, "body": json.dumps(body)}


# ── Schema (mirrors the Joi schema in editSensor.js) ─────────────────────────
# Identity fields (id, category, per-protein uniprot_id) are required; everything
# else is treated as unknown/optional so future sub-schemas don't break validation
# (mirrors Joi's allowUnknown: true / abortEarly: false semantics).

VALID_TYPES = ("One Component", "Two Component", "Riboswitch")
VALID_REF_TYPES = ("UniProt", "groovDB")


def _validate_body(body):
    """Mirrors bodySchema.validate(body, { abortEarly: false })."""
    errors = []
    if not isinstance(body, dict):
        errors.append('"value" must be of type object')
        return errors

    if not isinstance(body.get("category"), str):
        errors.append('"category" is required')
    if not isinstance(body.get("grv_id"), str):
        errors.append('"grv_id" is required')
    if not isinstance(body.get("data"), dict):
        errors.append('"data" is required')
    if "user" in body and body["user"] is not None and not isinstance(body["user"], str):
        errors.append('"user" must be a string')
    if "timeSubmit" in body and body["timeSubmit"] is not None and not isinstance(body["timeSubmit"], (int, float)):
        errors.append('"timeSubmit" must be a number')
    return errors


def _validate_mutation_entry(entry, path):
    errors = []
    if not isinstance(entry, dict):
        errors.append(f'"{path}" must be of type object')
        return errors
    muts = entry.get("mutations")
    if not isinstance(muts, list) or len(muts) < 1:
        errors.append(f'"{path}.mutations" is required')
    if entry.get("ref_type") not in VALID_REF_TYPES:
        errors.append(f'"{path}.ref_type" must be one of {VALID_REF_TYPES}')
    if not isinstance(entry.get("ref_id"), str):
        errors.append(f'"{path}.ref_id" is required')
    return errors


def _validate_protein(protein, idx):
    """Mirrors proteinSchema (allowUnknown: true) — only uniprot_id is required."""
    errors = []
    path = f"proteins[{idx}]"
    if not isinstance(protein, dict):
        errors.append(f'"{path}" must be of type object')
        return errors
    if not isinstance(protein.get("uniprot_id"), str):
        errors.append(f'"{path}.uniprot_id" is required')
    mutations = protein.get("mutations")
    if mutations is not None:
        if not isinstance(mutations, list):
            errors.append(f'"{path}.mutations" must be an array')
        else:
            for j, m in enumerate(mutations):
                errors.extend(_validate_mutation_entry(m, f"{path}.mutations[{j}]"))
    return errors


def _validate_data(data):
    """Mirrors dataSchema.validate(data, { abortEarly: false, allowUnknown: true })."""
    errors = []
    if not isinstance(data, dict):
        errors.append('"value" must be of type object')
        return errors

    if not isinstance(data.get("id"), str):
        errors.append('"id" is required')
    if not isinstance(data.get("category"), str):
        errors.append('"category" is required')
    if "type" in data and data["type"] is not None and data["type"] not in VALID_TYPES:
        errors.append(f'"type" must be one of {VALID_TYPES}')

    proteins = data.get("proteins")
    if not isinstance(proteins, list) or len(proteins) < 1:
        errors.append('"proteins" must contain at least 1 items')
    else:
        for i, p in enumerate(proteins):
            errors.extend(_validate_protein(p, i))

    return errors


# ── Handler ───────────────────────────────────────────────────────────────────

def lambda_handler(event, context=None):
    cors_headers = _cors_headers(event, "POST,OPTIONS")

    if _method(event) == "OPTIONS":
        return {"statusCode": 200, "headers": cors_headers}

    try:
        body = json.loads(event.get("body") or "{}")
    except (json.JSONDecodeError, TypeError, ValueError):
        return _err_body(400, "Invalid JSON in request body", cors_headers)

    body_errors = _validate_body(body)
    if body_errors:
        return _err_body(400, {"type": "Validation Error", "errors": body_errors}, cors_headers)

    category = body.get("category")
    grv_id = body.get("grv_id")
    data = body.get("data")
    user = body.get("user")
    time_submit = body.get("timeSubmit")

    data_errors = _validate_data(data)
    if data_errors:
        return _err_body(400, {"type": "Validation Error", "errors": data_errors}, cors_headers)

    # Identity guard: data fields must match the envelope-level identity params.
    if data.get("id") != grv_id:
        return _err_body(400, f"data.id ({data.get('id')}) does not match grv_id ({grv_id})", cors_headers)
    if data.get("category") != category:
        return _err_body(400, f"data.category ({data.get('category')}) does not match category ({category})", cors_headers)

    # Verify the prod row exists and that protein identity is unchanged.
    prod_table_name = os.environ.get("PROD_TABLE_V2_NAME")
    try:
        res = _table(prod_table_name).get_item(Key={"category": category, "grv_id": grv_id})
        prod_row = res.get("Item")
    except Exception as err:
        print(err)
        return _err_body(500, "Error reading prod table", cors_headers)

    if not prod_row:
        return _err_body(404, f"Sensor not found: {grv_id}", cors_headers)

    prod_data = prod_row.get("data") or {}

    # Protein uniprot_ids must match exactly (fixed identity — no re-minting on approval).
    prod_proteins = prod_data.get("proteins") or []
    edit_proteins = data.get("proteins") or []
    prod_uniprot_ids = sorted(p.get("uniprot_id") for p in prod_proteins)
    edit_uniprot_ids = sorted(p.get("uniprot_id") for p in edit_proteins)
    if prod_uniprot_ids != edit_uniprot_ids:
        return _err_body(400, "Protein uniprot_ids cannot be changed in an edit", cors_headers)

    # Read-only fields cannot be changed in an edit. The edit form renders them
    # read-only; we also enforce it server-side by forcing each back to the current
    # prod value. We overwrite rather than reject on mismatch: the editor loads the
    # sensor from the R2 static JSON, which can drift from the prod table for a
    # field the user never touched — rejecting would falsely block a valid edit,
    # whereas overwriting still guarantees these fields can't be changed.
    # Editable through the form: About, Alias, Regulation type, Stimulus, DNA
    # binding, and References. Identity fields below are forced back to prod.
    if "type" in prod_data:
        data["type"] = prod_data["type"]

    prod_proteins_by_uniprot = {p.get("uniprot_id"): p for p in prod_proteins}
    read_only_protein_fields = ["family", "kegg_id", "refseq_id", "sequence"]
    for edit_protein in edit_proteins:
        prod_protein = prod_proteins_by_uniprot.get(edit_protein.get("uniprot_id"))
        if not prod_protein:
            continue  # uniprot set already validated to match above
        for field in read_only_protein_fields:
            if field in prod_protein:
                edit_protein[field] = prod_protein[field]
        # References are editable (e.g. correcting a wrong DOI, title, or author).

        # Origin and mutations are tied to the sensor's identity — changing them
        # means creating a new sensor, not editing this one — so the edit form no
        # longer exposes them. Force each back to the prod value (deleting it when
        # prod has none) so an edit can neither modify nor introduce them.
        for field in ["origin", "mutations"]:
            if field in prod_protein:
                edit_protein[field] = prod_protein[field]
            else:
                edit_protein.pop(field, None)

    # Deterministic SK caps pending edits at one per sensor — re-submitting overwrites the queued copy.
    sk = f"EDIT#{grv_id}"
    processed_table_name = os.environ.get("PROCESSED_TEMP_TABLE_V2_NAME")
    item = {
        "PK": "PROCESSED",
        "SK": sk,
        "proposed_grv_id": None,
        "isEdit": True,
        "editTarget": {"category": category, "grv_id": grv_id},
        "user": user if user is not None else None,
        "editTimestamp": time_submit if time_submit is not None else int(time.time() * 1000),
        "data": data,
        # Snapshot the live prod row as the diff baseline so the admin review can
        # show FROM (previousData) → TO (data). Captured here because read-only
        # fields on `data` have already been forced to the prod values above, so
        # the two blobs share an identical shape and only user-changed fields differ.
        "previousData": prod_row.get("data"),
    }
    try:
        _table(processed_table_name).put_item(Item=item)
    except Exception as err:
        print(err)
        return _err_body(500, "Error writing to processed-temp table", cors_headers)

    return {
        "statusCode": 202,
        "headers": cors_headers,
        "body": json.dumps({"message": "Edit submitted for admin review", "submissionUUID": sk}),
    }
