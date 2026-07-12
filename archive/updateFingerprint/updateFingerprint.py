import json
import os
import tempfile
import boto3
import logging
import gzip

# Set up logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

try:
    from rdkit import Chem
    from rdkit.Chem import rdFingerprintGenerator
    
    # Create the Morgan fingerprint generator
    morgan_generator = rdFingerprintGenerator.GetMorganGenerator(
        radius=2,  # FINGERPRINT_RADIUS 
        fpSize=2048  # FINGERPRINT_NBITS
    )
except ImportError as e:
    # Exit here if RDKit is not available
    logger.fatal(f"RDKit import failed: {e}")
    exit()

# S3 client setup - following the pattern from getFamilyPages
if os.environ.get('IS_LOCAL'):
    s3_client = boto3.client('s3', 
        region_name='us-east-2',
        endpoint_url='http://host.docker.internal:9090',
        aws_access_key_id='test',
        aws_secret_access_key='test'
    )
    BUCKET_NAME = os.environ.get('BUCKET_NAME', 'my-test-bucket')
else:
    s3_client = boto3.client('s3', 
        region_name='auto',
        endpoint_url=os.environ.get('R2_ENDPOINT'),
        aws_access_key_id=os.environ.get('R2_ACCESS_KEY_ID'),
        aws_secret_access_key=os.environ.get('R2_SECRET_ACCESS_KEY')
    )
    BUCKET_NAME = os.environ.get('R2_BUCKET_NAME')

def download_file(key, local_path):
    try:
        logger.info(f"Downloading {key} to {local_path}")
        s3_client.download_file(BUCKET_NAME, key, local_path)
        return True
    except Exception as e:
        logger.error(f"Error downloading {key}: {e}")
        return False

def upload_file(local_path, key, content_type=None):
    try:
        logger.info(f"Uploading {local_path} to {key}")
        extra_args = {'ContentType': content_type} if content_type else {}
        s3_client.upload_file(local_path, BUCKET_NAME, key, ExtraArgs=extra_args)
        return True
    except Exception as e:
        logger.error(f"Error uploading {local_path} to {key}: {e}")
        return False

def setup_workspace(temp_dir):
    try:
        # Create directory structure
        s3_dir = os.path.join(temp_dir, "s3")
        os.makedirs(s3_dir, exist_ok=True)
        
        # Download the updated all-sensors.json (which already contains our updated sensor)
        all_sensors_path = os.path.join(s3_dir, "all-sensors.json")
        if not download_file("all-sensors.json", all_sensors_path):
            logger.error("Failed to download all-sensors.json")
            return False
            
        logger.info("Successfully downloaded updated all-sensors.json")
        return True
    except Exception as e:
        logger.error(f"Error setting up workspace: {e}")
        return False


def generate_fingerprints(base_dir):
    """Generate fingerprints from all sensor data in all-sensors.json""" 
    try:
        s3_dir = os.path.join(base_dir, "s3")
        
        # Load all-sensors.json (which contains all sensors including our update)
        all_sensors_path = os.path.join(s3_dir, "all-sensors.json")
        with open(all_sensors_path, "r") as f:
            all_sensors_data = json.load(f)
        
        # List to store all fingerprint data
        all_fingerprints = []
        ligand_count = 0
        sensor_count = 0
        error_count = 0
        
        # Generate a unique ligand ID counter
        next_ligand_id = 1
        seen_smiles = {}  # Map SMILES to ligand IDs
        
        # Process all sensors from all-sensors.json
        sensors = all_sensors_data.get("sensors", [])
        logger.info(f"Processing {len(sensors)} sensors from all-sensors.json")
        
        for sensor_data in sensors:
            try:
                sensor_id = sensor_data.get("uniprotID")
                if not sensor_id:
                    continue
                
                # Process ligands for this sensor
                ligands = sensor_data.get("ligands")
                if not ligands or not isinstance(ligands, list):
                    continue
                    
                sensor_count += 1
                
                for ligand in ligands:
                    smiles = ligand.get("SMILES")
                    if not smiles:
                        continue
                    
                    # Check if we've seen this SMILES before
                    if smiles in seen_smiles:
                        ligand_id = seen_smiles[smiles]
                    else:
                        # Generate a new ligand ID
                        ligand_id = f"LIG{next_ligand_id:05d}"
                        next_ligand_id += 1
                        seen_smiles[smiles] = ligand_id
                        
                        try:
                            # Generate Morgan fingerprint using RDKit
                            mol = Chem.MolFromSmiles(smiles)
                            if mol:
                                # Generate fingerprint
                                fingerprint = morgan_generator.GetFingerprint(mol)
                                
                                # Convert the fingerprint to a bit string for safe serialization
                                bit_string = fingerprint.ToBitString()
                                
                                # Include ligand name in the fingerprint data
                                ligand_name = ligand.get("name", "Unknown")
                                all_fingerprints.append((bit_string, ligand_id, sensor_id, ligand_name))
                                ligand_count += 1
                            else:
                                logger.warning(f"Could not parse SMILES: {smiles}")
                                error_count += 1
                        except Exception as e:
                            logger.error(f"Error generating fingerprint for {smiles}: {e}")
                            error_count += 1
            
            except Exception as e:
                logger.error(f"Error processing sensor {sensor_data.get('uniprotID', 'unknown')}: {e}")
                error_count += 1
        
        logger.info(f"Processed {sensor_count} sensors with {ligand_count} unique ligands")
        if error_count > 0:
            logger.warning(f"Encountered {error_count} errors")
        
        return all_fingerprints
    except Exception as e:
        logger.error(f"Error in generate_fingerprints: {e}")
        return []

def save_fingerprints(fingerprints, base_dir):
    """Save fingerprints and upload to S3"""
    try:
        s3_dir = os.path.join(base_dir, "s3")
        
        # Define output file paths
        fingerprint_path = os.path.join(s3_dir, "fingerprints.json")
        gzipped_path = os.path.join(s3_dir, "fingerprints.json.gz")
        
        # Save as JSON file (safe serialization)
        with open(fingerprint_path, "w") as f:
            json.dump(fingerprints, f)
        
        logger.info(f"Saved fingerprints to {fingerprint_path}")
        
        # Create a gzipped version for more efficient storage/transfer
        with open(fingerprint_path, "rb") as f_in:
            with gzip.open(gzipped_path, "wb") as f_out:
                f_out.write(f_in.read())
     
        # Upload to S3
        upload_file(fingerprint_path, 'fingerprints.json', 'application/json')
        upload_file(gzipped_path, 'fingerprints.json.gz', 'application/gzip')
        
        return True
    except Exception as e:
        logger.error(f"Error saving fingerprints: {e}")
        return False

def lambda_handler(event, context):
    """Lambda handler function"""
    try:
        logger.info("Starting fingerprint update process")
        
        # Check if we're running from API Gateway
        if isinstance(event, dict) and event.get('body'):
            try:
                body = json.loads(event['body'])
                sensor_data = body.get('sensorData')
                family = body.get('family')
            except Exception as e:
                logger.error(f"Error parsing request body: {e}")
                return {
                    'statusCode': 400,
                    'body': json.dumps({'error': 'Invalid request body'})
                }
        else:
            if isinstance(event, str):
                event = json.loads(event)
                
            sensor_data = event.get('sensorData')
            family = event.get('family')
        
        if not sensor_data or not family:
            return {
                'statusCode': 400,
                'body': json.dumps({'error': 'Missing required parameters'})
            }
        
        # Create temporary directory
        with tempfile.TemporaryDirectory() as temp_dir:
            logger.info(f"Created temporary directory: {temp_dir}")
            
            # Set up workspace
            if not setup_workspace(temp_dir):
                return {
                    'statusCode': 500,
                    'body': json.dumps({'error': 'Failed to set up workspace'})
                }
            
            # Generate fingerprints
            fingerprints = generate_fingerprints(temp_dir)
            
            if not fingerprints:
                logger.warning("No fingerprints were generated")
                return {
                    'statusCode': 200,
                    'body': json.dumps({'message': 'No fingerprints were generated'})
                }
            
            # Save fingerprints and upload to S3
            if not save_fingerprints(fingerprints, temp_dir):
                return {
                    'statusCode': 500,
                    'body': json.dumps({'error': 'Failed to save fingerprints'})
                }
            
            logger.info("Fingerprint update completed successfully")
            return {
                'statusCode': 200,
                'body': json.dumps({'message': 'Fingerprint update completed successfully'})
            }
            
    except Exception as e:
        logger.error(f"Error in lambda_handler: {e}")
        return {
            'statusCode': 500,
            'body': json.dumps({'error': str(e)})
        } 