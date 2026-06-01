import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { removeStaticJSON } from './s3RemoverV2.js';
import { invokeFingerprintAsync } from './lambdaInvoker.js';

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

  const { category, grv_id } = body;
  if (!category || !grv_id) {
    return errBody(400, 'Missing required fields: category, grv_id', corsHeaders);
  }

  const prodTable = process.env.PROD_TABLE_V2_NAME;

  let existingRow;
  try {
    const res = await docClient.send(new GetCommand({
      TableName: prodTable,
      Key: { category, grv_id },
    }));
    existingRow = res.Item;
  } catch (err) {
    console.log(err);
    return errBody(500, 'Error reading from prod table', corsHeaders);
  }
  if (!existingRow) {
    return errBody(404, 'Sensor not found', corsHeaders);
  }

  const data = existingRow.data;

  try {
    await docClient.send(new DeleteCommand({
      TableName: prodTable,
      Key: { category, grv_id },
    }));
  } catch (err) {
    console.log(err);
    return errBody(500, 'Error deleting from prod table', corsHeaders);
  }

  try {
    await removeStaticJSON(category, grv_id);
  } catch (err) {
    console.log('R2 cleanup failed (prod delete succeeded):', err);
  }

  try {
    await invokeFingerprintAsync({ grv_id, category, data });
  } catch (err) {
    console.log('Fingerprint lambda invocation failed (prod delete succeeded):', err);
  }

  return {
    statusCode: 200,
    headers: corsHeaders,
    body: JSON.stringify({ message: 'Sensor deleted', grv_id, category }),
  };
};
