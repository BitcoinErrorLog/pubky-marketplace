# Resume: Shop grant BFF

Parked: 2026-09-20  
Branch: `marketplace/grant-bff`  
Implementation head: `5714e3479faae357dc66f191447dbae75247e624`  
PR: none

## Status

The Shop BFF implementation is complete and pushed, but the release is
**NOT READY**. All staging grant flags are off. Production is clean.

Revision 7 design:

`$HOME/Library/Application Support/Cursor/AgentStores/cursor_agent_stores/bc-872e776d-51a7-400c-a253-6ba89fe66340/files/docs/bitkit-grant-url-design.md`

## Implemented

- server-side Shop-session bridge paired to the marketplace bearer minted by
  the existing one-approval sign-in;
- bearer-actor/pubky and exact session-UUID verification through existing Wave
  3a service routes;
- signed reconnect assertion with `sub` bound to the bearer-derived actor;
- same-origin BFF pair, clear, create, status/claim, cancel, and cleanup routes;
- shared PostgreSQL bridge/flow state with leases, terminal clearing, expiry,
  cleanup, and least-privilege roles;
- Ed25519/JCS service requests, assertion rings, result PoP, HKDF/HMAC binding,
  and XChaCha20-Poly1305 state envelopes;
- signer-neutral UI states, redesign tokens, and reduced-motion handling;
- default-off service/BFF/client rollout gates;
- staging and production environment/key separation.

## Gates

- format: PASS;
- lint: PASS;
- typecheck: PASS;
- unit: 930 files, 14,512 passed, 2 skipped;
- focused BFF tests: PASS;
- new grant BFF VRT: 24/24 PASS;
- marketplace VRT: every file passed independently; one untouched Orders
  WebKit drift passed on retry;
- monolithic VRT command: evidence harness NOT READY because Playwright emitted
  an unhandled closed-page route callback;
- live staging journey: NOT READY.

Evidence root:

`/Volumes/t7/vibes-dev/.evidence/bitkit-grant/shop-bff/`

## Exact live relay failure

The no-money journey passed:

```text
fresh staging seat
→ one-approval marketplace bearer
→ BFF bearer/pubky/session pairing
→ grant create
→ signer accepted and POSTed the encrypted grant
```

The marketplace flow then remained `awaiting` until expiry. It never entered a
verification lease and never emitted a successful relay-receive log.

Representative flow:

```text
flow_id=1529ab2d-f466-4d3c-9a23-eb92264a8599
created_at=2026-09-20T18:24:55.573624Z
expires_at=2026-09-20T18:29:55.573624Z
status=expired
terminal_code=flow_expired
```

Evidence:

- `RELAY-ROOT-CAUSE.md`;
- `SERVICE-LOG-flow-1529ab2d-redacted.log`;
- `LIVE-STAGING-VERDICT.md`.

## Root cause

Relay configuration matches #48:

```text
Paykit auth relay = https://httprelay.pubky.app/inbox
MARKETPLACE_GRANT_RELAY_URL = https://httprelay.pubky.app/inbox
channel id = base64url_no_pad(hash(secret))
```

The failure is marketplace-service worker lifecycle, not a key or relay URL.

`PubkyGrantAuthFlow::restore` spawns an asynchronous relay listener.
`process_lease` immediately calls `try_poll_once()`, whose underlying
`try_recv()` is nonblocking. It normally sees an empty queue, returns the row
to `awaiting`, drops the flow, and aborts the just-started relay GET. The
one-second worker scan repeats that sequence. #48 keeps its listener alive and
therefore does not hit this restore/try/drop race.

No service-side configuration key needs changing.

## First step on resume

In `pubky-marketplace-service`, write a failing real-inbox regression:

```text
message already stored in inbox
→ restore saved PubkyGrantAuthFlow
→ one durable worker lease observes and processes it
```

Design the fix around durable lease ownership and at-most-once relay
consumption. Do not use a scheduler yield or change
`MARKETPLACE_GRANT_RELAY_POLL_MILLISECONDS` as a workaround. After the service
fix, rerun Terra's combined design/code review and the mandatory Kimi audit,
then repeat the full no-money staging journey before enabling any flag.

## Environment left on staging

Marketplace service:

```text
MARKETPLACE_GRANT_FLOW_ENABLED=false
deployment=69cdb683-e619-4d5e-9b7d-b77276b4d277
status=SUCCESS
```

Shop:

```text
SHOP_BFF_GRANT_FLOW_ENABLED=false
PUBKY_RUNTIME_MARKETPLACE_GRANT_FLOW_ENABLED=false
deployment=dpl_A554hKpDrhvvuP6EegGfua7tNVnb
status=Ready
POST /api/marketplace/grant-flows=404
rendered marketplaceGrantFlowEnabled=false
```

Staging keeps the environment-separated verifier rings, private signing keys,
state key, cleanup secret, least-privilege `shop_grant_bff` schema, and staging
Postgres TCP proxy for the next gated attempt. Failed proof bridge rows were
deleted.

Production:

- no Shop-BFF schema;
- no Shop-BFF roles;
- no Postgres TCP proxy;
- no Shop or service grant flag enabled;
- no Shop-BFF deployment.

Production-touch incident:

`/Volumes/t7/vibes-dev/.evidence/bitkit-grant/shop-bff/INCIDENT-prod-db-touch.md`
