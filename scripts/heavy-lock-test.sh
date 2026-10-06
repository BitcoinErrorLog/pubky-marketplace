#!/usr/bin/env bash
# Proves queue tickets disappear on INT/TERM, and a dead PID cannot block
# the next waiter. Run on the Mac that has lockf. Not part of Linux CI.
set -euo pipefail
# Background jobs ignore SIGINT unless job control is on. The real gate is
# foreground and does receive Ctrl-C. Monitor mode gives each job its own
# process group so the signals under test are delivered.
set -m

DIR="$(cd "$(dirname "$0")" && pwd)"
export HEAVY_LOCK_DIR
HEAVY_LOCK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/heavy-lock-test.XXXXXX")"
# shellcheck source=heavy-lock.sh
source "$DIR/heavy-lock.sh"

pids=""
track() { pids="$pids $1"; }

cleanup() {
  local p
  for p in $pids; do
    kill -9 "$p" 2>/dev/null || true
  done
  wait 2>/dev/null || true
  rm -rf "$HEAVY_LOCK_DIR"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

process_gone() {
  local pid="$1" state
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi
  state=$(ps -o stat= -p "$pid" 2>/dev/null | tr -d '[:space:]' || true)
  case "$state" in
    Z*) return 0 ;;
  esac
  return 1
}

ticket_for() {
  local pid="$1" f pid2 epoch
  for f in "$HEAVY_LOCK_DIR"/vrt.q/*.ticket; do
    [ -e "$f" ] || continue
    pid2=""
    epoch=""
    read -r pid2 epoch < "$f" || true
    if [ "$pid2" = "$pid" ]; then
      printf '%s\n' "$f"
      return 0
    fi
  done
  return 1
}

wait_for() {
  local file="$1" needle="$2" i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25; do
    if [ -f "$file" ] && grep -q "$needle" "$file"; then
      return 0
    fi
    sleep 0.2
  done
  return 1
}

echo "test: command status is preserved"
set +e
run_heavy node bash -c 'exit 3'
st=$?
set -e
[ "$st" = 3 ] || fail "exit status $st"

echo "test: previous EXIT trap is restored"
restored="$(
  HEAVY_LOCK_DIR="$HEAVY_LOCK_DIR" bash -c '
    source "$1"
    trap "echo ORIGINAL" EXIT
    run_heavy node true
    trap -p EXIT
  ' _ "$DIR/heavy-lock.sh"
)"
printf '%s\n' "$restored" | grep -q ORIGINAL || fail "EXIT trap was not restored: $restored"

# One VRT slot. The holder occupies it. Two waiters queue. Killing the first
# must drop its ticket, and the second must run once the holder finishes.
interrupt_and_proceed() {
  local sig="$1" label="$2"
  local logdir holder w1 w2 t1 deadline
  rm -rf "$HEAVY_LOCK_DIR"
  mkdir -p "$HEAVY_LOCK_DIR"
  logdir="$HEAVY_LOCK_DIR/logs"
  mkdir -p "$logdir"

  run_heavy vrt bash -c 'printf hold > "$1"; sleep 6' _ "$logdir/holder" \
    >"$logdir/holder.out" 2>"$logdir/holder.err" &
  holder=$!
  track "$holder"
  wait_for "$logdir/holder" hold || fail "$label: holder did not start"

  run_heavy vrt bash -c 'printf ran > "$1"' _ "$logdir/w1" \
    >"$logdir/w1.out" 2>"$logdir/w1.err" &
  w1=$!
  track "$w1"
  run_heavy vrt bash -c 'printf ran > "$1"' _ "$logdir/w2" \
    >"$logdir/w2.out" 2>"$logdir/w2.err" &
  w2=$!
  track "$w2"
  wait_for "$logdir/w1.err" waiting || fail "$label: w1 did not wait"
  wait_for "$logdir/w2.err" waiting || fail "$label: w2 did not wait"
  t1="$(ticket_for "$w1")" || fail "$label: w1 has no ticket"

  # Signal the job's process group, as Ctrl-C does for a foreground gate.
  kill -s "$sig" -- "-$w1" 2>/dev/null || kill -s "$sig" "$w1" || true
  deadline=$(( $(date +%s) + 3 ))
  while [ -e "$t1" ]; do
    [ "$(date +%s)" -gt "$deadline" ] && fail "$label: ticket remained after $sig"
    sleep 0.1
  done
  deadline=$(( $(date +%s) + 3 ))
  while ! process_gone "$w1"; do
    [ "$(date +%s)" -gt "$deadline" ] && fail "$label: waiter still alive after $sig"
    sleep 0.1
  done
  if [ -f "$logdir/w2" ]; then
    fail "$label: next gate ran while the slot was still held"
  fi

  deadline=$(( $(date +%s) + 12 ))
  while [ ! -f "$logdir/w2" ]; do
    [ "$(date +%s)" -gt "$deadline" ] && fail "$label: next gate did not proceed"
    sleep 0.2
  done
  wait "$holder" || fail "$label: holder failed"
  wait "$w2" || fail "$label: next gate failed"
  wait "$w1" 2>/dev/null || true
  echo "$label ok"
}

echo "test: SIGINT drops the waiting ticket and the next gate proceeds"
interrupt_and_proceed INT "SIGINT"

echo "test: SIGTERM drops the waiting ticket and the next gate proceeds"
interrupt_and_proceed TERM "SIGTERM"

echo "test: a SIGKILL ticket expires so the next gate proceeds"
rm -rf "$HEAVY_LOCK_DIR"
mkdir -p "$HEAVY_LOCK_DIR"
logdir="$HEAVY_LOCK_DIR/logs"
mkdir -p "$logdir"
run_heavy vrt bash -c 'printf hold > "$1"; sleep 6' _ "$logdir/holder" \
  >"$logdir/holder.out" 2>"$logdir/holder.err" &
holder=$!
track "$holder"
wait_for "$logdir/holder" hold || fail "SIGKILL: holder did not start"
run_heavy vrt bash -c 'printf ran > "$1"' _ "$logdir/killed" \
  >"$logdir/killed.out" 2>"$logdir/killed.err" &
killed=$!
track "$killed"
wait_for "$logdir/killed.err" waiting || fail "SIGKILL: waiter did not wait"
tleak="$(ticket_for "$killed")" || fail "SIGKILL: no ticket"
kill -9 "$killed" || true
sleep 0.3
[ -e "$tleak" ] || fail "SIGKILL: ticket vanished without a scanner or a trap"
run_heavy vrt bash -c 'printf ran > "$1"' _ "$logdir/next" \
  >"$logdir/next.out" 2>"$logdir/next.err" &
next=$!
track "$next"
deadline=$(( $(date +%s) + 3 ))
while [ -e "$tleak" ]; do
  [ "$(date +%s)" -gt "$deadline" ] && fail "SIGKILL: dead ticket was not expired"
  sleep 0.1
done
if [ -f "$logdir/holder" ] && [ -f "$logdir/next" ]; then
  # next must not finish before the holder releases; the file appears when it runs
  :
fi
deadline=$(( $(date +%s) + 12 ))
while [ ! -f "$logdir/next" ]; do
  [ "$(date +%s)" -gt "$deadline" ] && fail "SIGKILL: next gate did not proceed"
  sleep 0.2
done
wait "$holder" || fail "SIGKILL: holder failed"
wait "$next" || fail "SIGKILL: next gate failed"
wait "$killed" 2>/dev/null || true
echo "SIGKILL ok"

echo "test: vrt and cargo refuse below the disk floor"
rm -rf "$HEAVY_LOCK_DIR"
mkdir -p "$HEAVY_LOCK_DIR"
logdir="$HEAVY_LOCK_DIR/logs"
mkdir -p "$logdir"
for class in vrt cargo; do
  set +e
  HEAVY_DISK_VOLUMES="$HEAVY_LOCK_DIR" HEAVY_DISK_FLOOR_GIB=999999999 \
    run_heavy "$class" bash -c 'printf ran > "$1"' _ "$logdir/$class" \
    2>"$logdir/$class.err"
  st=$?
  set -e
  [ "$st" != 0 ] || fail "disk floor: $class ran below the floor"
  [ ! -e "$logdir/$class" ] || fail "disk floor: $class command started"
  grep -q "refusing class=${class}" "$logdir/$class.err" \
    || fail "disk floor: $class printed no refusal"
  ls "$HEAVY_LOCK_DIR/${class}.q"/*.ticket >/dev/null 2>&1 \
    && fail "disk floor: $class left a ticket"
done
echo "disk floor refusal ok"

echo "test: node ignores the disk floor; vrt runs above it; unmounted volumes are skipped"
HEAVY_DISK_VOLUMES="$HEAVY_LOCK_DIR" HEAVY_DISK_FLOOR_GIB=999999999 \
  run_heavy node bash -c 'printf ran > "$1"' _ "$logdir/node"
[ -f "$logdir/node" ] || fail "disk floor: node did not run"
HEAVY_DISK_VOLUMES="$HEAVY_LOCK_DIR /nonexistent-heavy-lock-volume" HEAVY_DISK_FLOOR_GIB=0 \
  run_heavy vrt bash -c 'printf ran > "$1"' _ "$logdir/vrt-ok"
[ -f "$logdir/vrt-ok" ] || fail "disk floor: vrt did not run above the floor"
echo "disk floor pass ok"

echo "test: the floor is rechecked after the queue wait"
late_vol="$HEAVY_LOCK_DIR/late-volume"
run_heavy vrt bash -c 'printf hold > "$1"; sleep 3' _ "$logdir/late-holder" \
  >"$logdir/late-holder.out" 2>"$logdir/late-holder.err" &
holder=$!
track "$holder"
wait_for "$logdir/late-holder" hold || fail "recheck: holder did not start"
HEAVY_DISK_VOLUMES="$late_vol" HEAVY_DISK_FLOOR_GIB=999999999 \
  run_heavy vrt bash -c 'printf ran > "$1"' _ "$logdir/late" \
  >"$logdir/late.out" 2>"$logdir/late.err" &
late=$!
track "$late"
wait_for "$logdir/late.err" waiting || fail "recheck: waiter did not queue"
mkdir -p "$late_vol"
set +e
wait "$late"
st=$?
set -e
[ "$st" != 0 ] || fail "recheck: waiter ran below the floor"
[ ! -e "$logdir/late" ] || fail "recheck: waiter command started"
grep -q 'refusing class=vrt' "$logdir/late.err" || fail "recheck: no refusal"
wait "$holder" || fail "recheck: holder failed"
ls "$HEAVY_LOCK_DIR/vrt.q"/*.ticket >/dev/null 2>&1 && fail "recheck: ticket left behind"
echo "disk floor recheck ok"

echo "ALL OK"
