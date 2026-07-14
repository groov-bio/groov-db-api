#!/bin/bash
# Rebuilds layers/python-v2/layer.zip -- the shared Lambda layer for the
# local (Floci) V2 Python functions (requests, pydantic, groov_models, and
# python-jose for the ported adminAuthorizer.py).
#
# Installs into the public.ecr.aws/lambda/python:3.13 base image so the
# wheels (pydantic-core is the only compiled dependency here) match whatever
# architecture that image resolves to on THIS machine's default Docker
# platform -- which is also the architecture Floci will use to run the
# Lambda containers themselves (both come from the same local Docker
# daemon/default platform), so this always stays consistent without hardcoding
# an arch.
#
# python-jose is installed WITHOUT the `cryptography` extra, so it falls back
# to its pure-Python RSA backend (rsa/pyasn1/ecdsa) -- avoids a second set of
# architecture-specific wheels for something only the authorizer needs.
#
# Re-run this whenever layers/python-v2/requirements.txt changes, or if you
# run Floci on a different host architecture than the one used previously.
set -euo pipefail
cd "$(dirname "$0")"

rm -rf python layer.zip
mkdir -p python

docker run --rm \
  -v "$PWD":/layer \
  --entrypoint /bin/sh \
  public.ecr.aws/lambda/python:3.13 \
  -c "pip install --no-cache-dir -r /layer/requirements.txt -t /layer/python && \
      cp /layer/shared/groov_models.py /layer/python/groov_models.py && \
      chmod -R a+rX /layer/python"

zip -qr layer.zip python
echo "Built $(pwd)/layer.zip ($(du -h layer.zip | cut -f1))"
