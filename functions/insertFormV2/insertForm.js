import Joi from 'joi';
import crypto from 'crypto';
import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

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

const refFigurePattern = new RegExp("^(Figure|Supplementary Figure|Table|Supplementary Table) [S]?[1-9]?[0-9A-Za-z]?$");
const doiPattern = new RegExp("^(https?:\\/\\/doi\\.org\\/|doi:|doi\\.org\\/)?(10\\.\\d{4,9}[-._;()/:A-Z0-9]+)$", 'i');

const ligandSchema = Joi.object({
  doi: Joi.string().pattern(doiPattern).required(),
  method: Joi.string().valid(
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
  ).required(),
  ref_figure: Joi.string().pattern(refFigurePattern).required(),
  name: Joi.string().max(64).required(),
  SMILES: Joi.string().required(),
  regulatory_effect: Joi.string().valid('activates', 'represses').allow('', null).optional(),
  kd: Joi.number().allow(null).optional(),
});

const operatorSchema = Joi.object({
  doi: Joi.string().pattern(doiPattern).required(),
  method: Joi.string().valid(
    "EMSA",
    "DNase footprinting",
    "Crystal structure",
    "Isothermal titration calorimetry",
    "Fluorescence polarization",
    "Surface plasmon resonance",
    "Synthetic regulation",
    "ChIP-Seq",
  ).required(),
  ref_figure: Joi.string().pattern(refFigurePattern).required(),
  sequence: Joi.string().max(512).pattern(new RegExp("^[ATCGatcg]+$")).required(),
  kd: Joi.number().allow(null).optional(),
});

// Light/temperature evidence (DOI, figure, method) is required, matching the
// ligand/operator requirements — these stimuli are backed by references too.
const lightStimulusSchema = Joi.object({
  wavelength: Joi.number().required(),
  regulatory_effect: Joi.string().valid('activates', 'represses').allow('', null).optional(),
  doi: Joi.string().pattern(doiPattern).required(),
  method: Joi.string().required(),
  ref_figure: Joi.string().pattern(refFigurePattern).required(),
});

const temperatureStimulusSchema = Joi.object({
  temperature: Joi.number().required(),
  regulatory_effect: Joi.string().valid('activates', 'represses').allow('', null).optional(),
  doi: Joi.string().pattern(doiPattern).required(),
  method: Joi.string().required(),
  ref_figure: Joi.string().pattern(refFigurePattern).required(),
});

const proteinSchema = Joi.object({
  alias: Joi.string().max(16).pattern(new RegExp("^[A-Za-z0-9_.]+$")).required(),
  // UniProt ID is required: the protein's sequence, structures, cross-references
  // and operon are all derived from the UniProt call, so it cannot be blank.
  // RefSeq is optional (mutant/engineered proteins may lack one); pattern still
  // applies when a value is supplied.
  uniProtID: Joi.string().pattern(new RegExp("^[A-Za-z0-9_]+$")).required(),
  accession: Joi.string().pattern(new RegExp("^[A-Za-z0-9_.]+$")).allow('').optional(),
  // OmpR/HisKA are two-component-only structural families; the cross-protein
  // count check lives on sensorSchema below.
  family: Joi.string().valid("TetR", "LysR", "AraC", "MarR", "LacI", "GntR", "LuxR", "IclR", "Other", "OmpR", "HisKA").required(),
  ligands: Joi.array().items(ligandSchema).min(1).optional(),
  operators: Joi.array().items(operatorSchema).min(1).optional(),
  light_stimuli: Joi.array().items(lightStimulusSchema).min(1).optional(),
  temperature_stimuli: Joi.array().items(temperatureStimulusSchema).min(1).optional(),
  mutations: Joi.array().items(Joi.object({
    mutations: Joi.array().items(Joi.string().max(32)).min(1).required(),
    ref_type: Joi.string().valid("UniProt", "groovDB").required(),
    ref_id: Joi.string().max(64).required(),
  })).optional(),
}).or('ligands', 'operators', 'light_stimuli', 'temperature_stimuli');

// OmpR/HisKA proteins only exist as part of a two-component system, so a
// single-protein submission can't use them.
const TWO_COMPONENT_ONLY_FAMILIES = ["OmpR", "HisKA"];

const sensorSchema = Joi.object({
  mechanism: Joi.string()
    .valid("Apo-repressor", "Apo-activator", "Co-repressor", "Co-activator", "Signal transduction")
    .required(),
  about: Joi.string().max(500).allow('').optional(),
  proteins: Joi.array().items(proteinSchema).min(1).required(),
}).custom((value, helpers) => {
  const proteins = value.proteins ?? [];
  const usesTwoComponentFamily = proteins.some((p) => TWO_COMPONENT_ONLY_FAMILIES.includes(p?.family));
  if (usesTwoComponentFamily && proteins.length < 2) {
    return helpers.message('OmpR and HisKA families are only valid for two-component systems (2 or more proteins)');
  }
  return value;
}, 'two-component family check');

const mainSchema = Joi.object({
  sensor: sensorSchema.required(),
  user: Joi.string().optional(),
  timeSubmit: Joi.number().optional(),
}).options({ abortEarly: false });

// Without a uniProtID GSI on raw temp, we'd need a Scan to dedupe. Skipped per
// outstanding_questions.md Q1; the prod checks below are the meaningful gate.

// The v2 prod table (PROD_TABLE_V2_NAME) is the source of truth for duplicate
// detection. It holds every sensor — single- and two-component — keyed
// PK=category, SK=grv_id, with the proteins under data.proteins[]. The v1 table
// is frozen and drifts as new sensors are added only in v2, so we must dedupe
// against v2. A single-component sensor's category is its title-case structural
// family (e.g. "TetR"); two-component sensors collapse into the "Dual" bucket.
// There is no uniProtID GSI, so we Query the relevant (small) category
// partition(s) and scan data.proteins[].uniprot_id for a match.

// A submission is two-component ("Dual") when it carries more than one protein or
// uses a two-component-only structural family — mirrors the type resolution in
// addNewSensorV2 (proteins.length >= 2 → "Two Component").
const isTwoComponentSubmission = (proteins) =>
  proteins.length >= 2 ||
  proteins.some((p) => TWO_COMPONENT_ONLY_FAMILIES.includes(p?.family));

// The prod category partition(s) a submission's proteins would live in.
const prodCategoriesFor = (proteins) => {
  if (isTwoComponentSubmission(proteins)) return ['Dual'];
  return [...new Set(proteins.map((p) => p.family))];
};

// Collect every uniprot_id present in a given prod category partition.
const collectProdUniProtIDs = async (category) => {
  const ids = new Set();
  let lastKey;
  do {
    const res = await docClient.send(new QueryCommand({
      TableName: process.env.PROD_TABLE_V2_NAME,
      KeyConditionExpression: '#category = :category',
      ExpressionAttributeNames: { '#category': 'category' },
      ExpressionAttributeValues: { ':category': category },
      ExclusiveStartKey: lastKey,
    }));
    for (const item of res?.Items ?? []) {
      for (const protein of item.data?.proteins ?? []) {
        if (protein?.uniprot_id) ids.add(protein.uniprot_id);
      }
    }
    lastKey = res?.LastEvaluatedKey;
  } while (lastKey);
  return ids;
};

// Returns the uniProtID of the first submitted protein already present in prod, or null.
const findProdDuplicate = async (proteins) => {
  const existing = new Set();
  for (const category of prodCategoriesFor(proteins)) {
    for (const id of await collectProdUniProtIDs(category)) existing.add(id);
  }
  const dupe = proteins.find((p) => existing.has(p.uniProtID));
  return dupe ? dupe.uniProtID : null;
};

const writeToTemp = async (submissionUUID, body) => {
  const params = {
    TableName: process.env.TEMP_TABLE_V2_NAME,
    Item: {
      PK: 'TEMP',
      SK: submissionUUID,
      ...body,
    },
  };
  const command = new PutCommand(params);
  await docClient.send(command);
};

const returnErrorBody = (errCode, message, corsHeaders) => ({
  statusCode: errCode,
  headers: corsHeaders,
  ...(message && {
    body: JSON.stringify(typeof message === 'string' ? { message } : message),
  }),
});

export const handler = async (event) => {
  const corsHeaders = getCorsHeaders(event);

  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (err) {
    return returnErrorBody(400, 'Invalid JSON in request body', corsHeaders);
  }

  try {
    await mainSchema.validateAsync(body);
  } catch (err) {
    return returnErrorBody(400, {
      type: "Validation Error",
      errors: err.details.map((item) => item.message),
    }, corsHeaders);
  }

  try {
    const duplicateId = await findProdDuplicate(body.sensor.proteins);
    if (duplicateId) {
      return returnErrorBody(
        409,
        `The uniProtID ${duplicateId} already exists in our database. If there's an issue, please submit a bug report.`,
        corsHeaders,
      );
    }
  } catch (err) {
    console.log(err);
    return returnErrorBody(500, "Error checking for duplicate submission. Please notify the administrators.", corsHeaders);
  }

  const submissionUUID = crypto.randomUUID();

  try {
    await writeToTemp(submissionUUID, body);
  } catch (err) {
    console.log(err);
    return returnErrorBody(500, "Error processing submission. Please notify the administrators.", corsHeaders);
  }

  return {
    statusCode: 202,
    headers: corsHeaders,
    body: JSON.stringify({ submissionUUID }),
  };
};
