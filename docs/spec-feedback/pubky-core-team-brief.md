# Pubky SDK / homeserver / Homegate / pkarr as used by the marketplace

**To:** maintainers of the Pubky SDK (`pubky` crate), `pubky-homeserver`,
Homegate, and pkarr
**From:** the Pubky Marketplace integration (forks under `BitcoinErrorLog`)
**Date:** 2026-09-01
**Status:** technical brief. Not a PR, not a demand list. Every git SHA
below was checked with `git cat-file -e <sha>^{commit}` in the checkout
named for that row. Upstream objects not present locally were fetched
as a GitHub git object. The same objects were also fetched as
`raw.githubusercontent.com` at that SHA. Each of the eight vendor SHAs
in §3 returned HTTP 200 on `BitcoinErrorLog/paykit-rs-official`. A
fresh clone of that fork fetches every cited vendor SHA.

This document assumes you have not seen the marketplace. Several items
currently filed under the Paykit brief (§5 wasm write-abort / leftover
pkarr / CAS; §6 the historical `reqwest/stream` hole) are **pubky-core
findings**. They showed up through paykit-wasm’s homeserver writes. The
code lives in vendored crates.io `pubky` 0.8.0, not in paykit-lib. This
brief is the first-hand report, re-checked against crates.io `pubky`
0.11.0 and current `pubky/pubky-homeserver` main.

The sibling Paykit brief (final) is
`docs/spec-feedback/paykit-team-brief.md` in
`BitcoinErrorLog/pubky-marketplace-umbrella`. Cross-reference it for
Paykit-server wallet-interop, wasm packaging that is Paykit’s, and the
Noise slot-1 observation. That brief’s §5 recorded this as unproven;
§4 below settles it against 0.11.0 and main. Re-verified here against
0.11.0 and main `21c87402`; §4 states what is absent and where main’s
behavior partially overlaps.

Nothing here has had an independent security review. paykit-rs is
pre-1.0. Bitcoin is **regtest only**. Where a cause is unproven, it is
labeled that way. No secrets, admin passwords, or staging admin URLs
are in this document.

---

## 1. What we run, against which trees

The marketplace client talks to the **staging homeserver** through the
Pubky SDK. Browser Encrypted Links go through a WASM binding of
`paykit-lib` that path-patches crates.io `pubky` 0.8.0. Bitkit iOS
provisions identities through **Homegate staging** (IP verification)
during profile creation. Local browser e2e of the wasm binding uses a
pinned homeserver testnet image and a local pkarr relay.

Official GitHub naming, because it affects every citation below:
`pubky/pubky-core` now redirects to `pubky/pubky-homeserver`. crates.io
`pubky` 0.11.0 and `pubky-homeserver` 0.11.0 both list
`https://github.com/pubky/pubky-homeserver` as the repository. The SDK
crate in that tree is `pubky-sdk/`.

| Piece | Where we read it | Pin | What it is |
| --- | --- | --- | --- |
| paykit-rs (vendored pubky 0.8.0) | `BitcoinErrorLog/paykit-rs-official` | branch `fix/wasm-homeserver-write-abort` HEAD `d4a73a5765e1f0b18ed451d78f98dab97c611a8c` (`paykit-wasm` 0.1.0-rc50) | The browser-proven patch line. All eight vendor-touching commits are on this branch and pushed. |
| crates.io `pubky` 0.11.0 | local cargo registry extract | published 2026-08-19, not yanked | SDK source of record for “is this already upstream?” |
| crates.io `pubky-homeserver` 0.11.0 | same registry | same release | Homeserver source of record for quota / `WritePathForbidden`. |
| official git main | `pubky/pubky-homeserver` | `21c874028eb75a7e1d86a887df869ee3333cdc6a` | 14 commits past annotated tag `v0.11.0` (tag object `5a0884d4` peels to commit `6a14bdb8fa2e30ef4e4b241fcdd3992c453d2378`). |
| BitcoinErrorLog `pubky-core` (this machine) | local checkout of `BitcoinErrorLog/pubky-core` | branch `feat/session-revocation` `e5f479faea903a66f98c13d4fa1a37d47020670f` | **Not** an 0.11 tree. Workspace `pubky` / `pubky-homeserver` version `0.6.0-rc.6`. 22 ahead / 0 behind a stale local `upstream/main` at `6d51639c` (2026-01-02, `#289`). |
| 0.6 migration port | `BitcoinErrorLog/pubky-core` `fix/homeserver-migration` | HEAD `d8dd6ca77dc2e6a3133be65fcf7c4a359d0ccc52` | Public. Linear history `a7545d9a` → `10e42bf4` → `d8dd6ca7` (one parent, not a merge). GitHub `branches-where-head` is only that BEL branch; no PR on `pubky/pubky-homeserver`. The commit object is visible in the fork network. |
| Homegate | `pubky/homegate` `master` | `a70269e222c49f6caa073d3dff16011462841b48` (merge of #30) | Official. Read from GitHub at that SHA. |
| wallet-leg log | `BitcoinErrorLog/pubky-payment-rails` | HEAD `a4d70c893c0e89597a31a6c7b65536a7fed9633a` | Corrected `/priv` and Homegate-allowlist language. |
| `/priv` probe | `BitcoinErrorLog/pubky-app` `marketplace/pr25-ux` `64cb7aee` `src/test/live/priv-durability-probe.live.ts` | seeded 2026-08-28T09:09:26Z | See §7. |
| marketplace client | `BitcoinErrorLog/pubky-app` `marketplace/pr25-ux` | `64cb7aee23f4762c995c5ae1b16eef37346c9e10` | Probe, `docs/ecommerce/RUNNING.md`, and `homeserver.ts:66–77` citations below are this SHA. |
| Bitkit iOS (wallet-leg app) | local clone of `synonymdev/bitkit-ios` (read at `origin/master`) | `PubkyProfileManager.swift`, `Env.swift` | Homegate IP signup; profile publish is Paykit, not `pubky.app`. |

The marketplace web client still vendors an older wasm build
(`paykit-wasm` 0.1.0-rc44 at `0a6c6e4`). The write-abort line above is
rc50. Browser e2e quoted in §8 is from the rc44 revision.

---

## 2. Thesis

Paykit-rs did not invent these bugs. It compiled the SDK to wasm32 and
wrote to a homeserver. The failures were:

- a 2xx `fetch` aborted because the `Response` was dropped unread;
- a leftover pkarr HTTPS stream that resumed `resolve()` and trapped
  wasm `RuntimeError: unreachable`;
- a pkarr CAS loop on a phantom cached packet;
- WASM endpoint selection that preferred Pubky TLS, which a browser
  cannot speak;
- no first-class `migrate_homeserver` on the 0.8 signer.

Those patches are in `vendor/pubky` on
`fix/wasm-homeserver-write-abort`. `vendor/pubky/PATCHES.md` documents
four items and **lags the git history**: it does not list the two
bounded-drain commits (`f978731`, `d4a73a5`). The git history is the
complete inventory.

None of the behavioral fixes are in crates.io 0.11.0 or on
`pubky/pubky-homeserver` main `21c87402`. The one 0.11 packaging fix
that *did* land is `reqwest/stream` on wasm32 (see §9). Grant
authentication in 0.11 replaced the AuthToken signup path the 0.8
patches wrap, so they will not rebase cleanly (see §4).

---

## 3. Vendored pubky patches (the payload)

Checkout: `paykit-rs-official` `fix/wasm-homeserver-write-abort`
`d4a73a5`. Path-patches crates.io `pubky` 0.8.0 at `vendor/pubky`
(`[patch.crates-io]`). Eight commits touch `vendor/pubky`. All eight
are pushed; GitHub returned 200 for each full SHA.

`51f1e6847b65` vendors 0.8.0 (`.cargo_vcs_info.json` records
`path_in_vcs: pubky-sdk`, git `5a421c98`, `dirty: true`) and lands
PATCHES.md items 1–3 as of that commit. Later commits add drain,
leftover-drop, CAS restore, If-Match omit, retries, and bounded
timeouts. The hydrated-pubky check is **not** in `51f1e68`; it lands
in `2ff7d44`. Line numbers below are **HEAD of this branch** unless
noted.

| SHA | Subject | What failed | Fix |
| --- | --- | --- | --- |
| `51f1e6847b65cf5c4bddad340489ae79e3c4ab2b` | Export migrateHomeserverWithSecret on paykit-wasm | No migrate helper; WASM picked Pubky TLS | `PubkySigner::migrate_homeserver` (docs: HTTP 409 at the new host resumes via sign-in; **does not copy** host-local data). WASM endpoint ranking prefers ICANN/HTTP (`HTTP_PORT`) for **every** host (`browser.rs:1–6`, `rank_browser_endpoint` `27–38`). |
| `a4c66d940fd306b1f7e424c5a0e6fe300e1dbd4e` | Restore pkarr CAS baseline before republish retry | Failed publish leaves a phantom packet in the pkarr cache; `resolve_most_recent` never sees the relay’s newer record | `restore_cas_baseline_in_pkarr_cache` in `actors/pkdns.rs` |
| `2ff7d44e5cc97480a8a75348606d6167ba832de4` | Retry WASM homeserver publish after CAS and transport errors. | CAS/transport death; WASM backoff was not a real timer; `/session` did not retry; hydrated session not checked | Last **force** attempt omits If-Match; WASM backoff via `setTimeout`; signup `/session` retries on transport errors; `ensure_session_matches_identity` (`session.rs:237–245`) |
| `6a58d269fecdaa058c527890a3c39b0518e7cade` | fix: retry pkarr publish on unexpected relay responses | Unexpected relay responses aborted publish | Retry in `actors/pkdns.rs` |
| `b04e05cde937110bbd9fbedfa5ce36175b8cadc0` | fix: drain wasm write bodies so fetch is not aborted | reqwest-wasm `AbortGuard` aborts in-flight `fetch` when a 2xx `Response` is dropped unread (`net::ERR_ABORTED`). `Ok` did not mean the homeserver committed. | `commit_issued_http_write` in `util.rs`; storage PUT/DELETE (and JSON PUT, auth-relay POST/DELETE) drain before `Ok` |
| `cae1a8fb8bf9b05ca5e25a935e873db59da63f2a` | fix: drop leftover pkarr stream after BrowserHttp | Awaiting leftover HTTPS SVCB records after a BrowserHttp win resumes pkarr `resolve()` and races `AbortGuard` → `RuntimeError: unreachable` | Remaining items after a BrowserHttp win are **not visited** (`browser.rs`; test panics if a leftover item is polled) |
| `f97873183491f671220ae8e72f407df0a10ef69a` | fix: bound wasm write-body drain so a stalled 2xx cannot hang | A stalled 2xx body could hang the drain forever | `WRITE_BODY_DRAIN_TIMEOUT` = 5s (`util.rs:11`) |
| `d4a73a5765e1f0b18ed451d78f98dab97c611a8c` | fix: bound error-body drain and bump wasm to rc50 | A hostile/stalled homeserver could hang `check_http_status` the same way (`response.text()` unbounded); wasm sleep timers leaked | Same 5s bound on the error-body drain; `WasmTimeoutGuard` clears `setTimeout` on drop (`util.rs:99–145`); `paykit-wasm` 0.1.0-rc50 |

`migrate_homeserver` at HEAD (`session.rs:44–70`) calls `signup`, which
on 409 (`is_user_already_exists`, `signup_or_resume_on` `162–184`)
posts `/session` at that host. It does not copy data. The identity
check is `ensure_session_matches_identity`.

---

## 4. Upstream status (0.11.0 and current main)

Re-read locally from the crates.io 0.11.0 extracts, then again from
`raw.githubusercontent.com/pubky/pubky-homeserver/21c874028eb75a7e1d86a887df869ee3333cdc6a/pubky-sdk/…`
(and the matching `pubky-homeserver/` paths). The 14 commits on main
after `v0.11.0` are docs, refactors, Retry-After, metrics, dependency
bumps, path-addressed SDK requests, DockerPostgres, the homeserver
CLI, a rate-limit ordering fix (`21c87402`), and a TS-binding bump
(`ee46c8c2`). None of them add the behavioral fixes below.

**Still absent on both 0.11.0 and main `21c87402`:**

1. **Write-ack drain.** `pubky-sdk/src/actors/storage/verbs.rs`
   `send_checked` returns `check_http_status(resp)` after `send()`.
   `SessionStorage::put` / `delete` return that `Response`. There is
   no `commit_issued_http_write`. A wasm caller that treats 2xx
   `send()` as success and drops the body still hits AbortGuard.
2. **Unbounded error-body drain.** `pubky-sdk/src/util.rs`
   `check_http_status` on non-2xx still does `response.text().await`
   with no timeout (crates.io 0.11.0 lines 10–23; main identical).
3. **`migrate_homeserver`.** Zero matches in
   `pubky-sdk/src/actors/signer/session.rs` on 0.11.0 and on main.
   Primary `signup` is grant-based (`signup_account_from_grant`);
   `signup_cookie` remains as a legacy AuthToken path.
4. **WASM endpoint ranking.** Browsers cannot speak Pubky TLS.
   `select_first_usable_endpoint` in
   `pubky-sdk/src/client/http_targets/wasm.rs` returns the first
   endpoint whose `domain()` is `Some`. `HTTP_PORT` is applied only
   for testnet/localhost (`is_testnet_domain`). There is no
   `rank_browser_endpoint`, no BrowserHttp-wins-immediately, no
   leftover-stream test. After the first domain hit, remaining
   stream items are not awaited; the stream is dropped when
   `transform_url_with_stream` returns. That is not the vendor’s
   rank-and-break, and it is not an explicit leftover-drop.
5. **`publish_with_retries`.** Generic `for attempt in 1..=3` in
   `pkdns.rs`. No CAS-baseline restore. No If-Match omit on a final
   force attempt. `should_retry` is `pk.is_retryable() && attempt < 3`.

**Present in 0.11, absent in 0.8.0 (historical, not an ask):**

wasm32 `reqwest` features on crates.io 0.8.0 are `["json"]` only.
0.11.0 (and main `pubky-sdk/Cargo.toml`) is `["json", "stream"]`.
That was a compile hole for `Response::bytes_stream()`. It is fixed
in 0.11. It does **not** fix AbortGuard-on-drop.

**Porting collision:** 0.11 grant authentication replaced the AuthToken
signup/`/session` path the 0.8 patches wrap (`signup_or_resume_on`,
`send_session_request` to `/session`, `CookieCredential`). A clean
cherry-pick onto 0.11 will fail. Drain, leftover-drop, CAS restore,
If-Match omit, and HTTP_PORT ranking are independent of that and can
move without the migrate helper. `migrate_homeserver` itself would
have to be re-expressed on the grant signup + grant signin APIs
(`ClientId`, `signup_account_from_grant`,
`credential_from_grant_exchange`).

---

## 5. Two honest fork lines

**0.8 vendor line (current, browser-proven).** §3. This is what
paykit-wasm actually runs patches against. API: `Keypair::from_secret`,
reqwest 0.13, pkarr 6.

**0.6 port (older API, public, not on official branches).**
`BitcoinErrorLog/pubky-core` `fix/homeserver-migration` `d8dd6ca7`
(“Omit If-Match on the last force-publish CAS retry.”). Parents: one,
`10e42bf4` (“Restore pkarr CAS baseline before republish retry”).
`a7545d9a` (“Fix homeserver migration CAS retry and 409 resume”) is
the grandparent, not a second merge parent. Same `migrate_homeserver`
shape, but 0.6-rc.6: `signin()` takes no `ClientId`, reqwest 0.12,
pkarr from the 0.6 workspace. It is a port of CAS/409/If-Match onto
the tree this machine’s `pubky-core` checkout actually is. It is not
a substitute for taking the 0.8/0.11 work.

`feat/session-revocation` on the same BEL repo (`e5f479fa`, session
expiry / owner revocation) is **separate** from this brief (see §12).

---

## 6. Homegate write allowlist

Live staging, from `docs/wallet-leg.md` at `a4d70c8`, verbatim:

> The staging homeserver allows Bitkit/Homegate-provisioned users to write
> `/pub/paykit/**` but returns `403 Write to this path is not allowed` for
> `/pub/locks.app/**` and `/pub/pubky.app/**` (isolated with a direct
> delegated-session probe; the locks server surfaces this as a 500 on
> `publish`).

That isolation probe is **documentary**. No script for it survives in
the marketplace client, payment-rails, or the wallet-leg evidence
tree; only this paragraph (and a Bitkit brief that repeats it) remain.

The 403 string is **not** session-capability denial. In crates.io
`pubky-homeserver` 0.11.0 the string `Write to this path is not allowed`
is emitted at exactly one site (`http_error.rs:123`). 0.11
session-capability denials live in `client_server/auth/authorization.rs`
and use different messages. The 0.6-era authz string is still in the
BEL 0.6 tree:

`pubky-homeserver/src/client_server/layers/authz.rs:185`
`"Session does not have write access to path"`.

The observed string is homeserver quota enforcement. crates.io
`pubky-homeserver` 0.11.0 (and main `21c87402`, same lines):

- `http_error.rs:122–124` — `FileIoError::WritePathForbidden` →
  `403` `"Write to this path is not allowed"`
- `write_path_layer.rs:9–16, 48–76` — OpenDAL layer over
  `UserQuota.allowed_write_paths`; writes/deletes not on the list
  become `PermissionDenied` / `WritePathForbidden`
- `user_quota.rs:247–260, 300–305, 378–390` — `None` means unrestricted;
  directory entries are prefix match, file entries exact
- Admin `GET /generate_signup_token` mints `UserQuota::default()`
  (unrestricted paths). `POST` accepts a `UserQuota` JSON body
  including `allowed_write_paths` (`generate_signup_token.rs:21–42`)
- Signup copies the consumed token’s quota onto the user
  (`signup_service.rs` `create_user_in_tx` / `code.quota()`,
  `96–108` and `144–146`)

Official Homegate `master` `a70269e2`:

- IP verification **can** attach `[ip_verification.signup_quota]`
  `allowed_write_paths` (`config.toml.example`;
  `IpVerificationConfig.signup_quota` in `src/infrastructure/config.rs`,
  field ~line 134). When that section is set, Homegate POSTs the
  homeserver admin token endpoint with the quota
  (`RateLimitedSignupIssuer::generate_signup_token`).
- SMS, LN, and Google verification call the admin **GET** (default
  quota). Google’s issuer is constructed with `signup_quota: None`.

Bitkit iOS (the wallet-leg app) signs up via Homegate **IP
verification**: `PubkyProfileManager.swift:199–218` POSTs
`{Env.homegateUrl}/ip_verification`. Staging URL is
`https://homegate.staging.pubky.app` (`Bitkit/Constants/Env.swift:359–369`, staging
string at 368, non-mainnet).

**UNPROVEN:** staging Homegate’s actual `signup_quota` /
`allowed_write_paths` config. We have not read the deployed file.
The live 403 is the observation; the config is the suspected
mechanism.

**OPEN TENSION.** This tension is unresolved in both directions. A
paykit-only allowlist matches the live 403 on `/pub/pubky.app/**` and
`/pub/locks.app/**`.
The wallet-leg Bitkit app’s *own* profile publish is
`writeProfile` → `PubkyService.publishPaykitProfile` (Paykit tree,
`/pub/paykit/v0/…/profile.json`), which would succeed under a
paykit-only list. `bitkit-core` still **reads**
`/pub/pubky.app/profile.json` (`PROFILE_PATH` in
`src/modules/pubky/profile.rs`). A separate BEL Bitkit tree
(`DirectoryService.publishProfile`) **writes** that same path. So
“Bitkit always writes `profile.json` on Homegate signup” does **not**
hold for the wallet-leg app, and **does** hold for that other tree.
Possible resolutions (intended paykit-only identities; staging config
accident; Homegate should include `pubky.app` / `locks.app`; Bitkit
should not write `pubky.app`) are **unproven**.

The ask is §13.6.

---

## 7. `/priv` durability (homeserver storage — good news)

A day-old guarded upload under `/priv/locks.app/content/` answered
404 despite a valid credential; re-uploading the same bytes restored
the pin. That is a Locks-side serve question as much as a homeserver
one. Details and the Lock Server deploy caveat are in the Paykit
brief §8.2 and in `wallet-leg.md` at `a4d70c8`. Current text there:

> A later `/priv` durability probe (2026-08-28
> → 2026-08-29, ~25h, three files under `/priv/pubky.app/durability-probe/`,
> BLAKE3-verified green at T+1h and T+~25h) exonerated the staging
> homeserver's `/priv` storage engine for that window — but the window
> spanned no Lock Server redeploy, and the probe wrote to `/priv/pubky.app/`,
> not `/priv/locks.app/`. Remaining suspects are the Lock Server's
> imported-creator-session/serve layer and redeploy-triggered loss; the
> original 404's root cause is still not proven.

Probe: `BitcoinErrorLog/pubky-app` `marketplace/pr25-ux` `64cb7aee`
`src/test/live/priv-durability-probe.live.ts`. Three files under
`/priv/pubky.app/durability-probe/`. Seed timestamp verified in the
probe state file: `2026-08-28T09:09:26.096Z`. Check-completion
`2026-08-29T10:13Z` is taken from that wallet-leg paragraph and from
the marketplace status ledger; the probe was **not** re-executed for
this brief.

For you: the storage engine is exonerated for that window. The
original guarded-404 remains **unproven**. The probe did not cover
`/priv/locks.app/` and did not span a Lock Server redeploy.

---

## 8. pkarr flake (one bounded observation)

Quoted exactly from `paykit-wasm/docs/browser-e2e.md` at `0a6c6e4`,
the “Observed reliability” section:

> Across 10 recorded Chromium runs of the original 14-check suite, 9 passed
> 14/14 (~6–7 s each); one run failed transiently inside `signupWithSecret`
> at session establishment and passed on immediate re-run. Firefox and WebKit
> passed on their first attempts. After adding the session reload-survival
> checks (16-check suite): the first Chromium run hit the same transient
> pkarr-resolution failure — this time at the fresh-context `signinWithSecret`
> in the restore check, with the new reload-survival checks already passing —
> and the immediate re-run plus first Firefox and WebKit runs passed 16/16.
> After adding the cookie-resume checks (19-check suite): Chromium, Firefox,
> and WebKit each passed 19/19 on their first attempts. Treat isolated
> signin/signup-time pkarr failures as environmental (relay/DHT publish
> timing), not binding regressions.

Bound: local testnet image. The same document’s environment table
pins homeserver `f68014c111af0458e6a321e2d87a12479bfb3218` and labels
it “pubky-core”. That SHA now lives on `pubky/pubky-homeserver`
(message: `feat: Setup TypeDoc (#523)`). The “pubky-core” label is
stale naming after the repo split. pkarr relay `127.0.0.1:25411`.
Attribution is the doc’s. **Unproven** beyond that run log.

---

## 9. Packaging

The 0.8.0 wasm32 `reqwest/stream` hole is **fixed in 0.11**. It is
historical context that the upgrade path is real, not an ask.

Remaining wasm32 packaging (getrandom 0.3 `wasm_js`, uuid `js`, snow
`ring?/std`) belongs to Paykit / paykit-lib. See Paykit brief §6.
Those are Paykit items, not SDK asks.

Whether crates.io `pubky` 0.11.0 needs any consumer-side getrandom line
to compile for wasm32 is a pubky question; that is §13.10.

---

## 10. Signup-token friction (modest)

Marketplace live tests mint single-use tokens through the staging
homeserver **admin signup-token flow** (GET of the generate-token
admin route with the admin password header). This brief does not
record the URL or the password.

Cost, from `BitcoinErrorLog/pubky-app` `marketplace/pr25-ux` `64cb7aee`
`docs/ecommerce/RUNNING.md` (cite, do not quote secrets): lines 197–205
(staging messaging suite is
run-on-demand because each signup burns a token; recovery re-runs
reuse printed identity secrets), 216–224 (cross-account suite, two
tokens), 241 (drops race needs three tokens **or** a saved-identities
file whose path lives outside the repo). Suites are never standing
gates.

The ask is §13.8.

---

## 11. Session semantics (context, not a complaint)

One session cookie per user per origin. Split Ring grants clobber
each other. The marketplace app uses a combined grant
`/pub/pubky.app/:rw,/pub/paykit/:rw,/priv/pubky.app/:rw`
(`BitcoinErrorLog/pubky-app` `marketplace/pr25-ux` `64cb7aee`
`src/core/services/homeserver/homeserver.ts:66–77`). The browser
holds a capability-scoped session cookie with write authority, not
the identity secret.

Native cookie keyed by user pubkey can send a new host’s cookie to
the old host after migrate. From
`docs/HOMESERVER_MIGRATION.md:24–27` on BEL
`fix/homeserver-migration`:

> On native, the session cookie is keyed by user pubkey only, not by
> the issuing host. After a move, stale Pubky TLS routing can send the new
> host's cookie to the old host until the packet cache expires. WASM
> cookies are origin-scoped and are not affected.

404-on-missing-slot list semantics. Root cause is unconfirmed; no
workaround recipe is attached. `pubky-noise` `receive_messages` treating
a 404 at the read counter as “no more messages” meant slots ≥ 2 were
never read when a gap appeared at index 1. A later live run did not
need the workaround. The only question is whether 404 on a missing
sequential `/priv` slot is intended to mean end-of-stream for readers
(§13.9).

---

## 12. What you can ignore

Paykit-server wallet-interop (network-correct endpoint identifiers,
lowercase `"btc"`, JSON `{"value":…}` payloads) is in the Paykit
brief, not here.

Marketplace HTTP routes, multi-trusted-signer, fiat (Stripe, PayPal,
Shippo), and the marketplace specs fork contain no Paykit/SDK work
for you.

`BitcoinErrorLog/pubky-noise` is deprecated (its own README, June
2026). No shared history with official `pubky/pubky-noise`. The
marketplace does not use it.

BEL `pubky-core` `feat/session-revocation` is 0.6 session-expiry
work. Separate from this brief.

Bitkit WALLETLEG logs and Hypercolor are out of scope.

getrandom 0.3 `wasm_js` / uuid / snow wasm32 packaging is Paykit’s
(Paykit brief §6).

---

## 13. Asks

Each item is a real question. “Not now” is a valid answer.

1. **Write-ack drain.** Will you take the wasm write-ack drain and
   the bounded drains (`b04e05c`, `f978731`, `d4a73a5`) into post-0.11
   `pubky` so a 2xx `Response` dropped unread cannot abort the fetch,
   and a stalled 2xx or error body cannot hang the client?

2. **WASM HTTP_PORT / ICANN preference.** Will WASM prefer `HTTP_PORT` /
   ICANN for every host, instead of taking the first endpoint that has
   a domain?

3. **WASM leftover-stream drop.** Will WASM drop leftover pkarr streams
   after a BrowserHttp win, instead of dropping the stream only when
   `transform_url_with_stream` returns?

4. **pkarr publish CAS.** Will you take the combined CAS-baseline-restore
   plus last-attempt If-Match omit (`a4c66d94` and the last-force path in
   `2ff7d44e`) into `publish_with_retries`, instead of the generic 3-try
   loop in 0.11?

5. **`migrate_homeserver`.** Does `PubkySigner::migrate_homeserver`
   (409-at-new-host resume, no data copy, hydrated-pubky check)
   belong in the 0.11 grant-auth API, or is homeserver migration out
   of SDK scope?

6. **Homegate quota.** What is the intended `allowed_write_paths`
   contract for Homegate-provisioned identities (IP verification in
   particular): unrestricted, paykit-only, `pubky.app`+paykit,
   something that includes `locks.app`, or per-environment?

7. **pkarr signup/signin transients.** Is a ~1/10 Chromium failure
   inside `signupWithSecret` / `signinWithSecret` on a local testnet
   (pkarr `127.0.0.1:25411`) expected DHT/relay publish timing, or a
   retry bug you already know about?

8. **Staging tokens.** Is single-use-per-signup the intended contract
   for automated staging testing, or is there a supported
   test-token / reuse path so live suites can be standing gates?

9. **List 404.** Is 404 on a missing sequential `/priv` slot intended
   to mean end-of-stream for readers? We are not attaching a failing
   test; the second live Noise run did not reproduce the slot-1 gap.

10. **Optional, 0.11 wasm32.** Does crates.io `pubky` 0.11.0 compile
    for `wasm32-unknown-unknown` without a consumer-side getrandom 0.2
    `js` feature line? This is self-answerable with one
    `cargo build --target wasm32-unknown-unknown`; asked only as a
    confirmation.
