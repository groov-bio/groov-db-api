import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { regenerateStaticJSON, mintNextGrvId } from './s3UpdaterV2.js';
import { invokeFingerprintAsync } from './lambdaInvoker.js';

const ddbClient = new DynamoDBClient({
  region: 'us-east-2',
  ...(process.env.IS_LOCAL && { endpoint: 'http://host.docker.internal:8000' }),
});
const docClient = DynamoDBDocumentClient.from(ddbClient);

// Per api_v2_docs/implementation_plans/add_sensor_insert_form/v2_sensor_pipeline_plan.md.
// Two-component sensors use prefix 'D' regardless of category (interim convention).
export const CATEGORY_PREFIX = {
  AraC: 'A',
  GntR: 'G',
  IclR: 'I',
  LacI: 'L',
  LuxR: 'X',
  LysR: 'Y',
  MarR: 'M',
  Other: 'Z',
  TetR: 'T',
};
export const TWO_COMPONENT_PREFIX = 'D';

export const prefixFor = (category, data) => {
  if (data?.type === 'Two Component') return TWO_COMPONENT_PREFIX;
  return CATEGORY_PREFIX[category];
};

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
  body: JSON.stringify({ message }),
});

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

  const { category, submissionUUID } = body;
  if (!category || !submissionUUID) {
    return errBody(400, 'Missing required fields: category, submissionUUID', corsHeaders);
  }
  if (!CATEGORY_PREFIX[category]) {
    return errBody(400, `Unknown category: ${category}`, corsHeaders);
  }

  const processedTable = process.env.PROCESSED_TEMP_TABLE_V2_NAME;
  const prodTable = process.env.PROD_TABLE_V2_NAME;

  let processedRow;
  try {
    const res = await docClient.send(new GetCommand({
      TableName: processedTable,
      Key: { PK: category, SK: submissionUUID },
    }));
    processedRow = res.Item;
  } catch (err) {
    console.log(err);
    return errBody(500, 'Error reading from processed-temp table', corsHeaders);
  }
  if (!processedRow) {
    return errBody(404, 'Processed sensor not found', corsHeaders);
  }

  const data = processedRow.data;
  if (!data) {
    return errBody(500, 'Processed-temp row missing data field', corsHeaders);
  }
  if (data.id) {
    return errBody(409, `Sensor already has id: ${data.id}`, corsHeaders);
  }

  const prefix = prefixFor(category, data);
  if (!prefix) {
    return errBody(400, `Cannot determine GRV-ID prefix for category=${category}`, corsHeaders);
  }
  // Two-component sensors collapse into a single 'Dual' bucket in prod so the PK matches the
  // GRV-D prefix and R2 regen writes indexes/dual.json instead of per-category index files.
  const prodCategory = prefix === TWO_COMPONENT_PREFIX ? 'Dual' : category;

  let grv_id;
  try {
    grv_id = await mintNextGrvId(prefix);
  } catch (err) {
    console.log(err);
    return errBody(500, 'Error minting GRV-ID from R2 index', corsHeaders);
  }
  data.id = grv_id;
  data.category = prodCategory;
  delete data.proposed_grv_id;

  try {
    await docClient.send(new PutCommand({
      TableName: prodTable,
      Item: { category: prodCategory, grv_id, data },
      ConditionExpression: 'attribute_not_exists(grv_id)',
    }));
  } catch (err) {
    console.log(err);
    if (err?.name === 'ConditionalCheckFailedException') {
      return errBody(409, `Prod row already exists for ${grv_id}`, corsHeaders);
    }
    return errBody(500, 'Error writing to prod table', corsHeaders);
  }

  try {
    await docClient.send(new DeleteCommand({
      TableName: processedTable,
      Key: { PK: category, SK: submissionUUID },
    }));
  } catch (err) {
    console.log('Failed to delete processed-temp row (prod write succeeded):', err);
  }

  try {
    await regenerateStaticJSON(data, prodCategory, grv_id);
  } catch (err) {
    console.log('R2 static regen failed (prod write succeeded):', err);
  }

  try {
    await invokeFingerprintAsync({ grv_id, category: prodCategory, data });
  } catch (err) {
    console.log('Fingerprint lambda invocation failed (prod write succeeded):', err);
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ message: 'Sensor approved', grv_id, category: prodCategory }),
  };
};
