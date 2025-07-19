import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

// Initialize the S3 Client
const s3Client = new S3Client({ 
  ...(process.env.IS_LOCAL ? {
    region: "us-east-2",
    endpoint: "http://host.docker.internal:9090", // Local S3 mock endpoint
    forcePathStyle: true, // Required for S3Mock
    credentials: {
      accessKeyId: "test", // Dummy credentials for local testing
      secretAccessKey: "test" 
    }
  } : {
    region: "auto", // R2 uses 'auto' region
    endpoint: process.env.R2_ENDPOINT, // R2 endpoint URL
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  })
});

const BUCKET_NAME = process.env.IS_LOCAL ? (process.env.S3_BUCKET_NAME || 'my-test-bucket') : process.env.R2_BUCKET_NAME;

class HTTPError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
    }
}

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
    'Access-Control-Allow-Headers': 'Content-Type,content-type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,Cache-Control',
    'Access-Control-Allow-Methods': 'GET,OPTIONS',
    'Access-Control-Max-Age': '86400'
  };
};

// Convert S3 response stream to string
const streamToString = (stream) =>
    new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('data', (chunk) => chunks.push(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });

// Function to fetch sensor data from S3
const getSensorData = async (family, sensorID) => {
    try {
        // Family names are stored lowercase in the file paths
        const familyKey = family.toLowerCase();
        
        const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: `sensors/${familyKey}/${sensorID}.json`
        });
        
        const response = await s3Client.send(command);
        const bodyContents = await streamToString(response.Body);
        
        return JSON.parse(bodyContents);
    } catch (err) {
        console.log('Error fetching sensor from family:', sensorID, family, err);
        if (err.name === 'NoSuchKey') {
            throw new HTTPError(`Sensor not found`, 404);
        }
        throw new HTTPError(`Failed to fetch sensor data, please try again.`, 503);
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
    
    //Store query strings 
    let sensorID = event.queryStringParameters?.sensorID;
    let family = event.queryStringParameters?.family;

    if (!sensorID || !family) {
        return {
            statusCode: 422,
            headers: corsHeaders,
            body: JSON.stringify({
                message: 'Missing sensorID or family in query string.'
            })
        };
    }

    try {
        const sensorData = await getSensorData(family, sensorID);
        
        const response = {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify(sensorData)
        };
        return response;
    } catch (err) {
        console.error('Handler Error:', err);
        const statusCode = err.statusCode || 500;

        return {
            statusCode: statusCode,
            headers: corsHeaders,
            body: JSON.stringify({ message: err.message })
        };
    }
};