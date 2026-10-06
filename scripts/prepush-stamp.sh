#!/usr/bin/env bash
# Reuse of a passing pre-push gate, keyed by HEAD's tree and the gate mode.
#
# The gate has two modes. fast is the default. PREPUSH_FULL=1 runs full,
# which is what releases use. Each mode stamps separately, in the clone's
# git common dir, so every worktree of this clone shares the stamps:
#   full  <git-common-dir>/prepush-ok/<tree>
#   fast  <git-common-dir>/prepush-ok/fast/<tree>
# The full path is the one gates wrote before modes existed, so an older
# stamp counts as full. A fast run reuses a fast or a full stamp, because
# full checks everything fast does. A full run reuses only a full stamp.
#
# A later run on the same tree with no changes prints the PREPUSH OK line and
# skips the gate, so the push hook does not repeat a gate the lane already
# ran. A rebase that keeps the tree reuses the pass; one that changes content
# does not.
#
# PREPUSH_FORCE=1 always runs the gate. "No changes" means git status
# --porcelain is empty: no tracked change and no untracked file that is not
# ignored. A gate that started or ended with a change, or whose HEAD tree
# moved, checked files that are not the tree, so it writes no stamp.

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo "source scripts/prepush-stamp.sh" >&2
  exit 1
fi

# Sets PREPUSH_MODE from PREPUSH_FULL. Any value other than unset, empty,
# 0 or 1 is refused, so a typo cannot quietly run the fast gate.
prepush_mode_init() {
  case "${PREPUSH_FULL:-}" in
    1) PREPUSH_MODE=full ;;
    ""|0) PREPUSH_MODE=fast ;;
    *)
      echo "prepush: PREPUSH_FULL must be 1, 0 or unset (got '${PREPUSH_FULL}')" >&2
      return 1
      ;;
  esac
}

prepush_stamp_dir() {
  local common
  common="$(git rev-parse --git-common-dir)"
  printf '%s/prepush-ok\n' "$(cd "$common" && pwd)"
}

# Stamp file for a mode and tree.
prepush_stamp_path() {
  local mode="$1" tree="$2" dir
  dir="$(prepush_stamp_dir)"
  if [ "$mode" = full ]; then
    printf '%s/%s\n' "$dir" "$tree"
  else
    printf '%s/fast/%s\n' "$dir" "$tree"
  fi
}

prepush_tree_clean() {
  [ -z "$(git status --porcelain --untracked-files=normal)" ]
}

# Returns 0 and prints the PREPUSH OK line when this tree already passed in
# this mode or a stronger one. Call prepush_mode_init first.
prepush_reuse() {
  local sha="$1" stamp candidate
  : "${PREPUSH_MODE:?call prepush_mode_init before prepush_reuse}"
  PREPUSH_TREE="$(git rev-parse 'HEAD^{tree}')"
  PREPUSH_CLEAN_START=0
  if prepush_tree_clean; then
    PREPUSH_CLEAN_START=1
  fi
  if [ -n "${PREPUSH_FORCE:-}" ] || [ "$PREPUSH_CLEAN_START" != 1 ]; then
    return 1
  fi
  if [ "$PREPUSH_MODE" = full ]; then
    set -- full
  else
    set -- fast full
  fi
  for candidate in "$@"; do
    stamp="$(prepush_stamp_path "$candidate" "$PREPUSH_TREE")"
    if [ -f "$stamp" ]; then
      echo "PREPUSH OK ${sha} 0 ${PREPUSH_MODE} reused:${candidate} $(cat "$stamp")"
      return 0
    fi
  done
  return 1
}

# Call only after every step of the gate passed.
prepush_stamp() {
  local sha="$1" stamp tmp
  if [ "${PREPUSH_CLEAN_START:-0}" != 1 ] || ! prepush_tree_clean \
    || [ "$(git rev-parse 'HEAD^{tree}')" != "${PREPUSH_TREE:-}" ]; then
    echo "prepush: uncommitted or untracked changes, or a moved HEAD; no reuse stamp written"
    return 0
  fi
  stamp="$(prepush_stamp_path "${PREPUSH_MODE:?call prepush_mode_init first}" "$PREPUSH_TREE")"
  mkdir -p "$(dirname "$stamp")"
  tmp="$(mktemp "$(dirname "$stamp")/.stamp.XXXXXX")"
  printf '%s %s\n' "$sha" "$(date -u +%FT%TZ)" > "$tmp"
  mv "$tmp" "$stamp"
}
