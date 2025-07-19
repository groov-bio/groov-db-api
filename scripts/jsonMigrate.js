import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { gzipSync } from 'zlib';

dotenv.config();

const client = new DynamoDBClient({ region: 'us-east-2' });
const docClient = DynamoDBDocumentClient.from(client);

if (!process.env.TABLE_NAME) {
  console.error('ERROR: TABLE_NAME environment variable is required.');
  process.exit(1);
}

const BASE_DIR = path.join(process.cwd(), 's3');
const SENSORS_DIR = path.join(BASE_DIR, 'sensors');

if (!fs.existsSync(BASE_DIR)) {
  fs.mkdirSync(BASE_DIR, { recursive: true });
  console.log(`Created base directory: ${BASE_DIR}`);
}

if (!fs.existsSync(SENSORS_DIR)) {
  fs.mkdirSync(SENSORS_DIR, { recursive: true });
  console.log(`Created sensors directory: ${SENSORS_DIR}`);
}

// Function to scan the entire DynamoDB table
async function scanTable() {
  const params = {
    TableName: process.env.TABLE_NAME,
  };

  let allItems = [];
  let lastEvaluatedKey = null;

  do {
    if (lastEvaluatedKey) {
      params.ExclusiveStartKey = lastEvaluatedKey;
    }

    try {
      const command = new ScanCommand(params);
      const response = await docClient.send(command);
      
      allItems = [...allItems, ...response.Items];
      lastEvaluatedKey = response.LastEvaluatedKey;
      
      console.log(`Scanned ${response.Items.length} items. Total: ${allItems.length}`);
    } catch (error) {
      console.error('Error scanning table:', error);
      throw error;
    }
  } while (lastEvaluatedKey);

  console.log(`Scan complete. Retrieved ${allItems.length} items.`);
  return allItems;
}

// Format data using the same logic as getSensor function
function formatData(items) {
  try {
    const groupedItems = {};
    
    items.forEach(item => {
      if (item.SK && typeof item.SK === 'string' && item.PK) {
        const parts = item.SK.split('#');
        if (parts.length > 0) {
          const sensorId = parts[0];
          const family = item.PK;
          
          if (!groupedItems[family]) {
            groupedItems[family] = {};
          }
          
          if (!groupedItems[family][sensorId]) {
            groupedItems[family][sensorId] = [];
          }
          
          groupedItems[family][sensorId].push(item);
        }
      }
    });

    const formattedSensors = {};
    const sensorsIndex = [];
    
    for (const [family, familySensors] of Object.entries(groupedItems)) {
      if (!formattedSensors[family]) {
        formattedSensors[family] = {};
      }
      
      for (const [sensorId, sensorItems] of Object.entries(familySensors)) {
        let resp = {};
        
        let refs = [];
        let doiSeen = {};
        
        // Retrieve the full references
        let fullRefSeen = {};
        
        // Walk through data and format it properly for UI
        for (let i = 0; i < sensorItems.length; i++) {
          switch (sensorItems[i].category) {
            case 'about': {
              const {PK, SK, mechanism, category, ...aboutObj} = sensorItems[i];
              resp = aboutObj;
              resp['regulationType'] = mechanism ?? "";
              break;
            }
            case 'ligands': {
              const {PK, SK, category, ...ligandObj} = sensorItems[i];
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
              const {PK, SK, category, ...operatorObj} = sensorItems[i];

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
              const {PK, SK, category, ...structObj} = sensorItems[i];

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
              const {PK, SK, category, ...operonObj} = sensorItems[i];
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
        
        // Create index entry for this sensor
        if (resp.uniprotID) {
          sensorsIndex.push({
            id: resp.uniprotID,
            family: family,
            alias: resp.alias || "",
            organism: resp.organism || "",
            organismID: resp.organismID || null,
            regulationType: resp.regulationType || "",
            ligandCount: resp.ligands ? resp.ligands.length : 0,
            operatorCount: resp.operators ? resp.operators.length : 0,
            updated: new Date().toISOString().split('T')[0], // Current date in YYYY-MM-DD format
            key: `sensors/${family.toLowerCase()}/${resp.uniprotID}.json`
          });
        }
        
        formattedSensors[family][sensorId] = resp;
      }
    }
    
    return { formattedSensors, sensorsIndex };
  } catch (err) {
    console.error('Data Processing Error:', err);
    throw err;
  }
}

async function processSensors(items) {
  try {
    const { formattedSensors, sensorsIndex } = formatData(items);
    
    let totalSensors = 0;
    
    for (const [family, sensors] of Object.entries(formattedSensors)) {
      // Create family directory
      const familyDir = path.join(SENSORS_DIR, family.toLowerCase());
      if (!fs.existsSync(familyDir)) {
        fs.mkdirSync(familyDir, { recursive: true });
        console.log(`Created family directory: ${familyDir}`);
      }
      
      // Save each sensor in this family
      for (const [sensorId, sensorData] of Object.entries(sensors)) {
        const filePath = path.join(familyDir, `${sensorId}.json`);
        
        try {
          fs.writeFileSync(filePath, JSON.stringify(sensorData, null, 2));
          console.log(`Saved sensor data: ${filePath}`);
          totalSensors++;
        } catch (error) {
          console.error('Error saving sensor:', sensorId, error);
        }
      }
    }
    
    console.log(`Found ${sensorsIndex.length} unique sensors.`);
    
    // Create and save the index file
    const indexData = {
      version: new Date().toISOString(),
      count: sensorsIndex.length,
      sensors: sensorsIndex
    };
    
    const indexPath = path.join(BASE_DIR, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify(indexData, null, 2));
    console.log(`Created index file: ${indexPath}`);
    
    return { totalSensors, indexPath, formattedSensors };
  } catch (error) {
    console.error('Failed to process sensors:', error);
    throw error;
  }
}

// Function to create a JSON file containing all sensors
async function createSensorsJson(formattedSensors) {
  try {
    // Transform the nested object structure into a flat array of sensor objects
    const sensorsArray = [];
    
    for (const [family, sensors] of Object.entries(formattedSensors)) {
      for (const [sensorId, sensorData] of Object.entries(sensors)) {
        // Add family and id to each sensor object
        sensorsArray.push({
          ...sensorData,
          family: family,
          id: sensorId
        });
      }
    }
    
    const allSensorsData = {
      version: new Date().toISOString(),
      count: sensorsArray.length,
      sensors: sensorsArray
    };
    
    const jsonPath = path.join(BASE_DIR, 'all-sensors.json');
    fs.writeFileSync(jsonPath, JSON.stringify(allSensorsData, null, 2));
    
    console.log(`Created JSON file with all sensors: ${jsonPath}`);
    console.log(`File size: ${fs.statSync(jsonPath).size} bytes`);
    
    return jsonPath;
  } catch (error) {
    console.error('Failed to create JSON file:', error);
    throw error;
  }
}

// Main function to run the script
async function main() {
  try {
    console.log(`Starting scan of table: ${process.env.TABLE_NAME}`);
    const items = await scanTable();
    const { totalSensors, indexPath, formattedSensors } = await processSensors(items);
    
    // Create the JSON file with all sensors
    const jsonPath = await createSensorsJson(formattedSensors);
    
    console.log(`Process completed successfully. Saved ${totalSensors} sensors.`);
    console.log(`Index file created at: ${indexPath}`);
    console.log(`All sensors JSON file created at: ${jsonPath}`);
  } catch (error) {
    console.error('Failed to complete the process:', error);
    process.exit(1);
  }
}

// Run the script
main();