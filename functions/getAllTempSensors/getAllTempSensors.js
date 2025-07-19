import { QueryCommand } from '@aws-sdk/lib-dynamodb'
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

//Function that calls docClient.batchGet
const getItem = async (event) => {
    
    //Construct batchGet parameters to get a single sensors info
    
    const params = {
        TableName: process.env.TEMP_TABLE_NAME,
        KeyConditionExpression: 'PK = :PK',
        ExpressionAttributeValues: {
            ':PK': 'TEMP',
        },
    }
    
    //Call and return data
    try {
        const command = new QueryCommand(params);
        const data = await docClient.send(command);
        return data;
    } catch (err) {
        console.log(err);
        throw new Error('Unable to get all temp sensors')
    }
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
    
    //Standard try/catch for batch getting item info from DynamoDB
    try {
        const data = await getItem(event);
        if (data.Count === 0) {
            return {
                statusCode: 204,
                headers: corsHeaders,
            }
        }
        
        // Enhance the response data to distinguish between regular submissions and edits
        const enhancedItems = data.Items.map(item => {
            const isEdit = item.SK.endsWith('#EDIT');
            const uniProtID = isEdit ? item.SK.replace('#EDIT', '') : item.SK;
            
            return {
                ...item,
                uniProtID: uniProtID,
                submissionType: isEdit ? 'edit' : 'new',
                isEdit: isEdit,
                originalSK: item.SK // Keep original SK for reference
            };
        });
        
        const response = {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify(enhancedItems)
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
}