import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
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
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Max-Age': '86400'
  };
};

const deleteItem = async (event) => {
    // Validate input parameters
    if (!event.queryStringParameters || !event.queryStringParameters.sensorId) {
        throw new Error('Missing required parameter: sensorId');
    }

    const sensorId = event.queryStringParameters.sensorId;
    
    // Try to delete regular submission first
    let params = {
        TableName: process.env.TEMP_TABLE_NAME,
        Key: {
            PK: 'TEMP',
            SK: sensorId
        }
    }
    
    try {
        const command = new DeleteCommand(params);
        await docClient.send(command);
        console.log(`Successfully deleted regular submission for sensor: ${sensorId}`);
    } catch (err) {
        console.log('No regular submission found for deletion, trying edit submission:', err.message);
    }
    
    // Also try to delete edit submission
    params = {
        TableName: process.env.TEMP_TABLE_NAME,
        Key: {
            PK: 'TEMP',
            SK: `${sensorId}#EDIT`
        }
    }
    
    try {
        const command = new DeleteCommand(params);
        await docClient.send(command);
        console.log(`Successfully deleted edit submission for sensor: ${sensorId}`);
    } catch (err) {
        console.log('No edit submission found for deletion:', err.message);
    }
    
    return { success: true };
}

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
        await deleteItem(event);
        return {
            statusCode: 202,
            headers: corsHeaders,
        }
    } catch (err) {
        console.log('Handler error:', err);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({
                message: 'Error deleting sensor from temp table'
            })
        }
    }
}