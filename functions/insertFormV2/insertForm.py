import json
import os
import re
import uuid

import boto3
from boto3.dynamodb.conditions import Key

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
        kwargs = {"region_name": "us-east-2"}
        if os.environ.get("IS_LOCAL"):
            kwargs["endpoint_url"] = "http://host.docker.internal:8000"
        _dynamodb = boto3.resource("dynamodb", **kwargs)
    return _dynamodb.Table(name)


# ---------------------------------------------------------------------------
# Validation (mirrors the Joi schema in the original insertForm.js 1:1)
# ---------------------------------------------------------------------------

DOI_PATTERN = re.compile(
    r"^(https?://doi\.org/|doi:|doi\.org/)?(10\.\d{4,9}[-._;()/:A-Z0-9]+)$", re.IGNORECASE
)
REF_FIGURE_PATTERN = re.compile(r"^(Figure|Supplementary Figure|Table|Supplementary Table) [S]?[1-9]?[0-9A-Za-z]?$")
ALIAS_PATTERN = re.compile(r"^[A-Za-z0-9_.]+$")
UNIPROT_PATTERN = re.compile(r"^[A-Za-z0-9_]+$")
ACCESSION_PATTERN = re.compile(r"^[A-Za-z0-9_.]+$")
SEQUENCE_PATTERN = re.compile(r"^[ATCGatcg]+$")

LIGAND_METHODS = {
    "EMSA",
    "DNase footprinting",
    "Isothermal titration calorimetry",
    "Synthetic regulation",
    "Fluorescence polarization",
    "Surface plasmon resonance",
    "Thermal shift",
    "Spectrophotometric competition",
    "Spectral shift",
    "DNA affinity chromatography",
    "Autophosphorylation assay",
}

OPERATOR_METHODS = {
    "EMSA",
    "DNase footprinting",
    "Crystal structure",
    "Isothermal titration calorimetry",
    "Fluorescence polarization",
    "Surface plasmon resonance",
    "Synthetic regulation",
    "ChIP-Seq",
}

MECHANISM_ENUM = {"Apo-repressor", "Apo-activator", "Co-repressor", "Co-activator", "Signal transduction"}
FAMILY_ENUM = {"TetR", "LysR", "AraC", "MarR", "LacI", "GntR", "LuxR", "IclR", "Other", "OmpR", "HisKA"}
REGULATORY_EFFECT_ENUM = {"activates", "represses"}
REF_TYPE_ENUM = {"UniProt", "groovDB"}
TWO_COMPONENT_ONLY_FAMILIES = {"OmpR", "HisKA"}


def _is_number(value):
    if isinstance(value, bool):
        return False
    if isinstance(value, (int, float)):
        return True
    if isinstance(value, str):
        try:
            float(value)
            return True
        except ValueError:
            return False
    return False


def _check_unknown_keys(obj, allowed_keys, path, errors):
    for key in obj:
        if key not in allowed_keys:
            errors.append(f'"{path}.{key}" is not allowed')


def _required_str_pattern(obj, key, pattern, path, errors):
    if key not in obj or obj.get(key) is None:
        errors.append(f'"{path}.{key}" is required')
        return
    value = obj[key]
    if not isinstance(value, str):
        errors.append(f'"{path}.{key}" must be a string')
        return
    if not pattern.match(value):
        errors.append(f'"{path}.{key}" fails to match the required pattern')


def _required_enum(obj, key, allowed, path, errors):
    if key not in obj or obj.get(key) is None:
        errors.append(f'"{path}.{key}" is required')
        return
    if obj[key] not in allowed:
        errors.append(f'"{path}.{key}" must be one of {sorted(allowed)}')


def _required_str_maxlen(obj, key, maxlen, path, errors):
    if key not in obj or obj.get(key) is None:
        errors.append(f'"{path}.{key}" is required')
        return
    value = obj[key]
    if not isinstance(value, str):
        errors.append(f'"{path}.{key}" must be a string')
        return
    if len(value) > maxlen:
        errors.append(f'"{path}.{key}" length must be <= {maxlen} characters')


def _required_str(obj, key, path, errors):
    if key not in obj or obj.get(key) is None:
        errors.append(f'"{path}.{key}" is required')
        return
    if not isinstance(obj[key], str):
        errors.append(f'"{path}.{key}" must be a string')


def _required_number(obj, key, path, errors):
    if key not in obj or obj.get(key) is None:
        errors.append(f'"{path}.{key}" is required')
        return
    if not _is_number(obj[key]):
        errors.append(f'"{path}.{key}" must be a number')


def _optional_enum_allow_empty_null(obj, key, allowed, path, errors):
    if key not in obj:
        return
    value = obj[key]
    if value is None or value == "":
        return
    if value not in allowed:
        errors.append(f'"{path}.{key}" must be one of {sorted(allowed)}')


def _optional_number_allow_null(obj, key, path, errors):
    if key not in obj:
        return
    value = obj[key]
    if value is None:
        return
    if not _is_number(value):
        errors.append(f'"{path}.{key}" must be a number')


def _validate_array(arr, path, item_validator, min_len=1):
    errors = []
    if not isinstance(arr, list):
        errors.append(f'"{path}" must be an array')
        return errors
    if min_len is not None and len(arr) < min_len:
        errors.append(f'"{path}" must contain at least {min_len} item(s)')
    for idx, item in enumerate(arr):
        errors.extend(item_validator(item, f"{path}[{idx}]"))
    return errors


def _validate_ligand(ligand, path):
    if not isinstance(ligand, dict):
        return [f'"{path}" must be an object']
    errors = []
    _check_unknown_keys(ligand, {"doi", "method", "ref_figure", "name", "SMILES", "regulatory_effect", "kd"}, path, errors)
    _required_str_pattern(ligand, "doi", DOI_PATTERN, path, errors)
    _required_enum(ligand, "method", LIGAND_METHODS, path, errors)
    _required_str_pattern(ligand, "ref_figure", REF_FIGURE_PATTERN, path, errors)
    _required_str_maxlen(ligand, "name", 64, path, errors)
    _required_str(ligand, "SMILES", path, errors)
    _optional_enum_allow_empty_null(ligand, "regulatory_effect", REGULATORY_EFFECT_ENUM, path, errors)
    _optional_number_allow_null(ligand, "kd", path, errors)
    return errors


def _validate_operator(operator, path):
    if not isinstance(operator, dict):
        return [f'"{path}" must be an object']
    errors = []
    _check_unknown_keys(operator, {"doi", "method", "ref_figure", "sequence", "kd"}, path, errors)
    _required_str_pattern(operator, "doi", DOI_PATTERN, path, errors)
    _required_enum(operator, "method", OPERATOR_METHODS, path, errors)
    _required_str_pattern(operator, "ref_figure", REF_FIGURE_PATTERN, path, errors)

    if "sequence" not in operator or operator.get("sequence") is None:
        errors.append(f'"{path}.sequence" is required')
    elif not isinstance(operator["sequence"], str):
        errors.append(f'"{path}.sequence" must be a string')
    else:
        seq = operator["sequence"]
        if len(seq) > 512:
            errors.append(f'"{path}.sequence" length must be <= 512 characters')
        if not SEQUENCE_PATTERN.match(seq):
            errors.append(f'"{path}.sequence" fails to match the required pattern')

    _optional_number_allow_null(operator, "kd", path, errors)
    return errors


def _validate_light_stimulus(item, path):
    if not isinstance(item, dict):
        return [f'"{path}" must be an object']
    errors = []
    _check_unknown_keys(item, {"wavelength", "regulatory_effect", "doi", "method", "ref_figure"}, path, errors)
    _required_number(item, "wavelength", path, errors)
    _optional_enum_allow_empty_null(item, "regulatory_effect", REGULATORY_EFFECT_ENUM, path, errors)
    _required_str_pattern(item, "doi", DOI_PATTERN, path, errors)
    _required_str(item, "method", path, errors)
    _required_str_pattern(item, "ref_figure", REF_FIGURE_PATTERN, path, errors)
    return errors


def _validate_temperature_stimulus(item, path):
    if not isinstance(item, dict):
        return [f'"{path}" must be an object']
    errors = []
    _check_unknown_keys(item, {"temperature", "regulatory_effect", "doi", "method", "ref_figure"}, path, errors)
    _required_number(item, "temperature", path, errors)
    _optional_enum_allow_empty_null(item, "regulatory_effect", REGULATORY_EFFECT_ENUM, path, errors)
    _required_str_pattern(item, "doi", DOI_PATTERN, path, errors)
    _required_str(item, "method", path, errors)
    _required_str_pattern(item, "ref_figure", REF_FIGURE_PATTERN, path, errors)
    return errors


def _validate_mutation_entry(item, path):
    if not isinstance(item, dict):
        return [f'"{path}" must be an object']
    errors = []
    _check_unknown_keys(item, {"mutations", "ref_type", "ref_id"}, path, errors)

    if "mutations" not in item or item.get("mutations") is None:
        errors.append(f'"{path}.mutations" is required')
    elif not isinstance(item["mutations"], list):
        errors.append(f'"{path}.mutations" must be an array')
    else:
        muts = item["mutations"]
        if len(muts) < 1:
            errors.append(f'"{path}.mutations" must contain at least 1 item(s)')
        for idx, m in enumerate(muts):
            if not isinstance(m, str):
                errors.append(f'"{path}.mutations[{idx}]" must be a string')
            elif len(m) > 32:
                errors.append(f'"{path}.mutations[{idx}]" length must be <= 32 characters')

    _required_enum(item, "ref_type", REF_TYPE_ENUM, path, errors)
    _required_str_maxlen(item, "ref_id", 64, path, errors)
    return errors


def _validate_protein(protein, path):
    if not isinstance(protein, dict):
        return [f'"{path}" must be an object']
    errors = []
    _check_unknown_keys(
        protein,
        {"alias", "uniProtID", "accession", "family", "ligands", "operators",
         "light_stimuli", "temperature_stimuli", "mutations"},
        path,
        errors,
    )

    # alias
    if "alias" not in protein or protein.get("alias") is None:
        errors.append(f'"{path}.alias" is required')
    elif not isinstance(protein["alias"], str):
        errors.append(f'"{path}.alias" must be a string')
    else:
        alias = protein["alias"]
        if len(alias) > 16:
            errors.append(f'"{path}.alias" length must be <= 16 characters')
        if not ALIAS_PATTERN.match(alias):
            errors.append(f'"{path}.alias" fails to match the required pattern')

    # uniProtID (required, empty string fails since pattern requires 1+ chars)
    if "uniProtID" not in protein or protein.get("uniProtID") is None:
        errors.append(f'"{path}.uniProtID" is required')
    elif not isinstance(protein["uniProtID"], str):
        errors.append(f'"{path}.uniProtID" must be a string')
    elif not UNIPROT_PATTERN.match(protein["uniProtID"]):
        errors.append(f'"{path}.uniProtID" fails to match the required pattern')

    # accession (optional, allow '')
    if "accession" in protein and protein["accession"] is not None:
        accession = protein["accession"]
        if not isinstance(accession, str):
            errors.append(f'"{path}.accession" must be a string')
        elif accession != "" and not ACCESSION_PATTERN.match(accession):
            errors.append(f'"{path}.accession" fails to match the required pattern')

    # family
    _required_enum(protein, "family", FAMILY_ENUM, path, errors)

    # at least one of ligands/operators/light_stimuli/temperature_stimuli must be present
    stim_keys = ("ligands", "operators", "light_stimuli", "temperature_stimuli")
    if not any(key in protein for key in stim_keys):
        errors.append(
            f'"{path}" must contain at least one of [ligands, operators, light_stimuli, temperature_stimuli]'
        )

    if "ligands" in protein and protein["ligands"] is not None:
        errors.extend(_validate_array(protein["ligands"], f"{path}.ligands", _validate_ligand, min_len=1))
    if "operators" in protein and protein["operators"] is not None:
        errors.extend(_validate_array(protein["operators"], f"{path}.operators", _validate_operator, min_len=1))
    if "light_stimuli" in protein and protein["light_stimuli"] is not None:
        errors.extend(_validate_array(protein["light_stimuli"], f"{path}.light_stimuli", _validate_light_stimulus, min_len=1))
    if "temperature_stimuli" in protein and protein["temperature_stimuli"] is not None:
        errors.extend(_validate_array(protein["temperature_stimuli"], f"{path}.temperature_stimuli", _validate_temperature_stimulus, min_len=1))
    if "mutations" in protein and protein["mutations"] is not None:
        errors.extend(_validate_array(protein["mutations"], f"{path}.mutations", _validate_mutation_entry, min_len=None))

    return errors


def _validate_sensor(sensor, path):
    if not isinstance(sensor, dict):
        return [f'"{path}" must be an object']
    errors = []
    _check_unknown_keys(sensor, {"mechanism", "about", "proteins"}, path, errors)

    _required_enum(sensor, "mechanism", MECHANISM_ENUM, path, errors)

    if "about" in sensor and sensor["about"] is not None:
        about = sensor["about"]
        if not isinstance(about, str):
            errors.append(f'"{path}.about" must be a string')
        elif about != "" and len(about) > 500:
            errors.append(f'"{path}.about" length must be <= 500 characters')

    if "proteins" not in sensor or sensor.get("proteins") is None:
        errors.append(f'"{path}.proteins" is required')
    else:
        proteins = sensor["proteins"]
        if not isinstance(proteins, list):
            errors.append(f'"{path}.proteins" must be an array')
        else:
            if len(proteins) < 1:
                errors.append(f'"{path}.proteins" must contain at least 1 item(s)')
            for idx, protein in enumerate(proteins):
                errors.extend(_validate_protein(protein, f"{path}.proteins[{idx}]"))

            families = [p.get("family") if isinstance(p, dict) else None for p in proteins]
            uses_two_component_family = any(f in TWO_COMPONENT_ONLY_FAMILIES for f in families)
            if uses_two_component_family and len(proteins) < 2:
                errors.append(
                    "OmpR and HisKA families are only valid for two-component systems (2 or more proteins)"
                )

    return errors


def _validate_main(body):
    if not isinstance(body, dict):
        return ['"value" must be of type object']
    errors = []
    _check_unknown_keys(body, {"sensor", "user", "timeSubmit"}, "value", errors)

    if "sensor" not in body or body.get("sensor") is None:
        errors.append('"sensor" is required')
    else:
        errors.extend(_validate_sensor(body["sensor"], "sensor"))

    if "user" in body and body["user"] is not None and not isinstance(body["user"], str):
        errors.append('"user" must be a string')

    if "timeSubmit" in body and body["timeSubmit"] is not None and not _is_number(body["timeSubmit"]):
        errors.append('"timeSubmit" must be a number')

    return errors


# ---------------------------------------------------------------------------
# Prod duplicate detection
# ---------------------------------------------------------------------------

def _is_two_component_submission(proteins):
    return len(proteins) >= 2 or any(p.get("family") in TWO_COMPONENT_ONLY_FAMILIES for p in proteins)


def _prod_categories_for(proteins):
    if _is_two_component_submission(proteins):
        return ["Dual"]
    return list(dict.fromkeys(p.get("family") for p in proteins))


def _collect_prod_uniprot_ids(table, category):
    ids = set()
    last_key = None
    while True:
        kwargs = {"KeyConditionExpression": Key("category").eq(category)}
        if last_key is not None:
            kwargs["ExclusiveStartKey"] = last_key
        res = table.query(**kwargs)
        for item in (res or {}).get("Items", []) or []:
            for protein in (item.get("data") or {}).get("proteins", []) or []:
                uid = protein.get("uniprot_id") if isinstance(protein, dict) else None
                if uid:
                    ids.add(uid)
        last_key = (res or {}).get("LastEvaluatedKey")
        if not last_key:
            break
    return ids


def _find_prod_duplicate(table, proteins):
    existing = set()
    for category in _prod_categories_for(proteins):
        existing |= _collect_prod_uniprot_ids(table, category)
    for p in proteins:
        if p.get("uniProtID") in existing:
            return p.get("uniProtID")
    return None


def _write_to_temp(table, submission_uuid, body):
    item = {"PK": "TEMP", "SK": submission_uuid, **body}
    table.put_item(Item=item)


def lambda_handler(event, context=None):
    cors_headers = _cors_headers(event, "POST,OPTIONS")

    if _method(event) == "OPTIONS":
        return {"statusCode": 200, "headers": cors_headers}

    try:
        body = json.loads(event.get("body"))
    except (json.JSONDecodeError, TypeError):
        return {
            "statusCode": 400,
            "headers": cors_headers,
            "body": json.dumps({"message": "Invalid JSON in request body"}),
        }

    errors = _validate_main(body)
    if errors:
        return {
            "statusCode": 400,
            "headers": cors_headers,
            "body": json.dumps({"type": "Validation Error", "errors": errors}),
        }

    proteins = body["sensor"]["proteins"]

    try:
        prod_table = _table(os.environ.get("PROD_TABLE_V2_NAME"))
        duplicate_id = _find_prod_duplicate(prod_table, proteins)
        if duplicate_id:
            return {
                "statusCode": 409,
                "headers": cors_headers,
                "body": json.dumps({
                    "message": f"The uniProtID {duplicate_id} already exists in our database. "
                               f"If there's an issue, please submit a bug report."
                }),
            }
    except Exception:
        return {
            "statusCode": 500,
            "headers": cors_headers,
            "body": json.dumps({"message": "Error checking for duplicate submission. Please notify the administrators."}),
        }

    submission_uuid = str(uuid.uuid4())

    try:
        temp_table = _table(os.environ.get("TEMP_TABLE_V2_NAME"))
        _write_to_temp(temp_table, submission_uuid, body)
    except Exception:
        return {
            "statusCode": 500,
            "headers": cors_headers,
            "body": json.dumps({"message": "Error processing submission. Please notify the administrators."}),
        }

    return {
        "statusCode": 202,
        "headers": cors_headers,
        "body": json.dumps({"submissionUUID": submission_uuid}),
    }
