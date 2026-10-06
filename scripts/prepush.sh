#!/usr/bin/env bash
# Pre-push gate. Last line on success: PREPUSH OK <sha> <seconds> <mode>
#
# fast (default): prettier and eslint on files changed since the merge base,
#   typecheck, and the unit tests vitest relates to those files.
# full (PREPUSH_FULL=1, releases): fast plus Linux VRT for every spec that
#   renders a changed file.
# CI runs the whole unit suite and the Linux VRT projects on every pull
# request to a release branch; fast relies on that.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

start=$(date +%s)
# shellcheck source=heavy-lock.sh
source "$ROOT/scripts/heavy-lock.sh"
# shellcheck source=prepush-stamp.sh
source "$ROOT/scripts/prepush-stamp.sh"
prepush_mode_init || exit 1
echo "prepush: mode ${PREPUSH_MODE}"

# Hook stdin lists the refs being pushed. A push whose every commit message
# contains [skip ci] does not run the gate. A manual tty run always does.
if [ ! -t 0 ]; then
  skip=1
  saw=0
  while read -r _local_ref local_sha _remote_ref remote_sha; do
    [ -n "${local_sha:-}" ] || continue
    saw=1
    if [ "$local_sha" = "0000000000000000000000000000000000000000" ]; then
      continue
    fi
    if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
      range="$local_sha"
    else
      range="${remote_sha}..${local_sha}"
    fi
    # grep -q under pipefail exits 141 when git log is still writing,
    # and the gate then skips every push. Read the subjects first.
    subjects="$(git log --format=%s "$range" || true)"
    if printf '%s\n' "$subjects" | grep -v '\[skip ci\]' >/dev/null; then
      skip=0
    fi
  done
  if [ "$saw" = 1 ] && [ "$skip" = 1 ]; then
    echo "prepush: every commit has [skip ci]; gate not run"
    exit 0
  fi
fi

# A broken dependency tree fails every later step with an unrelated error,
# and must never pass through a reused stamp, so this runs before reuse.
# The shared seed is read-only; a lane gates only on its own node_modules.
# A .pnpm directory means pnpm ran in this npm tree, which leaves a second
# copy of packages such as @sentry/core.
shared_seed="${PREPUSH_SHARED_SEED:-/Volumes/t7/vibes-dev/.deps/pubky-app-shop-v068-4713}"
deps_problem=""
if [ ! -d "$ROOT/node_modules" ]; then
  deps_problem="node_modules is missing"
else
  nm_real="$(cd "$ROOT/node_modules" && pwd -P)"
  seed_real="$(cd "$shared_seed" 2>/dev/null && pwd -P || printf '%s' "$shared_seed")"
  case "$nm_real/" in
    "$seed_real"/*) deps_problem="node_modules resolves into the shared seed ${seed_real}" ;;
  esac
  if [ -z "$deps_problem" ] && [ -e "$nm_real/.pnpm" ]; then
    deps_problem="node_modules/.pnpm exists"
  fi
  for pkg in prettier-plugin-tailwindcss @testing-library/jest-dom; do
    if [ -z "$deps_problem" ] && [ ! -f "$nm_real/$pkg/package.json" ]; then
      deps_problem="${pkg} is missing"
    fi
  done
fi
if [ -n "$deps_problem" ]; then
  echo "prepush: ${deps_problem}; rebuild this lane's node_modules (release skill §1)" >&2
  exit 1
fi

sha="$(git rev-parse HEAD)"
if prepush_reuse "$sha"; then
  exit 0
fi

if [ -n "${PREPUSH_BASE:-}" ]; then
  base="$PREPUSH_BASE"
elif git rev-parse --verify --quiet origin/master >/dev/null; then
  base="$(git merge-base HEAD origin/master)"
elif git rev-parse --verify --quiet origin/release/shop-v0.6.8 >/dev/null; then
  base="$(git merge-base HEAD origin/release/shop-v0.6.8)"
else
  echo "prepush: set PREPUSH_BASE to the merge base" >&2
  exit 1
fi

changed=()
while IFS= read -r line; do
  [ -n "$line" ] && changed+=("$line")
done < <(git diff --name-only --diff-filter=ACMR "$base" HEAD)

prettier_files=()
eslint_files=()
unit_files=()
if [ "${#changed[@]}" -gt 0 ]; then
  for file in "${changed[@]}"; do
    [ -f "$file" ] || continue
    case "$file" in
      *.ts|*.tsx|*.js|*.jsx|*.json|*.css|*.md) prettier_files+=("$file") ;;
    esac
    case "$file" in
      *.ts|*.tsx|*.js|*.jsx)
        eslint_files+=("$file")
        unit_files+=("$file")
        ;;
    esac
  done
fi

if [ "${#prettier_files[@]}" -gt 0 ]; then
  echo "prepush: prettier (${#prettier_files[@]} files)"
  npx prettier --check --ignore-path .prettierignore "${prettier_files[@]}"
fi

if [ "${#eslint_files[@]}" -gt 0 ]; then
  echo "prepush: eslint (${#eslint_files[@]} files)"
  npx eslint "${eslint_files[@]}"
fi

echo "prepush: typecheck"
run_heavy node npm run typecheck

if [ "${#unit_files[@]}" -gt 0 ]; then
  echo "prepush: vitest related (${#unit_files[@]} files)"
  related_log="$(mktemp)"
  set +e
  run_heavy node npx vitest related --run --project unit "${unit_files[@]}" >"$related_log" 2>&1
  related_status=$?
  set -e
  cat "$related_log"
  if [ "$related_status" -ne 0 ]; then
    if grep -q 'No test files found' "$related_log"; then
      echo "prepush: no related unit tests"
    else
      rm -f "$related_log"
      exit "$related_status"
    fi
  fi
  rm -f "$related_log"
fi

if [ "$PREPUSH_MODE" = full ]; then
  vrt_specs=()
  if [ "${#changed[@]}" -gt 0 ]; then
    while IFS= read -r line; do
      [ -n "$line" ] && vrt_specs+=("$line")
    done < <(node scripts/vrt-related.mjs "${changed[@]}")
  fi

  # Linux baselines from the pinned container are the only VRT gate.
  # *-darwin.png files are not compared and are not regenerated.
  if [ "${#vrt_specs[@]}" -gt 0 ]; then
    echo "prepush: linux vrt (${#vrt_specs[@]} specs)"
    printf '  %s\n' "${vrt_specs[@]}"
    bash scripts/vrt-linux.sh "${vrt_specs[@]}"
  else
    echo "prepush: linux vrt (no specs render a changed file)"
  fi
else
  echo "prepush: linux vrt skipped in fast mode (PREPUSH_FULL=1 runs it; CI runs it on the PR)"
fi

prepush_stamp "$sha"
seconds="$(( $(date +%s) - start ))"
echo "PREPUSH OK ${sha} ${seconds} ${PREPUSH_MODE}"
