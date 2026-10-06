---
name: marketplace-install-verify
description: >-
  Verifies a fresh Pubky Marketplace installation end to end (Shop, marketplace service, Paykit
  server, Locks server, marketplace Nexus, fiat verifier): health, TLS, CORS, Shop runtime config,
  service-to-Paykit-to-Locks wiring, trusted keys, allowed origins, version parity, applied
  migrations, single-instance Paykit, plus opt-in Nexus write, Chromium and staging-only deep
  probes. Safe against production. Use after deploying or migrating the marketplace stack, when
  asked to verify, smoke-test or accept an installation, or to compare a new stack with the old one.
---

# Marketplace install verification

One command checks a deployed stack from the outside and prints PASS/FAIL per check with a fix
hint. The operator guide with every check and its fix is
[docs/launch/install-verification.md](../../../docs/launch/install-verification.md).

```bash
node .cursor/skills/marketplace-install-verify/scripts/verify.mjs --config <stack.env> --out <evidence-dir>
```

- Config: copy [stack.env.example](stack.env.example) outside the repository and fill it in. Only
  `MIV_ENV`, `SHOP_ORIGINS` and the four service URLs are required; every other check is skipped,
  with the key to set, until its input exists.
- Exit code 0 means no FAIL (`--strict` also fails on WARN), 1 means at least one FAIL, 2 means a
  config error. `--out` writes `results.json` and `report.md`.
- `--only <sections>` / `--skip <sections>`: `config tls shop service paykit locks fiat nexus
wiring version db flow write browser deep`.
- Core checks need Node 20+ and nothing else. `--write-probe` needs the repository's
  `node_modules` (`npm ci`); `--browser` also needs `npx playwright install chromium`.

## Safety contract

Keep these when changing the scripts:

- Default checks are read-only: GET/OPTIONS, POSTs the server must reject before doing work
  (unsigned or unauthenticated), TLS handshakes, SQL inside `BEGIN READ ONLY … ROLLBACK`, and
  operator-supplied status commands. No payment, order, checkout session or charge is created.
- Opt-in probes and their exact footprint:
  - `--flow-probes`: one Paykit setup page per Shop origin (upstream server; an in-memory flow
    that expires) and one Locks connect page per origin (one `pending_creator_connect_flows` row
    that expires and is never completed, the same as a seller opening and closing the dialog).
  - `--write-probe`: one post (plus a profile only if the identity has none) on the homeserver the
    Nexus watches; deleted, verified gone from the homeserver and the Nexus. Production requires
    `ALLOW_PRODUCTION_WRITE_PROBE=1`. A throwaway identity needs `--out`: its secret is kept there,
    mode 600, only until cleanup is verified.
  - `--browser`: a signed-out page load in headless Chromium. Nothing is clicked.
  - `--deep`: refused when `MIV_ENV=production` or when a command names a `PRODUCTION_HOSTS`
    entry. Runs the operator's staging proofs, which must clean up after themselves.
- No secret is printed or written. Config facts are read by key name only, command stderr is
  redacted, and pubkys and keys are shortened in output. Put database URLs and tokens in the
  environment, never in the config file.

## Reused proofs

- **Signed-in Shop proof:** the Shop release skill's `release-proof.mjs` (Ring and Bitkit
  sign-in, PayPal fixture without paying, Activity, sign-out). It needs seat credentials and runs
  after this skill passes.
- **Staging deep proof:** `pubky/pubky-marketplace-service` `scripts/release/hold-smoke.py`
  through `DEEP_PROOFS=hold_smoke` (checkout holds, competing buyer 409, cancel and restock). It
  reads the staging database through Railway today; on another platform it needs its `sql()`
  helper pointed at the new database.
- **Regtest purchase:** not automated. It needs Bitkit wallets on both sides; follow
  `pubky/pubky-payment-rails` `docs/wallet-leg.md` on staging after this skill passes.
- **Nexus parity:** `REFERENCE_NEXUS_URL` replaces the listing snapshot comparison from the
  Nexus release runbook.

## What the checks cannot see

- Only the Nexus publishes its build commit. The other services need `<SVC>_RUNNING_COMMIT_CMD`
  (`scripts/running-commit.mjs` reads the image's `org.opencontainers.image.revision` label).
- Paykit's trusted key, setup origins and Locks' Paykit URL live in config, not on the wire:
  give the rendered config files or the values (`stack.env.example`, "Config facts").
- A single Paykit process is a platform fact: `PAYKIT_INSTANCE_COUNT_CMD` must print 1.
- Private service-to-service URLs answer only from inside their network: `<KEY>_REACH_CMD`.

## Changing the skill

- Run the unit tests: `node --test .cursor/skills/marketplace-install-verify/scripts/lib.test.mjs`.
- A new check needs a PASS run on a healthy stack and a FAIL run with a deliberately wrong input
  before it is relied on.
- Railway-only helpers (`railway-facts.mjs`, `railway-instances.mjs`, `running-commit.mjs railway`)
  read the old stack so it can be verified, and compared, the same way as the new one.
