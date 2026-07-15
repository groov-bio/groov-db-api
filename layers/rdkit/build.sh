#!/bin/bash
# Rebuilds layers/rdkit/layer.zip -- rdkit + numpy + Pillow for
# updateFingerprintV2 (python3.12, the function's original template.yaml
# runtime -- kept as-is for rdkit manylinux wheel availability). This layer
# stays on python3.12 even though the rest of the V2 Python layer
# (layers/python-v2) moved to python3.14 for prod parity -- rdkit wheel
# availability for 3.14 is not there yet.
#
# Scope-addition note: rdkit fingerprinting is a COMMITTED local feature (not
# stubbed) -- approveProcessedSensorV2 / deleteSensorV2 invoke
# updateFingerprintV2 for real via FINGERPRINT_LAMBDA_NAME (see
# floci/provision.sh).
#
# These are binary-only downloads (--only-binary=:all:), not compiled, so no
# Docker/build image is needed -- just pip resolving prebuilt wheels for the
# TARGET platform.
#
# --- Architecture ---
# TARGET_PLATFORM's default is now derived from `uname -m` (previously
# hardcoded to aarch64): aarch64/arm64 -> manylinux2014_aarch64, x86_64 ->
# manylinux2014_x86_64. `layer.zip` (unsuffixed) is ALWAYS the host-arch
# build -- the Floci provisioner references `layer.zip` directly and assumes
# it matches the host. A `layer-<arch>.zip` copy (layer-arm64.zip /
# layer-x86_64.zip) is emitted alongside it for x86 CI or cross-arch use
# without disturbing that contract.
#
# To build for the OTHER architecture regardless of host (e.g. from an arm64
# dev machine, to produce an x86_64 artifact for CI), override
# TARGET_PLATFORM directly (pip's wheel download doesn't need to match the
# host since these are prebuilt binary wheels, not compiled locally):
#   TARGET_PLATFORM=manylinux2014_x86_64 ./build.sh
# In that case layer.zip/layer-<arch>.zip both reflect TARGET_PLATFORM's
# arch, not necessarily the host's -- only rely on layer.zip as "host-arch"
# when TARGET_PLATFORM was left at its default.
#
# Verified: `from rdkit import Chem` + Morgan fingerprint generation succeeds
# when this layer's python/ dir is mounted at /opt/python and imported inside
# `public.ecr.aws/lambda/python:3.12` run with --platform linux/arm64.
set -euo pipefail
cd "$(dirname "$0")"

HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  aarch64|arm64) DEFAULT_TARGET_PLATFORM="manylinux2014_aarch64" ;;
  x86_64) DEFAULT_TARGET_PLATFORM="manylinux2014_x86_64" ;;
  *) DEFAULT_TARGET_PLATFORM="manylinux2014_aarch64" ;;
esac
TARGET_PLATFORM="${TARGET_PLATFORM:-$DEFAULT_TARGET_PLATFORM}"
PYTHON_VERSION="312"   # matches updateFingerprintV2's python3.12 runtime -- do not change

case "$TARGET_PLATFORM" in
  manylinux2014_aarch64) ARCH_SUFFIX="arm64" ;;
  manylinux2014_x86_64) ARCH_SUFFIX="x86_64" ;;
  *) ARCH_SUFFIX="$TARGET_PLATFORM" ;;
esac

rm -rf python layer.zip "layer-${ARCH_SUFFIX}.zip"
mkdir -p python

pip3 install rdkit numpy \
  --only-binary=:all: \
  --platform "$TARGET_PLATFORM" \
  --python-version "$PYTHON_VERSION" \
  --implementation cp \
  --target python \
  --no-cache-dir

zip -qr layer.zip python -x "python/*/__pycache__/*"
cp layer.zip "layer-${ARCH_SUFFIX}.zip"
echo "Built $(pwd)/layer.zip ($(du -h layer.zip | cut -f1)) for platform=$TARGET_PLATFORM [also wrote layer-${ARCH_SUFFIX}.zip]"
