import { ScanCommand } from '@aws-sdk/lib-dynamodb';
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

// Function to get CORS headers based on the request origin
const getCorsHeaders = (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || 'http://localhost:3000';
  
  // Check if the origin is in our allowed list
  const allowedOrigin = allowedOrigins.includes(origin) ? origin : 'http://localhost:3000';
  
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type,content-type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Max-Age': '86400'
  };
};

// Function that calls docClient.scan
const getItem = async (event) => {
    // Construct scan parameters
    const params = {
        TableName: process.env.TEMP_TABLE_NAME,
        ExpressionAttributeNames: {
            "#PK": "PK",
            '#alias': 'alias',
            '#family': 'family',
            '#uni': 'uniprotID'
        },
        ExpressionAttributeValues: {
            ':PK': 'TEMP',
            ':op': 'operator',
            ':struct': 'structure',
            ':lin': 'lineage',
            ':operon': 'operon',
            ':ligs': 'ligands'
        },
        ProjectionExpression: '#alias, #family, #uni, PK, SK',
        FilterExpression: 'not(contains(category, :op)) and not(contains(category, :struct)) and not(contains(category, :lin)) and not(contains(category, :operon)) and not(contains(category, :ligs)) and #PK <> :PK'
    };
    
    // Call and return data using the new ScanCommand
    const command = new ScanCommand(params);
    const data = await docClient.send(command);
    return data;
};

export const handler = async (event) => {
    // Get CORS headers for this specific request
    const corsHeaders = getCorsHeaders(event);
    
    if (event.requestContext?.http?.method === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: corsHeaders,
        };
    }
    
    try {
        const data = await getItem(event);
        if (data.Count === 0) {
            return {
                statusCode: 204,
                headers: corsHeaders,
            };
        }
        const response = {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify(data.Items)
        };
        return response;
    } catch (err) {
        const response = {
            statusCode: 400,
            headers: corsHeaders,
            body: JSON.stringify({
                message: "Error on getting all process sensors, please check logs"
            })
        };
        console.log(err);
        return response;
    }
};