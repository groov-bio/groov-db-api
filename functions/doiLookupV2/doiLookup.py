import json

import requests

ALLOWED_ORIGINS = ["http://localhost:3000", "https://groov.bio", "https://www.groov.bio"]


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
    return (((event.get("requestContext") or {}).get("http") or {}).get("method"))


def _err_body(status_code, message, headers):
    return {
        "statusCode": status_code,
        "headers": headers,
        "body": json.dumps({"message": message}),
    }


def _fetch_csl(doi):
    resp = requests.get(
        f"https://doi.org/{doi}",
        headers={"Accept": "application/vnd.citationstyles.csl+json"},
        timeout=15,
        allow_redirects=True,
    )
    resp.raise_for_status()
    return resp.json()


def lookup_reference(doi):
    """Resolve a DOI to reference metadata using DOI content negotiation.

    This replaces citation-js's `new Cite(doi)` + `.format('data', {template: 'apa'})`
    call from the Node handler. Content negotiation returns a single CSL-JSON object
    (whereas citation-js's `.format('data')` returns an array of CSL entries), so we
    normalize to a list here and then loop exactly like the original JS to extract
    identical fields. Author names are emitted as { last_name, first_name } to match
    the stored/edited reference shape.

    A network error, non-2xx response, or unparsable body raises and is treated as an
    unresolvable DOI by the caller.
    """
    data = _fetch_csl(doi)
    entries = data if isinstance(data, list) else [data]

    title = ""
    authors = []
    year = None
    journal = ""
    resolved_doi = ""
    url = ""

    for entry in entries:
        if entry.get("author"):
            for a in entry["author"]:
                authors.append({"last_name": a.get("family"), "first_name": a.get("given")})
        if entry.get("title"):
            title = entry["title"]
        issued = entry.get("issued") or {}
        if issued.get("date-parts"):
            year = issued["date-parts"][0][0]
        if entry.get("container-title-short"):
            journal = entry["container-title-short"]
        elif entry.get("container-title"):
            journal = entry["container-title"]
        if entry.get("DOI"):
            resolved_doi = entry["DOI"]
        if entry.get("URL"):
            url = entry["URL"]

    return {
        "title": title or None,
        "authors": authors,
        # Year is stored as a string everywhere (matches addNewSensorV2 + the edit form).
        "year": str(year) if year is not None else None,
        "journal": journal or None,
        "doi": resolved_doi or doi,
        "url": url or None,
    }


def lambda_handler(event, context=None):
    cors_headers = _cors_headers(event, "GET,OPTIONS")

    if _method(event) == "OPTIONS":
        return {"statusCode": 200, "headers": cors_headers}

    query_params = event.get("queryStringParameters") or {}
    doi = query_params.get("doi")
    doi = doi.strip() if doi else doi
    if not doi:
        return _err_body(400, "Missing required query parameter: doi", cors_headers)

    try:
        reference = lookup_reference(doi)
    except Exception:
        return _err_body(404, f"Could not resolve DOI: {doi}", cors_headers)

    # DOI content negotiation can return an effectively empty CSL record for a
    # syntactically valid but unknown DOI.
    if not reference["title"] and len(reference["authors"]) == 0:
        return _err_body(404, f"No metadata found for DOI: {doi}", cors_headers)

    return {
        "statusCode": 200,
        "headers": {**cors_headers, "Content-Type": "application/json"},
        "body": json.dumps({"reference": reference}),
    }
