# GroovDB API
[![DOI](https://zenodo.org/badge/1019008840.svg)](https://doi.org/10.5281/zenodo.17234329)

Backend API for the GroovDB database - a comprehensive biosensor database for synthetic biology research.

## Overview

The GroovDB API is a serverless backend built with AWS SAM (Serverless Application Model) that powers the GroovDB database at [groov.bio](https://groov.bio). It manages biosensor data, provides search capabilities, handles user submissions, and includes advanced features like molecular fingerprint-based ligand searching.

## Features

- **Biosensor Data Management**: Store and retrieve biosensor information with protein sequences, ligand interactions, and literature references
- **Advanced Search**: Text-based search across sensors with family and organism filtering
- **Ligand Similarity Search**: RDKit-powered molecular fingerprint comparison for finding similar ligands
- **User Submissions**: Community-driven data contribution with admin review workflow
- **Data Export**: Download complete sensor datasets in JSON format
- **Authentication**: AWS Cognito integration with admin authorization
- **Contact System**: Email integration for user inquiries

## Architecture

The API is built using:
- **AWS Lambda Functions**: Serverless compute for API endpoints
- **Amazon DynamoDB**: NoSQL database for sensor data storage
- **AWS S3/Cloudflare R2**: Object storage for data files and molecular fingerprints
- **AWS Cognito**: User authentication and authorization
- **Python/RDKit**: Molecular fingerprint generation and similarity searching
- **Node.js**: Primary runtime for API functions

## Prerequisites

- [Docker](https://docs.docker.com/engine/install/)
- [AWS SAM CLI](https://github.com/aws/aws-sam-cli)
- [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html)
- [Node.js 20+](https://nodejs.org/)
- [Python 3.12+](https://www.python.org/downloads/)

### Optional but Recommended

- [NoSQL Workbench](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/workbench.settingup.html)
- [Bruno](https://www.usebruno.com/downloads) for API testing

## Getting Started

### 1. Download Sample Data

Since this is an open-source version, you'll need to obtain your own biosensor data. You can:

1. **Download existing data**: Visit [groov.bio](https://groov.bio) and download the complete sensor dataset and index files as a ZIP archive
2. **Use your own data**: Structure your biosensor data according to the format shown in the `scripts/` directory
3. **Start with empty database**: Set up the infrastructure and add data through the API endpoints

Extract any downloaded data to the `scripts/s3/` directory to match the expected file structure.

### 2. Quick Setup with Complete Script

The fastest way to get started:

```bash
chmod +x ./setup-local-complete.sh
./setup-local-complete.sh
```

This script will:
- Check dependencies
- Start local DynamoDB and S3 services
- Create required database tables
- Process any data in `scripts/s3/` directory
- Generate molecular fingerprints (if RDKit is available)
- Optionally start the API server

### 3. Manual Setup

If you prefer manual setup or need to troubleshoot:

#### Environment Configuration

Create `.env.json` in the root directory:

```json
{
  "SearchFunction": {
    "TEMP_TABLE_NAME": "groov-api-temp-table",
    "TABLE_NAME": "groov-api-table",
    "ENV": "dev",
    "IS_LOCAL": "true",
    "USER_POOL_ID": "YOUR_USER_POOL_ID",
    "USER_POOL_CLIENT_ID": "YOUR_USER_POOL_CLIENT_ID"
  }
}
```

#### Install Dependencies

```bash
# Install root dependencies
npm install

# Install Node.js layer dependencies
cd layers/node && npm install && cd ../..

# Install Python layer dependencies
cd layers/python && pip3 install -r requirements.txt -t ./python && cd ../..

# Install script dependencies
cd scripts && npm install && cd ..
```

#### Start Local Services

```bash
# Start DynamoDB and S3 mock services
docker-compose up -d

# Create local tables
npm run setup:tables

# Process any existing data files
cd scripts && node createIndex.js && cd ..

# Generate molecular fingerprints (requires RDKit)
cd scripts && python3 createFingerprint.py --upload && cd ..
```

## Running the API

### Development Mode

```bash
# Start the API with hot reloading
sam local start-api --env-vars .env.json --warm-containers EAGER -t template-local.yaml --skip-pull-image
```

The API will be available at `http://localhost:3000`

### Using npm Scripts

```bash
# Start local services
npm run dynamo:start
npm run s3:start

# Setup database tables
npm run setup:tables

# Start the API
npm run sam:start

# Stop all services
npm run stop:local
```

## API Endpoints

### Public Endpoints

- `GET /search` - Search biosensors
- `GET /getSensor` - Get individual sensor details
- `GET /getPages` - Get family page information
- `GET /downloadAllSensors` - Download complete dataset
- `POST /ligandSearch` - Molecular similarity search
- `POST /contact_form` - Contact form submission
- `GET /swagger` - API documentation

### Authenticated Endpoints

- `POST /insertForm` - Submit new sensor (requires login)
- `POST /updateSensor` - Edit existing sensor (requires login)

### Admin Endpoints

- `GET /getAllTempSensors` - View pending submissions
- `GET /getProcessedTemp` - View processed submissions
- `POST /approveProcessedSensor` - Approve submissions
- `POST /rejectProcessedSensor` - Reject submissions
- `POST /addNewSensor` - Add sensors to main database
- `POST /deleteTemp` - Delete temporary submissions

## Data Structure and Setup

### Expected File Structure

```
scripts/s3/
├── index.json           # Main sensor index
├── fingerprints.bin.gz  # Compressed molecular fingerprints
├── fingerprints.bin     # Uncompressed fingerprints
└── sensors/             # Sensor data organized by family
    ├── AHL/
    ├── Histidine_kinase/
    └── ...
```

### Working with Your Own Data

If you're setting up with your own biosensor data:

1. **Data Format**: Each sensor should be a JSON file with the structure shown in existing sensor files
2. **Organization**: Group sensors by family in separate directories under `scripts/s3/sensors/`
3. **Indexing**: Run `node createIndex.js` to generate search indexes
4. **Fingerprints**: Run `python3 createFingerprint.py` to generate molecular fingerprints for ligand similarity search

## Testing

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Generate coverage report
npm run test:coverage
```

Test files are located in `tests/unit/` and cover all Lambda functions.

## Molecular Fingerprints

The API includes advanced molecular similarity searching using RDKit:

### Fingerprint Generation

```bash
cd scripts
python3 createFingerprint.py --help
```

Options:
- `--upload`: Upload fingerprints to S3 after generation
- `--remote`: Upload to production R2 instead of local S3
- `--upload-both`: Upload both compressed and uncompressed files

### Similarity Search

The ligand search endpoint uses Morgan fingerprints with:
- Radius: 2
- Bits: 2048
- Tanimoto similarity coefficient

## Deployment

### Branch Strategy

This project uses a two-stage deployment process:

- **`stage` branch**: Staging environment for testing changes before production
- **`main` branch**: Production environment

### Staging Deployment

Changes should first be deployed to staging for testing:

1. Create a pull request targeting the `stage` branch
2. After review and approval, merge to `stage`
3. GitHub Actions automatically deploys to staging environment
4. Test your changes in the staging environment
5. Create a pull request from `stage` to `main` for production deployment

### Production Deployment

1. Ensure changes have been tested in staging
2. Create a pull request from `stage` to `main`
3. After review and approval, merge to `main`
4. GitHub Actions automatically deploys to production

### Manual Deployment

For manual deployments:

```bash
# Build the application
sam build

# Deploy to staging
sam deploy --stack-name stage-groov-api --parameter-overrides Env=stage [other-stage-params]

# Deploy to production
sam deploy --stack-name groov-api --parameter-overrides Env=prod [other-prod-params]
```

### Environment Variables

Production requires these environment variables:
- `USER_POOL_ID` - Cognito User Pool ID
- `USER_POOL_CLIENT_ID` - Cognito Client ID
- `R2_BUCKET_NAME` - Cloudflare R2 bucket
- `R2_ACCESS_KEY_ID` - R2 access key
- `R2_SECRET_ACCESS_KEY` - R2 secret key
- `R2_ENDPOINT` - R2 endpoint URL

## Development

### Adding New Endpoints

1. Create function directory in `functions/`
2. Implement handler with proper error handling
3. Add to `template.yaml` with appropriate permissions
4. Create corresponding test file
5. Update documentation

### Code Standards

- Use ESM modules (`type: "module"` in package.json)
- Implement proper error handling and logging
- Follow AWS Lambda best practices
- Use TypeScript-style JSDoc comments
- Validate inputs with Joi schemas

### Local Testing with Bruno

The `bruno/` directory contains API test collections. Import into Bruno for comprehensive endpoint testing.

## Security

- All admin endpoints require proper authorization
- Input validation using Joi schemas
- Secrets managed through environment variables
- CORS enabled for frontend integration
- Rate limiting and throttling configured

## Performance

- ARM64 architecture for better price/performance
- Warm containers for reduced cold starts
- Optimized memory allocation per function
- Compressed data storage with gzip
- Efficient DynamoDB query patterns

## Troubleshooting

### Common Issues

1. **Docker not starting**: Ensure Docker Desktop is running
2. **SAM build fails**: Check Node.js version (requires 20+)
3. **DynamoDB connection issues**: Verify local DynamoDB is running on port 8000
4. **Missing fingerprints**: Install RDKit and run fingerprint generation
5. **CORS errors**: Check API Gateway configuration in template.yaml
6. **No data found**: Download sample data from groov.bio or add your own data to `scripts/s3/`

### Logs

View logs for debugging:
```bash
# CloudWatch logs (production)
sam logs -n SearchFunction --stack-name your-stack-name --tail

# Local logs
docker-compose logs dynamodb-local
docker-compose logs s3-local
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidelines and contribution process.

## Security

Report security vulnerabilities to simon@groov.bio. See [SECURITY.md](SECURITY.md) for details.

## License

[Add your license information here]

## Support

- **Issues**: Create a GitHub issue for bug reports
- **Questions**: Use the contact form at [groov.bio/contact](https://groov.bio/contact)
- **Email**: simon@groov.bio

## Acknowledgments

Built for synthetic biology research and the scientific community. Special thanks to contributors and the open-source packages that make this project possible.
