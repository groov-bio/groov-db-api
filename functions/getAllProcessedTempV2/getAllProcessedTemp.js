import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const client = new DynamoDBClient({
  region: 'us-east-2',
  ...(process.env.IS_LOCAL && { endpoint: 'http://host.docker.internal:8000' }),
});
const docClient = DynamoDBDocumentClient.from(client);

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

const scanAll = async () => {
  const items = [];
  let ExclusiveStartKey;
  do {
    const command = new ScanCommand({
      TableName: process.env.PROCESSED_TEMP_TABLE_V2_NAME,
      ...(ExclusiveStartKey && { ExclusiveStartKey }),
    });
    const data = await docClient.send(command);
    if (data.Items) items.push(...data.Items);
    ExclusiveStartKey = data.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
};

export const handler = async (event) => {
  const corsHeaders = getCorsHeaders(event);

  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders };
  }

  try {
    const items = await scanAll();
    if (items.length === 0) {
      return { statusCode: 204, headers: corsHeaders };
    }
    const processed = items.map((item) => ({
      category: item.PK,
      submissionUUID: item.SK,
      proposed_grv_id: item.proposed_grv_id ?? null,
      data: item.data ?? null,
    }));
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ processed }),
    };
  } catch (err) {
    console.log(err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ message: 'Error getting all V2 processed temp sensors' }),
    };
  }
};
