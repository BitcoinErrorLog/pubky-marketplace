#!/usr/bin/env bash
# Fair slots for pre-push work that used to share one heavy.lock.
#
# lockf without -k removes the lock file on exit, so waiters are not ordered.
# Each class has its own ticket queue. A process may run only when fewer than
# SLOTS older live tickets exist, then it holds one slot with lockf -k.
# Each scan drops a ticket whose PID is dead, a zombie, or reused.
# EXIT, INT, and TERM remove the current ticket immediately. SIGKILL cannot
# be caught; the next scan expires that ticket so it cannot block the queue.
#
#   vrt    1 slot   Playwright in Docker. Browsers and /dev/shm are what
#                   exhaust the Docker VM, so this stays exclusive.
#   cargo  2 slots  Rust clippy and tests, plus their Postgres or Neo4j.
#                   Those containers are small next to a 16GB Docker VM, and
#                   the compilers run on the host.
#   node   1 slot   Host typecheck and vitest. Separate from cargo and vrt,
#                   so a Shop typecheck does not wait behind either.
#
# Classes do not exclude each other. A VRT run and two cargo runs can overlap.
#
# vrt and cargo refuse to take a slot when a volume in HEAVY_DISK_VOLUMES has
# less than HEAVY_DISK_FLOOR_GIB free. VRT and Rust builds are what filled
# /Volumes/vibedrive to 100% and failed with ENOSPC. A volume that is not
# mounted is skipped. node is not checked.
#
# HEAVY_LOCK_DIR overrides the directory (tests). The default is the shared
# lock directory. This does not take heavy.lock; in-flight worktrees that
# still lock that file keep their old behavior until they update.

HEAVY_LOCK_DIR="${HEAVY_LOCK_DIR:-/Volumes/t7/vibes-dev/.locks}"
HEAVY_DISK_FLOOR_GIB="${HEAVY_DISK_FLOOR_GIB:-25}"
HEAVY_DISK_VOLUMES="${HEAVY_DISK_VOLUMES:-/Volumes/vibedrive /Volumes/t7}"

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  echo "source scripts/heavy-lock.sh" >&2
  exit 1
fi

heavy_slots() {
  case "$1" in
    vrt) echo 1 ;;
    cargo) echo 2 ;;
    node) echo 1 ;;
    *)
      echo "heavy-lock: unknown class: $1" >&2
      return 1
      ;;
  esac
}

# 0 when every mounted volume has at least the floor free. Otherwise prints
# the refusal and returns 1.
heavy_disk_ok() {
  local class="$1" vol free_kib free_gib status=0
  case "$class" in
    vrt|cargo) ;;
    *) return 0 ;;
  esac
  for vol in $HEAVY_DISK_VOLUMES; do
    [ -d "$vol" ] || continue
    free_kib=$(df -Pk "$vol" 2>/dev/null | awk 'NR == 2 { print $4 }')
    [[ "$free_kib" =~ ^[0-9]+$ ]] || continue
    free_gib=$((free_kib / 1048576))
    if [ "$free_gib" -lt "$HEAVY_DISK_FLOOR_GIB" ]; then
      echo "heavy-lock: refusing class=${class}: ${vol} has ${free_gib} GiB free, floor is ${HEAVY_DISK_FLOOR_GIB} GiB" >&2
      status=1
    fi
  done
  if [ "$status" -ne 0 ]; then
    echo "heavy-lock: free space first: stale worktree target dirs under /Volumes/t7/vibes-dev/.cargo-target, unused docker volumes (docker volume ls), and old VRT attachments; see the fleet-resource-hygiene skill" >&2
  fi
  return "$status"
}

etime_to_seconds() {
  local t="$1" days=0 n a b c
  t="${t#-}"
  if [[ "$t" == *-* ]]; then
    days="${t%%-*}"
    t="${t#*-}"
  fi
  n=$(printf '%s\n' "$t" | awk -F: '{print NF}')
  IFS=: read -r a b c <<< "$t"
  a=$((10#${a:-0}))
  b=$((10#${b:-0}))
  c=$((10#${c:-0}))
  days=$((10#${days:-0}))
  if [ "$n" -le 1 ]; then
    echo "$a"
  elif [ "$n" -eq 2 ]; then
    echo $((days * 86400 + a * 60 + b))
  else
    echo $((days * 86400 + a * 3600 + b * 60 + c))
  fi
}

heavy_release() {
  local ticket="${HEAVY_TICKET:-}"
  HEAVY_TICKET=""
  if [ -n "$ticket" ]; then
    rm -f "$ticket"
  fi
}

# Installed only while this shell owns a ticket. Previous handlers are put
# back when the command returns. A signal re-raises itself so the exit status
# stays the signal.
heavy_finish_exit() {
  local status=$?
  heavy_release
  trap - EXIT
  if [ -n "${HEAVY_SAVED_EXIT:-}" ]; then
    eval "$HEAVY_SAVED_EXIT"
  fi
  exit "$status"
}

heavy_finish_signal() {
  local sig="$1" child self
  self="${HEAVY_SELF:-$$}"
  heavy_release
  for child in $(pgrep -P "$self" 2>/dev/null || true); do
    kill -s "$sig" "$child" 2>/dev/null || true
  done
  trap - EXIT INT TERM
  kill -s "$sig" "$self"
}

heavy_arm_traps() {
  HEAVY_SAVED_EXIT=$(trap -p EXIT || true)
  HEAVY_SAVED_INT=$(trap -p INT || true)
  HEAVY_SAVED_TERM=$(trap -p TERM || true)
  trap 'heavy_finish_exit' EXIT
  trap 'heavy_finish_signal INT' INT
  trap 'heavy_finish_signal TERM' TERM
}

heavy_disarm_traps() {
  trap - EXIT INT TERM
  if [ -n "${HEAVY_SAVED_EXIT:-}" ]; then
    eval "$HEAVY_SAVED_EXIT"
  fi
  if [ -n "${HEAVY_SAVED_INT:-}" ]; then
    eval "$HEAVY_SAVED_INT"
  fi
  if [ -n "${HEAVY_SAVED_TERM:-}" ]; then
    eval "$HEAVY_SAVED_TERM"
  fi
  HEAVY_SAVED_EXIT=""
  HEAVY_SAVED_INT=""
  HEAVY_SAVED_TERM=""
}

heavy_issue() {
  local class="$1"
  local self_pid="$2"
  local qdir="$HEAVY_LOCK_DIR/${class}.q"
  local seqfile="$HEAVY_LOCK_DIR/${class}.seq"
  local issue="$HEAVY_LOCK_DIR/${class}.issue.lock"
  mkdir -p "$qdir"
  lockf -k "$issue" bash -c '
    set -euo pipefail
    seqfile="$1"
    qdir="$2"
    pid="$3"
    n=0
    if [ -f "$seqfile" ]; then
      n=$(tr -cd "0-9" < "$seqfile" || true)
    fi
    [ -n "$n" ] || n=0
    n=$((n + 1))
    tmp=$(mktemp "${seqfile}.XXXXXX")
    printf "%s\n" "$n" > "$tmp"
    mv "$tmp" "$seqfile"
    name=$(printf "%020d" "$n")
    printf "%s %s\n" "$pid" "$(date +%s)" > "$qdir/${name}.ticket"
    printf "%s\n" "$n"
  ' _ "$seqfile" "$qdir" "$self_pid"
}

# 0 when the ticket must be removed: empty PID, dead PID, zombie, or a reused
# PID whose process started after the ticket was written.
heavy_pid_dead() {
  local pid="$1" epoch="$2" state etime es now age
  if [ -z "$pid" ]; then
    return 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  state=$(ps -o stat= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)
  case "$state" in
    Z*) return 0 ;;
  esac
  if [ -z "$epoch" ]; then
    return 1
  fi
  etime=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)
  if [ -z "$etime" ]; then
    return 1
  fi
  es=$(etime_to_seconds "$etime")
  now=$(date +%s)
  age=$((now - epoch))
  if [ "$age" -gt 3 ] && [ "$es" -lt $((age - 3)) ]; then
    return 0
  fi
  return 1
}

heavy_sweep() {
  local class="$1"
  local dir="$HEAVY_LOCK_DIR/${class}.q"
  local f pid epoch
  [ -d "$dir" ] || return 0
  for f in "$dir"/*.ticket; do
    [ -e "$f" ] || continue
    pid=""
    epoch=""
    read -r pid epoch < "$f" || true
    if heavy_pid_dead "$pid" "$epoch"; then
      rm -f "$f"
    fi
  done
}

heavy_ahead() {
  local class="$1" myseq="$2"
  local dir="$HEAVY_LOCK_DIR/${class}.q"
  local ahead=0 f base seq
  heavy_sweep "$class"
  for f in "$dir"/*.ticket; do
    [ -e "$f" ] || continue
    base=$(basename "$f")
    seq=$((10#${base%.ticket}))
    if [ "$seq" -lt "$myseq" ]; then
      ahead=$((ahead + 1))
    fi
  done
  echo "$ahead"
}

# Run the command inside one slot. Returns 75 when every try lost the race
# and the command did not start. Otherwise returns the command status.
heavy_run_in_slot() {
  local slotfile="$1"
  local marker hold_msg slot_status=0
  shift
  hold_msg="$1"
  shift
  marker=$(mktemp "${HEAVY_LOCK_DIR}/ran.XXXXXX")
  : > "$marker"
  # `||` keeps a non-zero status under set -e. A bare assignment from $? after
  # `if` is wrong on bash 3.2: a failed if with no else reports status 0.
  lockf -k -s -t 0 "$slotfile" bash -c '
    printf 1 > "$1"
    shift
    printf "%s\n" "$1" >&2
    shift
    "$@"
  ' _ "$marker" "$hold_msg" "$@" || slot_status=$?
  if [ ! -s "$marker" ]; then
    rm -f "$marker"
    return 75
  fi
  rm -f "$marker"
  return "$slot_status"
}

run_heavy() {
  local class="$1"
  shift
  local slots seq ahead last i st
  local self_pid pidfile
  slots=$(heavy_slots "$class") || return 1
  heavy_disk_ok "$class" || return 1
  mkdir -p "$HEAVY_LOCK_DIR"
  # heavy_issue runs inside a command substitution, and that subshell exits
  # as soon as the ticket number is printed. Record this shell, not that
  # subshell. $$ is the outermost shell even inside a background job, and
  # bash 3.2 has no BASHPID, so a direct child reports this process.
  pidfile="$(mktemp "${HEAVY_LOCK_DIR}/self.XXXXXX")"
  sh -c 'echo $PPID' > "$pidfile"
  self_pid="$(tr -cd '0-9' < "$pidfile")"
  rm -f "$pidfile"
  if [ -z "$self_pid" ]; then
    echo "heavy-lock: could not read own pid" >&2
    return 1
  fi
  HEAVY_SELF=$self_pid
  seq=$(heavy_issue "$class" "$self_pid")
  if ! [[ "$seq" =~ ^[0-9]+$ ]]; then
    echo "heavy-lock: could not take a ${class} ticket" >&2
    return 1
  fi
  HEAVY_TICKET="$HEAVY_LOCK_DIR/${class}.q/$(printf '%020d' "$seq").ticket"
  heavy_arm_traps
  last=""
  while true; do
    ahead=$(heavy_ahead "$class" "$seq")
    if [ "$ahead" -lt "$slots" ]; then
      break
    fi
    if [ "$ahead" != "$last" ]; then
      echo "heavy-lock: waiting class=${class} ticket=${seq} ahead=${ahead} slots=${slots}" >&2
      last=$ahead
    fi
    sleep 0.25
  done
  # The wait can be long; recheck just before the slot is taken.
  if ! heavy_disk_ok "$class"; then
    heavy_release
    heavy_disarm_traps
    return 1
  fi
  while true; do
    i=1
    while [ "$i" -le "$slots" ]; do
      st=0
      heavy_run_in_slot "$HEAVY_LOCK_DIR/${class}.${i}.lock" \
        "heavy-lock: hold class=${class} slot=${i} ticket=${seq}" \
        "$@" || st=$?
      if [ "$st" -eq 0 ]; then
        heavy_release
        heavy_disarm_traps
        return 0
      fi
      if [ "$st" -ne 75 ]; then
        heavy_release
        heavy_disarm_traps
        return "$st"
      fi
      i=$((i + 1))
    done
    sleep 0.2
  done
}
