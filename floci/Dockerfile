# floci/Dockerfile
#
# Runs floci/provisioner.py -- the Python provisioner that derives the local
# Floci stack from template.yaml. Built by the `floci-init` service in
# docker-compose.yml. template.yaml, scripts/s3_v2/, and the layer zips are
# NOT baked into this image; they're read at run time from the repo root,
# bind-mounted read-only at /workspace by docker-compose.yml.
FROM python:3.13-slim

RUN pip install --no-cache-dir boto3 pyyaml

COPY provisioner.py local_parameters.json /app/
WORKDIR /app

ENTRYPOINT ["python3", "/app/provisioner.py"]
