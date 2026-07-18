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
import sys
import time
from decimal import Decimal

import boto3
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# utils/operon.py lives alongside this file in a flat (non-package) layout,
# matching how the Lambda bundle is deployed — mirrors the JS
# `import { acc2operon } from './utils/operon.js'`.
_UTILS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "utils")
if _UTILS_DIR not in sys.path:
    sys.path.insert(0, _UTILS_DIR)

import operon  # noqa: E402
from groov_models import ADD_NEW_SENSOR_PAYLOAD, validate  # noqa: E402  (shared python-v2 layer)

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
        # No endpoint_url override for IS_LOCAL: boto3 auto-targets the
        # Floci-injected AWS_ENDPOINT_URL env var when present inside the
        # Lambda container. Prod is unaffected (that env var is unset there).
        kwargs = {"region_name": "us-east-2"}
        _dynamodb = boto3.resource("dynamodb", **kwargs)
    return _dynamodb.Table(name)


def fetch_with_timeout(method, url, timeout_ms=30000, session=None, **kwargs):
    # `session` lets callers route through a retry-configured requests.Session
    # (see the CrossRef DOI block below); when None we use the module-level
    # requests, matching the original bare-fetch behavior for UniProt/PDB.
    caller = session if session is not None else requests
    try:
        return caller.request(method, url, timeout=timeout_ms / 1000, **kwargs)
    except requests.RequestException as error:
        logger.error(f"Fetch request to {url} failed: {error}")
        raise


# ---- CrossRef DOI resolution: resilient + polite --------------------------
#
# DELIBERATE RESILIENCE IMPROVEMENT OVER THE JS SOURCE. addNewSensor.js resolved
# every citation DOI with a bare fetch and no retry, so a single CrossRef HTTP
# 429 (or a transient 5xx) raised and aborted the ENTIRE sensor. Heavily-curated
# sensors reliably tripped this — e.g. LmrR (A2RI36) has 32 structures but only
# 14 distinct DOIs, and re-resolving each occurrence burst CrossRef into a 429.
# This changes *how* DOIs are fetched, not *what* gets stored (all DOIs are still
# resolved); three additions make resolution robust while staying polite:
#   1) a module-level Session with bounded retry + exponential backoff on 429 and
#      transient 5xx, honoring CrossRef's Retry-After header. raise_on_status is
#      False so that once retries are exhausted the final response still reaches
#      callDOI's raise_for_status() below — preserving the original error text.
#   2) per-invocation memoization (_resolve_doi_cached) so each distinct DOI is
#      resolved at most once, which removes the request burst that causes the 429.
#   3) a descriptive User-Agent plus a light inter-request throttle so CrossRef
#      routes us through its lenient "polite pool".

_DOI_USER_AGENT = "GroovDB/1.0 (+https://groov.bio)"
_DOI_MIN_INTERVAL_S = 0.1  # >= 100ms between CrossRef requests, to smooth bursts


def _build_doi_session():
    session = requests.Session()
    retry = Retry(
        total=5,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=frozenset(["GET"]),
        backoff_factor=1.0,
        respect_retry_after_header=True,
        raise_on_status=False,
    )
    adapter = HTTPAdapter(max_retries=retry)
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    session.headers.update({"User-Agent": _DOI_USER_AGENT})
    return session


_doi_session = _build_doi_session()

_last_doi_request_time = 0.0


def _doi_throttle():
    global _last_doi_request_time
    elapsed = time.monotonic() - _last_doi_request_time
    if elapsed < _DOI_MIN_INTERVAL_S:
        time.sleep(_DOI_MIN_INTERVAL_S - elapsed)
    _last_doi_request_time = time.monotonic()


# DOI -> resolved reference memo, scoped to a single Lambda invocation. Cleared
# at the top of each enrichment run in lambda_handler so a warm container never
# serves a stale entry across invocations.
_doi_cache = {}


def _resolve_doi_cached(doi):
    if doi not in _doi_cache:
        _doi_cache[doi] = callDOI(doi)
    return _doi_cache[doi]


def validate_main_schema(data):
    # The full Joi->Pydantic schema now lives in the shared python-v2 layer
    # (groov_models.ADD_NEW_SENSOR_PAYLOAD). This endpoint's profile allows
    # unknown keys, makes sensor.mechanism optional, accepts plain-string DOIs,
    # and rejects an explicit-null protein.accession. Returns a list of error
    # strings (empty == valid) — same contract the handler already expects.
    return validate(ADD_NEW_SENSOR_PAYLOAD, data)


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

    # Routed through _doi_session (retry/backoff + polite User-Agent) and gated by
    # a light throttle — see the "CrossRef DOI resolution" block above. The session
    # transparently retries 429/5xx (honoring Retry-After); raise_for_status only
    # fires on the final response once retries are exhausted.
    _doi_throttle()
    response = fetch_with_timeout(
        "GET",
        f"https://doi.org/{doi}",
        timeout_ms=15000,
        session=_doi_session,
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
        full_doi = _resolve_doi_cached(item.get("doi")) if item.get("doi") else None
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

    # Dedup: many PDB structures on one sensor share a citation DOI, so resolve
    # each distinct DOI at most once per invocation (LmrR: 32 structures -> 14
    # distinct DOIs). This is what actually keeps us under CrossRef's limit.
    enriched_structures = []
    for s in (xref_data.get("structure") or []):
        full_doi = _resolve_doi_cached(s.get("doi")) if s.get("doi") else None
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

    # Fresh DOI memo per invocation so dedup spans all proteins in this sensor
    # while never carrying entries over to the next invocation on a warm container.
    _doi_cache.clear()
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
