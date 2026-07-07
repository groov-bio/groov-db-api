import Joi from 'joi';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const ddbClient = new DynamoDBClient({
  region: 'us-east-2',
  ...(process.env.IS_LOCAL && { endpoint: 'http://host.docker.internal:8000' }),
});
const docClient = DynamoDBDocumentClient.from(ddbClient);

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
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
};

const errBody = (statusCode, message, headers) => ({
  statusCode,
  headers,
  body: JSON.stringify(typeof message === 'string' ? { message } : message),
});

// ── Schema ────────────────────────────────────────────────────────────────────
// Full V2 sensor shape (the prod object that comes back from R2 static JSON).
// Identity fields (id, category, per-protein uniprot_id) are required; everything
// else uses allowUnknown so future sub-schemas don't break validation.
// Accept both stimulusType (camelCase, written by addNewSensorV2) and stimulus_type
// (snake_case, migrated data) — preserve whichever key the source uses.

const stimulusTypeEntrySchema = Joi.object({
  small_molecule: Joi.array().items(Joi.object({
    name: Joi.string().allow('', null).optional(),
    smiles: Joi.string().allow('', null).optional(),
    regulatory_effect: Joi.string().allow('', null).optional(),
  }).unknown(true)).allow(null).optional(),
  light: Joi.array().items(Joi.object({
    wavelength: Joi.number().optional(),
    regulatory_effect: Joi.string().allow('', null).optional(),
  }).unknown(true)).allow(null).optional(),
  temperature: Joi.array().items(Joi.object({
    temperature: Joi.number().optional(),
    regulatory_effect: Joi.string().allow('', null).optional(),
  }).unknown(true)).allow(null).optional(),
}).unknown(true);

const stimulusSchema = Joi.object({
  stimulusType: Joi.array().items(stimulusTypeEntrySchema).optional(),
  stimulus_type: Joi.array().items(stimulusTypeEntrySchema).optional(),
  stimulus_evidence: Joi.array().items(Joi.object({
    method: Joi.array().items(Joi.string()).optional(),
    ref_figure: Joi.string().allow('', null).optional(),
    doi: Joi.string().allow('', null).optional(),
    kd: Joi.number().allow(null).optional(),
  }).unknown(true)).optional(),
}).unknown(true);

const proteinSchema = Joi.object({
  alias: Joi.string().allow('', null).optional(),
  uniprot_id: Joi.string().required(),
  refseq_id: Joi.string().allow('', null).optional(),
  family: Joi.string().optional(),
  kegg_id: Joi.string().allow('', null).optional(),
  regulation_type: Joi.string().allow('', null).optional(),
  sequence: Joi.string().allow('', null).optional(),
  // Top-level mutations — same shape as addNewSensorV2 so both forms agree.
  mutations: Joi.array().items(Joi.object({
    mutations: Joi.array().items(Joi.string().max(32)).min(1).required(),
    ref_type: Joi.string().valid("UniProt", "groovDB").required(),
    ref_id: Joi.string().max(64).required(),
  })).optional(),
  stimulus: Joi.array().items(stimulusSchema).optional(),
  dna: Joi.array().items(Joi.object({
    sequence: Joi.string().optional(),
    ref_figure: Joi.string().allow('', null).optional(),
    doi: Joi.string().allow('', null).optional(),
    method: Joi.string().optional(),
    kd: Joi.number().allow(null).optional(),
  }).unknown(true)).optional(),
  context: Joi.array().items(Joi.object({
    reg_index: Joi.number().optional(),
    genome: Joi.string().allow('', null).optional(),
    operon_dir: Joi.array().items(Joi.object({
      link: Joi.string().allow('', null).optional(),
      start: Joi.number().allow(null).optional(),
      stop: Joi.number().allow(null).optional(),
      description: Joi.string().allow('', null).optional(),
      direction: Joi.string().allow('', null).optional(),
    }).unknown(true)).optional(),
  }).unknown(true)).optional(),
  structures: Joi.array().items(Joi.object({
    ID: Joi.string().optional(),
    file_location: Joi.string().allow('', null).optional(),
  }).unknown(true)).optional(),
  references: Joi.array().items(Joi.object({
    title: Joi.string().allow('', null).optional(),
    authors: Joi.array().items(Joi.object({
      last_name: Joi.string().allow('', null).optional(),
      first_name: Joi.string().allow('', null).optional(),
    }).unknown(true)).optional(),
    // Year is stored as a string everywhere (migrated data + addNewSensorV2 +
    // doiLookup all emit strings); the editor submits strings too.
    year: Joi.string().allow('', null).optional(),
    journal: Joi.string().allow('', null).optional(),
    doi: Joi.string().allow('', null).optional(),
    url: Joi.string().allow('', null).optional(),
    interaction: Joi.array().items(Joi.string()).optional(),
  }).unknown(true)).optional(),
  origin: Joi.array().items(Joi.object({
    type: Joi.string().allow('', null).optional(),
    organism_id: Joi.number().allow(null).optional(),
    organism_name: Joi.string().allow('', null).optional(),
    parent_id: Joi.string().allow('', null).optional(),
    mutations: Joi.array().optional(),
  }).unknown(true)).optional(),
  protein_interaction: Joi.array().optional(),
  metadata: Joi.object().allow(null).optional(),
}).unknown(true);

const dataSchema = Joi.object({
  id: Joi.string().required(),
  proposed_grv_id: Joi.any().valid(null).optional(),
  type: Joi.string().valid('One Component', 'Two Component', 'Riboswitch').optional(),
  category: Joi.string().required(),
  about: Joi.string().allow('', null).optional(),
  proteins: Joi.array().items(proteinSchema).min(1).required(),
  rna: Joi.any().optional(),
  experiment: Joi.any().optional(),
  promoter: Joi.any().optional(),
  annotation: Joi.any().optional(),
}).options({ abortEarly: false, allowUnknown: true });

const bodySchema = Joi.object({
  category: Joi.string().required(),
  grv_id: Joi.string().required(),
  data: Joi.object().required(),
  user: Joi.string().optional(),
  timeSubmit: Joi.number().optional(),
}).options({ abortEarly: false });

// ── Handler ───────────────────────────────────────────────────────────────────

export const handler = async (event) => {
  const corsHeaders = getCorsHeaders(event);

  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders };
  }

  let body;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return errBody(400, 'Invalid JSON in request body', corsHeaders);
  }

  const bodyValidation = bodySchema.validate(body);
  if (bodyValidation.error) {
    return errBody(400, {
      type: 'Validation Error',
      errors: bodyValidation.error.details.map((d) => d.message),
    }, corsHeaders);
  }

  const { category, grv_id, data, user, timeSubmit } = body;

  const dataValidation = dataSchema.validate(data);
  if (dataValidation.error) {
    return errBody(400, {
      type: 'Validation Error',
      errors: dataValidation.error.details.map((d) => d.message),
    }, corsHeaders);
  }

  // Identity guard: data fields must match the envelope-level identity params.
  if (data.id !== grv_id) {
    return errBody(400, `data.id (${data.id}) does not match grv_id (${grv_id})`, corsHeaders);
  }
  if (data.category !== category) {
    return errBody(400, `data.category (${data.category}) does not match category (${category})`, corsHeaders);
  }

  // Verify the prod row exists and that protein identity is unchanged.
  const prodTable = process.env.PROD_TABLE_V2_NAME;
  let prodRow;
  try {
    const res = await docClient.send(new GetCommand({
      TableName: prodTable,
      Key: { category, grv_id },
    }));
    prodRow = res.Item;
  } catch (err) {
    console.log(err);
    return errBody(500, 'Error reading prod table', corsHeaders);
  }

  if (!prodRow) {
    return errBody(404, `Sensor not found: ${grv_id}`, corsHeaders);
  }

  // Protein uniprot_ids must match exactly (fixed identity — no re-minting on approval).
  const prodUniprotIds = (prodRow.data?.proteins ?? []).map((p) => p.uniprot_id).sort();
  const editUniprotIds = (data.proteins ?? []).map((p) => p.uniprot_id).sort();
  if (
    prodUniprotIds.length !== editUniprotIds.length ||
    prodUniprotIds.some((id, i) => id !== editUniprotIds[i])
  ) {
    return errBody(400, 'Protein uniprot_ids cannot be changed in an edit', corsHeaders);
  }

  // Read-only fields cannot be changed in an edit. The edit form renders them
  // read-only; we also enforce it server-side by forcing each back to the current
  // prod value. We overwrite rather than reject on mismatch: the editor loads the
  // sensor from the R2 static JSON, which can drift from the prod table for a
  // field the user never touched — rejecting would falsely block a valid edit,
  // whereas overwriting still guarantees these fields can't be changed.
  // Only About (sensor) and Alias / Regulation type (protein) stay editable.
  if ('type' in (prodRow.data ?? {})) data.type = prodRow.data.type;
  const prodProteinsByUniprot = new Map(
    (prodRow.data?.proteins ?? []).map((p) => [p.uniprot_id, p])
  );
  const READ_ONLY_PROTEIN_FIELDS = ['family', 'kegg_id', 'refseq_id', 'sequence'];
  for (const editProtein of (data.proteins ?? [])) {
    const prodProtein = prodProteinsByUniprot.get(editProtein.uniprot_id);
    if (!prodProtein) continue; // uniprot set already validated to match above
    for (const field of READ_ONLY_PROTEIN_FIELDS) {
      if (field in prodProtein) editProtein[field] = prodProtein[field];
    }
  }

  // Deterministic SK caps pending edits at one per sensor — re-submitting overwrites the queued copy.
  const sk = `EDIT#${grv_id}`;
  const processedTable = process.env.PROCESSED_TEMP_TABLE_V2_NAME;
  try {
    await docClient.send(new PutCommand({
      TableName: processedTable,
      Item: {
        PK: 'PROCESSED',
        SK: sk,
        proposed_grv_id: null,
        isEdit: true,
        editTarget: { category, grv_id },
        user: user ?? null,
        editTimestamp: timeSubmit ?? Date.now(),
        data,
        // Snapshot the live prod row as the diff baseline so the admin review can
        // show FROM (previousData) → TO (data). Captured here because read-only
        // fields on `data` have already been forced to the prod values above, so
        // the two blobs share an identical shape and only user-changed fields differ.
        previousData: prodRow.data ?? null,
      },
    }));
  } catch (err) {
    console.log(err);
    return errBody(500, 'Error writing to processed-temp table', corsHeaders);
  }

  return {
    statusCode: 202,
    headers: corsHeaders,
    body: JSON.stringify({ message: 'Edit submitted for admin review', submissionUUID: sk }),
  };
};
