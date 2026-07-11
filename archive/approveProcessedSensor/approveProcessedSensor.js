import { QueryCommand, BatchWriteCommand} from '@aws-sdk/lib-dynamodb'
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { 
  updateMainIndex, 
  updateFamilyIndex, 
  saveSensorFile, 
  updateAllSensors, 
  updateFingerprints 
} from './s3Updater.js';

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

const createDeleteReq = (family, id) => {
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
    
    return batch;
}

//Function that calls docClient.batchGet
const getItem = async(id, family, table) => {
    
    //Construct batchGet parameters to get a single sensors info
    const params = {
        TableName: table,
        KeyConditionExpression: 'PK = :PK AND begins_with( SK, :SK )',
        ExpressionAttributeValues: {
            ':PK': `${family}`,
            ':SK': `${id}`
        }
    }

    const command = new QueryCommand(params);
    const data = await docClient.send(command);
    
    return data;
};

//Wrapper to batchwrite to DynamoDB
const writeBatch = async (batch, table) => {
    const params = { 
        TableName: table,
        RequestItems: batch,
    }
    
    try {
        const command = new BatchWriteCommand(params)
        await docClient.send(command);
    } catch (err) {
        console.log('Write error to DynamoDB:')
        console.log(err);
        throw new Error();
    }
};

const generateBatch = (items) => {
    let batch = {
        [`${process.env.TABLE_NAME}`]: []
    }
    
    items.forEach(item => batch[`${process.env.TABLE_NAME}`].push(
            {
                PutRequest: {
                    Item: item
                }
            }
        ))
        
    return batch;
}

// Format sensor data from DynamoDB items
const formatSensorData = (items) => {
    try {
        let resp = {};
        let refs = [];
        let doiSeen = {};
        let fullRefSeen = {};
        
        // Walk through data and format it properly
        for (let i = 0; i < items.length; i++) {
            switch (items[i].category) {
                case 'about': {
                    const {PK, SK, mechanism, category, ...aboutObj} = items[i];
                    resp = aboutObj;
                    resp['regulationType'] = mechanism ?? "";
                    break;
                }
                case 'ligands': {
                    const {PK, SK, category, ...ligandObj} = items[i];
                    // If there's no .ligands array, set null and break
                    if (!ligandObj?.ligands || !Array.isArray(ligandObj.ligands)) {
                        resp['ligands'] = null;
                        break;
                    }

                    let result = [];
                    
                    for (let j = 0; j < ligandObj.ligands.length; j++) {
                        let item = ligandObj.ligands[j];
                        
                        if (item?.doi?.length) {
                            refs.push({
                                doi: item.doi,
                                figure: item.ref_figure ? item.ref_figure : null,
                                interaction: 'Ligand',
                                method: item.method
                            });
                            doiSeen[item.doi] = true;
                        }
                        
                        // FullDOI data
                        if (item?.fullDOI) {
                            if (!fullRefSeen[item.fullDOI.doi]) {
                                fullRefSeen[item.fullDOI.doi] = {
                                    title: item.fullDOI.title,
                                    authors: item.fullDOI.authors,
                                    year: item.fullDOI.year,
                                    journal: item.fullDOI.journal,
                                    doi: item.fullDOI.doi,
                                    url: item.fullDOI.url,
                                    interaction: [
                                        {
                                            figure: item.ref_figure ? item.ref_figure : null,
                                            type: 'Ligand',
                                            method: item.method
                                        }],
                                }
                            } else {
                                fullRefSeen[item.fullDOI.doi].interaction.push({
                                    figure: item.ref_figure ? item.ref_figure : null,
                                    type: 'Ligand',
                                    method: item.method
                                })
                            }
                        }
                        result.push(item);
                    } 
                    
                    resp['ligands'] = result;
                    break;
                }
                case 'operator': {
                    const {PK, SK, category, ...operatorObj} = items[i];

                    if (!operatorObj?.operators || !Array.isArray(operatorObj.operators)) {
                        resp['operators'] = null;
                        break;
                    }

                    let result = [];
                    
                    for (let j = 0; j < operatorObj.operators.length; j++) {
                        let item = operatorObj.operators[j];
                        if (item?.doi?.length) {
                            refs.push({
                                doi: item.doi,
                                figure: item.ref_figure ? item.ref_figure : null,
                                interaction: 'Operator',
                                method: item.method
                            })
                            doiSeen[item.doi] = true;
                        }
                        if (item?.fullDOI) {
                            if (!fullRefSeen[item.fullDOI.doi]) {
                                fullRefSeen[item.fullDOI.doi] = {
                                    title: item.fullDOI.title,
                                    authors: item.fullDOI.authors,
                                    year: item.fullDOI.year,
                                    journal: item.fullDOI.journal,
                                    doi: item.fullDOI.doi,
                                    url: item.fullDOI.url,
                                    interaction: [
                                        {
                                            figure: item.ref_figure ? item.ref_figure : null,
                                            type: 'Operator',
                                            method: item.method
                                        }],
                                }
                            } else {
                                fullRefSeen[item.fullDOI.doi].interaction.push({
                                    figure: item.ref_figure ? item.ref_figure : null,
                                    type: 'Operator',
                                    method: item.method
                                })
                            }
                        }
                        result.push(item);
                    }
                    
                    resp['operators'] = result;
                    break;
                }
                case 'structure': {
                    const {PK, SK, category, ...structObj} = items[i];

                    // If there's no .data array, set null and break
                    if (!structObj?.data || !Array.isArray(structObj.data)) {
                        resp['structures'] = null;
                        break;
                    }

                    let result = []
                    
                    for (let j = 0; j < structObj.data.length; j++) {
                        let item = structObj.data[j];
                        if (item?.doi?.length) {
                            refs.push({
                                doi: item.doi,
                                figure: item?.ref_figure ? item.ref_figure : null,
                                interaction: 'Structure',
                                method: item.method
                            })
                            doiSeen[item.doi] = true;
                        }
                        if (item?.fullDOI) {
                            if (!fullRefSeen[item.fullDOI.doi]) {
                                fullRefSeen[item.fullDOI.doi] = {
                                    title: item.fullDOI.title,
                                    authors: item.fullDOI.authors,
                                    year: item.fullDOI.year,
                                    journal: item.fullDOI.journal,
                                    doi: item.fullDOI.doi,
                                    url: item.fullDOI.url,
                                    interaction: [
                                        {
                                            figure: item.ref_figure ? item.ref_figure : null,
                                            type: 'Structure',
                                            method: item.method
                                        }],
                                }
                            }
                            else {
                                fullRefSeen[item.fullDOI.doi].interaction.push({
                                    figure: item.ref_figure ? item.ref_figure : null,
                                    type: 'Structure',
                                    method: item.method
                                })
                            }
                        }
                        result.push(item.PDB_code);
                    }
                    
                    resp['structures'] = result;
                    break;
                }
                case 'operon': {
                    const {PK, SK, category, ...operonObj} = items[i];
                    let operonResult = [];
                    
                    if (operonObj.newOperon) {
                        if (typeof operonObj.newOperon.data === 'string') {
                            resp['newOperon'] = JSON.parse(operonObj.newOperon.data)
                        } else {
                            resp['newOperon'] = operonObj.newOperon;
                        }
                    } else {
                        for (let j = 0; j < operonObj.operon.length; j++) {
                            let item = operonObj.operon[j];
                            operonResult.push(item);
                        }
                    }
                    
                    resp['operon'] = operonResult;
                    break;
                }
            }
        }
        
        resp['references'] = refs;
        resp['fullReferences'] = Object.values(fullRefSeen);
        
        return resp;
    } catch (err) {
        console.error('Data Formatting Error:', err);
        throw err;
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

// Update S3 with the formatted sensor data
const updateS3Data = async (sensorData, family) => {
    try {
        console.log('Starting S3 updates...');
        
        // Update main index.json file
        await updateMainIndex(sensorData, family);
        
        // Update family index file
        await updateFamilyIndex(sensorData, family);
        
        // Save sensor JSON file
        await saveSensorFile(sensorData, family);
        
        // Update all-sensors.json file
        await updateAllSensors(sensorData);
        
        const fingerprintSuccess = await updateFingerprints(sensorData, family);
        if (!fingerprintSuccess) {
            console.log('Fingerprint update failed, but continuing with other updates');
        }
        
        console.log('S3 updates completed successfully');
        return true;
    } catch (error) {
        console.error('Error updating S3 data:', error);
        // We return false here instead of throwing to allow the function to continue
        // since the DynamoDB update was successful
        return false;
    }
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
  
    //Members
    let itemResult;
    let constructedBatch;
    let deleteReq;
    let formattedSensorData;
    
    const eventBody = JSON.parse(event.body);
    
    //Move the data from temp table to prod
    try {
        itemResult = await getItem(eventBody.uniProtID, eventBody.family, process.env.TEMP_TABLE_NAME);
    } catch (err) {
        console.log(err)
      return returnErrorBody(500, 'Error reading item from temp table', corsHeaders);
    }

    
    try {
      constructedBatch = generateBatch(itemResult.Items);
    } catch (err) {
      return returnErrorBody(500, `Error creating batch to write to prod, error: ${err}`, corsHeaders);
    }
    
    try {
      await writeBatch(constructedBatch, process.env.TABLE_NAME);
      console.log('Successfully wrote to DynamoDB production table');
    } catch (err) {
      return returnErrorBody(500, `Error writing batch to prod, error: ${err}`, corsHeaders);
    }
    
    // Format the sensor data for S3
    try {
        formattedSensorData = formatSensorData(itemResult.Items);
        console.log('Successfully formatted sensor data for S3');
    } catch (err) {
        console.error('Error formatting sensor data:', err);
        // Continue with deletion from temp table even if formatting fails
    }
    
    // Skip the temp table deletion if SKIP_TEMP_DELETE is set to "true"
    if (process.env.SKIP_TEMP_DELETE !== "true") {
        try {
          deleteReq = createDeleteReq(eventBody.family, eventBody.uniProtID);
        } catch (err) {
          return returnErrorBody(202, 'Error creating batch to delete from temp table', corsHeaders);
        }
        
        try {
          await writeBatch(deleteReq, process.env.TEMP_TABLE_NAME);
          console.log('Successfully deleted from temp table');
        } catch (err) {
          return returnErrorBody(202, 'Unable to delete sensor from temp table.', corsHeaders);
        }
    } else {
        console.log('Skipping deletion from temp table as SKIP_TEMP_DELETE is set to true');
    }
    
    // Update S3 if we have formatted sensor data
    if (formattedSensorData) {
        try {
            const s3UpdateSuccess = await updateS3Data(formattedSensorData, eventBody.family);
            if (!s3UpdateSuccess) {
                console.warn('S3 updates were not fully successful, but DynamoDB updates completed');
            }
        } catch (err) {
            console.error('Error during S3 update process:', err);
            // We don't return an error here since the DynamoDB operations were successful
        }
    }
    
    const response = {
        statusCode: 200,
        headers: corsHeaders,
    };
    return response;
}