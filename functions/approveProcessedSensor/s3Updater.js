import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { gzipSync, gunzipSync } from 'zlib';
import { invokeLambda } from './utils/lambdaInvoker.js';

// Configure S3 client
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

async function getObjectFromS3(key) {
  try {
    const command = new GetObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key
    });
    
    const response = await s3Client.send(command);
    const streamToBuffer = await streamToString(response.Body);
    
    return streamToBuffer;
  } catch (error) {
    console.error('Error getting object from S3:', key, error);
    throw error;
  }
}

async function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function putObjectToS3(key, body, contentType) {
  try {
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      Body: body,
      ContentType: contentType || 'application/json'
    });
    
    await s3Client.send(command);
    console.log(`Successfully uploaded ${key} to S3`);
  } catch (error) {
    console.error('Error putting object to S3:', key, error);
    throw error;
  }
}

// Update main index.json file
export async function updateMainIndex(sensorData, family) {
  try {
    const indexBuffer = await getObjectFromS3('index.json');
    const indexData = JSON.parse(indexBuffer.toString());
    
    // Process ligands to ensure they're just strings/names
    let simplifiedLigands = [];
    if (sensorData.ligands && Array.isArray(sensorData.ligands)) {
      simplifiedLigands = sensorData.ligands.map(ligand => 
        typeof ligand === 'object' && ligand.name ? ligand.name : ligand
      );
    }
    
    const newSensorEntry = {
      id: sensorData.uniprotID,
      family: family,
      alias: sensorData.alias || "",
      organism: sensorData.organism || "",
      organismID: sensorData.organismID || null,
      regulationType: sensorData.regulationType || "",
      ligandCount: sensorData.ligands ? sensorData.ligands.length : 0,
      operatorCount: sensorData.operators ? sensorData.operators.length : 0,
      updated: new Date().toISOString().split('T')[0], // Current date in YYYY-MM-DD format
      key: `sensors/${family.toLowerCase()}/${sensorData.uniprotID}.json`,
      ligands: simplifiedLigands // Add ligands array for UI
    };
    
    // Add the new sensor or update existing directly using uniprotID as key
    indexData[sensorData.uniprotID] = newSensorEntry;
    
    // Update stats field
    if (!indexData.stats) {
      indexData.stats = { regulators: 0, ligands: 0 };
    }
    
    // Count total regulators
    const regulatorCount = Object.keys(indexData).filter(key => key !== 'stats').length;
    
    // Update unique ligands count - collect all ligands and count unique ones
    const allLigands = new Set();
    Object.keys(indexData).forEach(key => {
      if (key !== 'stats' && indexData[key].ligands) {
        indexData[key].ligands.forEach(ligand => {
          if (ligand) allLigands.add(ligand);
        });
      }
    });
    
    indexData.stats.regulators = regulatorCount;
    indexData.stats.ligands = allLigands.size;
    
    await putObjectToS3('index.json', JSON.stringify(indexData, null, 2));
    
    return newSensorEntry;
  } catch (error) {
    console.error('Error updating main index:', error);
    throw error;
  }
}

// Update family index file
export async function updateFamilyIndex(sensorData, family) {
  try {
    const familyKey = family.toLowerCase();
    const indexKey = `indexes/${familyKey}.json`;
    
    // Try to get existing family index
    let familyIndex;
    try {
      const indexBuffer = await getObjectFromS3(indexKey);
      familyIndex = JSON.parse(indexBuffer.toString());
    } catch (error) {
      // Create new family index if it doesn't exist
      familyIndex = {
        data: {},
        count: 0
      };
    }
    
    // Create simplified ligands array (just names)
    let simplifiedLigands = [];
    if (sensorData.ligands && Array.isArray(sensorData.ligands)) {
      simplifiedLigands = sensorData.ligands.map(ligand => 
        typeof ligand === 'object' && ligand.name ? ligand.name : ligand
      );
    }
    
    const sensorEntry = {
      accession: sensorData.accession || "",
      alias: sensorData.alias || "",
      keggID: sensorData.keggID || "None",
      organism: sensorData.organism || "",
      uniprotID: sensorData.uniprotID,
      ligands: simplifiedLigands,
      family: family // Add family for UI needs
    };
    
    let sensorExists = false;
    for (const key in familyIndex.data) {
      if (familyIndex.data[key].uniprotID === sensorData.uniprotID) {
        familyIndex.data[key] = sensorEntry;
        sensorExists = true;
        break;
      }
    }
    
    // Add new sensor if it doesn't exist
    if (!sensorExists) {
      familyIndex.count += 1;
      familyIndex.data[familyIndex.count] = sensorEntry;
    }
    
    // Upload updated family index
    await putObjectToS3(indexKey, JSON.stringify(familyIndex, null, 2));
    
    return indexKey;
  } catch (error) {
    console.error('Error updating family index for:', family, error);
    throw error;
  }
}

// Save sensor data file
export async function saveSensorFile(sensorData, family) {
  try {
    const familyKey = family.toLowerCase();
    const sensorKey = `sensors/${familyKey}/${sensorData.uniprotID}.json`;
    
    // Upload sensor data
    await putObjectToS3(sensorKey, JSON.stringify(sensorData, null, 2));
    
    return sensorKey;
  } catch (error) {
    console.error('Error saving sensor file for:', sensorData.uniprotID, error);
    throw error;
  }
}

// Update all-sensors.json file
export async function updateAllSensors(sensorData) {
  try {
    // Try to get current file, create if it doesn't exist
    let allSensorsData;
    try {
      const jsonBuffer = await getObjectFromS3('all-sensors.json');
      allSensorsData = JSON.parse(jsonBuffer.toString());
    } catch (error) {
      if (error.name === 'NoSuchKey' || error.Code === 'NoSuchKey') {
        // Create new structure if file doesn't exist
        allSensorsData = {
          version: new Date().toISOString(),
          count: 0,
          sensors: []
        };
      } else {
        throw error;
      }
    }
    
    // Find existing sensor by uniprotID and update, or add new one
    const existingIndex = allSensorsData.sensors.findIndex(sensor => sensor.uniprotID === sensorData.uniprotID);
    
    if (existingIndex !== -1) {
      // Update existing sensor
      allSensorsData.sensors[existingIndex] = sensorData;
    } else {
      // Add new sensor
      allSensorsData.sensors.push(sensorData);
    }
    
    allSensorsData.count = allSensorsData.sensors.length;
    allSensorsData.version = new Date().toISOString();
    
    const updatedJson = JSON.stringify(allSensorsData, null, 2);
    
    await putObjectToS3('all-sensors.json', updatedJson, 'application/json');
    
    return 'all-sensors.json';
  } catch (error) {
    console.error('Error updating all-sensors.json:', error);
    throw error;
  }
}

// Update fingerprint files
export async function updateFingerprints(sensorData, family) {
  try {
    console.log('Triggering fingerprint update via API...');
    
    // Prepare the payload for the API call
    const payload = {
      sensorData,
      family
    };

    await invokeLambda(
      'updateFingerprint', 
      process.env.FINGERPRINT_LAMBDA_NAME, 
      payload,
      'updateFingerprint',
      'POST'
    );
    
    console.log('Successfully triggered fingerprint update');
    return true;
  } catch (error) {
    console.error('Error triggering fingerprint update:', error);
    // Continue with other updates even if fingerprint update fails
    return false;
  }
} 