//Require imports
import Cite from 'citation-js';
import Joi from 'joi';
import fetch from 'node-fetch';
import { GetCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb'
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { logger } from './utils/logger.js';
import { invokeLambda } from './utils/lambdaInvoker.js';

// Initialize the DynamoDB Document Client
const client = new DynamoDBClient({ 
  region: "us-east-2",
  ...(process.env.IS_LOCAL && { endpoint: "http://host.docker.internal:8000" })
});
const docClient = DynamoDBDocumentClient.from(client);

// List of allowed origins
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

// Add default timeout for fetch requests
const fetchWithTimeout = async (url, options = {}, timeout = 30000) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    logger.error(`Fetch request to ${url} failed`, error);
    throw error;
  }
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
  sequence: Joi.string().max(512).pattern(new RegExp("[ATCGatcg]")).required(),
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
  uniProtID: Joi.string().pattern(new RegExp("[A-Za-z0-9_]")).required(),
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
    accession: Joi.string().pattern(new RegExp("[A-Za-z0-9_.]")).required(),
    alias: Joi.string().max(16).pattern(new RegExp("[A-Za-z0-9_.]")).required(),
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
  timeSubmit: Joi.number(),
  // Edit-specific fields
  editTimestamp: Joi.number().optional(),
  isEdit: Joi.boolean().optional(),
  submissionType: Joi.string().valid('new', 'edit').optional(),
  originalSK: Joi.string().optional()
}).options({ abortEarly: false });


//Function to check if the new ID already exists in the DB
const checkForDupe = async (family, id) => {
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
      PK: family,
      SK: `${id}#ABOUT`,
    },
  };

  const command = new GetCommand(params);
  const result = await docClient.send(command);

  if (result.Item !== undefined && result.Item !== null) {
    throw new Error("Duplicate");
  }
}

const callUniProtAPI = async (id) => {
  try {
    logger.info(`Calling UniProt API for ID: ${id}`);
    const response = await fetchWithTimeout(
      `https://rest.uniprot.org/uniprotkb/search?query=(accession:${id})&fields=accession,organism_name,organism_id,gene_primary,sequence,xref_refseq,xref_kegg,xref_pdb`,
      {},
      10000
    );
    
    if (!response.ok) {
      logger.error(`UniProt API returned non-OK status: ${response.status}`, { responseText: await response.text() });
      throw new Error(`UniProt API error: ${response.status}`);
    }

    const data = await response.json();
    logger.info(`UniProt API call successful`);
    return data;
  } catch (err) {
    logger.error(`Error calling UniProt API`, err);
    throw err;
  }
};

//Wrapper to batchwrite to DynamoDB
const writeBatch = async (batch) => {
    const params = {
        TableName: process.env.TEMP_TABLE_NAME,
        RequestItems: batch
    }

    try {
        logger.info('Writing batch to DynamoDB', { tableName: process.env.TEMP_TABLE_NAME });
        const command = new BatchWriteCommand(params);
        const data = await docClient.send(command);
        logger.info('Successfully wrote batch to DynamoDB');
        return data;
    } catch (err) {
        logger.error('Write error to DynamoDB:', err, { params });
        throw new Error(`DynamoDB write error: ${err.message}`);
    }
};

//Function which uses citaiton-js to easily call for DOI data to save to DB
const callDOI = async (doi) => {
  let error = new Error(); //Create error object is neccessary
  let citation;
  let citeData;

  if (doi !== null) {
    try {
      citation = new Cite(doi);
    } catch (err) {
      console.log(err);
      Object.assign(error, {
        code: 500,
        message: `Error with citation-js for doi: ${doi}. Check logs.`
      });
      throw error;
    }

    let out = citation.format("data", {
      template: "apa",
    });
  
    try {
      citeData = JSON.parse(out);
    } catch (err) {
      console.log(err);
      Object.assign(error, {
        code: 500,
        message: `Error parsing citation-js our for doi: ${doi}. Check logs.`
      });
      throw error;
    }
  
    let title = "";
    let authors = [];
    let year = "";
    let journal = "";
    let newDOI = "";
    let url = "";
  
    for (let j = 0; j < citeData.length; j++) {
      if (citeData[j].author) {
        for (let i = 0; i < citeData[j]?.author.length; i++) {
          let lastName = citeData[j]?.author[i]["family"];
          let firstName = citeData[j]?.author[i]["given"];
          authors.push({
            lastName: lastName,
            firstName: firstName,
          });
        }
      }
  
      if (citeData[j].title) {
        title = citeData[j].title;
      }
  
      if (citeData[j].issued) {
        if (citeData[j].issued["date-parts"]) {
          year = citeData[j].issued["date-parts"][0][0];
        }
      }
  
      if (citeData[j]["container-title-short"]) {
        journal = citeData[j]["container-title-short"];
      } else if (citeData[j]["container-title"]) {
        journal = citeData[j]["container-title"];
      }
  
      if (citeData[j].DOI) {
        newDOI = citeData[j]?.DOI;
      }
  
      if (citeData[j].URL) {
        url = citeData[j]?.URL;
      }
    }
 
    return {
      title: title,
      authors: authors,
      year: year,
      journal: journal,
      doi: newDOI,
      url: url,
    };
  } else {
    return {
      title: null,
      authors: null,
      year: null,
      journal: null,
      doi: null,
      url: null,
    }
  }
};

//Loop over passed in array to extract doi into fullDOI
const loopObject = async (obj, type) => {
  
  if (!obj) {
    return;
  }

  const data = obj?.data?.data;

  if (!data) {
    return;
  }

  let result = [...data];
  
  for (let i = 0; i < result.length; i++) {
    if (result[i].hasOwnProperty("doi")) {
      result[i] = {
        ...result[i],
        fullDOI: await callDOI(result[i].doi),
      };
    }
  }

  return result;
};

//Construct each batch-write field for this sensor
const constructField = async (type, newSensor, family, id) => {
  switch (type) {
    case "about": {
      return {
        PK: family.toUpperCase(),
        SK: `${id}#ABOUT`,
        alias: newSensor.alias,
        about: newSensor.about,
        accession: newSensor.accession,
        organism: newSensor.organism,
        organismID: newSensor.organismID,
        family: newSensor.family,
        mechanism: newSensor.mechanism,
        name: newSensor.name,
        keggID: newSensor.keggID,
        sequence: newSensor.sequence,
        uniprotID: newSensor.uniProtID,
        category: "about",
      };
    }
    case "ligands": {
      return {
        PK: family.toUpperCase(),
        SK: `${id}#LIGANDS`,
        ligands: await loopObject(newSensor, 'ligands'), //TODO - walk for doi data
        category: "ligands",
      };
    }
    case "lineage": {
      return {
        PK: family.toUpperCase(),
        SK: `${id}#LINEAGE`,
        child_id: newSensor.child_id,
        mutation: newSensor.mutation,
        parent_id: newSensor.parent_id,
        doi: newSensor.doi,
        category: "lineage",
      };
    }
    case "operator": {
      return {
        PK: family.toUpperCase(),
        SK: `${id}#OPERATOR`,
        operators: await loopObject(newSensor, 'operator'), //TODO - walk for doi data
        category: "operator",
      };
    }
    case "operon": {
      return {
        PK: family.toUpperCase(),
        SK: `${id}#OPERON`,
        newOperon: newSensor,
        category: "operon",
      };
    }
    case "structure": {
      return {
        PK: family.toUpperCase(),
        SK: `${id}#STRUCTURE`,
        data: await loopObject(newSensor, 'structure'), //TODO - walk for doi data
        category: "structure",
      };
    }
  }
};

const walkData = async (body) => {
  //Construct batchWrite object
  let batch = {
    [`${process.env.TEMP_TABLE_NAME}`]: [
      {
        PutRequest: {
          Item: await constructField(
            "about",
            body.about,
            body.family,
            body.uniProtID
          ),
        },
      },
      ...(
        body?.ligands ? [{   
          PutRequest: {
            Item: await constructField(
              "ligands",
              body.ligands,
              body.family,
              body.uniProtID
            ),
          },
        }] : []
      ),
      ...(
        body?.lineage ? [{
          PutRequest: {
            Item: await constructField(
              "lineage",
              body.lineage,
              body.family,
              body.uniProtID
            ),
          },
        }] : []
      ),
      ...(
        body?.operator ? [{
          PutRequest: {
            Item: await constructField(
              "operator",
              body.operator,
              body.family,
              body.uniProtID
            ),
          },
        }] : []
      ),
      {
        PutRequest: {
          Item: await constructField(
            "operon",
            body.operon,
            body.family,
            body.uniProtID
          ),
        },
      },
      {
        PutRequest: {
          Item: await constructField(
            "structure",
            body.structure,
            body.family,
            body.uniProtID
          ),
        },
      },
    ],
  };

  return batch;
};

export const callOperonLambda = async (id) => {
  try {
    logger.info(`Invoking Operon Lambda for ID: ${id}`);
    const payload = {
      queryStringParameters: {
        id,
      }
    };

    const result = await invokeLambda(
      'getOperon',
      process.env.GET_OPERON_FUNCTION_ARN,
      payload,
      null,
      'GET'  // Specify GET method
    );
    
    return result.body;
  } catch (err) {
    logger.error(`Error invoking Operon Lambda`, err);
    throw err;
  }
};

const processPDBId = async (id) => {
  try {
    logger.info(`Processing PDB ID: ${id}`);
    const result = await fetchWithTimeout(`https://data.rcsb.org/graphql`, {
      method: 'post',
      body: JSON.stringify({
        query: `
          {
            entry(entry_id: "${id}")
            {
              exptl{method}
              rcsb_primary_citation {
                pdbx_database_id_DOI
              }
            }
          }
        `
      }),
      headers: {
        'Content-Type': "application/json",
        'User-Agent': "Mozilla/5.0 (X11; CrOS x86_64 13904.41.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.81 Safari/537.36"
      }
    }, 10000);

    if (!result.ok) {
      logger.error(`PDB API returned non-OK status: ${result.status}`, { responseText: await result.text() });
      throw new Error(`PDB API error: ${result.status}`);
    }

    const data = await result.json();
    logger.info(`Successfully processed PDB ID`);
    return {
      doi: data.data.entry.rcsb_primary_citation.pdbx_database_id_DOI ? data.data.entry.rcsb_primary_citation.pdbx_database_id_DOI : null,
      method: data.data.entry.exptl[0].method,
      PDB_code: id
    }
  } catch (err) {
    logger.error(`Error processing PDB ID`, err);
    throw err;
  }
}

const tryXrefData = async (data, accession) => {
  let xref = data.uniProtKBCrossReferences;

  let operonData = null;
  let structureData = [];
  let keggID = null;
  let error = new Error(); //Used to generate custom error, if applicable

  const throwError = (msg) => {
    Object.assign(error, {
      code: 500,
      message: msg
    });
    throw error;
  }
  
  //User provided accession, this takes precedent
  if (accession) {
    try {
      operonData = await callOperonLambda(accession);
    } catch (e) {
      console.log(e);
      throwError('Something went wrong with operon lambda call');
    }
  }

  for (let i = 0; i < xref.length; i++) {
    switch (xref[i].database) {
      case "RefSeq":
        
        //This is only called if the user didn't submit an accession
        if (!accession) {
          try {
            operonData = await callOperonLambda(xref[i].id);
          } catch (e) {
            console.log(e);
            throwError("Something went wrong with operon lambda call");
          }
        }
        break;
      case 'PDB':
        try {
          let pdbResult = await processPDBId(xref[i].id);
          structureData.push(pdbResult);
        } catch (e) {
          console.log(e);
          throwError("Something went wrong with PDB API call");
        }
        break;
      case 'KEGG':
        if (!keggID) {
          keggID = xref[i].id;
        }
    }
  }

  return {
    operon: operonData,
    structure: structureData,
    kegg: keggID
  }
};

const createObj = async (uniData, xrefData, body) => {
  return {
    family: body.family,
    uniProtID: body.uniProtID,
    about: {
      ...body.about,
      organism: uniData?.organism?.scientificName || null,
      organismID: uniData?.organism?.taxonId || null,
      family: body.family,
      name: uniData.genes ? uniData?.genes[0]?.geneName?.value || null : null,
      // name: uniData?.genes[0]?.geneName?.value || null,
      keggID: xrefData?.kegg || null,
      sequence: uniData?.sequence?.value || null,
      uniProtID: uniData?.primaryAccession || null,
    },
    ligands: {
      data: body?.ligands || null
    },
    lineage: {
      child_id: body?.lineage?.child_id || null,
      mutation: body?.lineage?.mutation || null,
      parent_id: body?.lineage?.parent_id || null,
      doi: body?.lineage?.doi || null,
    },
    operator: {
      data: body?.operator || null,
    },
    operon: {
      data: xrefData?.operon || null,
    },
    structure: {
      data: xrefData?.structure || null
    }
  }
}

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

// Function to fetch sensor data from temp table - handles both regular submissions and edits
const fetchFromTempTable = async (uniProtID) => {
  // First try to get regular submission (from insertForm)
  let params = {
    TableName: process.env.TEMP_TABLE_NAME,
    Key: {
      PK: 'TEMP',
      SK: uniProtID,
    },
  };

  let command = new GetCommand(params);
  let result = await docClient.send(command);

  if (result.Item) {
    return result.Item;
  }

  // If not found, try to get edit submission (from editSensor)
  params = {
    TableName: process.env.TEMP_TABLE_NAME,
    Key: {
      PK: 'TEMP',
      SK: `${uniProtID}#EDIT`,
    },
  };

  command = new GetCommand(params);
  result = await docClient.send(command);

  if (result.Item) {
    return result.Item;
  }

  // If neither found, throw error
  throw new Error(`No submission found for uniProtID: ${uniProtID}`);
};

export const handler = async (event) => {
  // Get CORS headers for this specific request
  const corsHeaders = getCorsHeaders(event);
  
  if (event.requestContext?.http?.method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: ''
    };
  }

  try {
    logger.info('Starting addNewSensor handler', { eventPath: event.path, method: event.httpMethod });
    
    // Ensure event.body exists
    if (!event.body) {
      logger.error('Missing request body');
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        },
        body: JSON.stringify({
          message: 'Missing request body'
        })
      };
    }
    
    let requestBody;
    try {
      requestBody = JSON.parse(event.body);
    } catch (err) {
      logger.error('Invalid JSON in request body', err);
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        },
        body: JSON.stringify({
          message: 'Invalid JSON in request body'
        })
      };
    }
    
    let data;
    
    // Check if this is a request to process temp data (from admin UI)
    if (requestBody.uniProtID && requestBody.family && !requestBody.about) {
      // This is a request from admin UI to process temp data
      try {
        data = await fetchFromTempTable(requestBody.uniProtID);
        logger.info('Successfully fetched data from temp table for processing', { uniProtID: requestBody.uniProtID });
      } catch (err) {
        logger.error('Error fetching from temp table', err);
        return {
          statusCode: 404,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          },
          body: JSON.stringify({
            message: 'No submission found for the provided uniProtID'
          })
        };
      }
    } else {
      // This is a direct submission (shouldn't happen in normal flow but keeping for backwards compatibility)
      data = requestBody;
    }
    
    let uniData;
    let xrefData;
    let fullDataObj;
    let walkedResult;

    //Schema validation first
    try {
      await mainSchema.validateAsync(data);
    } catch (err) {
      logger.error('Validation error', err);
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        },
        body: JSON.stringify({
          type: "Validation Error",
          errors: err.details.map((item) => {
            return item.message;
          }),
        })
      };
    }

    // For edits, skip the duplicate check since the sensor already exists in production
    if (!data.isEdit) {
      //Check ID doesn't already exist
      try {
        await checkForDupe(data.family, data.uniProtID);
      } catch (err) {
        console.log(err)
        return returnErrorBody(409, "uniProtID already exists in production.", corsHeaders);
      }
      
      // Also check temp table for new submissions only
      try {
        await checkForTempDupe(data.family, data.uniProtID);
      } catch (err) {
        console.log(err)
        return returnErrorBody(409, "uniProtID already exists in temp.", corsHeaders);
      }
    }

    //Call uniProtID API
    try {
      uniData = await callUniProtAPI(data.uniProtID);
      if (!uniData.results || uniData.results.length === 0) {
        logger.error('No results found for uniProtID', { uniProtID: data.uniProtID });
        return {
          statusCode: 400,
          headers: {
            'Content-Type': 'application/json',
            ...corsHeaders
          },
          body: JSON.stringify({
            message: "uniProtID is invalid - no results found"
          })
        };
      }
    } catch (err) {
      logger.error('Error calling UniProt API', err, { uniProtID: data.uniProtID });
      return {
        statusCode: 400,
        headers: {
          'Content-Type': 'application/json',
          ...corsHeaders
        },
        body: JSON.stringify({
          message: "Error calling UniProt API: " + err.message
        })
      };
    }

    //Walk through xRef data & make appropriate API calls
    try {
      xrefData = await tryXrefData(uniData.results[0], data.about.accession ? data.about.accession : null);
    } catch (err) {
      console.log(err)
      return returnErrorBody(err.code, err.message);
    }

    //Construct full object to be read from previous API calls
    try {
      fullDataObj = await createObj(uniData.results[0], xrefData, data);
      console.log('fullDataObj:')
      console.log(fullDataObj)
    } catch (err) {
      console.log(err)
      return returnErrorBody(500, `Error trying to create full object from API calls. Error: ${err}`);
    }

    try {
      walkedResult = await walkData(fullDataObj);
    } catch (err) {
      console.log(err)
      return returnErrorBody(err.code, err.message);
    }
    
    try {
      await writeBatch(walkedResult);
    } catch (err) {
      console.log(err)
      return returnErrorBody(500, 'Error writing to DynamoDB.')
    }

    logger.info('Successfully processed request');
    return {
      statusCode: 202,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      },
      body: JSON.stringify({
        message: 'Processing completed successfully'
      })
    };
  } catch (err) {
    logger.error('Unhandled exception in handler', err);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders
      },
      body: JSON.stringify({
        message: 'Internal server error: ' + err.message
      })
    };
  }
}
