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

def download_ligify_fingerprints():
    try:
        logger.info("Downloading compressed ligify fingerprints file")
        response = s3_client.get_object(Bucket=BUCKET_NAME, Key='ligify-fingerprints.json.gz')
        compressed_data = response['Body'].read()
        
        # Decompress the data
        with gzip.GzipFile(fileobj=BytesIO(compressed_data), mode='rb') as f:
            fingerprints_data = json.load(f)
                
        # Convert stored bit strings back to fingerprint objects
        # Format: [bit_string, ligand_id, regulator_id, ligand_name, smiles]
        fingerprints = []
        for i, item in enumerate(fingerprints_data):
            try:
                if len(item) == 5:
                    bit_string, ligand_id, regulator_id, ligand_name, smiles = item
                elif len(item) == 4:
                    # Handle legacy format without SMILES
                    bit_string, ligand_id, regulator_id, ligand_name = item
                    smiles = None
                else:
                    logger.warning(f"Unexpected item format at index {i}: {len(item)} elements")
                    continue
                    
                # Create ExplicitBitVect from the binary string
                fp = ExplicitBitVect(len(bit_string))
                for j, bit in enumerate(bit_string):
                    if bit == '1':
                        fp.SetBit(j)
                fingerprints.append((fp, ligand_id, regulator_id, ligand_name, smiles))
                    
            except Exception as item_error:
                logger.error(f"Error processing item {i}: {item_error}")
                continue
        return fingerprints
    except Exception as e:
        logger.error(f"Error downloading ligify fingerprints: {e}")
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
        
        # Download ligify fingerprints from S3
        fingerprints = download_ligify_fingerprints()
        if not fingerprints:
            logger.error("No ligify fingerprints available")
            return []
            
        logger.info(f"Loaded {len(fingerprints)} ligify fingerprints for comparison")
        
        # Calculate similarity scores
        results = []
        for i, item in enumerate(fingerprints):
            fp, ligand_id, regulator_id, ligand_name, smiles = item
                
            try:
                similarity = TanimotoSimilarity(query_fp, fp)
                
                if similarity >= threshold:
                    results.append({
                        'ligandId': ligand_id,
                        'regulatorId': regulator_id,
                        'similarity': similarity,
                        'name': ligand_name,
                        'smiles': smiles
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
                'message': 'Ligify search results with regulator associations'
            })
        }
    
    except Exception as e:
        logger.error(f"Error in handler: {str(e)}")
        
        return {
            'statusCode': 500,
            'headers': cors_headers,
            'body': json.dumps({
                'message': f'Error on ligify ligand search: {str(e)}'
            })
        }