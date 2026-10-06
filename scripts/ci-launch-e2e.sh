#!/usr/bin/env bash
# Start the committed Nexus fixture stub, then `next start`, then the
# launch-critical Chromium suite. Does not run `next build` — CI downloads
# the Build job's `.next`. Required gate never reads live nexusd 7108.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${PORT:-3000}"
BASE_URL="${LAUNCH_E2E_BASE_URL:-http://127.0.0.1:${PORT}}"
export LAUNCH_E2E_BASE_URL="$BASE_URL"
export LAUNCH_E2E_SERVICE_URL="${LAUNCH_E2E_SERVICE_URL:-https://staging-api.pubky.app}"
export LAUNCH_E2E_REQUIRE_SELLER_BOARD="${LAUNCH_E2E_REQUIRE_SELLER_BOARD:-1}"
if [[ -d /ms-playwright ]]; then
  export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/ms-playwright}"
fi
export MARKETPLACE_STAGING_DROP_IDENTITIES_FILE="${MARKETPLACE_STAGING_DROP_IDENTITIES_FILE:-/Users/johncarvalho/work/.staging-drop-identities.json}"

export PUBKY_RUNTIME_ENV="${PUBKY_RUNTIME_ENV:-staging}"
export PUBKY_RUNTIME_TESTNET="${PUBKY_RUNTIME_TESTNET:-false}"
export PUBKY_RUNTIME_HOMESERVER="${PUBKY_RUNTIME_HOMESERVER:-ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy}"
export PUBKY_RUNTIME_HOMESERVER_URL="${PUBKY_RUNTIME_HOMESERVER_URL:-https://homeserver.staging.pubky.app}"
export PUBKY_RUNTIME_NEXUS_URL="${PUBKY_RUNTIME_NEXUS_URL:-https://nexus.staging.pubky.app}"
export PUBKY_RUNTIME_CDN_URL="${PUBKY_RUNTIME_CDN_URL:-https://nexus.staging.pubky.app/static}"
export PUBKY_RUNTIME_HOMEGATE_URL="${PUBKY_RUNTIME_HOMEGATE_URL:-https://homegate.staging.pubky.app}"
export PUBKY_RUNTIME_PKARR_RELAYS="${PUBKY_RUNTIME_PKARR_RELAYS:-[\"https://pkarr.pubky.app\",\"https://pkarr.pubky.org\"]}"
export PUBKY_RUNTIME_DEFAULT_HTTP_RELAY="${PUBKY_RUNTIME_DEFAULT_HTTP_RELAY:-https://httprelay.staging.pubky.app/inbox}"
export PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE="${PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE:-transaction-service}"
export PUBKY_RUNTIME_MARKETPLACE_URL="${PUBKY_RUNTIME_MARKETPLACE_URL:-https://staging-api.pubky.app}"

STUB_HOST="${LAUNCH_E2E_NEXUS_STUB_HOST:-127.0.0.1}"
STUB_PORT="${LAUNCH_E2E_NEXUS_STUB_PORT:-7109}"
STUB_URL="http://${STUB_HOST}:${STUB_PORT}"

forbid_live_nexus() {
  local value="$1"
  local name="$2"
  if [[ "${LAUNCH_E2E_ALLOW_LIVE_NEXUS:-}" == "1" ]]; then
    return 0
  fi
  if [[ "$value" == *railway.app* || "$value" == *7108* ]]; then
    echo "${name} must not point at live nexusd 7108 (got ${value})"
    exit 1
  fi
}

if [[ ! -d .next || ! -f .next/BUILD_ID ]]; then
  echo "Missing .next — this script reuses a production build and must not run next build."
  ls -la . next-build-artifact 2>/dev/null | head -80 || true
  exit 1
fi

started_server=0
started_stub=0
SERVER_PID=""
STUB_PID=""
SERVER_LOG="${LAUNCH_E2E_SERVER_LOG:-}"
STUB_LOG="${LAUNCH_E2E_STUB_LOG:-}"
cleanup() {
  if [[ "$started_server" == "1" && -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ "$started_stub" == "1" && -n "$STUB_PID" ]]; then
    kill "$STUB_PID" 2>/dev/null || true
    wait "$STUB_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if [[ -z "$STUB_LOG" ]]; then
  STUB_LOG="$(mktemp)"
fi
node scripts/launch-e2e-nexus-stub.mjs >"$STUB_LOG" 2>&1 &
STUB_PID=$!
started_stub=1
STUB_WAIT=0
while ! curl -fsS "${STUB_URL}/health" >/dev/null 2>&1; do
  if ! kill -0 "$STUB_PID" 2>/dev/null; then
    echo "nexus stub exited unexpectedly"
    cat "$STUB_LOG"
    exit 1
  fi
  if (( STUB_WAIT >= 10 )); then
    echo "nexus stub did not become ready"
    cat "$STUB_LOG"
    exit 1
  fi
  sleep 0.5
  STUB_WAIT=$((STUB_WAIT + 1))
done
echo "Nexus fixture stub is ready at ${STUB_URL}"

if [[ "${LAUNCH_E2E_ALLOW_LIVE_NEXUS:-}" == "1" ]]; then
  export PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL="${PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL:-$STUB_URL}"
  export LAUNCH_E2E_NEXUS_URL="${LAUNCH_E2E_NEXUS_URL:-$PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL}"
else
  # Required gate never inherits live 7108 from the parent shell / CI env.
  export PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL="$STUB_URL"
  export LAUNCH_E2E_NEXUS_URL="$STUB_URL"
fi
forbid_live_nexus "$PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL" "PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL"
forbid_live_nexus "$LAUNCH_E2E_NEXUS_URL" "LAUNCH_E2E_NEXUS_URL"

if curl -fsS "${BASE_URL}/" >/dev/null 2>&1; then
  echo "Reusing already-running server at ${BASE_URL}"
else
  if [[ -z "$SERVER_LOG" ]]; then
    SERVER_LOG="$(mktemp)"
  fi
  npm run start >"$SERVER_LOG" 2>&1 &
  SERVER_PID=$!
  started_server=1
  ELAPSED=0
  MAX_WAIT=120
  while ! curl -fsS "${BASE_URL}/" >/dev/null 2>&1; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      echo "next start exited unexpectedly"
      cat "$SERVER_LOG"
      exit 1
    fi
    if (( ELAPSED >= MAX_WAIT )); then
      echo "next start did not become ready within ${MAX_WAIT}s"
      cat "$SERVER_LOG"
      exit 1
    fi
    sleep 2
    ELAPSED=$((ELAPSED + 2))
  done
  echo "Production server is ready at ${BASE_URL}"
fi

node src/test/e2e/launch-critical.mjs
