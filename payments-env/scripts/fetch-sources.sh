#!/usr/bin/env bash
# Fetches every pinned source tree this environment builds from.
# Idempotent: existing checkouts are verified against the pinned revisions.
set -euo pipefail
cd "$(dirname "$0")/.."

# Pinned revisions (see README.md for provenance):
LOCKS_RUNTIME_REV=ba49a777a94db318ec6ebd427315080a5b904645   # pubky/locks, runtime stack
LOCKS_DEP_REV=df5ea1b6d8dcdec3a9b5a915c3f57bca69d75c8a       # pubky/locks, paykit-server's locks-core dependency pin
PAYKIT_RS_REV=52a852995bfc457b78d32f5a45f6741766a89bba       # pubky/paykit-rs, paykit-server's dependency pin
PAYKIT_SERVER_REV=f38c7915e6b9b104e040773e78438f8aa984c46c   # pubky/paykit-server, audited revision

fetch() {
  local url="$1" dir="$2" rev="$3"
  if [ ! -d "$dir/.git" ]; then
    git clone "$url" "$dir"
  fi
  git -C "$dir" fetch origin "$rev" 2>/dev/null || git -C "$dir" fetch origin
  git -C "$dir" checkout --detach "$rev"
  local head
  head="$(git -C "$dir" rev-parse HEAD)"
  if [ "$head" != "$rev" ]; then
    echo "ERROR: $dir is at $head, expected $rev" >&2
    exit 1
  fi
  echo "pinned: $dir @ $rev"
}

mkdir -p sources
fetch https://github.com/pubky/locks.git         sources/locks            "$LOCKS_RUNTIME_REV"
fetch https://github.com/pubky/locks.git         sources/locks-paykit-dep "$LOCKS_DEP_REV"
fetch https://github.com/pubky/paykit-rs.git     sources/paykit-rs        "$PAYKIT_RS_REV"
fetch https://github.com/pubky/paykit-server.git sources/paykit-server    "$PAYKIT_SERVER_REV"
