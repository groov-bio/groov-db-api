import json
import os
import subprocess
import re
import logging
from tempfile import NamedTemporaryFile

logger = logging.getLogger()
logger.setLevel(logging.INFO)

allowed_origins = [
    'http://localhost:3000',
    'https://groov.bio',
    'https://www.groov.bio',
    'https://ligify.groov.bio',
    'https://www.ligify.groov.bio'
]

AMINO_ACID_PATTERN = re.compile(r'^[ACDEFGHIKLMNPQRSTVWXY*]+$', re.IGNORECASE)

DIAMOND_DB = os.path.join(os.environ.get('LAMBDA_TASK_ROOT', '.'), 'ligify_blast.dmnd')


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


def validate_sequence(sequence):
    cleaned = sequence.strip().replace('\n', '').replace('\r', '').replace(' ', '')
    if not cleaned:
        return None, "Empty sequence"
    # TODO - more validations?
    if not AMINO_ACID_PATTERN.match(cleaned):
        return None, "Invalid characters in sequence. Expected amino acid single-letter codes."
    return cleaned, None


def run_diamond_blast(sequence, identity=30, coverage=60, max_results=50):
    query_file = NamedTemporaryFile(mode='w', suffix='.fasta', delete=False)
    output_file = NamedTemporaryFile(mode='r', suffix='.tsv', delete=False)
    output_path = output_file.name
    output_file.close()

    try:
        query_file.write(f">query\n{sequence}\n")
        query_file.close()

        cmd = (
            f"diamond blastp "
            f"-d {DIAMOND_DB} "
            f"-q {query_file.name} "
            f"-o {output_path} "
            f"--outfmt 6 sseqid pident qcovhsp "
            f"-b 0.1 "
            f"--id {identity} "
            f"--query-cover {coverage} "
            f"--max-target-seqs {max_results}"
        )

        logger.info(f"Running diamond command: {cmd}")

        # Trying to fit within the API gateway 30s limit here
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=25
        )

        if result.returncode != 0:
            logger.error(f"Diamond stderr: {result.stderr}")
            raise Exception(f"Diamond BLAST failed: {result.stderr}")

        with open(output_path, 'r') as f:
            lines = f.readlines()

        results = []
        for line in lines:
            parts = line.strip().split('\t')
            if len(parts) == 3:
                results.append({
                    'refseq_id': parts[0],
                    'identity': float(parts[1]),
                    'coverage': float(parts[2])
                })

        return results

    finally:
        try:
            os.unlink(query_file.name)
        except OSError:
            pass
        try:
            os.unlink(output_path)
        except OSError:
            pass


def lambda_handler(event, context):
    cors_headers = get_cors_headers(event)

    if event.get('requestContext', {}).get('http', {}).get('method') == 'OPTIONS':
        return {'statusCode': 200, 'headers': cors_headers, 'body': ''}

    try:
        body = event.get('body', '{}')
        if isinstance(body, str):
            body = json.loads(body)

        sequence = body.get('sequence')
        if not sequence:
            return {
                'statusCode': 400,
                'headers': cors_headers,
                'body': json.dumps({'error': 'Missing required field: sequence'})
            }

        cleaned_sequence, error = validate_sequence(sequence)
        if error:
            return {
                'statusCode': 400,
                'headers': cors_headers,
                'body': json.dumps({'error': error})
            }

        identity = min(max(int(body.get('identity', 30)), 20), 100)
        coverage = min(max(int(body.get('coverage', 60)), 20), 100)
        max_results = min(max(int(body.get('max_results', 50)), 1), 500)

        results = run_diamond_blast(cleaned_sequence, identity, coverage, max_results)

        return {
            'statusCode': 200,
            'headers': cors_headers,
            'body': json.dumps({
                'results': results,
                'num_results': len(results),
                'query_length': len(cleaned_sequence)
            })
        }

    except json.JSONDecodeError:
        return {
            'statusCode': 400,
            'headers': cors_headers,
            'body': json.dumps({'error': 'Invalid JSON in request body'})
        }
    except Exception as e:
        logger.error(f"Error processing BLAST request: {str(e)}")
        return {
            'statusCode': 500,
            'headers': cors_headers,
            'body': json.dumps({'error': 'Internal server error during BLAST search'})
        }
