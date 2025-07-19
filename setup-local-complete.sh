#!/bin/bash
set -e

echo "=== Starting complete local environment setup ==="

# Check for dependencies
echo "Checking dependencies..."

# Check for Node.js
if ! command -v node > /dev/null; then
  echo "Error: Node.js is not installed. Please install Node.js and try again."
  exit 1
fi

# Check for npm
if ! command -v npm > /dev/null; then
  echo "Error: npm is not installed. Please install npm and try again."
  exit 1
fi

# Install Node dependencies in scripts directory
echo "Installing Node.js dependencies in scripts directory..."
(cd scripts && npm install)

# Check for AWS SAM CLI
if ! command -v sam > /dev/null; then
  echo "Warning: AWS SAM CLI is not installed. You will need it to run the local API."
  echo "Visit https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/serverless-sam-cli-install.html"
fi

# Check for Docker
if ! docker ps > /dev/null 2>&1; then
  echo "Error: Docker is not running. Please start Docker and try again."
  exit 1
fi

# Check for Python and RDKit
PYTHON_AVAILABLE=false
RDKIT_AVAILABLE=false
if command -v python3 > /dev/null; then
  PYTHON_AVAILABLE=true
  echo "Python 3 is installed."
  if python3 -c "import rdkit" > /dev/null 2>&1; then
    RDKIT_AVAILABLE=true
    echo "RDKit is installed."
  else
    echo "Warning: RDKit not found. Fingerprint generation will be skipped."
    echo "To install RDKit, run: pip install rdkit"
  fi
else
  echo "Warning: Python 3 not found. Fingerprint generation will be skipped."
fi

# Start local DynamoDB and S3 with Docker Compose
echo "Starting local DynamoDB and S3..."
docker-compose up -d

# Wait for services to be ready
echo "Waiting for services to be ready..."
sleep 5

# Create DynamoDB tables
echo "Setting up DynamoDB tables..."
node scripts/setup-local.js

# Setup directory structure
echo "Setting up directory structure..."
# Remove existing s3 directory if it exists
rm -rf s3
# Create a symbolic link from s3 to scripts/s3
ln -sf scripts/s3 s3
# Make sure scripts/s3/sensors directory exists
mkdir -p scripts/s3/sensors

# Run the JSON migration script
echo "Running JSON migration from DynamoDB to local files..."
(cd scripts && node jsonMigrate.js)

# Create index files
echo "Creating index files..."
node scripts/createIndex.js

# Create fingerprints if Python and RDKit are available
if [ "$PYTHON_AVAILABLE" = true ] && [ "$RDKIT_AVAILABLE" = true ]; then
  echo "Creating fingerprints using Python/RDKit..."
  python3 scripts/createFingerprint.py
fi

# Upload files to S3 mock with IS_LOCAL environment variable set
echo "Uploading files to local S3 mock service..."
IS_LOCAL=true node scripts/uploadToS3.js

echo "Setup completed successfully!"

# Ask if user wants to start the API
read -p "Do you want to start the SAM local API now? (y/n) " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  echo "Starting SAM local API..."
  sam local start-api --env-vars env.json --warm-containers EAGER -t template-local.yaml --skip-pull-image
else
  echo "To start the API later, run: sam local start-api --env-vars env.json --warm-containers EAGER -t template-local.yaml --skip-pull-image"
fi 