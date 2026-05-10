import { GetCommand } from '@aws-sdk/lib-dynamodb';
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

export const handler = async (event) => {
  const corsHeaders = getCorsHeaders(event);

  if (event.requestContext?.http?.method === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders };
  }

  const submissionUUID = event.queryStringParameters?.submissionUUID;
  if (!submissionUUID) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ message: 'Missing required parameter: submissionUUID' }),
    };
  }

  try {
    const result = await docClient.send(new GetCommand({
      TableName: process.env.TEMP_TABLE_V2_NAME,
      Key: { PK: 'TEMP', SK: submissionUUID },
    }));
    if (!result.Item) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ message: 'Submission not found' }),
      };
    }
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        submissionUUID: result.Item.SK,
        user: result.Item.user ?? null,
        timeSubmit: result.Item.timeSubmit ?? null,
        sensor: result.Item.sensor ?? null,
      }),
    };
  } catch (err) {
    console.log(err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ message: 'Error fetching V2 temp sensor' }),
    };
  }
};
