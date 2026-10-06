#!/usr/bin/env bash
# Proves the fast and full modes of scripts/prepush.sh run the right steps:
# fast runs prettier, eslint, typecheck and related unit tests; full adds
# Linux VRT. Runs the real gate in a throwaway repository. npx and npm are
# stand-ins on PATH, and vrt-related.mjs and vrt-linux.sh are stubs, all of
# which log their arguments; nothing is formatted, compiled or rendered.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/prepush-mode-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

mkdir -p "$WORK/bin"
for tool in npx npm; do
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "$FAKE_LOG/%s"\n' "$tool" > "$WORK/bin/$tool"
done
chmod +x "$WORK/bin/"*

good="$WORK/good/node_modules"
mkdir -p "$good/prettier-plugin-tailwindcss" "$good/@testing-library/jest-dom"
echo '{}' > "$good/prettier-plugin-tailwindcss/package.json"
echo '{}' > "$good/@testing-library/jest-dom/package.json"

git init -q "$WORK/app"
cd "$WORK/app"
git config user.email test@example.invalid
git config user.name test
mkdir -p scripts src
cp "$DIR/prepush.sh" "$DIR/prepush-stamp.sh" "$DIR/heavy-lock.sh" scripts/
cat > scripts/vrt-related.mjs <<'EOF'
if (process.argv.slice(2).some((file) => file.endsWith('.tsx'))) {
  console.log('src/test/vrt/marketplace/Card.vrt.test.tsx');
}
EOF
cat > scripts/vrt-linux.sh <<'EOF'
printf '%s\n' "$*" >> "$FAKE_LOG/vrt"
exit "${VRT_FAIL:-0}"
EOF
printf '/node_modules\n' > .gitignore
: > .prettierignore
printf 'export const a = 1;\n' > src/Card.tsx
git add -A
git commit -qm base
BASE="$(git rev-parse HEAD)"
ln -s "$good" node_modules

gate() {
  rm -rf "$WORK/log"
  mkdir -p "$WORK/log"
  local st=0
  FAKE_LOG="$WORK/log" PATH="$WORK/bin:$PATH" PREPUSH_BASE="$BASE" \
    PREPUSH_SHARED_SEED="$WORK/seed" HEAVY_LOCK_DIR="$WORK/locks" \
    bash scripts/prepush.sh </dev/null >"$WORK/out" 2>&1 || st=$?
  printf '%s\n' "$st"
}
log() { cat "$WORK/log/$1" 2>/dev/null || true; }
expect_ok() {
  [ "$1" = 0 ] || fail "$2: status $1: $(cat "$WORK/out")"
  tail -1 "$WORK/out" | grep -q "^PREPUSH OK $(git rev-parse HEAD) [0-9]* $3$" \
    || fail "$2: last line: $(tail -1 "$WORK/out")"
}
commit_change() {
  git reset -q --hard "$BASE"
  printf '// %s %s\n' "$RANDOM" "$(date +%s)" >> src/Card.tsx
  git commit -qam change
}
fast_steps="prettier --check --ignore-path .prettierignore src/Card.tsx
eslint src/Card.tsx
vitest related --run --project unit src/Card.tsx"

echo "test: fast runs prettier, eslint, typecheck and related unit tests, and no VRT"
commit_change
st="$(gate)"
expect_ok "$st" "fast" fast
[ "$(log npx)" = "$fast_steps" ] || fail "fast: npx calls: $(log npx)"
[ "$(log npm)" = "run typecheck" ] || fail "fast: npm calls: $(log npm)"
[ -z "$(log vrt)" ] || fail "fast ran VRT: $(log vrt)"
grep -q 'linux vrt skipped in fast mode' "$WORK/out" || fail "fast: no VRT skip line: $(cat "$WORK/out")"

echo "test: PREPUSH_FULL=1 does not reuse the fast pass and adds Linux VRT"
st="$(PREPUSH_FULL=1 gate)"
expect_ok "$st" "full" full
[ "$(log npx)" = "$fast_steps" ] || fail "full: npx calls: $(log npx)"
[ "$(log npm)" = "run typecheck" ] || fail "full: npm calls: $(log npm)"
[ "$(log vrt)" = "src/test/vrt/marketplace/Card.vrt.test.tsx" ] || fail "full: VRT calls: $(log vrt)"

echo "test: a failing VRT fails the full gate and leaves no full stamp"
commit_change
st="$(PREPUSH_FULL=1 VRT_FAIL=1 gate)"
[ "$st" != 0 ] || fail "failing VRT returned 0: $(cat "$WORK/out")"
grep -q 'PREPUSH OK' "$WORK/out" && fail "failing VRT printed PREPUSH OK: $(cat "$WORK/out")"
st="$(PREPUSH_FULL=1 gate)"
expect_ok "$st" "full after a VRT failure" full
[ -n "$(log vrt)" ] || fail "full after a VRT failure reused a stamp: $(cat "$WORK/out")"

echo "test: a fast run after a full pass reuses it"
st="$(gate)"
expect_ok "$st" "fast after full" "fast reused:full .*"
[ -z "$(log npx)$(log npm)$(log vrt)" ] || fail "fast after full ran steps"

echo "test: PREPUSH_FULL=yes is refused before any step"
commit_change
st="$(PREPUSH_FULL=yes gate)"
[ "$st" = 1 ] || fail "PREPUSH_FULL=yes: status $st"
grep -q 'PREPUSH_FULL must be 1, 0 or unset' "$WORK/out" || fail "PREPUSH_FULL=yes: $(cat "$WORK/out")"
[ -z "$(log npx)$(log npm)$(log vrt)" ] || fail "PREPUSH_FULL=yes ran steps"

echo "ALL OK"
