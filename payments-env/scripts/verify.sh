#!/usr/bin/env bash
# End-to-end verification of the real Locks + Paykit payment path on regtest.
#
# Drives, with no stubs and no manual completion:
#   1.  creator legacy-connect authority + frontend session (Locks)
#   2.  creator Paykit setup: companion claim with a real regtest BIP84 account
#       tpub held by bitcoind (paykit-companion-auth plays Bitkit's approval role)
#   3.  reader identity signup + Paykit receiver marker (paykit-reader-demo
#       plays Bitkit's protocol role)
#   4.  guarded content upload + paykit-payment content lock (Locks creator routes)
#   5.  trust boundary: unsigned/garbage-signed Paykit business calls refused
#   6.  proof-bundle submission -> Lock Server requests a real invoice from
#       Paykit Server (no 422 paykit_not_configured)
#   7.  Paykit reports undetected; reader receives the private Payment Request
#       carrying the unique BIP84 address; address independently re-derived
#       from the tpub via bitcoind
#   8.  payment from the regtest node -> detected -> mined -> confirmed
#   9.  Locks verification lifecycle completes; access credential issued;
#       guarded read returns the exact uploaded bytes
#   10. five more blocks -> confirmations capped at 6 (finality)
#
# Requires: docker compose stack up (scripts/up.sh), curl, jq, python3.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

LOCKS_URL="http://localhost:${LOCKS_SERVER_PORT:-3000}"
PAYKIT_URL="http://localhost:${PAYKIT_SERVER_PORT:-3001}"
AMOUNT_SATS="${VERIFY_AMOUNT_SATS:-15000}"
OUT_DIR=".verify-out/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT_DIR"

DC="docker compose"
BCLI="$DC exec -T bitcoind bitcoin-cli -regtest -rpcuser=paykitregtest -rpcpassword=paykitregtestpass"

step() { printf '\n=== %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
fail() { printf '\nFAIL: %s\n' "$*" >&2; exit 1; }

http_post_json() {
  # $1 path (locks), $2 body; prints "STATUS\nBODY"
  local status body_file
  body_file="$(mktemp)"
  status="$(curl -sS -o "$body_file" -w '%{http_code}' -H 'content-type: application/json' \
    -X POST --data "$2" "$LOCKS_URL$1")"
  printf '%s\n' "$status"
  cat "$body_file"
  rm -f "$body_file"
}

wait_for() {
  # $1 timeout-seconds, $2 description, rest: command that must succeed
  local deadline=$(( $(date +%s) + $1 )) desc="$2"
  shift 2
  until "$@" >/dev/null 2>&1; do
    [ "$(date +%s)" -gt "$deadline" ] && fail "timed out waiting for: $desc"
    sleep 2
  done
}

# --- 0. stack readiness -----------------------------------------------------
step "0. stack readiness"
curl -fsS "$LOCKS_URL/readyz" | tee "$OUT_DIR/locks-readyz.json" | jq -e '.status == "ready"' >/dev/null \
  || fail "Lock Server not ready"
paykit_ready="$(curl -s -o "$OUT_DIR/paykit-ready.json" -w '%{http_code}' "$PAYKIT_URL/health/ready")"
[ "$paykit_ready" = "200" ] || fail "Paykit Server /health/ready returned $paykit_ready: $(cat "$OUT_DIR/paykit-ready.json")"
note "locks /readyz ready; paykit /health/ready 200: $(cat "$OUT_DIR/paykit-ready.json")"

# --- 1. bitcoin regtest funding ----------------------------------------------
step "1. bitcoin regtest miner wallet + mature coins"
$BCLI createwallet miner >/dev/null 2>&1 || $BCLI loadwallet miner >/dev/null 2>&1 || true
MINER_ADDR="$($BCLI -rpcwallet=miner getnewaddress | tr -d '\r\n')"
HEIGHT="$($BCLI getblockcount | tr -d '\r\n')"
if [ "$HEIGHT" -lt 101 ]; then
  $BCLI -rpcwallet=miner generatetoaddress "$((101 - HEIGHT))" "$MINER_ADDR" >/dev/null
fi
note "height=$($BCLI getblockcount | tr -d '\r\n') miner balance=$($BCLI -rpcwallet=miner getbalance | tr -d '\r\n')"

# --- 2. creator BIP84 account tpub from bitcoind ------------------------------
step "2. creator BIP84 account tpub (keys held by bitcoind wallet paykit_creator)"
$BCLI createwallet paykit_creator >/dev/null 2>&1 || $BCLI loadwallet paykit_creator >/dev/null 2>&1 || true
TPUB="$($BCLI -rpcwallet=paykit_creator listdescriptors \
  | jq -r '.descriptors[] | select(.internal == false) | select(.desc | test("^wpkh\\(")) | select(.desc | test("/84.?/1.?/0.?\\]")) | .desc' \
  | sed -E 's/.*\]([a-zA-Z0-9]+)\/.*/\1/' | head -1)"
case "$TPUB" in tpub*) ;; *) fail "could not extract BIP84 account tpub from bitcoind (got: '$TPUB')";; esac
ACCOUNT_INDEX=0
note "tpub=$TPUB account_index=$ACCOUNT_INDEX"

# --- 3. creator identity -------------------------------------------------------
step "3. creator Pubky identity (js-sdk demo user)"
wait_for 180 "creator-demo to create the content-creator identity" \
  $DC exec -T creator-demo test -f /workspace/.local/content-creator/profile.json
CREATOR_ID_JSON="$($DC exec -T creator-demo node /overlay-js/creator-secret.mjs)"
CREATOR_SECRET="$(jq -r '.secret' <<<"$CREATOR_ID_JSON")"
note "creator identity loaded (raw pubky $(jq -r '.pubky' <<<"$CREATOR_ID_JSON"))"

# --- 4. Locks legacy-connect -> frontend session --------------------------------
step "4. Locks legacy-connect creator authority + frontend session"
STATE="verify-$(date +%s)-$$"
CONNECT_HTML="$OUT_DIR/connect-shell.html"
curl -fsS "$LOCKS_URL/connect?return_to=http%3A%2F%2Flocalhost%3A8080%2Fdev-auth-complete&state=$STATE" -o "$CONNECT_HTML"
read -r CONNECT_FLOW CONNECT_AUTH_URL < <(python3 - "$CONNECT_HTML" <<'PY'
import html, re, sys
body = open(sys.argv[1], encoding='utf-8').read()
flow = re.search(r'action="/connect/([^"/]+)/complete"', body)
auth = re.search(r'href="([^"]+)"', body)
if not flow or not auth:
    raise SystemExit('connect shell missing flow action or auth href')
print(flow.group(1), html.unescape(auth.group(1)))
PY
)
note "connect flow $CONNECT_FLOW"
$DC exec -T creator-demo npm --prefix examples/js-sdk run --silent authenticate -- --role content-creator --auth "$CONNECT_AUTH_URL" >"$OUT_DIR/authenticate.json"
note "creator approved legacy-connect auth: $(jq -c 'del(.pubky)' "$OUT_DIR/authenticate.json" 2>/dev/null || cat "$OUT_DIR/authenticate.json")"

COMPLETE_HEADERS="$OUT_DIR/connect-complete-headers.txt"
COMPLETE_STATUS="$(curl -sS -D "$COMPLETE_HEADERS" -o "$OUT_DIR/connect-complete-body.txt" -w '%{http_code}' -X POST "$LOCKS_URL/connect/$CONNECT_FLOW/complete")"
[ "$COMPLETE_STATUS" = "303" ] || fail "connect completion returned HTTP $COMPLETE_STATUS"
LOCATION="$(awk 'tolower($1)=="location:" {sub(/^[^ ]+[ ]*/, ""); sub(/\r$/, ""); print; exit}' "$COMPLETE_HEADERS")"
CODE="$(python3 -c "from urllib.parse import urlparse, parse_qs; import sys; print(parse_qs(urlparse(sys.argv[1]).query).get('code',[''])[0])" "$LOCATION")"
SESSION_JSON="$(http_post_json /frontend-sessions "$(jq -nc --arg code "$CODE" --arg state "$STATE" '{code: $code, state: $state}')" | tail -n +2)"
SESSION_TOKEN="$(jq -r '.session_token' <<<"$SESSION_JSON")"
CREATOR="$(jq -r '.creator' <<<"$SESSION_JSON")"
[ -n "$SESSION_TOKEN" ] && [ "$SESSION_TOKEN" != "null" ] || fail "no frontend session token: $SESSION_JSON"
note "creator=$CREATOR (frontend session acquired)"

# --- 5. Paykit Server creator setup (companion claim) ---------------------------
step "5. Paykit Server setup: watch-only companion claim (Bitkit approval role)"
SETUP_HTML="$OUT_DIR/paykit-setup.html"
curl -fsS "$PAYKIT_URL/setup?return_to=http%3A%2F%2Flocalhost%3A8080&state=$STATE" -o "$SETUP_HTML"
read -r SETUP_FLOW SETUP_AUTH_URL < <(python3 - "$SETUP_HTML" <<'PY'
import html, json, re, sys
body = open(sys.argv[1], encoding='utf-8').read()
flow = re.search(r'const flowId=("(?:[^"\\]|\\.)*");', body)
auth = re.search(r'<code>([^<]+)</code>', body)
if not flow or not auth:
    raise SystemExit('setup shell missing flowId or auth url')
print(json.loads(flow.group(1)), html.unescape(auth.group(1)))
PY
)
note "setup flow $SETUP_FLOW"
CLAIM_JSON="$(jq -nc --arg auth "$SETUP_AUTH_URL" --arg secret "$CREATOR_SECRET" --arg xpub "$TPUB" \
  '{version: 1, auth_url: $auth, creator_secret: $secret, account_xpub: $xpub, account_index: 0}')"
printf '%s' "$CLAIM_JSON" | $DC exec -T paykit-server paykit-companion-auth >"$OUT_DIR/companion-auth.json"
jq -e '.status == "approved"' "$OUT_DIR/companion-auth.json" >/dev/null || fail "companion auth failed: $(cat "$OUT_DIR/companion-auth.json")"
note "companion claim approved: $(cat "$OUT_DIR/companion-auth.json")"

SETUP_DEADLINE=$(( $(date +%s) + 120 ))
while :; do
  SETUP_POLL="$(curl -s -o "$OUT_DIR/setup-complete.json" -w '%{http_code}' -X POST "$PAYKIT_URL/setup/$SETUP_FLOW/complete")"
  [ "$SETUP_POLL" = "200" ] && break
  [ "$(date +%s)" -gt "$SETUP_DEADLINE" ] && fail "Paykit setup did not complete (last HTTP $SETUP_POLL: $(cat "$OUT_DIR/setup-complete.json"))"
  sleep 2
done
note "setup complete: $(cat "$OUT_DIR/setup-complete.json")"

# --- 6. reader identity + receiver marker ---------------------------------------
step "6. reader identity + Paykit receiver marker (Bitkit protocol role)"
# Fresh reader per run: an invoice is bound to its reader, so a fresh reader
# receives exactly one Payment Request. Reusing a reader would surface older
# (already paid) requests from previous runs.
$DC exec -T creator-demo rm -rf /workspace/.local/paykit-reader
$DC exec -T paykit-reader rm -f /reader-state/state.bin
READER_ID_JSON="$($DC exec -T creator-demo node /overlay-js/create-reader.mjs)"
READER_SECRET="$(jq -r '.secret' <<<"$READER_ID_JSON")"
PREPARE_OUT="$(printf '{"version":1,"operation":"prepare","reader_secret":"%s"}' "$READER_SECRET" \
  | $DC exec -e PAYKIT_READER_SERVER_PUBKY="$CREATOR" -T paykit-reader paykit-reader-demo)"
echo "$PREPARE_OUT" >"$OUT_DIR/reader-prepare.json"
READER_PUBKY="$(jq -r '.reader_pubky' <<<"$PREPARE_OUT")"
jq -e '.status == "prepared"' <<<"$PREPARE_OUT" >/dev/null || fail "reader prepare failed: $PREPARE_OUT"
note "reader=$READER_PUBKY (receiver marker published)"

# --- 7. creator publishes guarded content + paykit-payment lock -----------------
step "7. guarded content + paykit-payment content lock"
LOCK_SERVER_PUBKY="$($DC exec -T locks-server cat /paykit-shared/lock_server_public_key | tr -d '\r\n')"
CONFIG_RESULT="$(curl -sS -o "$OUT_DIR/lock-service-config.json" -w '%{http_code}' -H 'content-type: application/json' \
  -H "authorization: Bearer $SESSION_TOKEN" \
  -X POST --data "$(jq -nc --arg k "$LOCK_SERVER_PUBKY" '{default_lock_server: $k}')" \
  "$LOCKS_URL/creator/lock-service-config")"
[ "${CONFIG_RESULT:0:1}" = "2" ] || fail "lock-service-config returned HTTP $CONFIG_RESULT: $(cat "$OUT_DIR/lock-service-config.json")"

GUARDED_BODY="paid regtest bytes $STATE"
UPLOAD_RESULT="$(printf '%s' "$GUARDED_BODY" | curl -sS -o "$OUT_DIR/priv-upload.json" -w '%{http_code}' \
  -H "authorization: Bearer $SESSION_TOKEN" -H 'content-type: text/plain' \
  -X PUT --data-binary @- "$LOCKS_URL/creator/priv-resources/content/premium.txt")"
[ "${UPLOAD_RESULT:0:1}" = "2" ] || fail "guarded upload returned HTTP $UPLOAD_RESULT: $(cat "$OUT_DIR/priv-upload.json")"

LOCK_BODY="$(jq -c --arg creator "$CREATOR" --arg amount "$AMOUNT_SATS" --arg override "$LOCK_SERVER_PUBKY" \
  '{
     primary_resource: .guarded_resource,
     secondary_resources: {},
     criteria: [{
       criterion_id: "criterion-1",
       verifier_type: "paykit-payment",
       params: { recipient_pubky: $creator, amount: $amount, asset: "BTC" }
     }],
     lock_logic: { type: "all", criteria: ["criterion-1"] },
     access_policy: { requested_credential_ttl_seconds: 900 },
     lock_server: { override: $override }
   }' "$OUT_DIR/priv-upload.json")"
LOCK_RESULT="$(curl -sS -o "$OUT_DIR/content-lock.json" -w '%{http_code}' -H 'content-type: application/json' \
  -H "authorization: Bearer $SESSION_TOKEN" \
  -X POST --data "$LOCK_BODY" "$LOCKS_URL/creator/content-locks")"
[ "${LOCK_RESULT:0:1}" = "2" ] || fail "content-lock creation returned HTTP $LOCK_RESULT: $(cat "$OUT_DIR/content-lock.json")"
CONTENT_LOCK_PATH="$(jq -r '.content_lock_path' "$OUT_DIR/content-lock.json")"
LOCK_RESOURCE="${CREATOR}${CONTENT_LOCK_PATH}"
note "lock resource: $LOCK_RESOURCE (amount ${AMOUNT_SATS} sats BTC to $CREATOR)"

# --- 8. trust boundary: unsigned business calls refused --------------------------
step "8. trust boundary: Paykit business routes refuse unsigned calls"
BUNDLE_ID="$(python3 - <<'PY'
import os
alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
data = os.urandom(16)
bits = ''.join(f'{byte:08b}' for byte in data)
print(''.join(alphabet[int(bits[i:i+5].ljust(5, '0'), 2)] for i in range(0, len(bits), 5)))
PY
)"
INVOICE_BODY="$(jq -cnS --arg b "$BUNDLE_ID" --arg l "$LOCK_RESOURCE" --arg r "$READER_PUBKY" \
  '{bundle_id: $b, lock_resource: $l, reader: $r}')"
UNSIGNED_STATUS="$(curl -s -o "$OUT_DIR/unsigned-invoice.json" -w '%{http_code}' \
  -X POST --data "$INVOICE_BODY" "$PAYKIT_URL/invoices")"
[ "$UNSIGNED_STATUS" = "401" ] || fail "unsigned POST /invoices returned HTTP $UNSIGNED_STATUS (expected 401)"
GARBAGE_SIG_STATUS="$(curl -s -o "$OUT_DIR/garbage-sig-invoice.json" -w '%{http_code}' \
  -H "X-Paykit-Signature: $(head -c 64 /dev/zero | base64 | tr '+/' '-_' | tr -d '=\n')" \
  -X POST --data "$INVOICE_BODY" "$PAYKIT_URL/invoices")"
[ "$GARBAGE_SIG_STATUS" = "401" ] || fail "garbage-signed POST /invoices returned HTTP $GARBAGE_SIG_STATUS (expected 401)"
UNSIGNED_STATUS2="$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST --data "$(jq -cnS --arg b "$BUNDLE_ID" --arg c "$CREATOR" '{bundle_id: $b, creator: $c}')" \
  "$PAYKIT_URL/transactions/status")"
[ "$UNSIGNED_STATUS2" = "401" ] || fail "unsigned POST /transactions/status returned HTTP $UNSIGNED_STATUS2 (expected 401)"
note "unsigned /invoices -> 401 $(jq -c . "$OUT_DIR/unsigned-invoice.json" 2>/dev/null || true)"
note "garbage-signed /invoices -> 401; unsigned /transactions/status -> 401"

# --- 9. proof bundle -> real invoice ---------------------------------------------
step "9. viewer proof bundle -> Lock Server requests real Paykit invoice"
PROOF_BODY="$(jq -nc --arg b "$BUNDLE_ID" --arg l "$LOCK_RESOURCE" --arg r "$READER_PUBKY" \
  '{submitted_proof_bundle: {
      version: 1,
      bundle_id: $b,
      pubky_lock_resource: $l,
      reader_public_key: $r,
      proofs: [{criterion_id: "criterion-1", verifier_type: "paykit-payment", payload: {}}]
    }}')"
PROOF_STATUS="$(curl -sS -o "$OUT_DIR/proof-bundle.json" -w '%{http_code}' -H 'content-type: application/json' \
  -X POST --data "$PROOF_BODY" "$LOCKS_URL/proof-bundles")"
if [ "$PROOF_STATUS" != "200" ]; then
  jq . "$OUT_DIR/proof-bundle.json" 2>/dev/null || cat "$OUT_DIR/proof-bundle.json"
  fail "proof-bundle submission returned HTTP $PROOF_STATUS (a 422 paykit_not_configured here would mean the [paykit] wiring is broken; a 502 means invoice creation failed)"
fi
note "proof accepted, lifecycle: $(jq -c . "$OUT_DIR/proof-bundle.json")"

# --- 10. Paykit reports undetected (signed status, Lock Server key) ---------------
step "10. Paykit signed status: undetected before payment"
LOCKS_SEED="$($DC exec -T locks-server cat /var/lib/pubky-lock/.pubky-lock/secret.sess | tr -d '\r\n' | sed 's/^keypair-seed://')"
signed_status() {
  local body sig
  body="$(jq -cnS --arg b "$BUNDLE_ID" --arg c "$CREATOR" '{bundle_id: $b, creator: $c}')"
  sig="$(printf '%s' "$body" | $DC exec -T creator-demo node /overlay-js/sign-body.mjs "$LOCKS_SEED")"
  curl -sS -H "X-Paykit-Signature: $sig" -X POST --data "$body" "$PAYKIT_URL/transactions/status"
}
STATUS_JSON="$(signed_status)"
echo "$STATUS_JSON" >"$OUT_DIR/status-undetected.json"
jq -e '.status == "undetected"' <<<"$STATUS_JSON" >/dev/null || fail "expected undetected, got: $STATUS_JSON"
note "paykit status: $STATUS_JSON"

# --- 11. reader receives the Payment Request (address + amount) -------------------
step "11. reader receives private Payment Request from Paykit Server"
RECEIVE_OUT="$(printf '{"version":1,"operation":"receive","reader_secret":"%s"}' "$READER_SECRET" \
  | $DC exec -e PAYKIT_READER_SERVER_PUBKY="$CREATOR" -T paykit-reader paykit-reader-demo)"
echo "$RECEIVE_OUT" >"$OUT_DIR/reader-receive.json"
INVOICE_ADDRESS="$(jq -r '.address' <<<"$RECEIVE_OUT")"
INVOICE_AMOUNT_SATS="$(jq -r '.amount_sats' <<<"$RECEIVE_OUT")"
case "$INVOICE_ADDRESS" in bcrt1*) ;; *) fail "unexpected invoice address: $RECEIVE_OUT";; esac
[ "$INVOICE_AMOUNT_SATS" = "$AMOUNT_SATS" ] || fail "amount mismatch: requested $AMOUNT_SATS, payment request says $INVOICE_AMOUNT_SATS"
note "payment request received: address=$INVOICE_ADDRESS amount=${INVOICE_AMOUNT_SATS} sats"

# Each invoice allocates the next external-chain child; scan a window so the
# check stays valid on repeated runs against the same Creator.
DESCRIPTOR="$($BCLI getdescriptorinfo "wpkh($TPUB/0/*)" | jq -r '.descriptor')"
DERIVED_CHILD="$($BCLI deriveaddresses "$DESCRIPTOR" '[0,50]' \
  | jq -r --arg a "$INVOICE_ADDRESS" 'index($a) // "none"')"
[ "$DERIVED_CHILD" != "none" ] || fail "invoice address $INVOICE_ADDRESS is not derived from the claimed tpub (children 0..50 of m/84h/1h/0h/0)"
note "address independently re-derived from tpub: external child index $DERIVED_CHILD"

# --- 12. pay from the regtest node -------------------------------------------------
step "12. pay the invoice address from the regtest node (Bitkit wallet-execution role)"
AMOUNT_BTC="$(python3 -c "print(f'{int('"$AMOUNT_SATS"')/1e8:.8f}')")"
TXID="$($BCLI -rpcwallet=miner sendtoaddress "$INVOICE_ADDRESS" "$AMOUNT_BTC" | tr -d '\r\n')"
note "sent $AMOUNT_BTC BTC -> $INVOICE_ADDRESS (txid $TXID)"

DETECT_DEADLINE=$(( $(date +%s) + 90 ))
while :; do
  STATUS_JSON="$(signed_status)"
  jq -e '.status == "detected" and .amount_matched == true' <<<"$STATUS_JSON" >/dev/null && break
  [ "$(date +%s)" -gt "$DETECT_DEADLINE" ] && fail "payment never reached detected; last status: $STATUS_JSON"
  sleep 2
done
echo "$STATUS_JSON" >"$OUT_DIR/status-detected.json"
note "paykit status after mempool payment: $STATUS_JSON"

LOOKUP_BODY="$(jq -nc --arg c "$CREATOR" --arg b "$BUNDLE_ID" '{creator: $c, bundle_id: $b}')"
PRE_CONFIRM_LIFECYCLE="$(http_post_json /verification-task-lookups "$LOOKUP_BODY" | tail -n +2)"
note "locks lifecycle at 0-conf (minimum_confirmations=${LOCKS_PAYKIT_MIN_CONFIRMATIONS:-1}): $(jq -c . <<<"$PRE_CONFIRM_LIFECYCLE")"

# --- 13. confirm -> paykit confirmed -> locks completes -----------------------------
step "13. mine 1 block -> confirmed -> Locks verification completes"
$BCLI -rpcwallet=miner generatetoaddress 1 "$MINER_ADDR" >/dev/null
CONFIRM_DEADLINE=$(( $(date +%s) + 90 ))
while :; do
  STATUS_JSON="$(signed_status)"
  jq -e '.status == "confirmed" and .confirmations >= 1 and .amount_matched == true' <<<"$STATUS_JSON" >/dev/null && break
  [ "$(date +%s)" -gt "$CONFIRM_DEADLINE" ] && fail "payment never reached confirmed; last status: $STATUS_JSON"
  sleep 2
done
echo "$STATUS_JSON" >"$OUT_DIR/status-confirmed.json"
note "paykit status after 1 block: $STATUS_JSON"

COMPLETE_DEADLINE=$(( $(date +%s) + 180 ))
while :; do
  LIFECYCLE_JSON="$(http_post_json /verification-task-lookups "$LOOKUP_BODY" | tail -n +2)"
  jq -e '.status == "completed"' <<<"$LIFECYCLE_JSON" >/dev/null && break
  [ "$(date +%s)" -gt "$COMPLETE_DEADLINE" ] && fail "Locks verification never completed; last lifecycle: $LIFECYCLE_JSON"
  sleep 3
done
echo "$LIFECYCLE_JSON" >"$OUT_DIR/lifecycle-completed.json"
note "locks lifecycle: $(jq -c . <<<"$LIFECYCLE_JSON")"

# --- 14. credential + guarded read ---------------------------------------------------
step "14. access credential + guarded proxy read"
CRED_RESPONSE="$(http_post_json /access-credentials "$LOOKUP_BODY")"
CRED_STATUS="$(head -1 <<<"$CRED_RESPONSE")"
CRED_JSON="$(tail -n +2 <<<"$CRED_RESPONSE")"
[ "$CRED_STATUS" = "200" ] || fail "access-credentials returned HTTP $CRED_STATUS: $CRED_JSON"
CREDENTIAL="$(jq -r '.credential' <<<"$CRED_JSON")"
READ_STATUS="$(curl -sS -o "$OUT_DIR/guarded-read.txt" -w '%{http_code}' \
  -H "authorization: Bearer $CREDENTIAL" "$LOCKS_URL/priv-resources/content/premium.txt")"
[ "$READ_STATUS" = "200" ] || fail "guarded read returned HTTP $READ_STATUS: $(cat "$OUT_DIR/guarded-read.txt")"
[ "$(cat "$OUT_DIR/guarded-read.txt")" = "$GUARDED_BODY" ] || fail "guarded read bytes do not match the uploaded content"
note "guarded read returned the exact uploaded bytes"

# --- 15. finality cap ------------------------------------------------------------------
step "15. finality: confirmations cap at 6"
$BCLI -rpcwallet=miner generatetoaddress 5 "$MINER_ADDR" >/dev/null
FINAL_DEADLINE=$(( $(date +%s) + 60 ))
while :; do
  STATUS_JSON="$(signed_status)"
  jq -e '.status == "confirmed" and .confirmations == 6' <<<"$STATUS_JSON" >/dev/null && break
  [ "$(date +%s)" -gt "$FINAL_DEADLINE" ] && fail "confirmations never reached the 6 cap; last status: $STATUS_JSON"
  sleep 2
done
echo "$STATUS_JSON" >"$OUT_DIR/status-final.json"
note "paykit status at finality: $STATUS_JSON"

step "RESULT: protocol-level payment leg verified end to end on regtest"
jq -n \
  --arg creator "$CREATOR" \
  --arg reader "$READER_PUBKY" \
  --arg lock_resource "$LOCK_RESOURCE" \
  --arg bundle_id "$BUNDLE_ID" \
  --arg invoice_address "$INVOICE_ADDRESS" \
  --arg amount_sats "$AMOUNT_SATS" \
  --arg txid "$TXID" \
  --slurpfile undetected "$OUT_DIR/status-undetected.json" \
  --slurpfile detected "$OUT_DIR/status-detected.json" \
  --slurpfile confirmed "$OUT_DIR/status-confirmed.json" \
  --slurpfile final "$OUT_DIR/status-final.json" \
  --slurpfile lifecycle "$OUT_DIR/lifecycle-completed.json" \
  '{
     creator: $creator,
     reader: $reader,
     lock_resource: $lock_resource,
     bundle_id: $bundle_id,
     invoice_address: $invoice_address,
     amount_sats: $amount_sats,
     payment_txid: $txid,
     paykit_status_progression: {
       before_payment: $undetected[0],
       after_mempool_payment: $detected[0],
       after_one_block: $confirmed[0],
       at_finality: $final[0]
     },
     locks_lifecycle: $lifecycle[0],
     artifacts: "'"$OUT_DIR"'"
   }' | tee "$OUT_DIR/summary.json"
