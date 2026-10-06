#!/usr/bin/env bash
# Runs the "Match VRT paths" step of .github/workflows/vrt-marketplace.yml
# against sample changes in a throwaway repository and checks which ones run
# the VRT jobs. Usage: scripts/ci-vrt-paths-test.sh [workflow file]
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
WORKFLOW="$(cd "$(dirname "${1:-$ROOT/.github/workflows/vrt-marketplace.yml}")" && pwd)/$(basename "${1:-vrt-marketplace.yml}")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ci-vrt-paths-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

(cd "$ROOT" && node -e '
  const { parse } = require("yaml");
  const wf = parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const step = wf.jobs.paths.steps.find((s) => s.id === "filter");
  if (!step) process.exit(1);
  process.stdout.write(step.run);
' "$WORKFLOW") > "$WORK/filter.sh" || fail "no filter step in $WORKFLOW"

git init -q "$WORK/repo"
cd "$WORK/repo"
git config user.email test@example.invalid
git config user.name test
git commit -q --allow-empty -m base
base="$(git rev-parse HEAD)"

matches() {
  git reset -q --hard "$base"
  mkdir -p "$(dirname "$1")"
  printf 'x\n' > "$1"
  git add -A
  git commit -qm "change $1"
  : > "$WORK/output"
  BASE_SHA="$base" RUNNER_TEMP="$WORK" GITHUB_OUTPUT="$WORK/output" bash "$WORK/filter.sh" >/dev/null
  grep -qx 'run=true' "$WORK/output"
}

for file in \
  src/components/Card.tsx src/test/vrt/marketplace/Card.vrt.test.tsx \
  public/images/logo.png vendor/paykit-wasm/index.js src/app/globals.css \
  package.json package-lock.json .nvmrc \
  tsconfig.json tsconfig.test.json \
  vitest.config.ts vitest.config.mts vite.config.ts vite.config.mjs \
  postcss.config.mjs postcss.config.js tailwind.config.ts \
  .github/workflows/vrt-marketplace.yml scripts/vrt-linux.sh scripts/ci-vrt-marketplace.sh; do
  echo "test: $file runs VRT"
  matches "$file" || fail "$file did not run VRT"
done

for file in docs/readme.md README.md .github/workflows/test.yml scripts/prepush.sh \
  cypress/e2e/feed.cy.ts vitest.integration.config.ts; do
  echo "test: $file skips VRT"
  if matches "$file"; then
    fail "$file ran VRT"
  fi
done

echo "ALL OK"
