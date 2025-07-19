#!/bin/bash
set -e

echo "Starting migration to S3 process..."

# Check if Docker is running
if ! docker ps > /dev/null 2>&1; then
  echo "Error: Docker is not running. Please start Docker and try again."
  exit 1
fi

# Ensure docker-compose services are up
echo "Ensuring S3 and DynamoDB local services are running..."
docker-compose up -d

# Run the JSON migration script
echo "Step 1: Running JSON migration from DynamoDB to local files..."
node scripts/jsonMigrate.js

# Create index files
echo "Step 2: Creating index files..."
node scripts/createIndex.js

# Check if Python and RDKit are installed
echo "Step 3: Checking if Python and RDKit are available for fingerprint generation..."
if command -v python3 > /dev/null; then
  if python3 -c "import rdkit" > /dev/null 2>&1; then
    echo "Creating fingerprints using Python/RDKit..."
    python3 scripts/createFingerprint.py
  else
    echo "Warning: RDKit not found. Skipping fingerprint generation."
    echo "To install RDKit, run: pip install rdkit"
  fi
else
  echo "Warning: Python 3 not found. Skipping fingerprint generation."
fi

# Upload files to S3 mock
echo "Step 4: Uploading files to local S3 mock service..."
node scripts/uploadToS3.js

echo "Migration completed successfully!"
echo "You can now test your application using the local S3 mock service."
echo "The search endpoint should now fetch data from S3 instead of DynamoDB." 