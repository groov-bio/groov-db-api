import json
import os
import boto3
import logging
import gzip
from io import BytesIO
from rdkit import Chem
from rdkit.Chem import rdFingerprintGenerator
from rdkit.DataStructs import BulkTanimotoSimilarity, TanimotoSimilarity, ExplicitBitVect

# Set up logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# S3 client setup with R2 support
if os.environ.get('IS_LOCAL'):
    s3_client = boto3.client('s3', 
        region_name=os.environ.get('AWS_REGION', 'us-east-2'),
        endpoint_url=os.environ.get('S3_ENDPOINT'),
        aws_access_key_id='test',
        aws_secret_access_key='test'
    )
    BUCKET_NAME = os.environ.get('BUCKET_NAME')
else:
    s3_client = boto3.client('s3',
        region_name='auto',
        endpoint_url=os.environ.get('R2_ENDPOINT'),
        aws_access_key_id=os.environ.get('R2_ACCESS_KEY_ID'),
        aws_secret_access_key=os.environ.get('R2_SECRET_ACCESS_KEY')
    )
    BUCKET_NAME = os.environ.get('R2_BUCKET_NAME')

morgan_generator = rdFingerprintGenerator.GetMorganGenerator(
    radius=2,  # FINGERPRINT_RADIUS 
    fpSize=2048  # FINGERPRINT_NBITS
)

allowed_origins = [
    'http://localhost:3000',
    'https://groov.bio',
    'https://www.groov.bio'
]

def get_cors_headers(event):
    default_origin = 'http://localhost:3000'
    
    headers = event.get('headers', {})
    origin = None
    
    if headers:
        for key in headers:
            if key.lower() == 'origin':
                origin = headers[key]
                break
    
    allowed_origin = origin if origin in allowed_origins else default_origin
    
    return {
        'Access-Control-Allow-Origin': allowed_origin,
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Allow-Headers': 'Content-Type,content-type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,Cache-Control',
        'Access-Control-Allow-Methods': 'POST,OPTIONS',
        'Access-Control-Max-Age': '86400'
    }

def download_fingerprints():
    try:
        # Check if we can get the gzipped version first (more efficient)
        try:
            logger.info("Downloading compressed fingerprints file")
            response = s3_client.get_object(Bucket=BUCKET_NAME, Key='fingerprints.json.gz')
            compressed_data = response['Body'].read()
            
            # Decompress the data
            with gzip.GzipFile(fileobj=BytesIO(compressed_data), mode='rb') as f:
                fingerprints_data = json.load(f)
                
        except Exception as e:
            logger.warning(f"Failed to get compressed fingerprints, trying uncompressed: {e}")
            
            # Fall back to uncompressed version
            response = s3_client.get_object(Bucket=BUCKET_NAME, Key='fingerprints.json')
            fingerprints_data = json.load(response['Body'])
            
        # Convert stored bit strings back to fingerprint objects
        fingerprints = []
        for i, item in enumerate(fingerprints_data):
            try:
                if len(item) == 4:
                    bit_string, ligand_id, sensor_id, ligand_name = item
                    # Create ExplicitBitVect from the binary string
                    fp = ExplicitBitVect(len(bit_string))
                    for j, bit in enumerate(bit_string):
                        if bit == '1':
                            fp.SetBit(j)
                    fingerprints.append((fp, ligand_id, sensor_id, ligand_name))
                else:
                    bit_string, ligand_id, sensor_id = item
                    # Create ExplicitBitVect from the binary string
                    fp = ExplicitBitVect(len(bit_string))
                    for j, bit in enumerate(bit_string):
                        if bit == '1':
                            fp.SetBit(j)
                    fingerprints.append((fp, ligand_id, sensor_id, "Unknown"))
                    
            except Exception as item_error:
                logger.error(f"Error processing item {i}: {item_error}")
                continue
        return fingerprints
    except Exception as e:
        logger.error(f"Error downloading fingerprints: {e}")
        return None

def search_similar_ligands(query_smiles, threshold=0.7, max_results=50):
    try:
        logger.info(f"Searching for SMILES: {query_smiles} with threshold: {threshold}")
        mol = Chem.MolFromSmiles(query_smiles)
        if not mol:
            logger.warning(f"Could not parse SMILES: {query_smiles}")
            return []
            
        query_fp = morgan_generator.GetFingerprint(mol)
        logger.info(f"Generated query fingerprint, size: {query_fp.GetNumBits()}")
        
        # Download fingerprints from S3
        fingerprints = download_fingerprints()
        if not fingerprints:
            logger.error("No fingerprints available")
            return []
            
        logger.info(f"Loaded {len(fingerprints)} fingerprints for comparison")
        
        # Calculate similarity scores
        results = []
        for i, item in enumerate(fingerprints):
            # Handle both new format (with name) and old format (without name)
            if len(item) == 4:
                fp, ligand_id, sensor_id, ligand_name = item
            else:
                fp, ligand_id, sensor_id = item
                ligand_name = "Unknown"
                
            try:
                similarity = TanimotoSimilarity(query_fp, fp)
                logger.info(f"Item {i}: {ligand_id} similarity: {similarity}")
                
                if similarity >= threshold:
                    results.append({
                        'ligandId': ligand_id,
                        'sensorId': sensor_id,
                        'similarity': similarity,
                        'name': ligand_name
                    })
            except Exception as sim_error:
                logger.error(f"Error calculating similarity for item {i}: {sim_error}")
                continue
        
        logger.info(f"Found {len(results)} results above threshold {threshold}")
        
        # Sort by similarity (highest first) and limit results
        results.sort(key=lambda x: x['similarity'], reverse=True)
        return results[:max_results]
    except Exception as e:
        logger.error(f"Error in search_similar_ligands: {e}")
        return []

def lambda_handler(event, context):
    cors_headers = get_cors_headers(event)
    
    if event.get('requestContext', {}).get('http', {}).get('method') == 'OPTIONS':
        return {
            'statusCode': 200,
            'headers': cors_headers,
            'body': ''
        }
    
    try:
        body = json.loads(event.get('body', '{}'))
        
        smiles = body.get('smiles')
        
        if not smiles:
            return {
                'statusCode': 400,
                'headers': cors_headers,
                'body': json.dumps({
                    'message': 'Missing required parameter: smiles'
                })
            }
        
        # Optional parameters
        threshold = body.get('threshold', 0.7)
        max_results = body.get('maxResults', 50)
        
        results = search_similar_ligands(smiles, threshold, max_results)
        
        return {
            'statusCode': 200,
            'headers': cors_headers,
            'body': json.dumps({
                'query': smiles,
                'threshold': threshold,
                'results': results,
                'message': 'Results include chemical names'
            })
        }
    
    except Exception as e:
        logger.error(f"Error in handler: {str(e)}")
        
        return {
            'statusCode': 500,
            'headers': cors_headers,
            'body': json.dumps({
                'message': f'Error on ligand search: {str(e)}'
            })
        }
