import Cite from 'citation-js';

const allowedOrigins = [
  'http://localhost:3000',
  'https://groov.bio',
  'https://www.groov.bio',
];

const getCorsHeaders = (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || 'http://localhost:3000';
  const allowedOrigin = allowedOrigins.includes(origin) ? origin : 'http://localhost:3000';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type,content-type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
};

const errBody = (statusCode, message, headers) => ({
  statusCode,
  headers,
  body: JSON.stringify(typeof message === 'string' ? { message } : message),
});

/**
 * Resolve a DOI to reference metadata using citation-js — the same library and
 * CSL-JSON extraction used by addNewSensorV2's callDOI, kept in sync so the two
 * flows produce identical reference objects. Author names are emitted as
 * { last_name, first_name } to match the stored/edited reference shape.
 *
 * `new Cite(doi)` performs a blocking network fetch against the DOI resolver and
 * throws on an unresolvable DOI (e.g. HTTP 404).
 */
const lookupReference = (doi) => {
  const citation = new Cite(doi);
  const citeData = JSON.parse(citation.format('data', { template: 'apa' }));

  let title = '';
  const authors = [];
  let year = null;
  let journal = '';
  let resolvedDoi = '';
  let url = '';

  for (const entry of citeData) {
    if (entry.author) {
      for (const a of entry.author) {
        authors.push({ last_name: a.family ?? null, first_name: a.given ?? null });
      }
    }
    if (entry.title) title = entry.title;
    if (entry.issued?.['date-parts']) year = entry.issued['date-parts'][0][0];
    if (entry['container-title-short']) journal = entry['container-title-short'];
    else if (entry['container-title']) journal = entry['container-title'];
    if (entry.DOI) resolvedDoi = entry.DOI;
    if (entry.URL) url = entry.URL;
  }

  return {
    title: title || null,
    authors,
    // Year is stored as a string everywhere (matches addNewSensorV2 + the edit form).
    year: year != null ? String(year) : null,
    journal: journal || null,
    doi: resolvedDoi || doi,
    url: url || null,
  };
};

export const handler = async (event) => {
  const corsHeaders = getCorsHeaders(event);

  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders };
  }

  const doi = event.queryStringParameters?.doi?.trim();
  if (!doi) {
    return errBody(400, 'Missing required query parameter: doi', corsHeaders);
  }

  let reference;
  try {
    reference = lookupReference(doi);
  } catch (err) {
    console.log(`DOI lookup failed for "${doi}":`, err?.message);
    return errBody(404, `Could not resolve DOI: ${doi}`, corsHeaders);
  }

  // citation-js can return an empty set for a syntactically valid but unknown DOI.
  if (!reference.title && reference.authors.length === 0) {
    return errBody(404, `No metadata found for DOI: ${doi}`, corsHeaders);
  }

  return {
    statusCode: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reference }),
  };
};
