import { QueryCommand } from '@aws-sdk/lib-dynamodb';
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

const queryAll = async () => {
  const items = [];
  let ExclusiveStartKey;
  do {
    const command = new QueryCommand({
      TableName: process.env.TEMP_TABLE_V2_NAME,
      KeyConditionExpression: 'PK = :PK',
      ExpressionAttributeValues: { ':PK': 'TEMP' },
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
    const items = await queryAll();
    if (items.length === 0) {
      return { statusCode: 204, headers: corsHeaders };
    }
    const submissions = items.map((item) => ({
      submissionUUID: item.SK,
      user: item.user ?? null,
      timeSubmit: item.timeSubmit ?? null,
      sensor: item.sensor ?? null,
    }));
    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ submissions }),
    };
  } catch (err) {
    console.log(err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ message: 'Error getting all V2 temp sensors' }),
    };
  }
};
