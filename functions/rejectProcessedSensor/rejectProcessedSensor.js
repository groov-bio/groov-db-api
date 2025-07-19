import { BatchWriteCommand} from '@aws-sdk/lib-dynamodb'
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

const client = new DynamoDBClient({ 
  region: "us-east-2",
  ...(process.env.IS_LOCAL && { endpoint: "http://host.docker.internal:8000" })
});
const docClient = DynamoDBDocumentClient.from(client);

let isError = {
    val: false,
    msg: null
};

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

const batchDelete = async (family, id) => {
    let batch = {
        [`${process.env.TEMP_TABLE_NAME}`]: [
            {
                DeleteRequest: {
                    Key: {
                        PK: family,
                        SK: `${id}#ABOUT`
                    }
                }
            },
            {
                DeleteRequest: {
                    Key: {
                        PK: family,
                        SK: `${id}#LIGANDS`
                    }
                }
            },
            {
                DeleteRequest: {
                    Key: {
                        PK: family,
                        SK: `${id}#LINEAGE`
                    }
                }
            },
            {
                DeleteRequest: {
                    Key: {
                        PK: family,
                        SK: `${id}#OPERATOR`
                    }
                }
            },
            {
                DeleteRequest: {
                    Key: {
                        PK: family,
                        SK: `${id}#OPERON`
                    }
                }
            },
            {
                DeleteRequest: {
                    Key: {
                        PK: family,
                        SK: `${id}#STRUCTURE`
                    }
                }
            },
            {
                DeleteRequest: {
                    Key: {
                        PK: 'TEMP',
                        SK: `${id}`
                    }
                }
            },
            {
                DeleteRequest: {
                    Key: {
                        PK: 'TEMP',
                        SK: `${id}#EDIT`
                    }
                }
            }
        ]
    }

    const params = {
        TableName: process.env.TEMP_TABLE_NAME,
        RequestItems: batch
    }
    
    try {
        const command = new BatchWriteCommand(params);
        await docClient.send(command);
    } catch (err) {
        console.log(err)
        isError = {
            val: true,
            msg: 'Error trying to do batchWrite'
        }
    }
}

//TODO - refactor error logic to use error logic from addNewSensor

export const handler = async (event) => {
    // Get CORS headers for this specific request
    const corsHeaders = getCorsHeaders(event);
    
    if (event.requestContext?.http?.method === 'OPTIONS') {
        return {
            statusCode: 200,
            headers: corsHeaders,
        };
    }
    
    let body = JSON.parse(event.body);
    
    await batchDelete(body.family, body.uniProtID);
    
    if (isError.val !== false) {
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({
                message: isError.msg
            })
        }
    } else {
        return {
            statusCode: 200,
            headers: corsHeaders,
        }
    }
}