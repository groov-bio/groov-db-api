import Joi from 'joi';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
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

//Schema for each object within operator array
const operatorSchema = Joi.object({
  doi: Joi.string().required(),
  method: Joi.string()
    .valid(
      "EMSA",
      "DNase footprinting",
      "Crystal structure",
      "Isothermal titration calorimetry",
      "Fluorescence polarization",
      "Surface plasmon resonance",
      "Synthetic regulation",
    )
    .required(),
  ref_figure: Joi.string()
    .pattern(new RegExp("^(Figure|Table) [S]?[1-9]?[0-9A-Za-z]?$"))
    .required(),
  sequence: Joi.string().max(512).pattern(new RegExp("^[ATCGatcg]+$")).required(),
}).default(null);

//Schema for each object within ligand array
const ligandSchema = Joi.object({
  doi: Joi.string().required(),
  method: Joi.string()
    .valid(
      "EMSA", 
      "DNase footprinting", 
      "Isothermal titration calorimetry", 
      "Synthetic regulation", 
      "Fluorescence polarization",
      "Surface plasmon resonance",
      )
    .required(),
  ref_figure: Joi.string()
    .pattern(new RegExp("^(Figure|Table) [S]?[1-9]?[0-9A-Za-z]?$"))
    .required(),
  name: Joi.string().max(64).required(),
  SMILES: Joi.string().required(),
}).default(null);

//Main validation schema
const mainSchema = Joi.object({
  uniProtID: Joi.string().pattern(new RegExp("^[A-Za-z0-9_]+$")).required(),
  family: Joi.string()
    .valid(
      "TETR",
      "LYSR",
      "ARAC",
      "MARR",
      "LACI",
      "GNTR",
      "LUXR",
      "ICLR",
      "OTHER"
    )
    .required(),
  about: {
    about: Joi.string().max(500).optional().allow(''),
    accession: Joi.string().pattern(new RegExp("^[A-Za-z0-9_.]+$")).required(),
    alias: Joi.string().max(16).pattern(new RegExp("^[A-Za-z0-9_.]+$")).required(),
    mechanism: Joi.string()
      .valid("Apo-repressor", "Apo-activator", "Co-repressor", "Co-activator").optional().allow('')
  },
  // One or the other here
  operator: Joi.object({
    data: Joi.array().items(operatorSchema),
  }),
  ligands: Joi.object({
    data: Joi.array().items(ligandSchema),
  }),
  //To be changed in the future
  lineage: {
    child_id: Joi.string().min(0).allow(""),
    mutation: Joi.string().min(0).allow(""),
    parent_id: Joi.string().min(0).allow(""),
    doi: Joi.string().min(0).allow(""),
  },
  
  user: Joi.string(),
  timeSubmit: Joi.number()
}).options({ abortEarly: false });

//Check if the ID already exists in the prod database
const checkForProdDupe = async (family, id) => {
    const params = {
        TableName: process.env.TABLE_NAME,
        Key: {
            PK: family,
            SK: `${id}#ABOUT`,
        },
    };
    
    const command = new GetCommand(params);
    const result = await docClient.send(command);
    
    if (result.Item !== undefined && result.Item !== null) {
        throw new Error("Duplicate");
    }
};

const checkForTempDupe = async (family, id) => {
    const params = {
        TableName: process.env.TEMP_TABLE_NAME,
        Key: {
            PK: 'TEMP',
            SK: `${id}`
        },
    };
    
    const command = new GetCommand(params);
    const result = await docClient.send(command);
    
    if (result.Item !== undefined && result.Item !== null) {
        throw new Error("Duplicate");
    }
};

const writeToTemp = async (body) => {
    const params = {
        TableName: process.env.TEMP_TABLE_NAME,
        Item: {
          PK: `TEMP`,
          SK: `${body.uniProtID}`,
          ...body
        }
    }
    const command = new PutCommand(params);
    try {
        await docClient.send(command);
        console.log(`Successfully added sensor: ${body.uniProtID}`)
    } catch (err) {
        console.log(err);
        throw new Error()
    }
};

const returnErrorBody = async (errCode, message, corsHeaders) => {
  return {
    statusCode: errCode,
    headers: corsHeaders,
    //Optionally added body to return if message passed in
    ...(message && {
      body: JSON.stringify({
        message: message,
      }),
    }),
  };
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
  
    let body = JSON.parse(event.body);
    
    //Validate request body
    try {
        await mainSchema.validateAsync(body);
    } catch (err) {
        return returnErrorBody(400, {
            type: "Validation Error",
            errors: err.details.map((item) => {
                return item.message;
            })
        }, corsHeaders)
    }
    
    try {
        await checkForProdDupe(body.family, body.uniProtID);
    } catch (err) {
        console.log(err)
        return returnErrorBody(409, "This uniProtID already exists in our database. If there's an issue, please submit a bug report.", corsHeaders);
    }
    
    try {
        await checkForTempDupe(body.family, body.uniProtID);
    } catch (err) {
        return returnErrorBody(409, "A submission for this uniProtID is already pending. If there's an issue, please submit a bug report.", corsHeaders);
    }
    
    try {
        await writeToTemp(body);
    } catch (err) {
        return returnErrorBody(500, "Error processing submission. Please notify the administrators.", corsHeaders);
    }
    
    // TODO implement
    const response = {
        statusCode: 202,
        headers: corsHeaders,
    };
    return response;
}
