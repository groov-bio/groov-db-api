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

const fetchIndexFromS3 = async () => {
    try {
        const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: 'index.json'
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
        throw new HTTPError(`Failed to fetch index from S3, please try again.`, 503);
    }
};

const calculateStats = (indexData) => {
    try {
        if (!indexData || !indexData.sensors || !Array.isArray(indexData.sensors)) {
            throw new HTTPError('Invalid index data format.', 422);
        }

        // Sets to track unique values
        const uniqueLigandsSet = new Set();
        const uniqueRegulatorsSet = new Set();
        const result = {};
        
        // Process each sensor in the index
        indexData.sensors.forEach((sensor, idx) => {
            // Add sensor alias to regulators set
            if (sensor.alias) {
                uniqueRegulatorsSet.add(sensor.alias);
            }
            
            // Add ligand count info
            result[idx + 1] = {
                alias: sensor.alias || "",
                family: sensor.family || "",
                ligands: [], // We don't have detailed ligand info in the index
                ligandCount: sensor.ligandCount || 0
            };
        });
        
        // Add stats
        result['stats'] = {
            ligands: indexData.sensors.reduce((sum, sensor) => sum + (sensor.ligandCount || 0), 0),
            regulators: uniqueRegulatorsSet.size,
            sensorCount: indexData.count || indexData.sensors.length
        };

        return result;
    } catch (err) {
        console.error('Data Processing Error:', err);
        throw new HTTPError(`Data processing failed for search, please try again.`, 422);
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
        const indexData = await fetchIndexFromS3();
        
        // Check if stats processing is requested
        const useStats = event.queryStringParameters?.stats === 'true';
        
        let responseData;
        if (useStats) {
            responseData = calculateStats(indexData);
        } else {
            responseData = indexData;
        }
        
        const response = {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify(responseData)
        };
        return response;
    } catch (err) {
        console.error('Handler Error:', err);
        
        const statusCode = err.statusCode || 500;
        
        const response = {
            statusCode: statusCode,
            headers: corsHeaders,
            body: JSON.stringify({
                message: `Error on search: ${err.message}`
            })
        };
        return response;
    }
};
