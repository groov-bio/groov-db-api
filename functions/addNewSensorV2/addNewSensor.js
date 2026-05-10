import Cite from 'citation-js';
import Joi from 'joi';
import fetch from 'node-fetch';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb'
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { logger } from './utils/logger.js';
import { invokeLambda } from './utils/lambdaInvoker.js';

const client = new DynamoDBClient({
  region: "us-east-2",
  ...(process.env.IS_LOCAL && { endpoint: "http://host.docker.internal:8000" })
});
const docClient = DynamoDBDocumentClient.from(client);

const allowedOrigins = [
  'http://localhost:3000',
  'https://groov.bio',
  'https://www.groov.bio'
];

const getCorsHeaders = (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || 'http://localhost:3000';
  const allowedOrigin = allowedOrigins.includes(origin) ? origin : 'http://localhost:3000';
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type,content-type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Max-Age': '86400'
  };
};

const fetchWithTimeout = async (url, options = {}, timeout = 30000) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    logger.error(`Fetch request to ${url} failed`, error);
    throw error;
  }
};

const refFigurePattern = new RegExp("^(Figure|Supplementary Figure|Table|Supplementary Table) [S]?[1-9]?[0-9A-Za-z]?$");

const ligandSchema = Joi.object({
  doi: Joi.string().required(),
  method: Joi.string().valid(
    "EMSA", "DNase footprinting", "Isothermal titration calorimetry",
    "Synthetic regulation", "Fluorescence polarization", "Surface plasmon resonance",
    "Thermal shift", "Spectrophotometric competition", "Spectral shift",
    "DNA affinity chromatography",
  ).required(),
  ref_figure: Joi.string().pattern(refFigurePattern).required(),
  name: Joi.string().max(64).required(),
  SMILES: Joi.string().required(),
  regulatory_effect: Joi.string().allow('', null).optional(),
  kd: Joi.number().allow(null).optional(),
});

const operatorSchema = Joi.object({
  doi: Joi.string().required(),
  method: Joi.string().valid(
    "EMSA", "DNase footprinting", "Crystal structure", "Isothermal titration calorimetry",
    "Fluorescence polarization", "Surface plasmon resonance", "Synthetic regulation", "ChIP-Seq",
  ).required(),
  ref_figure: Joi.string().pattern(refFigurePattern).required(),
  sequence: Joi.string().max(512).pattern(new RegExp("^[ATCGatcg]+$")).required(),
  kd: Joi.number().allow(null).optional(),
});

const lightStimulusSchema = Joi.object({
  wavelength: Joi.number().required(),
  regulatory_effect: Joi.string().allow('', null).optional(),
  doi: Joi.string().allow('').optional(),
  method: Joi.string().allow('').optional(),
  ref_figure: Joi.string().pattern(refFigurePattern).allow('').optional(),
});

const temperatureStimulusSchema = Joi.object({
  temperature: Joi.number().required(),
  regulatory_effect: Joi.string().allow('', null).optional(),
  doi: Joi.string().allow('').optional(),
  method: Joi.string().allow('').optional(),
  ref_figure: Joi.string().pattern(refFigurePattern).allow('').optional(),
});

const proteinSchema = Joi.object({
  alias: Joi.string().max(16).pattern(new RegExp("^[A-Za-z0-9_.]+$")).required(),
  uniProtID: Joi.string().pattern(new RegExp("^[A-Za-z0-9_]+$")).required(),
  accession: Joi.string().pattern(new RegExp("^[A-Za-z0-9_.]+$")).required(),
  mechanism: Joi.string()
    .valid("Apo-repressor", "Apo-activator", "Co-repressor", "Co-activator")
    .allow('', null).optional(),
  ligands: Joi.array().items(ligandSchema).optional(),
  operators: Joi.array().items(operatorSchema).optional(),
  light_stimuli: Joi.array().items(lightStimulusSchema).optional(),
  temperature_stimuli: Joi.array().items(temperatureStimulusSchema).optional(),
  mutations: Joi.array().items(Joi.string().max(32)).optional(),
});

const sensorSchema = Joi.object({
  category: Joi.string()
    .valid("TetR", "LysR", "AraC", "MarR", "LacI", "GntR", "LuxR", "IclR", "Other")
    .required(),
  about: Joi.string().max(500).allow('', null).optional(),
  proteins: Joi.array().items(proteinSchema).min(1).required(),
});

const mainSchema = Joi.object({
  sensor: sensorSchema.required(),
  user: Joi.string().optional(),
  timeSubmit: Joi.number().optional(),
  submissionUUID: Joi.string().optional(),
  PK: Joi.string().optional(),
  SK: Joi.string().optional(),
}).options({ abortEarly: false, allowUnknown: true });

const inferType = (proteins, rna) => {
  if (rna) return 'Riboswitch';
  if (proteins?.length >= 2) return 'Two Component';
  return 'One Component';
};

const checkForProcessedDupe = async (category, submissionUUID) => {
  const params = {
    TableName: process.env.PROCESSED_TEMP_TABLE_V2_NAME,
    Key: { PK: category, SK: submissionUUID },
  };
  const result = await docClient.send(new GetCommand(params));
  if (result.Item) throw new Error("Duplicate");
};

const callUniProtAPI = async (id) => {
  logger.info(`Calling UniProt API for ID: ${id}`);
  const response = await fetchWithTimeout(
    `https://rest.uniprot.org/uniprotkb/search?query=(accession:${id})&fields=accession,organism_name,organism_id,gene_primary,sequence,xref_refseq,xref_kegg,xref_pdb`,
    {},
    10000
  );
  if (!response.ok) {
    const responseText = await response.text();
    logger.error(`UniProt API returned non-OK status: ${response.status}`, { responseText });
    throw new Error(`UniProt API error: ${response.status}`);
  }
  return response.json();
};

const callDOI = async (doi) => {
  if (doi == null || doi === '') {
    return { title: null, authors: null, year: null, journal: null, doi: null, url: null };
  }
  const citation = new Cite(doi);
  const out = citation.format("data", { template: "apa" });
  const citeData = JSON.parse(out);
  let title = "", authors = [], year = "", journal = "", newDOI = "", url = "";
  for (const entry of citeData) {
    if (entry.author) {
      for (const a of entry.author) authors.push({ lastName: a.family, firstName: a.given });
    }
    if (entry.title) title = entry.title;
    if (entry.issued?.["date-parts"]) year = entry.issued["date-parts"][0][0];
    if (entry["container-title-short"]) journal = entry["container-title-short"];
    else if (entry["container-title"]) journal = entry["container-title"];
    if (entry.DOI) newDOI = entry.DOI;
    if (entry.URL) url = entry.URL;
  }
  return { title, authors, year, journal, doi: newDOI, url };
};

const enrichDOI = async (items) => {
  if (!items?.length) return [];
  const out = [];
  for (const item of items) {
    out.push({ ...item, fullDOI: item.doi ? await callDOI(item.doi) : null });
  }
  return out;
};

export const callOperonLambda = async (id) => {
  logger.info(`Invoking Operon Lambda for ID: ${id}`);
  const payload = { queryStringParameters: { id } };
  const result = await invokeLambda('getOperon', process.env.GET_OPERON_FUNCTION_ARN, payload, null, 'GET');
  // Existing pre-condition: result.body is a JSON string. Parse so downstream
  // builders can read fields rather than getting `undefined` everywhere.
  if (typeof result.body === 'string') {
    try { return JSON.parse(result.body); } catch { return null; }
  }
  return result.body;
};

const processPDBId = async (id) => {
  logger.info(`Processing PDB ID: ${id}`);
  const result = await fetchWithTimeout(`https://data.rcsb.org/graphql`, {
    method: 'post',
    body: JSON.stringify({
      query: `{ entry(entry_id: "${id}") { exptl{method} rcsb_primary_citation { pdbx_database_id_DOI } } }`
    }),
    headers: {
      'Content-Type': "application/json",
      'User-Agent': "Mozilla/5.0 (X11; CrOS x86_64 13904.41.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.81 Safari/537.36"
    }
  }, 10000);
  if (!result.ok) {
    const responseText = await result.text();
    logger.error(`PDB API returned non-OK status: ${result.status}`, { responseText });
    throw new Error(`PDB API error: ${result.status}`);
  }
  const data = await result.json();
  return {
    doi: data.data.entry.rcsb_primary_citation.pdbx_database_id_DOI || null,
    method: data.data.entry.exptl[0].method,
    PDB_code: id
  };
};

const tryXrefData = async (uniEntry, accession) => {
  const xref = uniEntry.uniProtKBCrossReferences ?? [];
  let operonData = null;
  const structureData = [];
  let keggID = null;

  if (accession) {
    operonData = await callOperonLambda(accession);
  }

  for (const x of xref) {
    switch (x.database) {
      case 'RefSeq':
        if (!accession && !operonData) operonData = await callOperonLambda(x.id);
        break;
      case 'PDB':
        structureData.push(await processPDBId(x.id));
        break;
      case 'KEGG':
        if (!keggID) keggID = x.id;
        break;
    }
  }

  return { operon: operonData, structure: structureData, kegg: keggID };
};

const fetchFromTempTable = async (submissionUUID) => {
  const params = {
    TableName: process.env.TEMP_TABLE_V2_NAME,
    Key: { PK: 'TEMP', SK: submissionUUID },
  };
  const result = await docClient.send(new GetCommand(params));
  if (result.Item) return result.Item;
  throw new Error(`No submission found for UUID: ${submissionUUID}`);
};

// ---- Builders --------------------------------------------------------------

const buildSmallMoleculeStimuli = (ligands) =>
  (ligands ?? [])
    .filter(l => l?.fullDOI)
    .map(l => ({
      stimulusType: [{
        small_molecule: [{
          name: l.name,
          smiles: l.SMILES,
          regulatory_effect: l.regulatory_effect ?? null,
        }],
        light: null,
        temperature: null,
      }],
      stimulus_evidence: [{
        method: [l.method],
        ref_figure: l.ref_figure,
        doi: l.fullDOI?.doi ?? null,
        kd: l.kd ?? null,
      }],
    }));

const buildLightStimuli = (lights) =>
  (lights ?? []).map(l => ({
    stimulusType: [{
      small_molecule: null,
      light: [{
        wavelength: Number(l.wavelength),
        regulatory_effect: l.regulatory_effect ?? null,
      }],
      temperature: null,
    }],
    stimulus_evidence: [{
      method: l.method ? [l.method] : [],
      ref_figure: l.ref_figure ?? null,
      doi: l.fullDOI?.doi ?? l.doi ?? null,
      kd: null,
    }],
  }));

const buildTemperatureStimuli = (temps) =>
  (temps ?? []).map(t => ({
    stimulusType: [{
      small_molecule: null,
      light: null,
      temperature: [{
        temperature: Number(t.temperature),
        regulatory_effect: t.regulatory_effect ?? null,
      }],
    }],
    stimulus_evidence: [{
      method: t.method ? [t.method] : [],
      ref_figure: t.ref_figure ?? null,
      doi: t.fullDOI?.doi ?? t.doi ?? null,
      kd: null,
    }],
  }));

const buildDNA = (operators) =>
  (operators ?? []).map(op => ({
    sequence: op.sequence,
    ref_figure: op.ref_figure,
    doi: op.fullDOI?.doi ?? null,
    method: op.method,
    kd: op.kd ?? null,
  }));

const buildContext = (operonData) => {
  if (!operonData) return [];
  return [{
    reg_index: operonData.regIndex,
    genome: operonData.genome,
    operon_dir: (operonData.operon ?? []).map(g => ({
      link: g.link,
      start: g.start,
      stop: g.Stop ?? g.stop,
      description: g.description,
      direction: g.direction,
    })),
  }];
};

const buildStructures = (structureData) =>
  (structureData ?? []).map(s => ({ ID: s.PDB_code, file_location: null }));

const buildReferences = (...enrichedGroups) => {
  // enrichedGroups is array of [{items, type}, ...]
  const refMap = new Map();
  const addEntry = (fullDOI, interactionType) => {
    if (!fullDOI?.doi) return;
    if (!refMap.has(fullDOI.doi)) {
      refMap.set(fullDOI.doi, {
        title: fullDOI.title,
        authors: (fullDOI.authors ?? []).map(a => ({ last_name: a.lastName, first_name: a.firstName })),
        year: fullDOI.year != null ? String(fullDOI.year) : null,
        journal: fullDOI.journal,
        doi: fullDOI.doi,
        url: fullDOI.url,
        interaction: [],
      });
    }
    const ref = refMap.get(fullDOI.doi);
    if (!ref.interaction.includes(interactionType)) ref.interaction.push(interactionType);
  };
  for (const { items, type } of enrichedGroups) {
    for (const it of (items ?? [])) {
      if (it?.fullDOI) addEntry(it.fullDOI, type);
    }
  }
  return Array.from(refMap.values());
};

const buildProtein = (protein, enrichment) => {
  const { uniEntry, xrefData, enrichedLigands, enrichedOperators, enrichedLight, enrichedTemperature, enrichedStructures } = enrichment;
  const stimulus = [
    ...buildSmallMoleculeStimuli(enrichedLigands),
    ...buildLightStimuli(enrichedLight),
    ...buildTemperatureStimuli(enrichedTemperature),
  ];
  return {
    alias: protein.alias,
    uniprot_id: protein.uniProtID,
    refseq_id: protein.accession,
    kegg_id: xrefData.kegg ?? null,
    regulation_type: protein.mechanism || null,
    sequence: uniEntry.sequence?.value ?? null,
    stimulus,
    dna: buildDNA(enrichedOperators),
    context: buildContext(xrefData.operon),
    structures: buildStructures(xrefData.structure),
    references: buildReferences(
      { items: enrichedLigands, type: 'Stimulus' },
      { items: enrichedLight, type: 'Stimulus' },
      { items: enrichedTemperature, type: 'Stimulus' },
      { items: enrichedOperators, type: 'DNA' },
      { items: enrichedStructures, type: 'Structure' },
    ),
    origin: [{
      type: 'natural',
      organism_id: uniEntry.organism?.taxonId ?? null,
      organism_name: uniEntry.organism?.scientificName ?? null,
      parent_id: null,
      mutations: protein.mutations ?? [],
    }],
    protein_interaction: [],
    metadata: null,
  };
};

const enrichProtein = async (protein) => {
  const uniData = await callUniProtAPI(protein.uniProtID);
  if (!uniData.results?.length) {
    const err = new Error(`No UniProt results for ${protein.uniProtID}`);
    err.statusCode = 400;
    throw err;
  }
  const uniEntry = uniData.results[0];
  const xrefData = await tryXrefData(uniEntry, protein.accession ?? null);
  const enrichedLigands = await enrichDOI(protein.ligands);
  const enrichedOperators = await enrichDOI(protein.operators);
  const enrichedLight = await enrichDOI(protein.light_stimuli);
  const enrichedTemperature = await enrichDOI(protein.temperature_stimuli);
  const enrichedStructures = await Promise.all(
    (xrefData.structure ?? []).map(async (s) => ({
      ...s,
      fullDOI: s.doi ? await callDOI(s.doi) : null,
    }))
  );
  return { uniEntry, xrefData, enrichedLigands, enrichedOperators, enrichedLight, enrichedTemperature, enrichedStructures };
};

const constructV2Sensor = (sensor, perProteinEnrichment) => ({
  id: null,
  proposed_grv_id: null,
  type: inferType(sensor.proteins, null),
  category: sensor.category,
  about: sensor.about ?? null,
  proteins: sensor.proteins.map((p, i) => buildProtein(p, perProteinEnrichment[i])),
  rna: null,
  experiment: null,
  promoter: null,
  annotation: null,
});

const writeProcessedRow = async (category, submissionUUID, v2Sensor) => {
  const params = {
    TableName: process.env.PROCESSED_TEMP_TABLE_V2_NAME,
    Item: {
      PK: category,
      SK: submissionUUID,
      proposed_grv_id: null,
      data: v2Sensor,
    },
  };
  await docClient.send(new PutCommand(params));
};

const errorBody = (statusCode, message, corsHeaders) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', ...corsHeaders },
  body: JSON.stringify(typeof message === 'string' ? { message } : message),
});

export const handler = async (event) => {
  const corsHeaders = getCorsHeaders(event);

  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  if (!event.body) return errorBody(400, 'Missing request body', corsHeaders);

  let requestBody;
  try {
    requestBody = JSON.parse(event.body);
  } catch (err) {
    return errorBody(400, 'Invalid JSON in request body', corsHeaders);
  }

  // Two invocation modes:
  //   1) { submissionUUID } — fetch raw submission and process
  //   2) full sensor body — process inline (used for tests / direct admin pushes)
  let data;
  if (requestBody.submissionUUID && !requestBody.sensor) {
    try {
      const item = await fetchFromTempTable(requestBody.submissionUUID);
      data = { sensor: item.sensor, user: item.user, timeSubmit: item.timeSubmit, submissionUUID: requestBody.submissionUUID };
    } catch (err) {
      return errorBody(404, 'No submission found for the provided UUID', corsHeaders);
    }
  } else {
    data = requestBody;
  }

  try {
    await mainSchema.validateAsync(data);
  } catch (err) {
    return errorBody(400, {
      type: 'Validation Error',
      errors: err.details.map((item) => item.message),
    }, corsHeaders);
  }

  const submissionUUID = data.submissionUUID ?? requestBody.submissionUUID;
  if (!submissionUUID) {
    return errorBody(400, 'submissionUUID is required (either top-level or from inline call)', corsHeaders);
  }

  try {
    await checkForProcessedDupe(data.sensor.category, submissionUUID);
  } catch (err) {
    return errorBody(409, 'A processed entry already exists for this submission', corsHeaders);
  }

  let perProteinEnrichment;
  try {
    perProteinEnrichment = [];
    for (const protein of data.sensor.proteins) {
      perProteinEnrichment.push(await enrichProtein(protein));
    }
  } catch (err) {
    logger.error('Enrichment failed', err);
    return errorBody(err.statusCode ?? 500, err.message ?? 'Error enriching protein data', corsHeaders);
  }

  const v2Sensor = constructV2Sensor(data.sensor, perProteinEnrichment);

  try {
    await writeProcessedRow(data.sensor.category, submissionUUID, v2Sensor);
  } catch (err) {
    logger.error('Write to processed temp failed', err);
    return errorBody(500, 'Error writing processed sensor row', corsHeaders);
  }

  return {
    statusCode: 202,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
    body: JSON.stringify({ message: 'Processing completed successfully', submissionUUID }),
  };
};
