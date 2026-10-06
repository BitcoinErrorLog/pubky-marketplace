#!/usr/bin/env bash
# After vitest --update, restore every PNG that is not a *-linux.png under
# one of the named specs' __screenshots__ directories. A path argument does
# not isolate --update.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ "$#" -eq 0 ]; then
  echo "usage: scripts/vrt-revert-outside.sh <spec>..." >&2
  exit 1
fi

SPECS=("$@")

keep_linux() {
  local path="$1" spec dir
  case "$path" in
    *-linux.png) ;;
    *) return 1 ;;
  esac
  for spec in "${SPECS[@]}"; do
    dir="$(dirname "$spec")/__screenshots__/$(basename "$spec")/"
    case "$path" in
      "$dir"*) return 0 ;;
    esac
  done
  return 1
}

while IFS= read -r line; do
  [ -n "$line" ] || continue
  path="${line:3}"
  case "$path" in
    *" -> "*) path="${path##* -> }" ;;
  esac
  path="${path#\"}"
  path="${path%\"}"
  if keep_linux "$path"; then
    continue
  fi
  if git cat-file -e "HEAD:${path}" 2>/dev/null; then
    git checkout -- "$path"
  elif [ -f "$path" ]; then
    rm -f -- "$path"
  fi
done < <(git status --porcelain -uall -- ':(glob)**/*.png')
