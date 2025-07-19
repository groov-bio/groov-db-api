import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

// Initialize the S3 Client
const s3Client = new S3Client({ 
  ...(process.env.IS_LOCAL ? {
    region: "us-east-2",
    endpoint: "http://host.docker.internal:9090",
    forcePathStyle: true,
    credentials: {
      accessKeyId: "test", 
      secretAccessKey: "test" 
    }
  } : {
    region: "auto", 
    endpoint: process.env.R2_ENDPOINT, 
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  })
});

const BUCKET_NAME = process.env.IS_LOCAL ? (process.env.S3_BUCKET_NAME || 'my-test-bucket') : process.env.R2_BUCKET_NAME;

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

class HTTPError extends Error {
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
    }
}

const fetchAllSensorsFromS3 = async () => {
    try {
        const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: 'all-sensors.json'
        });
        
        const response = await s3Client.send(command);
        
        // Convert stream to string
        const streamToString = (stream) =>
            new Promise((resolve, reject) => {
                const chunks = [];
                stream.on('data', (chunk) => chunks.push(chunk));
                stream.on('error', reject);
                stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            });
            
        const bodyContents = await streamToString(response.Body);
        return JSON.parse(bodyContents);
    } catch (err) {
        console.log('S3 Fetch Error:', err);
        throw new HTTPError(`Failed to fetch all-sensors.json from S3, please try again.`, 503);
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
    
    try {
        const allSensorsData = await fetchAllSensorsFromS3();
        const response = {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify(allSensorsData)
        };
        return response;
    } catch (err) {
        console.error('Handler Error:', err);
        
        const statusCode = err.statusCode || 500;
        
        const response = {
            statusCode: statusCode,
            headers: corsHeaders,
            body: JSON.stringify({
                message: `Error fetching all sensors: ${err.message}`
            })
        };
        return response;
    }
};
