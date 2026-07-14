#!/bin/bash
# Rebuilds layers/rdkit/layer.zip -- rdkit + numpy + Pillow for
# updateFingerprintV2 (python3.12, the function's original template.yaml
# runtime -- kept as-is for rdkit manylinux wheel availability).
#
# Scope-addition note: rdkit fingerprinting is a COMMITTED local feature (not
# stubbed) -- approveProcessedSensorV2 / deleteSensorV2 invoke
# updateFingerprintV2 for real via FINGERPRINT_LAMBDA_NAME (see
# floci/provision.sh).
#
# These are binary-only downloads (--only-binary=:all:), not compiled, so no
# Docker/build image is needed -- just pip resolving prebuilt wheels for the
# TARGET platform. Defaults to aarch64 (this repo's dev host + Floci's
# default Docker platform are both arm64, confirmed empirically: `docker run
# public.ecr.aws/lambda/python:3.12` reports aarch64 on this machine). If
# your Floci/Docker default platform is x86_64 instead, rerun with:
#   TARGET_PLATFORM=manylinux2014_x86_64 ./build.sh
#
# Verified: `from rdkit import Chem` + Morgan fingerprint generation succeeds
# when this layer's python/ dir is mounted at /opt/python and imported inside
# `public.ecr.aws/lambda/python:3.12` run with --platform linux/arm64.
set -euo pipefail
cd "$(dirname "$0")"

TARGET_PLATFORM="${TARGET_PLATFORM:-manylinux2014_aarch64}"
PYTHON_VERSION="312"   # matches updateFingerprintV2's python3.12 runtime

rm -rf python layer.zip
mkdir -p python

pip3 install rdkit numpy \
  --only-binary=:all: \
  --platform "$TARGET_PLATFORM" \
  --python-version "$PYTHON_VERSION" \
  --implementation cp \
  --target python \
  --no-cache-dir

zip -qr layer.zip python -x "python/*/__pycache__/*"
echo "Built $(pwd)/layer.zip ($(du -h layer.zip | cut -f1)) for platform=$TARGET_PLATFORM"
