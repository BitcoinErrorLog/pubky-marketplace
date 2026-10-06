#!/usr/bin/env bash
# Linux VRT in the pinned Playwright image CI uses.
# Usage: scripts/vrt-linux.sh [spec...]
# No arguments runs the full Linux suite. Missing *-linux.png baselines fail.
# VRT_LINUX_UPDATE=1 writes *-linux.png baselines (vitest --update). --update
# rewrites every scene in the named files, so follow it with
# scripts/vrt-revert-outside.sh <spec>... to drop PNGs outside the named set.
# This script does not read or write *-darwin.png.
#
# vrt-marketplace and vrt each run in their own container. One container
# running both leaves the second project with a closed browser: the first
# Vitest process hangs on close, and the next process in that container
# loses the browser before any test runs.
#
# Docker's default /dev/shm is 64MB. Firefox uses it, and a plain Chromium
# (not Playwright's headless shell) aborts in the font service with ENOSPC
# once enough desktop pages are open. Playwright's Chromium is launched
# with --disable-dev-shm-usage, so this size is not what closes the Vitest
# socket. The vrt project also runs one file at a time for that.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

IMAGE="${VRT_LINUX_IMAGE:-mcr.microsoft.com/playwright:v1.60.0-noble}"
VOLUME="${VRT_LINUX_NM_VOLUME:-pubky-app-vrt-linux-nm}"

export COPYFILE_DISABLE=1

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for scripts/vrt-linux.sh" >&2
  exit 1
fi

# One Docker VRT at a time. The slot is held for this whole script, including
# a direct invocation. Re-exec so the lock outlives the shell functions here.
if [ "${VRT_LOCK_HELD:-}" != 1 ]; then
  # shellcheck source=heavy-lock.sh
  source "$ROOT/scripts/heavy-lock.sh"
  export VRT_LOCK_HELD=1
  run_heavy vrt bash "$ROOT/scripts/vrt-linux.sh" "$@"
  exit 0
fi

# The host tree has macOS binaries, so the container installs its own Linux
# dependencies into a volume, mounted at the host node_modules' real path.
# For a lane whose node_modules is a symlink into /Volumes/t7/vibes-dev/.deps,
# the symlink inside /w resolves to the volume. npm ci must not run in /w
# then: it deletes the symlink through the bind mount and writes a Linux tree
# into the worktree. It runs in the real path's parent instead, which exists
# only inside the container, with the lockfile copied in and vendor/ linked
# to /w/vendor for the file: dependencies. The worktree and the host tree
# are never modified. For a real directory the real path is /w/node_modules.
if [ ! -e "$ROOT/node_modules" ]; then
  echo "vrt-linux: node_modules is missing; rebuild this lane's node_modules (release skill §1)" >&2
  exit 1
fi
NM_REAL="$(cd "$ROOT/node_modules" && pwd -P)"
ROOT_REAL="$(pwd -P)"
if [ "$NM_REAL" = "$ROOT_REAL/node_modules" ]; then
  NM_MOUNT=/w/node_modules
  deps_setup=""
  deps_install="npm ci"
else
  NM_MOUNT="$NM_REAL"
  nm_parent="$(printf '%q' "$(dirname "$NM_REAL")")"
  deps_setup="ln -sfn /w/vendor ${nm_parent}/vendor && "
  deps_install="cp /w/package.json /w/package-lock.json ${nm_parent}/ && (cd ${nm_parent} && npm ci)"
fi
cleanup_attachments() {
  # Preserve a failing test status. Bash uses the EXIT trap's status as the
  # script status, so a successful cleanup must not turn a red suite green.
  local status=$?
  rm -rf "$ROOT/.vitest-attachments" || true
  return "$status"
}
trap cleanup_attachments EXIT

quote_list() {
  local out="" spec
  for spec in "$@"; do
    out+=" $(printf '%q' "$spec")"
  done
  printf '%s' "$out"
}

installed=0
run_project() {
  local project="$1"
  shift
  local browsers="${VRT_BROWSERS:-chromium,firefox}"
  local browser cmd
  local browser_list=()
  IFS=',' read -r -a browser_list <<< "$browsers"

  # Vite's browser dependency optimizer writes one shared cache. Starting
  # Chromium and Firefox projects together can race while replacing that
  # cache, leaving either browser with transiently missing generated files.
  # Run each configured browser in its own container, against the same
  # installed dependency volume.
  for browser in "${browser_list[@]}"; do
    cmd="$deps_setup"
    if [ "$installed" -eq 0 ]; then
      cmd+="${deps_install} && "
      installed=1
    fi
    cmd+="npx vitest run --project ${project}"
    if [ "$#" -gt 0 ]; then
      cmd+="$(quote_list "$@")"
    fi
    if [ "${VRT_LINUX_UPDATE:-}" = 1 ]; then
      cmd+=" --update"
    fi
    echo "vrt-linux: container ${project} (${browser})"
    docker run --rm \
      --shm-size="${VRT_LINUX_SHM_SIZE:-2g}" \
      -e COPYFILE_DISABLE=1 \
      -e VRT_BROWSERS="${browser}" \
      -e PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
      -e CI=true \
      -v "$ROOT":/w \
      -v "${VOLUME}:${NM_MOUNT}" \
      -w /w \
      "$IMAGE" \
      bash -lc "$cmd"
  done
}

if [ "$#" -eq 0 ]; then
  run_project vrt-marketplace
  run_project vrt
else
  market=()
  other=()
  for spec in "$@"; do
    case "$spec" in
      src/test/vrt/marketplace/*) market+=("$spec") ;;
      *) other+=("$spec") ;;
    esac
  done
  if [ "${#market[@]}" -gt 0 ]; then
    run_project vrt-marketplace "${market[@]}"
  fi
  if [ "${#other[@]}" -gt 0 ]; then
    run_project vrt "${other[@]}"
  fi
fi
