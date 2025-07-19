# GroovDB Data Export Scripts

This directory contains scripts to export sensor data from DynamoDB and generate the necessary files for the GroovDB static data structure.

## Overview

These scripts extract all sensor data from DynamoDB, format it consistently with the `getSensor` API, and organize it into a structured file system that can be served statically.

## Generated File Structure

The scripts will create a file structure like this:

```
s3/
├── sensors/               # Folder containing sensors grouped by family
│   ├── luxR/              # Each family has its own folder
│   │   └── A0A0D5A3S5.json  # Sensor files named by uniprotID
│   ├── tetR/
│   │   └── ...
│   └── ...
├── index.json             # Lightweight index for list views 
├── fingerprints.bin       # Binary file containing chemical fingerprints
└── fingerprints.bin.gz    # Compressed version of fingerprints.bin
```

## Scripts

### jsonMigrate.js

Exports all sensor data from DynamoDB and formats it to match the `getSensor` API response format.

- Scans the entire DynamoDB table
- Groups data by family and sensor ID
- Formats data consistently with the API
- Creates the folder structure in `s3/sensors/{family}/{sensorId}.json`
- Outputs initial index.json

### createIndex.js

Generates the `index.json` file with metadata for all sensors.

The index file has this structure:
```json
{
  "version": "2024-04-12T03:17:00Z",  // build timestamp
  "count": 211,                       // total sensors in this snapshot
  "sensors": [                        // array of sensor metadata
    {
      "id": "A0A0D5A3S5",              // uniprotID
      "family": "LuxR",                // family name
      "alias": "PauR",                 // common name
      "organism": "Photorhabdus asymbiotica subsp. asymbiotica",
      "organismID": 171440,
      "regulationType": "Co-Activator",
      "ligandCount": 2,                // quick badge in list view
      "operatorCount": 1,
      "updated": "2024-11-02",         // last edit date
      "key": "sensors/luxR/A0A0D5A3S5.json"  // relative path
    },
    // ...more sensors
  ]
}
```

### createFingerprint.py

Generates chemical fingerprints for all ligands in the database.

- Reads all sensor JSON files
- Extracts SMILES strings for each ligand
- Creates Morgan fingerprints (ECFP4) with RDKit
- Packages fingerprints with sensor and ligand IDs
- Creates both uncompressed (`fingerprints.bin`) and compressed (`fingerprints.bin.gz`) versions

The fingerprints file contains a list of tuples in this format:
```python
[
  (fingerprint_bytes, ligand_id, regulator_id),
  # ... more fingerprint entries
]
```

## How to Use

### Prerequisites

1. Node.js dependencies:
   ```
   npm install
   ```

2. Python dependencies for fingerprint generation:
   ```
   pip install -r requirements.txt
   ```

3. Configure AWS credentials using the AWS CLI:
   ```
   aws configure
   ```

4. Set the `TABLE_NAME` environment variable in `.env`:
   ```
   TABLE_NAME=YourDynamoDBTableName
   ```

### Running the Scripts

To run the entire export process:
```
npm run export-all
```

To run individual steps:
```
npm run migrate           # Export data from DynamoDB
npm run create-index      # Generate index.json
npm run create-fingerprints  # Generate fingerprints.bin
```

## Fingerprint Format

The fingerprints file uses Morgan fingerprints (ECFP4) with these parameters:
- Radius: 2 (captures features up to 4 bonds away)
- Length: 2048 bits
- Format: RDKit BitVect objects serialized with Python's pickle

This format allows for efficient similarity searching using the Tanimoto coefficient:

T(A,B) = |A∩B| / (|A|+|B|-|A∩B|)

Where:
- |A| and |B| are the counts of 1-bits in each fingerprint
- |A∩B| is the count of shared 1-bits (calculated with bitwise AND)