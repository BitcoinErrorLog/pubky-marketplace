#!/usr/bin/env bash
# Runs the "Match non-docs paths" step of .github/workflows/test.yml against
# sample changes in a throwaway repository and checks which ones run the unit
# suite. Usage: scripts/ci-test-paths-test.sh [workflow file]
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$DIR/.." && pwd)"
WORKFLOW="$(cd "$(dirname "${1:-$ROOT/.github/workflows/test.yml}")" && pwd)/$(basename "${1:-test.yml}")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ci-test-paths-test.XXXXXX")"
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

# run_filter EVENT BASE FILE... commits FILE... on top of the base and prints
# the filter's run= value.
run_filter() {
  local event="$1" event_base="$2"
  shift 2
  git reset -q --hard "$base"
  for file in "$@"; do
    mkdir -p "$(dirname "$file")"
    printf 'x\n' > "$file"
  done
  git add -A
  git commit -q --allow-empty -m "change $*"
  : > "$WORK/output"
  EVENT_NAME="$event" PR_BASE_SHA="$event_base" PUSH_BEFORE="$event_base" \
    RUNNER_TEMP="$WORK" GITHUB_OUTPUT="$WORK/output" bash "$WORK/filter.sh" >/dev/null
  sed -n 's/^run=//p' "$WORK/output"
}

expect() {
  local want="$1" label="$2"
  shift 2
  local got
  got="$(run_filter "$@")"
  echo "test: ${label} -> run=${got}"
  [ "$got" = "$want" ] || fail "${label}: expected run=${want}, got run=${got}"
}

for event in pull_request push; do
  for file in docs/launch/shop-launch-plan.md docs/vrt/catalog-browse.png \
    docs/adr/0030-example.md payments-env/scripts/up.sh README.md SUMMARY.md \
    src/components/README.md; do
    expect false "${event} ${file}" "$event" "$base" "$file"
  done
  for file in src/components/Card.tsx package.json package-lock.json \
    .github/workflows/test.yml scripts/prepush.sh vitest.config.ts \
    public/images/logo.png .prettierignore; do
    expect true "${event} ${file}" "$event" "$base" "$file"
  done
  expect true "${event} docs plus code" "$event" "$base" docs/README.md src/app/page.tsx
  expect true "${event} empty diff" "$event" "$base"
done

expect true "push without before" push "" docs/README.md
expect true "push of a new branch" push 0000000000000000000000000000000000000000 docs/README.md
expect true "push with an unknown before" push 1111111111111111111111111111111111111111 docs/README.md
expect true "merge_group" merge_group "" docs/README.md
expect true "workflow_dispatch" workflow_dispatch "" docs/README.md

echo "ci-test-paths-test: all cases passed"
