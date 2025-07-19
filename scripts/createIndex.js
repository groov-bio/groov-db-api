import fs from 'fs';
import path from 'path';
import * as globModule from 'glob';
const { glob } = globModule;

const BASE_DIR = path.join(process.cwd(), 's3');
const SENSORS_DIR = path.join(BASE_DIR, 'sensors');
const INDEXES_DIR = path.join(BASE_DIR, 'indexes');

// Function to generate the index file
async function generateIndex() {
  try {
    // Ensure base directory exists
    if (!fs.existsSync(BASE_DIR)) {
      fs.mkdirSync(BASE_DIR, { recursive: true });
      console.log(`Created base directory: ${BASE_DIR}`);
    }
    
    // Ensure indexes directory exists
    if (!fs.existsSync(INDEXES_DIR)) {
      fs.mkdirSync(INDEXES_DIR, { recursive: true });
      console.log(`Created indexes directory: ${INDEXES_DIR}`);
    }
    
    console.log('Starting index generation...');
    
    const sensorFiles = await glob(path.join(SENSORS_DIR, '**/*.json'));
    
    console.log(`Found ${sensorFiles.length} sensor files.`);
    
    const sensorsIndex = [];
    const indexData = {}; // Object to hold all sensors by ID for UI compatibility
    const familyIndexes = {};
    const uniqueLigands = new Set(); // Track unique ligand names
    
    for (const filePath of sensorFiles) {
      try {
        const sensorData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        
        // Extract family from the file path
        // Pattern is: .../s3/sensors/family/sensorId.json
        const relativePath = path.relative(BASE_DIR, filePath);
        const pathParts = relativePath.split(path.sep);
        
        if (sensorData.uniprotID) {
          // Get family and normalize to lowercase for file naming
          let family = sensorData.family || pathParts[1];
          const familyKey = family.toLowerCase(); // Use lowercase for file name keys
          
          // Process ligands to ensure they're just strings/names
          let simplifiedLigands = [];
          if (sensorData.ligands && Array.isArray(sensorData.ligands)) {
            simplifiedLigands = sensorData.ligands.map(ligand => {
              const ligandName = typeof ligand === 'object' && ligand.name ? ligand.name : ligand;
              // Add to unique ligands set
              if (ligandName) {
                uniqueLigands.add(ligandName);
              }
              return ligandName;
            });
          }
          
          // Create sensor entry for main index
          const sensorEntry = {
            id: sensorData.uniprotID,
            family: family, // Keep original casing for display
            alias: sensorData.alias || "",
            organism: sensorData.organism || "",
            organismID: sensorData.organismID || null,
            regulationType: sensorData.regulationType || "",
            ligandCount: sensorData.ligands ? sensorData.ligands.length : 0,
            operatorCount: sensorData.operators ? sensorData.operators.length : 0,
            updated: new Date().toISOString().split('T')[0], // Current date in YYYY-MM-DD format
            key: relativePath,
            ligands: simplifiedLigands // Add ligands array for UI
          };
          
          // Add to sensors array (for backward compatibility)
          sensorsIndex.push(sensorEntry);
          
          // Add to indexData with uniprotID as key (for UI compatibility)
          indexData[sensorData.uniprotID] = sensorEntry;
          
          // Create or update family-specific index
          if (!familyIndexes[familyKey]) {
            familyIndexes[familyKey] = {
              data: {},
              count: 0
            };
          }
          
          const familySensorEntry = {
            accession: sensorData.accession || "",
            alias: sensorData.alias || "",
            keggID: sensorData.keggID || "None",
            organism: sensorData.organism || "",
            uniprotID: sensorData.uniprotID,
            ligands: simplifiedLigands,
            family: family // Add family for UI needs
          };
          
          familyIndexes[familyKey].count += 1;
          const sensorCount = familyIndexes[familyKey].count;
          familyIndexes[familyKey].data[sensorCount] = familySensorEntry;
        } else {
          console.warn(`Skipping file ${filePath} - missing uniprotID`);
        }
      } catch (error) {
        console.error('Error processing file:', filePath, error);
      }
    }
    
    // Add stats to the index data
    indexData.stats = {
      regulators: sensorsIndex.length,
      ligands: uniqueLigands.size
    };
    
    const indexPath = path.join(BASE_DIR, 'index.json');
    fs.writeFileSync(indexPath, JSON.stringify(indexData, null, 2));
    console.log(`Created main index file with ${sensorsIndex.length} sensors and ${uniqueLigands.size} unique ligands at: ${indexPath}`);
    
    // Create family-specific index files
    for (const [family, sensors] of Object.entries(familyIndexes)) {
      const familyPath = path.join(INDEXES_DIR, `${family}.json`);
      fs.writeFileSync(familyPath, JSON.stringify(sensors, null, 2));
      console.log(`Created family index for "${family}" with ${sensors.count} sensors at: ${familyPath}`);
    }
    
    return { 
      count: sensorsIndex.length, 
      indexPath,
      familyCount: Object.keys(familyIndexes).length,
      familyDetails: Object.entries(familyIndexes).map(([family, index]) => ({
        family,
        count: index.count
      })),
      uniqueLigandCount: uniqueLigands.size
    };
  } catch (error) {
    console.error('Failed to generate index:', error);
    throw error;
  }
}

async function main() {
  try {
    const { count, indexPath, familyCount, familyDetails, uniqueLigandCount } = await generateIndex();
    console.log(`Index generation completed successfully. Indexed ${count} sensors.`);
    console.log(`Main index file created at: ${indexPath}`);
    console.log(`Created ${familyCount} family-specific index files in: ${INDEXES_DIR}`);
    console.log(`Total unique ligands: ${uniqueLigandCount}`);
    console.log('Family index details:');
    familyDetails.forEach(f => {
      console.log(`  - ${f.family}: ${f.count} sensors`);
    });
  } catch (error) {
    console.error('Failed to complete the process:', error);
    process.exit(1);
  }
}

main();