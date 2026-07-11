import { QueryCommand, BatchWriteCommand} from '@aws-sdk/lib-dynamodb'
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
const getItem = async(event) => {
    
    //Store query strings 
    let sensorID = event.queryStringParameters.sensorID;
    let family = event.queryStringParameters.family;
    
    //Construct batchGet parameters to get a single sensors info
    const params = {
        TableName: process.env.TEMP_TABLE_NAME,
        KeyConditionExpression: 'PK = :PK AND begins_with( SK, :SK )',
        ExpressionAttributeValues: {
            ':PK': `${family}`,
            ':SK': `${sensorID}`
        }
    }
    
    //Call and return data
    const command = new QueryCommand(params);
    const data = await docClient.send(command);
    console.log('data')
    console.log(data)
    return data;
};

const formatData = async (data) => {
    
    let resp = {}
    
    //TO be removed after frontend refactor
    let refs = []
    let doiSeen = {}
    
    //Retrieve the full references
    let fullRefs = []
    let fullRefSeen = {}
    
    //Walk through data and format it properly for UI
    for (let i = 0; i < data.length; i++) {
        switch (data[i].category) {
            case 'about': {
                const {PK, SK, mechanism, category, ...aboutObj} = data[i];
                resp = aboutObj;
                resp['regulationType'] = mechanism ?? "";
                break;
            }
            case 'ligands': {
                const {PK, SK, category, ...ligandObj} = data[i];

                  // If there's no .ligands array, set null and break
                  if (!ligandObj?.ligands || !Array.isArray(ligandObj.ligands)) {
                    resp['ligands'] = null;
                    break;
                  }

                let result = []
                
                for (let j = 0; j < ligandObj.ligands.length; j++) {
                    let item = ligandObj.ligands[j];
                    
                    //To be removed after frontend refactor
                    if (item?.doi?.length) {
                            refs.push({
                                doi: item.doi,
                                figure: item.ref_figure ? item.ref_figure : null,
                                interaction: 'Ligand',
                                method: item.method
                            });
                            doiSeen[item.doi] = true;
                    }
                    
                    //FullDOI data
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
                                figure: item.ref_Figure ? item.ref_figure : null,
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
                const {PK, SK, category, ...operatorObj} = data[i];

                  // If there's no .operators array, set null and break
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
                                figure: item.ref_Figure ? item.ref_figure : null,
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
                const {PK, SK, category, ...structObj} = data[i];

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
                                        type: 'Operator',
                                        method: item.method
                                    }],
                            }
                        }
                        else {
                            fullRefSeen[item.fullDOI.doi].interaction.push({
                                figure: item.ref_Figure ? item.ref_figure : null,
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
                const { PK, SK, category, ...operonObj } = data[i];
  
                let parsedOperon = null;
                if (operonObj?.newOperon?.data) {
                  try {
                    parsedOperon = JSON.parse(operonObj.newOperon.data);
                  } catch (err) {
                    console.log("Error parsing newOperon.data:", err);
                    parsedOperon = null;
                  }
                }
                
                resp['newOperon'] = parsedOperon;
                break;
            }
        }
    }
    
    resp['references'] = refs;
    resp['fullReferences'] = Object.values(fullRefSeen);
    return resp;

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
    
    //Standard try/catch for batch getting item info from DynamoDB
    try {
        const data = await getItem(event);
        console.log(data.Items)
        const result = await formatData(data.Items);
        const response = {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify(result)
        };
        return response;
    } catch (err) {
        const response = {
            statusCode: 400,
            headers: corsHeaders,
            body: JSON.stringify({
                message: "Error on getting processed temp, please check logs"
            })
        };
        console.log(err);
        return response;
    }
}