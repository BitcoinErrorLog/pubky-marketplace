#!/usr/bin/env bash
# Marketplace VRT for GitHub Actions (Linux).
#
# Compares against committed *-linux.png baselines. Missing linux baselines
# are recorded and uploaded as an artifact, then the job FAILS — commit the
# recorded *-linux.png from the artifact. Pixel mismatch against an existing
# linux baseline also fails. Darwin PNGs are not part of this gate.
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

export VRT_BROWSERS="${VRT_BROWSERS:-chromium,firefox}"
REPORT_DIR="${VRT_REPORT_DIR:-${ROOT}/.vrt-marketplace-ci}"
REPORT_JSON="${REPORT_DIR}/report.json"
NEW_LINUX_DIR="${REPORT_DIR}/new-linux-baselines"
mkdir -p "$REPORT_DIR" "$NEW_LINUX_DIR"

run_vrt() {
  local extra=()
  if [ "${1:-}" = "update" ]; then
    extra+=(--update)
  fi
  npx vitest run --project vrt-marketplace \
    --reporter=dot \
    --reporter=json \
    --outputFile="$REPORT_JSON" \
    "${extra[@]}"
}

classify() {
  node --input-type=module - "$REPORT_JSON" <<'NODE'
import { readFileSync } from 'node:fs';

const path = process.argv[2];
let report;
try {
  report = JSON.parse(readFileSync(path, 'utf8'));
} catch (error) {
  console.error(`could not parse ${path}: ${error.message}`);
  process.exit(12);
}

function collectFailedTests(value) {
  const tests = [];
  function walk(node) {
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (typeof node !== 'object') return;
    if (Array.isArray(node.assertionResults)) {
      for (const assertion of node.assertionResults) {
        if (!assertion || assertion.status !== 'failed') continue;
        const messages = [];
        if (Array.isArray(assertion.failureMessages)) {
          for (const message of assertion.failureMessages) {
            if (typeof message === 'string') messages.push(message);
          }
        }
        tests.push({
          title: assertion.fullName || assertion.title || '',
          messages,
        });
      }
    }
    if (Array.isArray(node.testResults)) {
      for (const nested of node.testResults) walk(nested);
    }
  }
  walk(value);
  return tests;
}

function kind(message) {
  if (/No existing reference screenshot found/i.test(message)) return 'missing';
  if (
    /Screenshot does not match the stored reference/i.test(message) ||
    /screenshots do not match/i.test(message) ||
    /Expected image dimensions/i.test(message) ||
    /pixels \(ratio .+\) differ/i.test(message)
  ) {
    return 'mismatch';
  }
  return 'other';
}

const failedTests = collectFailedTests(report);
const byTitle = new Map();
for (const test of failedTests) {
  const kinds = byTitle.get(test.title) || [];
  for (const message of test.messages) kinds.push(kind(message));
  if (test.messages.length === 0) kinds.push('other');
  byTitle.set(test.title, kinds);
}

let missing = 0;
let mismatch = 0;
let other = 0;
for (const kinds of byTitle.values()) {
  if (kinds.includes('missing')) missing += 1;
  else if (kinds.includes('mismatch')) mismatch += 1;
  else other += 1;
}

const failed =
  report.success === false ||
  (typeof report.numFailedTests === 'number' && report.numFailedTests > 0) ||
  (typeof report.numFailedTestSuites === 'number' && report.numFailedTestSuites > 0);

if (!failed) {
  console.log('CLASS=pass');
  process.exit(0);
}
if (mismatch > 0 || other > 0) {
  console.log(`CLASS=mismatch missing=${missing} mismatch=${mismatch} other=${other}`);
  process.exit(11);
}
if (missing > 0) {
  console.log(`CLASS=missing missing=${missing}`);
  process.exit(10);
}
console.log('CLASS=other');
process.exit(12);
NODE
}

echo "Running marketplace VRT (browsers=${VRT_BROWSERS})"
set +e
run_vrt compare
VRT_EXIT=$?
CLASS_OUT="$(classify)"
CLASS_EXIT=$?
set -e
echo "$CLASS_OUT"
echo "Vitest exit=${VRT_EXIT} classify=${CLASS_EXIT}"

restore_committed_pngs() {
  git diff --name-only -- 'src/test/vrt/**/*-linux.png' | while IFS= read -r file; do
    [ -n "$file" ] || continue
    git checkout -- "$file"
  done
}

stage_new_linux() {
  git ls-files --others --exclude-standard -- 'src/test/vrt/marketplace/**/*-linux.png' |
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      rel="${file#src/test/vrt/}"
      dest="${NEW_LINUX_DIR}/${rel}"
      mkdir -p "$(dirname "$dest")"
      cp "$file" "$dest"
    done
}

record_missing_linux() {
  echo "Recording missing Linux baselines for the artifact. Committed Linux files are restored after the record pass."
  set +e
  run_vrt update
  set -e
  restore_committed_pngs
  stage_new_linux
  echo "New Linux baselines staged under ${NEW_LINUX_DIR}"
  find "$NEW_LINUX_DIR" -name '*-linux.png' | wc -l
}

if [ "$CLASS_EXIT" -eq 0 ]; then
  echo "Marketplace VRT matched existing Linux baselines."
  exit 0
fi

if [ "$CLASS_EXIT" -eq 10 ]; then
  record_missing_linux
  if [ "${VRT_LINUX_LOCAL:-}" = "1" ]; then
    echo "Missing Linux baselines recorded in the worktree. Commit the new *-linux.png files (npm run vrt:linux)."
    exit 0
  fi
  echo "Missing Linux baselines. Job failed. Commit the recorded *-linux.png from the vrt-marketplace-linux-baselines artifact."
  exit 1
fi

if [ "$CLASS_EXIT" -eq 11 ]; then
  record_missing_linux
  echo "Marketplace VRT failed on a pixel mismatch against committed Linux baselines."
  exit 1
fi

echo "Marketplace VRT failed on a non-screenshot error."
restore_committed_pngs
exit 1

