#!/bin/bash
# Rebuilds layers/python-v2/layer.zip -- the shared Lambda layer for the
# local (Floci) V2 Python functions (requests, pydantic, groov_models, and
# python-jose for the ported adminAuthorizer.py).
#
# Installs into the public.ecr.aws/lambda/python:3.14 base image (V2 Python
# functions run python3.14 in prod -- see template.yaml -- so the layer is
# built against a matching python3.14/pydantic-core cp314 base for runtime
# parity). updateFingerprintV2 is NOT part of this layer -- it stays on
# python3.12 via layers/rdkit, unaffected by this change.
#
# python-jose is installed WITHOUT the `cryptography` extra, so it falls back
# to its pure-Python RSA backend (rsa/pyasn1/ecdsa) -- avoids a second set of
# architecture-specific wheels for something only the authorizer needs.
#
# --- Architecture ---
# Host arch is detected via `uname -m` and used both to select the Docker
# platform passed to `docker run` and to name the arch-suffixed output copy.
# By DEFAULT this builds for the arch `uname -m` reports (arm64 on Apple
# Silicon, x86_64 elsewhere) since that's what Floci's local Docker daemon
# will also run the Lambda containers under. `layer.zip` (unsuffixed) is
# ALWAYS the host-arch build -- the Floci provisioner references `layer.zip`
# directly and assumes it matches the host. A `layer-<arch>.zip` copy is
# emitted alongside it (e.g. layer-arm64.zip / layer-x86_64.zip) for x86 CI
# or cross-arch use without disturbing that contract.
#
# To cross-build for the OTHER architecture (e.g. produce an x86_64 layer
# from an arm64 host for CI), override BUILD_ARCH:
#   BUILD_ARCH=x86_64 ./build.sh
# This still writes layer.zip as "the build this invocation produced" (so
# only run it that way on a host that actually matches, e.g. in x86 CI) plus
# the matching layer-x86_64.zip. Requires the docker daemon to support the
# target --platform (e.g. via QEMU emulation) if cross-building.
#
# Re-run this whenever layers/python-v2/requirements.txt changes, or if you
# run Floci on a different host architecture than the one used previously.
set -euo pipefail
cd "$(dirname "$0")"

HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  aarch64|arm64) DEFAULT_ARCH="arm64" ;;
  x86_64) DEFAULT_ARCH="x86_64" ;;
  *) DEFAULT_ARCH="$HOST_ARCH" ;;
esac
BUILD_ARCH="${BUILD_ARCH:-$DEFAULT_ARCH}"

case "$BUILD_ARCH" in
  arm64) DOCKER_PLATFORM="linux/arm64" ;;
  x86_64) DOCKER_PLATFORM="linux/amd64" ;;
  *) echo "Unsupported BUILD_ARCH=$BUILD_ARCH (expected arm64 or x86_64)" >&2; exit 1 ;;
esac

rm -rf python layer.zip "layer-${BUILD_ARCH}.zip"
mkdir -p python

docker run --rm \
  --platform "$DOCKER_PLATFORM" \
  -v "$PWD":/layer \
  --entrypoint /bin/sh \
  public.ecr.aws/lambda/python:3.14 \
  -c "pip install --no-cache-dir -r /layer/requirements.txt -t /layer/python && \
      cp /layer/shared/groov_models.py /layer/python/groov_models.py && \
      chmod -R a+rX /layer/python"

zip -qr layer.zip python
cp layer.zip "layer-${BUILD_ARCH}.zip"
echo "Built $(pwd)/layer.zip ($(du -h layer.zip | cut -f1)) [BUILD_ARCH=$BUILD_ARCH, also wrote layer-${BUILD_ARCH}.zip]"
