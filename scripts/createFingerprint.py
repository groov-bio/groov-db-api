import os
import json
import gzip
import boto3
import argparse
from pathlib import Path
import sys
from rdkit import Chem
from rdkit.Chem import AllChem
from rdkit.Chem import rdFingerprintGenerator

# Set base directory
BASE_DIR = Path(os.path.dirname(os.path.abspath(__file__)))
S3_DIR = BASE_DIR / "s3"
SENSORS_DIR = S3_DIR / "sensors"
OUTPUT_FILE = S3_DIR / "fingerprints.json"
GZIPPED_OUTPUT = S3_DIR / "fingerprints.json.gz"

# Configuration
FINGERPRINT_RADIUS = 2 
FINGERPRINT_NBITS = 2048

# Create the Morgan fingerprint generator once
morgan_generator = rdFingerprintGenerator.GetMorganGenerator(
    radius=FINGERPRINT_RADIUS,
    fpSize=FINGERPRINT_NBITS
)


def load_sensors_index():
    try:
        with open(S3_DIR / "index.json", "r") as f:
            index_data = json.load(f)
        
        # Create a mapping from sensor ID to family
        sensor_to_family = {}
        for sensor in index_data.get("sensors", []):
            sensor_to_family[sensor["id"]] = sensor["family"]
        
        return sensor_to_family
    except Exception as e:
        print(f"Error loading sensor index: {e}")
        return {}


def generate_fingerprints():
    sensor_to_family = load_sensors_index()
    
    # List to store all fingerprint data
    all_fingerprints = []
    ligand_count = 0
    sensor_count = 0
    error_count = 0
    
    # Generate a unique ligand ID counter
    next_ligand_id = 1
    seen_smiles = {}  # Map SMILES to ligand IDs
    
    for family_dir in SENSORS_DIR.iterdir():
        if not family_dir.is_dir():
            continue
            
        print(f"Processing family: {family_dir.name}")
        
        # Process each sensor file in this family
        for sensor_file in family_dir.glob("*.json"):
            try:
                with open(sensor_file, "r") as f:
                    sensor_data = json.load(f)
                
                sensor_id = sensor_data.get("uniprotID")
                if not sensor_id:
                    continue
                
                # Process ligands for this sensor
                ligands = sensor_data.get("ligands", [])
                if not ligands:
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
                                # Generate fingerprint using the new MorganGenerator
                                fingerprint = morgan_generator.GetFingerprint(mol)
                                
                                # Convert the fingerprint to a bit string for safe serialization
                                bit_string = fingerprint.ToBitString()
                                
                                # Include ligand name in the fingerprint data
                                ligand_name = ligand.get("name", "Unknown")
                                all_fingerprints.append((bit_string, ligand_id, sensor_id, ligand_name))
                                ligand_count += 1
                            else:
                                print(f"  Warning: Could not parse SMILES: {smiles}")
                                error_count += 1
                        except Exception as e:
                            print(f"  Error generating fingerprint for {smiles}: {e}")
                            error_count += 1
            
            except Exception as e:
                print(f"  Error processing sensor file {sensor_file}: {e}")
                error_count += 1
    
    print(f"Processed {sensor_count} sensors with {ligand_count} unique ligands")
    if error_count > 0:
        print(f"Encountered {error_count} errors")
    
    return all_fingerprints


def save_fingerprints(fingerprints):
    try:
        # Save as JSON file (safe serialization)
        with open(OUTPUT_FILE, "w") as f:
            json.dump(fingerprints, f)
        
        print(f"Saved fingerprints to {OUTPUT_FILE}")
        
        # Create a gzipped version for more efficient storage/transfer
        with open(OUTPUT_FILE, "rb") as f_in:
            with gzip.open(GZIPPED_OUTPUT, "wb") as f_out:
                f_out.write(f_in.read())
        
        print(f"Created compressed version at {GZIPPED_OUTPUT}")
        
        # Print file sizes
        original_size = os.path.getsize(OUTPUT_FILE)
        compressed_size = os.path.getsize(GZIPPED_OUTPUT)
        print(f"Original size: {original_size/1024:.2f} KB")
        print(f"Compressed size: {compressed_size/1024:.2f} KB")
        print(f"Compression ratio: {original_size/compressed_size:.2f}x")
        
    except Exception as e:
        print(f"Error saving fingerprints: {e}")


def upload_to_s3(local=True, upload_both=True):
    """Upload fingerprint files to S3/R2"""
    try:
        # Configure S3 client
        if local:
            # Local development with S3 mock
            s3_client = boto3.client('s3',
                region_name='us-east-2',
                endpoint_url=os.environ.get('S3_ENDPOINT', 'http://localhost:9090'),
                aws_access_key_id='test',
                aws_secret_access_key='test'
            )
            bucket_name = os.environ.get('BUCKET_NAME', 'my-test-bucket')
        else:
            # Production environment with Cloudflare R2
            s3_client = boto3.client('s3',
                region_name='auto',
                endpoint_url=os.environ.get('R2_ENDPOINT'),
                aws_access_key_id=os.environ.get('R2_ACCESS_KEY_ID'),
                aws_secret_access_key=os.environ.get('R2_SECRET_ACCESS_KEY')
            )
            bucket_name = os.environ.get('R2_BUCKET_NAME')

        # Always upload gzipped version
        with open(GZIPPED_OUTPUT, 'rb') as f:
            s3_client.upload_fileobj(
                f, 
                bucket_name, 
                'fingerprints.json.gz',
                ExtraArgs={'ContentType': 'application/gzip'}
            )
        print(f"Uploaded fingerprints.json.gz to {bucket_name}")
        
        # Optionally upload uncompressed version
        if upload_both:
            with open(OUTPUT_FILE, 'rb') as f:
                s3_client.upload_fileobj(
                    f, 
                    bucket_name, 
                    'fingerprints.json',
                    ExtraArgs={'ContentType': 'application/json'}
                )
            print(f"Uploaded fingerprints.json to {bucket_name}")
            
        return True
    except Exception as e:
        print(f"Error uploading to S3/R2: {e}")
        return False


def main():
    try:
        parser = argparse.ArgumentParser(description='Generate and manage fingerprints for ligand searching')
        parser.add_argument('--upload', action='store_true', help='Upload fingerprints to S3/R2 after generation')
        parser.add_argument('--remote', action='store_true', help='Upload to remote R2 instead of local S3')
        parser.add_argument('--upload-both', action='store_true', help='Upload both compressed and uncompressed files')
        args = parser.parse_args()
        
        if 'rdkit' not in sys.modules:
            print("Error: RDKit is not installed. Please install it with:")
            print("  pip install rdkit")
            return 1
        
        # Ensure the output directory exists
        os.makedirs(S3_DIR, exist_ok=True)
        
        if not os.path.exists(SENSORS_DIR) or not any(SENSORS_DIR.glob("**/*.json")):
            print(f"Error: No sensor files found in {SENSORS_DIR}")
            print("Please run jsonMigrate.js first to generate sensor files.")
            return 1
            
        print(f"Generating fingerprints from sensors in {SENSORS_DIR}")
        fingerprints = generate_fingerprints()
        
        if fingerprints:
            save_fingerprints(fingerprints)
            
            if args.upload:
                if upload_to_s3(local=not args.remote, upload_both=args.upload_both):
                    print("Fingerprints uploaded successfully!")
                else:
                    print("Failed to upload fingerprints.")
                    return 1
                    
            print("Fingerprint generation completed successfully!")
            return 0
        else:
            print("No fingerprints were generated. Check if sensor files contain ligands with SMILES strings.")
            return 1
            
    except Exception as e:
        print(f"Unexpected error: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())