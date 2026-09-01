# Bitkit surface as used by the Pubky Marketplace and Hypercolor

**To:** maintainers of `synonymdev/bitkit`, `synonymdev/bitkit-ios`,
`synonymdev/bitkit-android`, `synonymdev/bitkit-core`, and
`synonymdev/pubky-ring`
**From:** the Pubky Marketplace + Hypercolor integrations (forks under
`BitcoinErrorLog`)
**Date:** 2026-09-01
**Status:** technical brief. Not a PR, not a demand list. Every SHA below was
checked with `git cat-file -e <sha>^{commit}` in the named checkout.

This document assumes you have not seen the marketplace or Hypercolor. It
covers only the Bitkit and Pubky Ring surface we actually ran or read: what
we run, what changed in our forks of Bitkit-owned repos, what looks like
yours to fix, what we deliberately built around you, and what you can
ignore.

Nothing here has had an independent security review. Bitcoin is **regtest
only**. Where a cause is unproven, it is labeled that way.

---

## 1. What we run

Two products touch Bitkit. They use different seams.

- **Marketplace Bitcoin rail (regtest).** Locks entitlement + Paykit Server
  invoice observation + **Bitkit iOS as the buyer wallet**. Proven live on
  2026-08-22: seller companion claim, in-app Payment Request, swipe-to-pay,
  on-chain confirmation. Written up in
  `BitcoinErrorLog/pubky-payment-rails` `docs/wallet-leg.md` (local
  checkout, HEAD
  `a4d70c893c0e89597a31a6c7b65536a7fed9633a`, same as `origin/master`). That
  revision corrected the reader-demo framing (mirror-coupling: the demo
  asserted the server's own output rather than the spec) and the guarded-404
  durability status. Screens and logs live in `~/work/bitkit-wallet-leg/` on
  the machine that ran it (not a git repo).
- **Hypercolor (RN chat).** Encrypted-Link payment *messages* are Paykit. The
  *execution* path is a validated `lightning:` / `bitcoin:` URI handed to
  whatever wallet is registered (`walletHandoff.ts`). Bitkit is the preferred
  closer for proof row P4. That row is **not green**. See §5.

The local compose stack in this umbrella (`payments-env/`) does **not** run
Bitkit. It uses `paykit-reader-demo` to play Bitkit's protocol role. That is
why the rails looked green before a real wallet was tried.

| Piece | Git | Branch / pin | What it is |
| --- | --- | --- | --- |
| Wallet-leg target | `synonymdev/bitkit-ios` (local clone, not a product fork) | checked at `9b51fac39208ec24bc4b90ec2194a9f53fb301a2` (2026-08-20); current `origin/master` is `4120f207ad5458d2f34e2a43bcc418a2c5ed6ec7` (2026-08-31) | Native iOS. Debug/regtest. Companion claim + incoming Payment Request UI. Exact SHA of the 2026-08-22 Debug binary is **unrecorded**. The three issuer filters in §2 were re-read at `9b51fac3` and remain on the incoming/actionable path at `4120f207`. |
| Android (read, not used for the wallet leg) | `synonymdev/bitkit-android` | checked at `efc9bcd655b07209dd53106f3b1fdfdb34f3180c` (2026-07-30); current `origin/master` is `9182771b18eb594bd634e8018e3d505bc7389fa2` (2026-08-31) | At `efc9bcd65` there was no `x-bitkit-claim` / incoming Payment Request presentation in `app/src/main`. Current master implements both (§3.1). We have not run either Android path. |
| bitkit-core (read) | `synonymdev/bitkit-core` | checked at `7e9849873a4f2600ef1c7fcfa0953c914d54f0f5` (2026-07-30); current `origin/master` is `5028865cb8a8946e57933d6e72ff767492932bc2` (2026-08-28) | `src/modules/pubky` is **upstream** (`25ced3b3ab070bc187c629e163327bc5d8d040bf`, 2026-03-04). We did not add it. `AGENTS.md` lists the module; `CLAUDE.md` is a symlink to `AGENTS.md`. |
| Paykit Server (deployed) | `BitcoinErrorLog/paykit-server` | branch `marketplace-rails`; **deployed** `98f7c2251e5eabf1d7b14704dcdababf25499c53` | Fork of `pubky/paykit-server` @ `f38c7915e6b9b104e040773e78438f8aa984c46c` (“Initial public release”). Wallet-interop fixes exist because Bitkit rejected that revision's material (§2). Branch HEAD is one docs commit later (`651d428d74c94e6fa05579c126a6f564a3cc27c9`); staging is pinned at `98f7c22`. Verified in a local clone of the fork. |
| Staging rails | `BitcoinErrorLog/pubky-payment-rails` | Railway `pubky-marketplace-staging`; docs HEAD `a4d70c8` | Lock Server + paykit-server + regtest bitcoind + Fulcrum. |
| Hypercolor | `BitcoinErrorLog/hypercolor` | local checkout, HEAD `46b65dbcc289a425c607eb698c8fb62aa1cd6902` (= `origin/main`) | Chat app. Handoff at `src/services/payments/walletHandoff.ts`. |
| RN Bitkit (unused) | `BitcoinErrorLog/bitkit` | local checkout, HEAD `4c967f7af8a9368eece05ee87202fe40f32cd755` (= `origin/master`, 2025-11-27) | Stale production-app fork. Marketplace and Hypercolor do not run it. The working tree shows mass mode-churn (exFAT) and a rewritten README; HEAD still matches remote master. Substantive claim unchanged. |

Working copies we treat as **read-only synonymdev clones** (confirmed
`git remote -v`):

- a local clone of `synonymdev/bitkit-ios`
- a local clone of `synonymdev/bitkit-android`
- a local clone of `synonymdev/bitkit-core`

Each is on `master` tracking `origin/master`, currently **behind** the
fetched tips in the table (iOS 109 commits, Android 377). No committed
local divergence. bitkit-ios has **uncommitted** diagnostic `WALLETLEG`
log lines in four files (§6). Those are not a proposed patch. New master
content below was read with `git show origin/master:<path>` / `git log
origin/master` only; those clones were not checked out onto the new tips.

---

## 2. The wallet-interop filters

We are not asserting these filters are bugs. We are asserting they are
load-bearing and, on an incoming request, invisible to the user when they
fire.

Issuer-side claims in this section are pinned to upstream paykit-server
`f38c7915` (what staging ran). Bitkit filter line numbers are given at
`9b51fac3` (the tree we matched the 2026-08-22 run to) and, where the
incoming path is unchanged or not, at current `origin/master` `4120f207`.

At `f38c7915`, paykit-server emitted payment material that Bitkit dropped
or refused to open. Confirmed by a live Bitkit iOS run (2026-08-21/22),
then matched to filter code at `9b51fac3`. Three issuer shapes. Each is
correct against the payment-requests / payment-endpoint-identifier specs.
Together they are why the demo reader was a false green.

`paykit-reader-demo` at that revision asserted the same shapes the server
emitted, so server and reader drifted from the spec together. The demo was
strict — just strict against the wrong reference. A spec-conventional
lowercase `"btc"`, `btc-regtest-p2wpkh`, or JSON `{"value":"..."}` payload
would have failed the demo as well. The failures appeared only when the
real Bitkit wallet was tried. Detail is in the companion Paykit brief §2
and in `docs/wallet-leg.md` at `a4d70c8`.

1. **Network segment on the endpoint identifier (on-chain only).**
   `PaykitPaymentRequest.init?(record:)` keeps only identifiers that
   `PublicPaykitService.MethodId` knows, then requires
   `methodId.onchainNetwork == Env.network`
   (`supportedEndpointIdentifiers` at
   `Bitkit/Services/PaykitPaymentRequestService.swift:75-88` at
   `9b51fac3`; same logic at `:192-202` at `4120f207`). Debug builds are
   regtest, so `btc-bitcoin-p2wpkh` is discarded and `btc-regtest-p2wpkh`
   is kept. Method ids live in `Bitkit/Services/PublicPaykitService.swift`
   (`btc-bitcoin-p2wpkh`, `btc-regtest-p2wpkh`, testnet/signet siblings,
   `:98-116` at both pins).
   Lightning identifiers are exempt: `btc-lightning-bolt11` /
   `btc-lightning-lnurl` have `onchainNetwork == nil` and are accepted on
   any chain (`:86` / `:156-157` at `9b51fac3`; `:201` / `:156-157` at
   `4120f207`).

2. **Asset `"btc"` (lowercase, exact).**
   Same initializer: `terms.amount.asset == "btc"` (`:32` at `9b51fac3`;
   `:66` at `4120f207`). Uppercase `"BTC"` makes `init?` return `nil`. The
   private-pay path also constructs `PaymentAmountContext(value:asset:)`
   with asset `"btc"` (`Bitkit/Services/PrivatePaykitService+Payments.swift:61`
   at `9b51fac3`; `:62` at `4120f207`).

3. **Endpoint payload as JSON `{"value":"<address>"}`.**
   This is **not** an `init?` gate. `PublicPaykitService.parsePayload`
   (`:403-421` at both pins) accepts only a JSON object with a non-empty
   `value` string. A bare address string returns `nil`, so `parseEndpoint`
   drops the candidate at open time. Android does the same at current
   master: `PublicPaykitRepo.parseEndpoint` decodes
   `PaymentEndpointPayload(value, min?, max?)` and returns null on failure
   (`app/src/main/java/to/bitkit/repositories/PublicPaykitRepo.kt:108-114`
   at `9182771b`). When that happens the Paykit SDK reports
   `PublicPaymentResolutionStatus::UnsupportedEndpoint` (or `NoEndpoint`)
   — observed in local `WALLETLEG` diagnostics as
   `status=unsupportedEndpoint` with `payableCount=0`. That identifier is
   the SDK's, not Bitkit's. Bitkit's own returned case is
   `PublicPaykitPaymentLaunchResult.noEndpoint`
   (`PublicPaykitService.swift:34-44` at both pins: `.opened` /
   `.noEndpoint` / `.notOpened` / `.waitingForUpdatedPaymentList`).
   `unsupportedEndpoint` has zero hits in the Bitkit Swift tree.

The paykit-server fork fix is `1a7f242b7224b99fafd21f184150e910341a28c4`
("Advertise network-correct endpoint identifiers and JSON payloads") on
`BitcoinErrorLog/paykit-server`. That is a Paykit ask,
already written up for that team. The Bitkit-side consequence is: **these
three shapes are de facto required for any issuer that wants Bitkit to
pay** (with the lightning identifier carve-out above). If that is
intentional, it belongs in a wallet-interop note next to the spec. If it
is accidental strictness, issuers will keep discovering it the way we did.

Incoming `init?` is more than the two issuer shapes that land there. At
`9b51fac3:28-47` (and on the incoming/actionable path at `4120f207:62-87`)
the same initializer also returns `nil` when `localRole != .payer`,
`state != .proposed`, terms are missing, `recurrence != nil`, the amount
is unparseable or zero (more than 8 decimal places, overflow guard
`amountSats <= UInt64.max / 1000`), or `proposalExpiresAt` is already
past. At `4120f207` a history path relaxes state / empty-identifier /
expiry when `requiresActionableRequest` is false; incoming
`PaykitPaymentRequest(record:)` still requires the actionable gates.

**Two silences, not one.**

- **Parse-time.** `synchronize()` feeds records through
  `PaykitPaymentRequest.init?` via `compactMap`
  (`PaykitPaymentRequestService.swift:179-181` at `9b51fac3`; incoming
  compactMap at `:352-354` at `4120f207`). A record that fails any `init?`
  gate is dropped with **zero log output** and never enters presentation
  retry.
- **Open-time.** Only requests that parsed are candidates for
  `beginPaymentRequest`. `AppScene` defers when the result is not
  `.opened` (`AppScene.swift:810-814` at `9b51fac3`; `:838-840` at
  `4120f207`). At `9b51fac3` that path backs off
  `[30, 60, 120, 300]` and, after the fifth attempt, logs one line
  (`Stopped retrying incoming Paykit payment request after 5 presentation
  attempts`) and stops (`PaykitPaymentRequestService.swift:226` and
  `:330-332`). No toast, no sheet. Contact-initiated pay *does* toast
  (`ContactDetailView` / `AddContactView` / `SendContactSelectView` use
  `contactPaymentFailureMessageKey`). Incoming Payment Request
  presentation does not. Temporary `WALLETLEG` logs on a local Debug build
  were required to see the SDK `UnsupportedEndpoint` status.

  At `4120f207` the retry table changed: fourteen 2-second delays, then
  120-second repeats for automatic presentations; the stop-and-log line
  fires only for *requested* presentations
  (`presentationRetryDelays` / `automaticPresentationRetryDelay` at
  `:572-573`, `:857-883`). Parse-time remains silent. Open-time still
  does not toast, though the defer path now emits a `Logger.debug` line
  (`AppScene.swift:839`) that did not exist at `9b51fac3`.

---

## 3. Bitkit iOS behavior observed on the live wallet leg

Source unless noted: `docs/wallet-leg.md` in
`BitcoinErrorLog/pubky-payment-rails` at `a4d70c8`, plus the synonymdev
tree at `9b51fac3`, with current-master notes where the code moved.

### 3.1 Companion claim (seller): PASS on iOS; Android code exists, unrun

`x-bitkit-claim=watch-only-account-v1` on the Paykit `/setup` `authUrl`.
Bitkit iOS showed the dedicated watch-only consent step
(`PubkyAuthApprovalSheet`, testIDs `PubkyAuthWatchOnlyConsent` /
`PubkyAuthWatchOnlyApprove`), exported an xpub, and the deployed
paykit-server accepted the claim (HTTP 200 on `setup-poll`). No spending
authority left the wallet.

Contract as you document it:
`Docs/watch-only-account-claim-v1.md` (iOS tree) and
`Bitkit/Models/PubkyAuthRequest.swift`
(`PubkyAuthClaim.watchOnlyAccountV1`, capabilities
`/pub/paykit/v0/bitkit/server/:rw` and
`/pub/paykit/v0/private/bitkit/server/:rw`).

That doc says the contract is implemented by Bitkit iOS **and Android**.
At `efc9bcd65` (2026-07-30) that was not true of the Android tree: `rg`
over `app/src/main` found no `x-bitkit-claim`, `watch-only-account-v1`,
or companion-claim approval surface (hardware "watch-only" there is
Trezor xpub tracking). Current `origin/master` `9182771b` implements the
claim (`PubkyAuthClaim.WATCH_ONLY_ACCOUNT_V1`,
`QUERY_PARAMETER = "x-bitkit-claim"`, `parseBitkitClaim`, error objects
in `app/src/main/java/to/bitkit/models/PubkyAuthRequest.kt`; store / repo
/ coordinator / `PubkyAuthApprovalSheet` / `WatchOnlyAccountsScreen`) and
incoming Payment Request presentation
(`PaykitPaymentRequestRepo.kt` with
`PaykitPaymentRequestDirection.Incoming`, `markPresented`, accept/reject;
`repositories/PaykitPaymentRequestPresentationStore.kt`;
`ui/screens/paymentrequests/PaymentRequestsScreen.kt`). Watch-only
accounts landed 2026-08-03 (`6f3134e1`); payment-request UI 2026-08-27.
The doc does not overstate current master. We have not **run** the
Android path, so runtime behavior stays unproven. The 2026-08-22 live
proof was iOS; seller-on-phone is not an iOS-only code gap on current
master. Whether that Android surface is in a shipped release is §10
ask 4.

### 3.2 `pubkyauth://` is not a Bitkit iOS URL type

`Bitkit/Info.plist` registers `CFBundleURLSchemes` exactly: `bitkit`,
`bitcoin`, `BITCOIN`, `lightning`, `LIGHTNING`, `lnurl`, `lnurlw`,
`lnurlp`, `lnurlc` (no uppercase LNURL variants, while `BITCOIN` /
`LIGHTNING` exist — relevant to §10 asks 7–8). `pubkyauth` appears only
under `LSApplicationQueriesSchemes`. We could not deep-link the locks /
Paykit setup URLs into Bitkit on the simulator. The workaround was
`simctl pbcopy` into the in-app scanner.

Android `AndroidManifest.xml` at `9182771b` registers
`android:scheme="pubkyauth"` on the VIEW/BROWSABLE filter of
`.ui.MainActivityPubkyAuth` (same file also registers `lightning` /
`bitcoin` / `bitkit`). We did not run the Android claim path, so whether
that filter actually opens the approval sheet is **unproven**.

### 3.3 Payment requests only flow from linked peers

The payment-request poll is
`sdk.receivePrivateMessagesFromLinkedPeers()` in
`PaykitPaymentRequestService.swift:176` at `9b51fac3` (`:348` at
`4120f207`). The matching call in `PrivatePaykitService+Contacts.swift`
(`:511` / `:513` at `9b51fac3`) is the contacts-drain path, not the
payment-request poll. The buyer had to add the creator as a contact
before anything arrived. Until then, nothing is polled. That matched the
product once we knew it; it is easy to misread as "the server never sent
the request."

### 3.4 Stale Electrum tip poisons nLockTime

A buyer wallet that briefly synced Bitkit's default staging-regtest
Electrum (height ~160623) before the Fulcrum override was applied kept
that height as tip. ldk-node anti-fee-sniping then stamped
`nLockTime=160623`. The deployed chain was ~1114. bitcoind rejected the
broadcast as non-final. The UI showed "Bitcoin Sent." LDK logged a
successful Electrum broadcast. The daemon dropped the tx. Wallet state
lived in remote VSS, so reinstalling the app did not clear it.

The poisoned wallet was never recovered. An attempted remediation
(mining past the stale tip via `setmocktime`) was abandoned at ~71,563
of ~160,624 blocks. The remediation that worked is avoidance on a new
wallet: erase the simulator, seed `electrumServer` + `paykitUiEnabled`
**before first launch**, sync genesis → deployed chain. Finality run
(2026-08-22): swipe-to-pay broadcast
`cc85df0e24b54be353a57700429d144b35264c1af97f3de41c503dc52f1e4792`,
confirmed at height 77318, bundle `DHWG…NX0` completed, credentialed
read 200.

Whether the "Bitcoin Sent" / quiet drop is ldk-node, Electrum, or Bitkit
UI is **unproven**. Operationally: a wallet that has ever seen a taller
foreign tip on the same network name will produce non-final sends on a
shorter chain, and the user is told the send succeeded. On mainnet a
foreign tip requires headers with valid proof-of-work, so the practical
exposure is network/config mix-ups, not remote induction.

### 3.5 Homegate-provisioned write allowlist (not Bitkit)

Bitkit/Homegate staging identities could write `/pub/paykit/**` and got
`403 Write to this path is not allowed` on `/pub/locks.app/**` and
`/pub/pubky.app/**`. That blocked publishing marketplace content as the
Bitkit seller identity. Isolated with a delegated-session probe; the
locks server surfaced it as a 500 on `publish`.

That 403 string is the homeserver's per-user `allowed_write_paths` quota
(`FileIoError::WritePathForbidden` in pubky-homeserver 0.11, mapped in
`http_error.rs` to exactly `Write to this path is not allowed`). It is
not session-capability denial — that error reads `Session does not have
write access to path`. Homegate **may** stamp the quota onto
IP-verification signup tokens; staging Homegate's actual quota config is
**unproven** (the Homegate tree we read calls `GET generate_signup_token`
with no quota body). This is a **homeserver / Homegate** allowlist, not
a Bitkit bug. Listed so you are not asked to debug a 500 that is not
yours.

---

## 4. Pubky Ring identity-only approvals

The marketplace transaction-service session (`shop.pubky.app`) exchanges
a signed AuthToken for a bearer session and requests **zero**
capabilities: identity attestation, no homeserver scopes. That is the
least-privilege case working as designed.

Ring's approval screen then shows an empty permission list and nothing
else. A tester reported it as a suspected bug ("the session did not ask
for any permissions, but it still worked"). The client now pre-explains
this on its connect dialog; the explanation belongs in the signer, where
the trust decision happens. Leaving the list empty pushes app developers
toward requesting scopes they do not need just to look legitimate.

Draft write-up (not filed; Ring is outside `BitcoinErrorLog`):
<https://github.com/BitcoinErrorLog/pubky-app/blob/marketplace/pr25-ux/docs/spec-feedback/pubky-ring-identity-only-approvals.md>.
Suggested signer copy is in that doc. Scope-to-description mapping for
non-empty capability sets has no owner today; that is also spec-feedback
R7 on social/v1. Question in §10 ask 10.

---

## 5. Hypercolor payment handoff

Hypercolor does not embed Bitkit. It builds a BIP-21-style URI and asks
the OS to open it.

- `src/services/payments/walletHandoff.ts` was added in `61e10da`
  (2026-08-30), revised in `eb1e087`, and is present at HEAD `46b65dbc`
  (= `origin/main`). It emits `lightning:<bolt11>` or
  `bitcoin:<address>?amount=<btc>`. Lightning invoices are mainnet-only
  and amount-bound (exact match, or amountless with a warning). On-chain
  addresses are checksum-validated. Injection (`javascript:`, swapped
  amount, swapped destination) fails closed before `Linking.openURL`.
- iOS `ios/hypercolor/Info.plist:65-70` `LSApplicationQueriesSchemes` is
  `pubkyring`, `lightning`, `bitcoin`. Hypercolor's own URL scheme is
  `hypercolor` only.
- Proof row P4 (`docs/PROOF.md`) requires a registered handler to receive
  that exact URI. Preferred closer: one real payment via Bitkit. Dummy
  `proofData` hex does not close the row.

**Unlogged session observation (2026-08-30; not a Bitkit code defect):**
`Linking.openURL` of a `lightning:` URI on an iOS simulator with **no
wallet installed** never returned. It hung the live-proof suite for the
full timeout instead of taking the `canOpenURL == false` → "No wallet
installed" / copy-URI path in `openBuiltUri`. Hypercolor already queries
the schemes. The hang is RN/OS behavior when no handler exists. Whether
Bitkit **installed on the same simulator** is seen as a `lightning:`
handler, and whether an incoming URI opens Send with the bound amount,
is **unproven**. The marketplace wallet leg never used inter-app deep
links; it used the in-app scanner and the in-app Payment Request sheet.

Bitkit already registers `lightning` / `LIGHTNING` / `bitcoin` /
`BITCOIN` (iOS `Info.plist`, Android `AndroidManifest.xml`). What is
unproven is the incoming-URI contract from another app, including
whether `amount` is honored and what happens on network mismatch
(Hypercolor currently emits mainnet invoices only). A `bitkit:` URI with
a payment-request reference is optional; we are not blocked on it.
Questions in §10 asks 7–8.

---

## 6. Our Bitkit-owned forks are not product forks

`BitcoinErrorLog` has GitHub forks of `bitkit-ios`, `bitkit-android`,
`bitkit-core`, and `bitkit`. They are not where the marketplace or
Hypercolor logic lives.

| Local checkout of | Remote (`git remote -v`) | HEAD (verified) | What it is |
| --- | --- | --- | --- |
| `BitcoinErrorLog/bitkit-ios` | `BitcoinErrorLog/bitkit-ios` | `f0382b790ccf9e8370957a801f4038c8fa49610c` (2026-03-26, "disable all automatic workflow triggers") | Shallow clone (depth 1), so only the HEAD commit is present locally. Both fork remotes carry full history. Treat as a CI-disabled snapshot, not a feature branch. |
| `BitcoinErrorLog/bitkit-core` | `BitcoinErrorLog/bitkit-core` | `92461042957847a43a35346b659d62425c0b5fab` (2026-02-07, "chore: update Rust code") | Same shape locally (shallow, depth 1). Tree still has `src/modules/paykit` and `pubky_sdk`. Current `synonymdev/bitkit-core` has `pubky` (no `paykit` module) and is a different line. |
| `BitcoinErrorLog/bitkit-android` (archived experiment) | `BitcoinErrorLog/bitkit-android` | `4154c7c44696fe4a72bbcfc9ecae034a293d76e4` (2026-03-26, same "disable all automatic workflow triggers") | Full history. HEAD is the CI-disable commit. GitHub `BitcoinErrorLog/bitkit-android` matches this SHA. |
| `BitcoinErrorLog/bitkit` | `BitcoinErrorLog/bitkit` | `4c967f7af8a9368eece05ee87202fe40f32cd755` | RN production app, last commit 2025-11-27. Unused by us. Working tree: mass mode-churn (exFAT) and a rewritten README; HEAD matches remote master. |

February 2026 local session notes (not in any repo you can read) describe
Paykit wiring inside those BEL trees. That work is **not** on current
`synonymdev` master as a delta we own, and the BEL HEADs above are not
something we will rebase onto you. Ignore them.

**bitkit-core `pubky` module.** `AGENTS.md` on `synonymdev/bitkit-core`
lists `src/modules/pubky` (`CLAUDE.md` is a symlink to `AGENTS.md`).
History on that clone: `25ced3b3` "feat: add pubky module" and later
Homegate / profile / contacts commits, all on `origin/master`. Not a
local add.

**Uncommitted iOS diagnostics** (vibes-dev clone only, not pushed):
`AppScene.swift`, `PaykitPaymentRequestService.swift`,
`PrivatePaykitService+Payments.swift`, `PubkyService.swift`. They log
resolve status, candidate identifier/payload, and intake batches under
the `WALLETLEG` prefix. Useful to us; not a request that you take them.

---

## 7. What we built around Bitkit, and why

- **Protocol proof without the app.** `paykit-reader-demo` + a regtest
  bitcoind pay. That is how `payments-env/` stays green. It is also why
  three issuer defects reached staging: the demo asserted the same shapes
  the server emitted, so server and reader drifted from the spec
  together. The demo was strict — just strict against the wrong
  reference. We will not ask you to become that demo.
- **Issuer-side interop on the paykit-server fork**, not in Bitkit.
  Network identifiers, lowercase `btc`, JSON payloads. See the Paykit
  brief.
- **Fiat (Stripe / PayPal)** never touches Bitkit. Bitkit is the Bitcoin
  wallet leg only.
- **Hypercolor execution is BIP-21, not an in-app Paykit Payment Request.**
  Chat already has Paykit PAMs. Binding those to Bitkit's incoming-request
  sheet would require a shared contact / Encrypted Link / request id we
  have not designed. URI handoff is the seam we chose so Bitkit can stay a
  black-box wallet.
- **Marketplace seller onboard in the browser** uses a paykit-server
  watch-only claim that does **not** run the Bitkit companion binary
  (`POST /v0/accounts/claim`). That exists because a browser seller cannot
  hold the identity secret or run Bitkit (in that flow the identity key is
  held by paykit-server; the Bitcoin side remains watch-only xpub). It is
  a Paykit Server extension, asked of that team, not of you. Bitkit's
  companion path remains the phone-wallet path we proved.

Umbrella `README.md` and `SUMMARY.md` are current on the 2026-08-22
wallet-leg proof.

---

## 8. Open and unproven

- Exact `bitkit-ios` commit of the 2026-08-22 Debug build. Unrecorded.
  Behavior above was re-checked against `9b51fac3`; incoming filters
  unchanged in substance at `4120f207`.
- Inter-app `lightning:` / `bitcoin:` into a Bitkit install (device or
  simulator). Unproven.
- Android companion claim and Android incoming Payment Request
  presentation: **present** at `9182771b`; **not run**; not known to be
  in a shipped release or tag.
- Root cause of the stale-tip "Bitcoin Sent" / non-final drop. Unproven.
  Poisoned wallet never recovered (§3.4).
- Noise outbox slot-1 gap (one wallet-leg run; the finality run did not
  reproduce). That is paykit-server / pubky-noise, not Bitkit. Already on
  the Paykit brief.
- Guarded-content 404 after a day. Lock Server / homeserver, not Bitkit.
  Status as corrected in `wallet-leg.md` at `a4d70c8`.

No independent security review of this integration. Pre-1.0 rails.
Regtest coins only.

---

## 9. What we are not asking for

The `BitcoinErrorLog/bitkit*` forks are not proposed Bitkit patches.
They are CI-disabled or stale snapshots (§6). The marketplace and
Hypercolor do not ship them.

The Bitkit RN→native migration-review tree is not a git repo. It is a
2026-01-14 RN → native migration audit. It has no marketplace, Paykit
Payment Request, or Hypercolor content.

The uncommitted `WALLETLEG` logs are local diagnostics on a synonymdev
clone.

Homegate path 403s are not a Bitkit bug (§3.5).

`BitcoinErrorLog/bitkit` (RN) is unused.

---

## 10. Asks

Each item is a real question. "Not now" is a valid answer.

1. **De facto issuer contract.** Will you document (or point us at) the
   three shapes in §2 — on-chain network-correct identifier (lightning
   identifiers `btc-lightning-bolt11` / `btc-lightning-lnurl` are
   accepted on any chain), lowercase `"btc"`, JSON
   `{"value":"<address>"}` — as the Bitkit requirement for Paykit
   issuers? We already patched the server fork. A one-page note would
   stop the next issuer from repeating the false-green demo.

2. **Incoming-request rejection UX.** Two different silences (§2):
   (a) Should a request that fails `init?` (never presented, never
   logged) surface to the user at all?
   (b) Should an open-time failure (`beginPaymentRequest` not `.opened`,
   including Bitkit `.noEndpoint`) surface after retries exhaust — at
   `9b51fac3`, the fifth deferred attempt then one warning — given
   contact-pay already toasts?

3. **`pubkyauth://` on iOS.** Should Bitkit register `pubkyauth` in
   `CFBundleURLTypes` so a setup URL can open the approval sheet, or is
   "scan / paste only" the contract?

4. **Android claim / incoming-request shipping.** The surfaces exist at
   `9182771b` (§3.1). Are they in a shipped release or tag, and has
   anyone run them end-to-end?

5. **Linked-peers-only polling.** Is "add as contact before any Payment
   Request is received" a permanent invariant? If yes, we will keep
   documenting it as a buyer prerequisite. If you later poll unlinked
   counterparties, the marketplace copy should change.

6. **Stale-tip non-final send.** When Electrum broadcast succeeds and
   bitcoind drops a non-final tx, do you want the UI to stay on "Bitcoin
   Sent," or is a mempool/reject signal in scope? We are not attaching a
   failing test; we have the 2026-08-21 log, a poisoned wallet that was
   never recovered (abandoned `setmocktime` mine at ~71,563 / ~160,624),
   and the 2026-08-22 clean-wallet counterexample. VSS means reinstall
   does not clear it.

7. **External URI destination and amount.** If Bitkit is installed, will
   an incoming `lightning:<bolt11>` or `bitcoin:<addr>?amount=` from
   another app open Send with that destination and amount?

8. **`bitkit:` alternative.** If the supported contract is `bitkit:`
   plus a payment-request reference instead of BIP-21, what is the URI
   shape?

9. **Simulator as a proof target.** P4 cannot close on a sim with no
   wallet handler. Is "install Bitkit Debug on the same sim and open
   `lightning:`" a combination you expect to work, or should we only
   prove handoff on a physical device?

10. **Ring identity-only approvals.** When an AuthToken requests zero
    capabilities, should Ring's approval screen say that explicitly
    (identity proof, no homeserver access) instead of showing an empty
    permission list?
