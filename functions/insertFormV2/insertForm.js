import Joi from 'joi';
import crypto from 'crypto';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
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
  ).required(),
  ref_figure: Joi.string().pattern(refFigurePattern).required(),
  name: Joi.string().max(64).required(),
  SMILES: Joi.string().required(),
  regulatory_effect: Joi.string().allow('', null).optional(),
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

const lightStimulusSchema = Joi.object({
  wavelength: Joi.number().required(),
  regulatory_effect: Joi.string().allow('', null).optional(),
  doi: Joi.string().pattern(doiPattern).allow('').optional(),
  method: Joi.string().allow('').optional(),
  ref_figure: Joi.string().pattern(refFigurePattern).allow('').optional(),
});

const temperatureStimulusSchema = Joi.object({
  temperature: Joi.number().required(),
  regulatory_effect: Joi.string().allow('', null).optional(),
  doi: Joi.string().pattern(doiPattern).allow('').optional(),
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
  about: Joi.string().max(500).allow('').optional(),
  proteins: Joi.array().items(proteinSchema).min(1).required(),
});

const mainSchema = Joi.object({
  sensor: sensorSchema.required(),
  user: Joi.string().optional(),
  timeSubmit: Joi.number().optional(),
}).options({ abortEarly: false });

// Without a uniProtID GSI on raw temp, we'd need a Scan to dedupe. Skipped per
// outstanding_questions.md Q1; processed-temp + (future) prod GSI are the gates.

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
