#!/usr/bin/env bash
# Stops the payments-env compose project. Pass --volumes to also delete its
# named volumes (fresh state on next start). Never touches other projects.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" = "--volumes" ]; then
  docker compose down --volumes
else
  docker compose down
fi
