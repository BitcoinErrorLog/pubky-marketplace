#!/usr/bin/env bash
# Brings the composed environment up. Safe to re-run.
# Never touches containers outside the payments-env compose project.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  cp .env.example .env
fi

if ! rg -q '^PAYKIT_MASTER_KEY=..' .env 2>/dev/null && ! grep -q '^PAYKIT_MASTER_KEY=..' .env; then
  key="$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
  tmp="$(mktemp)"
  grep -v '^PAYKIT_MASTER_KEY=' .env > "$tmp" || true
  printf 'PAYKIT_MASTER_KEY=%s\n' "$key" >> "$tmp"
  mv "$tmp" .env
  echo "generated PAYKIT_MASTER_KEY in .env"
fi

./scripts/fetch-sources.sh

if ! docker image inspect paykit-server:local-867fc883 >/dev/null 2>&1; then
  ./scripts/build-paykit-image.sh
fi

docker compose build pubky-testnet locks-server
docker compose up -d

echo
echo "waiting for Lock Server readiness..."
locks_port="$(grep -E '^LOCKS_SERVER_PORT=' .env | cut -d= -f2)"
locks_port="${locks_port:-3000}"
paykit_port="$(grep -E '^PAYKIT_SERVER_PORT=' .env | cut -d= -f2)"
paykit_port="${paykit_port:-3001}"

deadline=$(( $(date +%s) + 300 ))
until curl -fsS "http://localhost:${locks_port}/readyz" >/dev/null 2>&1; do
  [ "$(date +%s)" -gt "$deadline" ] && { echo "Lock Server did not become ready" >&2; exit 1; }
  sleep 2
done
curl -fsS "http://localhost:${locks_port}/readyz"; echo

echo "waiting for Paykit Server readiness..."
until [ "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${paykit_port}/health/ready")" = "200" ]; do
  [ "$(date +%s)" -gt "$deadline" ] && { echo "Paykit Server did not become ready" >&2; exit 1; }
  sleep 2
done
curl -fsS "http://localhost:${paykit_port}/health/ready"; echo

echo "stack is up"
