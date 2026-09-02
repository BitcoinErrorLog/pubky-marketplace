#!/usr/bin/env bash
# Builds the Paykit Server local demo image from pinned sources using the
# upstream Dockerfile.local and its named BuildKit contexts. The upstream
# prepare-local-docker-sources.sh step fails closed if the supplied trees do
# not match the dependency pins committed in paykit-server's manifests.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE_TAG="paykit-server:local-867fc883"

for dir in sources/paykit-server sources/paykit-rs sources/locks-paykit-dep; do
  if [ ! -d "$dir" ]; then
    echo "missing $dir; run scripts/fetch-sources.sh first" >&2
    exit 1
  fi
done

docker buildx build --load \
  --build-context paykit-lib=sources/paykit-rs/paykit-lib \
  --build-context paykit-sdk=sources/paykit-rs/paykit-sdk \
  --build-context locks=sources/locks-paykit-dep \
  -f sources/paykit-server/Dockerfile.local \
  -t "$IMAGE_TAG" \
  sources/paykit-server

echo "built $IMAGE_TAG"
