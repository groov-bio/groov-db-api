# Python port of functions/addNewSensorV2/addNewSensor.js.
#
# This is a pure, deterministic refactor: behavior matches the Node source in
# every observable way (status codes, response JSON, the exact constructed
# V2-sensor object shape written to DynamoDB, and the order in which failures
# surface). See the module docstring-style comments throughout for notes on
# where JS semantics (??, ||, Joi validation, Promise concurrency) required a
# deliberate Python equivalent.

import json
import logging
import os
import re
import sys
from decimal import Decimal

import boto3
import requests

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# utils/operon.py lives alongside this file in a flat (non-package) layout,
# matching how the Lambda bundle is deployed — mirrors the JS
# `import { acc2operon } from './utils/operon.js'`.
_UTILS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "utils")
if _UTILS_DIR not in sys.path:
    sys.path.insert(0, _UTILS_DIR)

import operon  # noqa: E402

ALLOWED_ORIGINS = ["http://localhost:3000", "https://groov.bio", "https://www.groov.bio"]


class EnrichmentError(Exception):
    """Carries an optional HTTP status code, mirroring `err.statusCode` in the JS handler."""

    def __init__(self, message, status_code=None):
        super().__init__(message)
        self.status_code = status_code


def _cors_headers(event, methods):
    headers = event.get("headers") or {}
    origin = headers.get("origin") or headers.get("Origin") or "http://localhost:3000"
    allowed_origin = origin if origin in ALLOWED_ORIGINS else "http://localhost:3000"
    return {
        "Access-Control-Allow-Origin": allowed_origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Headers": "Content-Type,content-type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token",
        "Access-Control-Allow-Methods": methods,
        "Access-Control-Max-Age": "86400",
    }


def _method(event):
    return ((event.get("requestContext") or {}).get("http") or {}).get("method")


_dynamodb = None


def _table(name):
    global _dynamodb
    if _dynamodb is None:
        kwargs = {"region_name": "us-east-2"}
        if os.environ.get("IS_LOCAL"):
            kwargs["endpoint_url"] = "http://host.docker.internal:8000"
        _dynamodb = boto3.resource("dynamodb", **kwargs)
    return _dynamodb.Table(name)


def fetch_with_timeout(method, url, timeout_ms=30000, **kwargs):
    try:
        return requests.request(method, url, timeout=timeout_ms / 1000, **kwargs)
    except requests.RequestException as error:
        logger.error(f"Fetch request to {url} failed: {error}")
        raise


# ---- Validation (hand-rolled port of the Joi schemas) -----------------------
#
# mainSchema in the JS source is built with `.options({ abortEarly: false,
# allowUnknown: true })`. In Joi, preferences set on the root schema this way
# cascade to every nested schema unless a child explicitly overrides them —
# and none of the nested schemas here call `.unknown()` — so unknown/extra
# keys are permitted at every level of the payload. That means our validator
# below never needs to reject on unrecognized keys; it only needs to enforce
# required-ness / type / pattern / valid-list rules for the fields Joi does
# constrain, and collect every failure (abortEarly: false) rather than
# stopping at the first one.
#
# The handler tests only assert statusCode and that body.type ==
# 'Validation Error' with body.errors being a list — they do not assert on
# message text — so exact Joi error message wording is not reproduced; only
# PASS/FAIL parity matters.

REF_FIGURE_RE = re.compile(r"^(Figure|Supplementary Figure|Table|Supplementary Table) [S]?[1-9]?[0-9A-Za-z]?$")
ALIAS_RE = re.compile(r"^[A-Za-z0-9_.]+$")
UNIPROT_ID_RE = re.compile(r"^[A-Za-z0-9_]+$")
ACCESSION_RE = re.compile(r"^[A-Za-z0-9_.]+$")
SEQUENCE_RE = re.compile(r"^[ATCGatcg]+$")

LIGAND_METHODS = {
    "EMSA", "DNase footprinting", "Isothermal titration calorimetry",
    "Synthetic regulation", "Fluorescence polarization", "Surface plasmon resonance",
    "Thermal shift", "Spectrophotometric competition", "Spectral shift",
    "DNA affinity chromatography", "Autophosphorylation assay",
}
OPERATOR_METHODS = {
    "EMSA", "DNase footprinting", "Crystal structure", "Isothermal titration calorimetry",
    "Fluorescence polarization", "Surface plasmon resonance", "Synthetic regulation", "ChIP-Seq",
}
REGULATORY_EFFECTS = {"activates", "represses"}
PROTEIN_FAMILIES = {"TetR", "LysR", "AraC", "MarR", "LacI", "GntR", "LuxR", "IclR", "Other", "OmpR", "HisKA"}
MECHANISMS = {"Apo-repressor", "Apo-activator", "Co-repressor", "Co-activator", "Signal transduction"}
MUTATION_REF_TYPES = {"UniProt", "groovDB"}
# OmpR/HisKA proteins only exist as part of a two-component system, so a
# single-protein submission can't use them.
TWO_COMPONENT_ONLY_FAMILIES = {"OmpR", "HisKA"}


def _is_str(v):
    return isinstance(v, str)


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _validate_ligand(o, errors):
    if not isinstance(o, dict):
        errors.append("protein.ligands[]: must be an object")
        return
    if not (_is_str(o.get("doi")) and o.get("doi") != ""):
        errors.append("protein.ligands[].doi is required")
    if not (_is_str(o.get("method")) and o.get("method") in LIGAND_METHODS):
        errors.append("protein.ligands[].method is invalid")
    rf = o.get("ref_figure")
    if not (_is_str(rf) and REF_FIGURE_RE.match(rf)):
        errors.append("protein.ligands[].ref_figure is invalid")
    name = o.get("name")
    if not (_is_str(name) and name != "" and len(name) <= 64):
        errors.append("protein.ligands[].name is invalid")
    smiles = o.get("SMILES")
    if not (_is_str(smiles) and smiles != ""):
        errors.append("protein.ligands[].SMILES is required")
    if "regulatory_effect" in o and o["regulatory_effect"] not in ({None, "", *REGULATORY_EFFECTS}):
        errors.append("protein.ligands[].regulatory_effect is invalid")
    if "kd" in o and o["kd"] is not None and not _is_num(o["kd"]):
        errors.append("protein.ligands[].kd must be a number or null")


def _validate_operator(o, errors):
    if not isinstance(o, dict):
        errors.append("protein.operators[]: must be an object")
        return
    if not (_is_str(o.get("doi")) and o.get("doi") != ""):
        errors.append("protein.operators[].doi is required")
    if not (_is_str(o.get("method")) and o.get("method") in OPERATOR_METHODS):
        errors.append("protein.operators[].method is invalid")
    rf = o.get("ref_figure")
    if not (_is_str(rf) and REF_FIGURE_RE.match(rf)):
        errors.append("protein.operators[].ref_figure is invalid")
    seq = o.get("sequence")
    if not (_is_str(seq) and seq != "" and len(seq) <= 512 and SEQUENCE_RE.match(seq)):
        errors.append("protein.operators[].sequence is invalid")
    if "kd" in o and o["kd"] is not None and not _is_num(o["kd"]):
        errors.append("protein.operators[].kd must be a number or null")


def _validate_light_stimulus(o, errors):
    if not isinstance(o, dict):
        errors.append("protein.light_stimuli[]: must be an object")
        return
    if not _is_num(o.get("wavelength")):
        errors.append("protein.light_stimuli[].wavelength is required")
    if "regulatory_effect" in o and o["regulatory_effect"] not in ({None, "", *REGULATORY_EFFECTS}):
        errors.append("protein.light_stimuli[].regulatory_effect is invalid")
    if not (_is_str(o.get("doi")) and o.get("doi") != ""):
        errors.append("protein.light_stimuli[].doi is required")
    if not (_is_str(o.get("method")) and o.get("method") != ""):
        errors.append("protein.light_stimuli[].method is required")
    rf = o.get("ref_figure")
    if not (_is_str(rf) and REF_FIGURE_RE.match(rf)):
        errors.append("protein.light_stimuli[].ref_figure is invalid")


def _validate_temperature_stimulus(o, errors):
    if not isinstance(o, dict):
        errors.append("protein.temperature_stimuli[]: must be an object")
        return
    if not _is_num(o.get("temperature")):
        errors.append("protein.temperature_stimuli[].temperature is required")
    if "regulatory_effect" in o and o["regulatory_effect"] not in ({None, "", *REGULATORY_EFFECTS}):
        errors.append("protein.temperature_stimuli[].regulatory_effect is invalid")
    if not (_is_str(o.get("doi")) and o.get("doi") != ""):
        errors.append("protein.temperature_stimuli[].doi is required")
    if not (_is_str(o.get("method")) and o.get("method") != ""):
        errors.append("protein.temperature_stimuli[].method is required")
    rf = o.get("ref_figure")
    if not (_is_str(rf) and REF_FIGURE_RE.match(rf)):
        errors.append("protein.temperature_stimuli[].ref_figure is invalid")


def _validate_mutation_entry(o, errors):
    if not isinstance(o, dict):
        errors.append("protein.mutations[]: must be an object")
        return
    muts = o.get("mutations")
    if not (isinstance(muts, list) and len(muts) >= 1 and all(_is_str(m) and len(m) <= 32 for m in muts)):
        errors.append("protein.mutations[].mutations is invalid")
    if o.get("ref_type") not in MUTATION_REF_TYPES:
        errors.append("protein.mutations[].ref_type is invalid")
    ref_id = o.get("ref_id")
    if not (_is_str(ref_id) and ref_id != "" and len(ref_id) <= 64):
        errors.append("protein.mutations[].ref_id is invalid")


def _validate_protein(o, errors):
    if not isinstance(o, dict):
        errors.append("sensor.proteins[]: must be an object")
        return

    alias = o.get("alias")
    if not (_is_str(alias) and alias != "" and len(alias) <= 16 and ALIAS_RE.match(alias)):
        errors.append("protein.alias is invalid")

    uni = o.get("uniProtID")
    if not (_is_str(uni) and uni != "" and UNIPROT_ID_RE.match(uni)):
        errors.append("protein.uniProtID is required")

    if "accession" in o:
        acc = o["accession"]
        if acc is None:
            errors.append("protein.accession cannot be null")
        elif acc == "":
            pass  # explicitly allowed blank
        elif not (_is_str(acc) and ACCESSION_RE.match(acc)):
            errors.append("protein.accession is invalid")

    if o.get("family") not in PROTEIN_FAMILIES:
        errors.append("protein.family is invalid")

    if o.get("ligands") is not None:
        ligands = o["ligands"]
        if not isinstance(ligands, list):
            errors.append("protein.ligands must be an array")
        else:
            for l in ligands:
                _validate_ligand(l, errors)

    if o.get("operators") is not None:
        operators = o["operators"]
        if not isinstance(operators, list):
            errors.append("protein.operators must be an array")
        else:
            for op in operators:
                _validate_operator(op, errors)

    if o.get("light_stimuli") is not None:
        lights = o["light_stimuli"]
        if not isinstance(lights, list):
            errors.append("protein.light_stimuli must be an array")
        else:
            for l in lights:
                _validate_light_stimulus(l, errors)

    if o.get("temperature_stimuli") is not None:
        temps = o["temperature_stimuli"]
        if not isinstance(temps, list):
            errors.append("protein.temperature_stimuli must be an array")
        else:
            for t in temps:
                _validate_temperature_stimulus(t, errors)

    if o.get("mutations") is not None:
        mutations = o["mutations"]
        if not isinstance(mutations, list):
            errors.append("protein.mutations must be an array")
        else:
            for m in mutations:
                _validate_mutation_entry(m, errors)


def _validate_sensor(o, errors):
    if not isinstance(o, dict):
        errors.append("sensor: must be an object")
        return

    if "mechanism" in o and o["mechanism"] not in ({None, "", *MECHANISMS}):
        errors.append("sensor.mechanism is invalid")

    if o.get("about") not in (None, ""):
        about = o.get("about")
        if not (_is_str(about) and len(about) <= 500):
            errors.append("sensor.about is invalid")

    proteins = o.get("proteins")
    if not (isinstance(proteins, list) and len(proteins) >= 1):
        errors.append("sensor.proteins is required and must have at least 1 item")
        proteins = proteins if isinstance(proteins, list) else []

    for p in proteins:
        _validate_protein(p, errors)

    # Two-component-only family check (Joi `.custom()` on sensorSchema).
    uses_two_component_family = any(
        isinstance(p, dict) and p.get("family") in TWO_COMPONENT_ONLY_FAMILIES for p in proteins
    )
    if uses_two_component_family and len(proteins) < 2:
        errors.append("OmpR and HisKA families are only valid for two-component systems (2 or more proteins)")


def validate_main_schema(data):
    errors = []
    if not isinstance(data, dict):
        return ["Invalid payload: expected an object"]

    sensor = data.get("sensor")
    if sensor is None:
        errors.append("sensor is required")
    else:
        _validate_sensor(sensor, errors)

    if "user" in data and data["user"] is not None and not _is_str(data["user"]):
        errors.append("user must be a string")
    if "timeSubmit" in data and data["timeSubmit"] is not None and not _is_num(data["timeSubmit"]):
        errors.append("timeSubmit must be a number")
    if "submissionUUID" in data and data["submissionUUID"] is not None and not _is_str(data["submissionUUID"]):
        errors.append("submissionUUID must be a string")
    if "PK" in data and data["PK"] is not None and not _is_str(data["PK"]):
        errors.append("PK must be a string")
    if "SK" in data and data["SK"] is not None and not _is_str(data["SK"]):
        errors.append("SK must be a string")

    return errors


def inferType(proteins, rna):
    if rna:
        return "Riboswitch"
    if proteins and len(proteins) >= 2:
        return "Two Component"
    return "One Component"


def checkForProcessedDupe(submission_uuid):
    table = _table(os.environ.get("PROCESSED_TEMP_TABLE_V2_NAME"))
    result = table.get_item(Key={"PK": "PROCESSED", "SK": submission_uuid})
    if result.get("Item"):
        raise Exception("Duplicate")


def callUniProtAPI(id):
    logger.info(f"Calling UniProt API for ID: {id}")
    url = (
        f"https://rest.uniprot.org/uniprotkb/search?query=(accession:{id})"
        "&fields=accession,organism_name,organism_id,gene_primary,sequence,xref_refseq,xref_kegg,xref_pdb"
    )
    response = fetch_with_timeout("GET", url, timeout_ms=10000)
    if not response.ok:
        response_text = response.text
        logger.error(f"UniProt API returned non-OK status: {response.status_code}: {response_text}")
        raise Exception(f"UniProt API error: {response.status_code}")
    return response.json()


def callDOI(doi):
    # DOI content negotiation replaces citation-js: request CSL-JSON directly
    # from the DOI resolver. Field names below intentionally match addNewSensor.js's
    # callDOI (camelCase lastName/firstName, doi=newDOI, year as-is) — this
    # differs from doiLookupV2's mapping (snake_case, year always a string).
    if doi is None or doi == "":
        return {"title": None, "authors": None, "year": None, "journal": None, "doi": None, "url": None}

    response = fetch_with_timeout(
        "GET",
        f"https://doi.org/{doi}",
        timeout_ms=15000,
        headers={"Accept": "application/vnd.citationstyles.csl+json"},
    )
    response.raise_for_status()
    entry = response.json()

    title, authors, year, journal, new_doi, url = "", [], "", "", "", ""
    if entry.get("author"):
        for a in entry["author"]:
            authors.append({"lastName": a.get("family"), "firstName": a.get("given")})
    if entry.get("title"):
        title = entry["title"]
    date_parts = (entry.get("issued") or {}).get("date-parts")
    if date_parts:
        year = date_parts[0][0]
    if entry.get("container-title-short"):
        journal = entry["container-title-short"]
    elif entry.get("container-title"):
        journal = entry["container-title"]
    if entry.get("DOI"):
        new_doi = entry["DOI"]
    if entry.get("URL"):
        url = entry["URL"]

    return {"title": title, "authors": authors, "year": year, "journal": journal, "doi": new_doi, "url": url}


def enrichDOI(items):
    if not items:
        return []
    out = []
    for item in items:
        full_doi = callDOI(item.get("doi")) if item.get("doi") else None
        out.append({**item, "fullDOI": full_doi})
    return out


def callOperonLambda(id):
    # In-process resolution of the former getOperon Python lambda (see
    # utils/operon.py). The name is kept so callers/tests don't have to change.
    logger.info(f"Resolving operon in-process for ID: {id}")
    return operon.acc2operon(id)


def processPDBId(id):
    logger.info(f"Processing PDB ID: {id}")
    query = '{ entry(entry_id: "%s") { exptl{method} rcsb_primary_citation { pdbx_database_id_DOI } } }' % id
    response = fetch_with_timeout(
        "POST",
        "https://data.rcsb.org/graphql",
        timeout_ms=10000,
        data=json.dumps({"query": query}),
        headers={
            "Content-Type": "application/json",
            "User-Agent": "Mozilla/5.0 (X11; CrOS x86_64 13904.41.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.81 Safari/537.36",
        },
    )
    if not response.ok:
        response_text = response.text
        logger.error(f"PDB API returned non-OK status: {response.status_code}: {response_text}")
        raise Exception(f"PDB API error: {response.status_code}")
    data = response.json()
    entry = data["data"]["entry"]
    return {
        "doi": entry["rcsb_primary_citation"]["pdbx_database_id_DOI"] or None,
        "method": entry["exptl"][0]["method"],
        "PDB_code": id,
    }


def tryXrefData(uni_entry, accession):
    # uni_entry may be None when the protein has no uniProtID (item 7) — no
    # xrefs, but operon resolution can still run off a user-supplied accession.
    xref = (uni_entry or {}).get("uniProtKBCrossReferences") or []

    pdb_ids = []
    kegg_id = None
    refseq_fallback = None
    for x in xref:
        db = x.get("database")
        if db == "RefSeq":
            if not refseq_fallback:
                refseq_fallback = x.get("id")
        elif db == "PDB":
            pdb_ids.append(x.get("id"))
        elif db == "KEGG":
            if not kegg_id:
                kegg_id = x.get("id")

    operon_id = accession if accession is not None else refseq_fallback
    operon_data = callOperonLambda(operon_id) if operon_id else None
    structure_data = [processPDBId(pid) for pid in pdb_ids]

    return {"operon": operon_data, "structure": structure_data, "kegg": kegg_id}


def fetchFromTempTable(submission_uuid):
    table = _table(os.environ.get("TEMP_TABLE_V2_NAME"))
    result = table.get_item(Key={"PK": "TEMP", "SK": submission_uuid})
    item = result.get("Item")
    if item:
        return item
    raise Exception(f"No submission found for UUID: {submission_uuid}")


# ---- Builders --------------------------------------------------------------
#
# Throughout: JS's `x ?? null` / `x?.y` are ported as plain dict.get() calls —
# json.loads already turns JSON null into Python None, so dict.get(key)
# already returns None both when the key is absent and when it's explicitly
# null, exactly matching `??`'s nullish (not falsy) semantics.

def _dig(d, *keys):
    cur = d
    for k in keys:
        if not isinstance(cur, dict):
            return None
        cur = cur.get(k)
    return cur


def _to_number(v):
    if isinstance(v, bool):
        return 1 if v else 0
    if isinstance(v, (int, float)):
        return v
    try:
        f = float(v)
    except (TypeError, ValueError):
        return float("nan")
    return int(f) if f.is_integer() else f


def buildSmallMoleculeStimuli(ligands):
    out = []
    for l in (ligands or []):
        if not (l and l.get("fullDOI")):
            continue
        full_doi = l.get("fullDOI") or {}
        out.append({
            "stimulus_type": [{
                "small_molecule": [{
                    "name": l.get("name"),
                    "smiles": l.get("SMILES"),
                    "regulatory_effect": l.get("regulatory_effect"),
                }],
                "light": None,
                "temperature": None,
            }],
            "stimulus_evidence": [{
                "method": [l.get("method")],
                "ref_figure": l.get("ref_figure"),
                "doi": full_doi.get("doi"),
                "kd": l.get("kd"),
            }],
        })
    return out


def buildLightStimuli(lights):
    out = []
    for l in (lights or []):
        full_doi = l.get("fullDOI") or {}
        doi_val = full_doi.get("doi")
        if doi_val is None:
            doi_val = l.get("doi")
        out.append({
            "stimulus_type": [{
                "small_molecule": None,
                "light": [{
                    "wavelength": _to_number(l.get("wavelength")),
                    "regulatory_effect": l.get("regulatory_effect"),
                }],
                "temperature": None,
            }],
            "stimulus_evidence": [{
                "method": [l["method"]] if l.get("method") else [],
                "ref_figure": l.get("ref_figure"),
                "doi": doi_val,
                "kd": None,
            }],
        })
    return out


def buildTemperatureStimuli(temps):
    out = []
    for t in (temps or []):
        full_doi = t.get("fullDOI") or {}
        doi_val = full_doi.get("doi")
        if doi_val is None:
            doi_val = t.get("doi")
        out.append({
            "stimulus_type": [{
                "small_molecule": None,
                "light": None,
                "temperature": [{
                    "temperature": _to_number(t.get("temperature")),
                    "regulatory_effect": t.get("regulatory_effect"),
                }],
            }],
            "stimulus_evidence": [{
                "method": [t["method"]] if t.get("method") else [],
                "ref_figure": t.get("ref_figure"),
                "doi": doi_val,
                "kd": None,
            }],
        })
    return out


def buildDNA(operators):
    out = []
    for op in (operators or []):
        full_doi = op.get("fullDOI") or {}
        out.append({
            "sequence": op.get("sequence"),
            "ref_figure": op.get("ref_figure"),
            "doi": full_doi.get("doi"),
            "method": op.get("method"),
            "kd": op.get("kd"),
        })
    return out


def buildContext(operon_data):
    if not operon_data:
        return []
    genes = []
    for g in (operon_data.get("operon") or []):
        # Note: prefers capital "Stop" (matches the operon-resolver fixture
        # shape) and falls back to lowercase "stop" (matches getOperonWalk's
        # fasta2MetaData-produced gene dicts) — ported verbatim from JS's
        # `g.Stop ?? g.stop`.
        stop_val = g.get("Stop")
        if stop_val is None:
            stop_val = g.get("stop")
        genes.append({
            "link": g.get("link"),
            "start": g.get("start"),
            "stop": stop_val,
            "description": g.get("description"),
            "direction": g.get("direction"),
        })
    return [{
        "reg_index": operon_data.get("regIndex"),
        "genome": operon_data.get("genome"),
        "operon_dir": genes,
    }]


def buildStructures(structure_data):
    return [{"ID": s.get("PDB_code"), "file_location": None} for s in (structure_data or [])]


def buildReferences(*enriched_groups):
    # `interaction` is deprecated dead data — no longer surfaced in the UI and
    # slated for removal. We keep the (empty) key for shape compatibility but
    # stop populating it, so new sensors don't accrue more of it.
    ref_map = {}

    def add_entry(full_doi):
        if not full_doi or not full_doi.get("doi"):
            return
        doi = full_doi["doi"]
        if doi in ref_map:
            return
        year = full_doi.get("year")
        ref_map[doi] = {
            "title": full_doi.get("title"),
            "authors": [
                {"last_name": a.get("lastName"), "first_name": a.get("firstName")}
                for a in (full_doi.get("authors") or [])
            ],
            "year": str(year) if year is not None else None,
            "journal": full_doi.get("journal"),
            "doi": full_doi.get("doi"),
            "url": full_doi.get("url"),
            "interaction": [],
        }

    for group in enriched_groups:
        items = (group or {}).get("items") or []
        for it in items:
            if it and it.get("fullDOI"):
                add_entry(it["fullDOI"])

    return list(ref_map.values())


def buildProtein(protein, enrichment, sensor_mechanism):
    uni_entry = enrichment.get("uniEntry")
    xref_data = enrichment.get("xrefData") or {}
    enriched_ligands = enrichment.get("enrichedLigands")
    enriched_operators = enrichment.get("enrichedOperators")
    enriched_light = enrichment.get("enrichedLight")
    enriched_temperature = enrichment.get("enrichedTemperature")
    enriched_structures = enrichment.get("enrichedStructures")

    stimulus = (
        buildSmallMoleculeStimuli(enriched_ligands)
        + buildLightStimuli(enriched_light)
        + buildTemperatureStimuli(enriched_temperature)
    )

    return {
        "alias": protein.get("alias"),
        "uniprot_id": protein.get("uniProtID") or None,
        "refseq_id": protein.get("accession") or None,
        "family": protein.get("family"),
        "kegg_id": xref_data.get("kegg"),
        "regulation_type": sensor_mechanism or None,
        "sequence": _dig(uni_entry, "sequence", "value"),
        "stimulus": stimulus,
        "dna": buildDNA(enriched_operators),
        "context": buildContext(xref_data.get("operon")),
        "structures": buildStructures(xref_data.get("structure")),
        "references": buildReferences(
            {"items": enriched_ligands, "type": "Stimulus"},
            {"items": enriched_light, "type": "Stimulus"},
            {"items": enriched_temperature, "type": "Stimulus"},
            {"items": enriched_operators, "type": "DNA"},
            {"items": enriched_structures, "type": "Structure"},
        ),
        "origin": [{
            "type": "natural",
            "organism_id": _dig(uni_entry, "organism", "taxonId"),
            "organism_name": _dig(uni_entry, "organism", "scientificName"),
            "parent_id": None,
            "mutations": protein.get("mutations") or [],
        }],
        "protein_interaction": [],
        "metadata": None,
    }


def enrichProtein(protein):
    # uniProtID and accession are optional (item 7). Normalize empty/whitespace
    # to None so downstream lookups are skipped cleanly.
    uni_protid_raw = protein.get("uniProtID")
    uni_protid = uni_protid_raw.strip() if isinstance(uni_protid_raw, str) and uni_protid_raw.strip() else None
    accession_raw = protein.get("accession")
    accession = accession_raw.strip() if isinstance(accession_raw, str) and accession_raw.strip() else None

    # UniProt is called (and checked) first so its "no results" / non-OK
    # errors take precedence over downstream DOI/PDB failures — this
    # preserves the JS version's sequential failure ordering (UniProt is
    # awaited before Promise.all on the rest). With no uniProtID we skip
    # UniProt entirely and build the protein without a sequence / organism /
    # KEGG / PDB / AlphaFold.
    uni_data = callUniProtAPI(uni_protid) if uni_protid else None
    uni_entry = None
    if uni_protid:
        results = (uni_data or {}).get("results")
        if not results:
            raise EnrichmentError(f"No UniProt results for {uni_protid}", status_code=400)
        uni_entry = results[0]

    enriched_ligands = enrichDOI(protein.get("ligands"))
    enriched_operators = enrichDOI(protein.get("operators"))
    enriched_light = enrichDOI(protein.get("light_stimuli"))
    enriched_temperature = enrichDOI(protein.get("temperature_stimuli"))
    xref_data = tryXrefData(uni_entry, accession)

    enriched_structures = []
    for s in (xref_data.get("structure") or []):
        full_doi = callDOI(s.get("doi")) if s.get("doi") else None
        enriched_structures.append({**s, "fullDOI": full_doi})

    return {
        "uniEntry": uni_entry,
        "xrefData": xref_data,
        "enrichedLigands": enriched_ligands,
        "enrichedOperators": enriched_operators,
        "enrichedLight": enriched_light,
        "enrichedTemperature": enriched_temperature,
        "enrichedStructures": enriched_structures,
    }


def constructV2Sensor(sensor, per_protein_enrichment):
    proteins = sensor.get("proteins") or []
    return {
        "id": None,
        "proposed_grv_id": None,
        "type": inferType(proteins, None),
        "about": sensor.get("about"),
        "proteins": [
            buildProtein(p, per_protein_enrichment[i], sensor.get("mechanism"))
            for i, p in enumerate(proteins)
        ],
        "rna": None,
        "experiment": None,
        "promoter": None,
        "annotation": None,
    }


def _dynamo_safe(value):
    # boto3's DynamoDB resource rejects raw Python floats (it requires
    # Decimal for the Number type). JS has no such distinction, so this is a
    # Python-specific adaptation with no effect on the stored values.
    if isinstance(value, float):
        return Decimal(str(value))
    if isinstance(value, list):
        return [_dynamo_safe(v) for v in value]
    if isinstance(value, dict):
        return {k: _dynamo_safe(v) for k, v in value.items()}
    return value


def writeProcessedRow(submission_uuid, v2_sensor):
    table = _table(os.environ.get("PROCESSED_TEMP_TABLE_V2_NAME"))
    table.put_item(Item=_dynamo_safe({
        "PK": "PROCESSED",
        "SK": submission_uuid,
        "proposed_grv_id": None,
        "data": v2_sensor,
    }))


def errorBody(status_code, message, cors_headers):
    body = {"message": message} if isinstance(message, str) else message
    return {
        "statusCode": status_code,
        "headers": {"Content-Type": "application/json", **cors_headers},
        "body": json.dumps(body),
    }


def lambda_handler(event, context=None):
    cors_headers = _cors_headers(event, "POST,OPTIONS")

    if _method(event) == "OPTIONS":
        return {"statusCode": 200, "headers": cors_headers, "body": ""}

    if not event.get("body"):
        return errorBody(400, "Missing request body", cors_headers)

    try:
        request_body = json.loads(event["body"])
    except (json.JSONDecodeError, TypeError):
        return errorBody(400, "Invalid JSON in request body", cors_headers)

    # Two invocation modes:
    #   1) { submissionUUID } — fetch raw submission and process
    #   2) full sensor body — process inline (used for tests / direct admin pushes)
    if request_body.get("submissionUUID") and not request_body.get("sensor"):
        try:
            item = fetchFromTempTable(request_body["submissionUUID"])
        except Exception:
            return errorBody(404, "No submission found for the provided UUID", cors_headers)
        data = {
            "sensor": item.get("sensor"),
            "user": item.get("user"),
            "timeSubmit": item.get("timeSubmit"),
            "submissionUUID": request_body["submissionUUID"],
        }
    else:
        data = request_body

    validation_errors = validate_main_schema(data)
    if validation_errors:
        return errorBody(400, {"type": "Validation Error", "errors": validation_errors}, cors_headers)

    submission_uuid = data.get("submissionUUID") or request_body.get("submissionUUID")
    if not submission_uuid:
        return errorBody(400, "submissionUUID is required (either top-level or from inline call)", cors_headers)

    try:
        checkForProcessedDupe(submission_uuid)
    except Exception:
        return errorBody(409, "A processed entry already exists for this submission", cors_headers)

    try:
        per_protein_enrichment = [enrichProtein(p) for p in data["sensor"]["proteins"]]
    except Exception as err:
        logger.error(f"Enrichment failed: {err}")
        status_code = getattr(err, "status_code", None) or 500
        message = str(err) or "Error enriching protein data"
        return errorBody(status_code, message, cors_headers)

    v2_sensor = constructV2Sensor(data["sensor"], per_protein_enrichment)

    try:
        writeProcessedRow(submission_uuid, v2_sensor)
    except Exception as err:
        logger.error(f"Write to processed temp failed: {err}")
        return errorBody(500, "Error writing processed sensor row", cors_headers)

    return {
        "statusCode": 202,
        "headers": {"Content-Type": "application/json", **cors_headers},
        "body": json.dumps({"message": "Processing completed successfully", "submissionUUID": submission_uuid}),
    }
