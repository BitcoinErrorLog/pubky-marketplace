# Bitkit surface as used by the Pubky Marketplace and Hypercolor

**To:** maintainers of `synonymdev/bitkit`, `synonymdev/bitkit-ios`,
`synonymdev/bitkit-android`, and `synonymdev/bitkit-core`
**From:** the Pubky Marketplace + Hypercolor integrations (forks under
`BitcoinErrorLog`)
**Date:** 2026-09-01
**Status:** technical brief. Not a PR, not a demand list. Every SHA below was
checked with `git cat-file -e <sha>^{commit}` in the named checkout.

This document assumes you have not seen the marketplace or Hypercolor. It
covers only the Bitkit surface we actually ran: what we run, what changed in
our forks of Bitkit-owned repos, what looks like yours to fix, what we
deliberately built around you, and what you can ignore.

Nothing here has had an independent security review. Bitcoin is **regtest
only**. Where a cause is unproven, it is labeled that way.

---

## 1. What we run

Two products touch Bitkit. They use different seams.

- **Marketplace Bitcoin rail (regtest).** Locks entitlement + Paykit Server
  invoice observation + **Bitkit iOS as the buyer wallet**. Proven live on
  2026-08-22: seller companion claim, in-app Payment Request, swipe-to-pay,
  on-chain confirmation. Written up in
  `BitcoinErrorLog/pubky-payment-rails` `docs/wallet-leg.md` (checkout
  `/Users/johncarvalho/work/pubky-payment-rails`, HEAD
  `402f1a1423e7f8cf192b10415395125ecb6c6cd4`). Screens and logs live in
  `~/work/bitkit-wallet-leg/` on the machine that ran it (not a git repo).
- **Hypercolor (RN chat).** Encrypted-Link payment *messages* are Paykit. The
  *execution* path is a validated `lightning:` / `bitcoin:` URI handed to
  whatever wallet is registered (`walletHandoff.ts`). Bitkit is the preferred
  closer for proof row P4. That row is **not green**. See §4.

The local compose stack in this umbrella (`payments-env/`) does **not** run
Bitkit. It uses `paykit-reader-demo` to play Bitkit's protocol role. That is
why the rails looked green before a real wallet was tried.

| Piece | Git | Branch / pin | What it is |
| --- | --- | --- | --- |
| Wallet-leg target | `synonymdev/bitkit-ios` (local clone, not a product fork) | `master` HEAD `9b51fac39208ec24bc4b90ec2194a9f53fb301a2` | Native iOS. Debug/regtest. Companion claim + incoming Payment Request UI. Exact SHA of the 2026-08-22 Debug binary is **unrecorded**. |
| Android (read, not used for the wallet leg) | `synonymdev/bitkit-android` | `master` HEAD `efc9bcd655b07209dd53106f3b1fdfdb34f3180c` | Paykit contact pay exists. No `x-bitkit-claim` / incoming Payment Request presentation found in `app/src/main`. |
| bitkit-core (read) | `synonymdev/bitkit-core` | `master` HEAD `7e9849873a4f2600ef1c7fcfa0953c914d54f0f5` | `src/modules/pubky` is **upstream** (`25ced3b3ab070bc187c629e163327bc5d8d040bf`, 2026-03-04). We did not add it. |
| Paykit Server (deployed) | `BitcoinErrorLog/paykit-server` | checkout `/Users/johncarvalho/work/paykit-server-fork` | Fork of `pubky/paykit-server` @ `f38c7915e6b9b104e040773e78438f8aa984c46c`. Wallet-interop fixes exist because Bitkit rejected that revision's material (§2). |
| Staging rails | `BitcoinErrorLog/pubky-payment-rails` | Railway `pubky-marketplace-staging` | Lock Server + paykit-server + regtest bitcoind + Fulcrum. |
| Hypercolor | `BitcoinErrorLog/hypercolor` | checkout `/Users/johncarvalho/work/hypercolor` HEAD `46b65dbcc289a425c607eb698c8fb62aa1cd6902` | Chat app. Handoff at `src/services/payments/walletHandoff.ts`. |
| RN Bitkit (unused) | `BitcoinErrorLog/bitkit` | local `/Volumes/vibedrive/vibes-dev/bitkit` HEAD `4c967f7af8a9368eece05ee87202fe40f32cd755` | Stale production-app fork (last commit 2025-11-27). Marketplace and Hypercolor do not run it. |

Working copies we treat as **read-only synonymdev clones** (confirmed
`git remote -v`):

- `/Volumes/vibedrive/vibes-dev/bitkit-ios` → `synonymdev/bitkit-ios`
- `/Volumes/vibedrive/vibes-dev/bitkit-android` → `synonymdev/bitkit-android`
- `/Volumes/vibedrive/vibes-dev/bitkit-core` → `synonymdev/bitkit-core`

Each is on `master` tracking `origin/master`. No committed local divergence.
bitkit-ios has **uncommitted** diagnostic `WALLETLEG` log lines in four files
(§5). Those are not a proposed patch.

---

## 2. The wallet-interop filters (highest value)

Upstream paykit-server at `f38c7915` emitted payment material that Bitkit
silently dropped. Confirmed by a live Bitkit iOS run (2026-08-21/22), then
matched to your current filter code at `9b51fac3`. Three distinct filters.
Each is correct against the payment-requests / payment-endpoint-identifier
specs. Together they are the reason the demo reader was a false green.

1. **Network segment on the endpoint identifier.**
   `PaykitPaymentRequest.init?(record:)` keeps only identifiers that
   `PublicPaykitService.MethodId` knows, then requires
   `methodId.onchainNetwork == Env.network`
   (`Bitkit/Services/PaykitPaymentRequestService.swift` around the
   `supportedEndpointIdentifiers` helper). Debug builds are regtest, so
   `btc-bitcoin-p2wpkh` is discarded and `btc-regtest-p2wpkh` is kept.
   Method ids live in `Bitkit/Services/PublicPaykitService.swift`
   (`btc-bitcoin-p2wpkh`, `btc-regtest-p2wpkh`, and the testnet/signet
   siblings).

2. **Asset `"btc"` (lowercase, exact).**
   Same initializer: `terms.amount.asset == "btc"`. Uppercase `"BTC"` makes
   `init?` return `nil`. The private-pay path also constructs
   `PaymentAmountContext(value:asset:)` with asset `"btc"`
   (`Bitkit/Services/PrivatePaykitService+Payments.swift`).

3. **Endpoint payload as JSON `{"value":"<address>"}`.**
   `PublicPaykitService.parsePayload` accepts only a JSON object with a
   non-empty `value` string. A bare address string returns `nil`, so
   `parseEndpoint` drops the candidate. Android does the same:
   `PublicPaykitRepo.parseEndpoint` decodes
   `PaymentEndpointPayload(value, min?, max?)` and returns null on failure
   (`app/src/main/java/to/bitkit/repositories/PublicPaykitRepo.kt`).

The paykit-server fork fix is `1a7f242b7224b99fafd21f184150e910341a28c4`
("Advertise network-correct endpoint identifiers and JSON payloads") in
`/Users/johncarvalho/work/paykit-server-fork`. That is a Paykit ask, already
written up for that team. The Bitkit-side consequence is: **these three
shapes are de facto required for any issuer that wants Bitkit to pay.** If
that is intentional, it belongs in a wallet-interop note next to the spec.
If it is accidental strictness, issuers will keep discovering it the way we
did.

**Presentation of a rejected request is silent.** Incoming requests that
fail `beginPaymentRequest` (including `noEndpoint` /
`unsupportedEndpoint`) are `deferPresentation`'d. After four backoff delays
`[30, 60, 120, 300]` the fifth failure logs one line
(`Stopped retrying incoming Paykit payment request after 5 presentation
attempts`) and stops. No toast, no sheet. Contact-initiated pay *does*
toast (`ContactDetailView` / `AddContactView` /
`SendContactSelectView` use `contactPaymentFailureMessageKey`). Incoming
Payment Request presentation does not. Temporary `WALLETLEG` logs on a
local Debug build were required to see
`status=unsupportedEndpoint ... payableCount=0`.

We are not asserting these filters are bugs. We are asserting they are
load-bearing and invisible to the user when they fire on an incoming
request.

---

## 3. Bitkit iOS behavior observed on the live wallet leg

Source unless noted: `docs/wallet-leg.md` in
`BitcoinErrorLog/pubky-payment-rails`, plus the current synonymdev tree at
`9b51fac3`.

### 3.1 Companion claim (seller): PASS

`x-bitkit-claim=watch-only-account-v1` on the Paykit `/setup` `authUrl`.
Bitkit showed the dedicated watch-only consent step
(`PubkyAuthApprovalSheet`, testIDs `PubkyAuthWatchOnlyConsent` /
`PubkyAuthWatchOnlyApprove`), exported an xpub, and the deployed
paykit-server accepted the claim (HTTP 200 on `setup-poll`). No spending
authority left the wallet.

Contract as you document it:
`Docs/watch-only-account-claim-v1.md` and
`Bitkit/Models/PubkyAuthRequest.swift`
(`PubkyAuthClaim.watchOnlyAccountV1`, capabilities
`/pub/paykit/v0/bitkit/server/:rw` and
`/pub/paykit/v0/private/bitkit/server/:rw`).

That same doc says the contract is "implemented by Bitkit iOS **and
Android**." On current `synonymdev/bitkit-android` `efc9bcd65`,
`rg` over `app/src/main` finds **no** `x-bitkit-claim`,
`watch-only-account-v1`, or companion-claim approval surface. Hardware
"watch-only" in that tree is Trezor xpub tracking, a different feature.
Whether Android later grew the claim and we are looking at a lag, or the
doc overstates Android, is **unproven** beyond "not in this SHA."

### 3.2 `pubkyauth://` is not a Bitkit iOS URL type

`Bitkit/Info.plist` registers `CFBundleURLSchemes`: `bitkit`, `bitcoin`,
`BITCOIN`, `lightning`, `LIGHTNING`, `lnurl*`. `pubkyauth` appears only
under `LSApplicationQueriesSchemes`. We could not deep-link the locks /
Paykit setup URLs into Bitkit on the simulator. The workaround was
`simctl pbcopy` into the in-app scanner.

Android `AndroidManifest.xml` **does** register `android:scheme="pubkyauth"`
on the VIEW/BROWSABLE filter (same file also registers `lightning` /
`bitcoin` / `bitkit`). We did not run the Android claim path, so whether
that filter actually opens the approval sheet is **unproven**.

### 3.3 Payment requests only flow from linked peers

Bitkit polls `receivePrivateMessagesFromLinkedPeers`
(`PrivatePaykitService+Contacts.swift`). The buyer had to add the creator
as a contact before anything arrived. Until then, nothing is polled. That
matched the product once we knew it; it is easy to misread as "the server
never sent the request."

### 3.4 Stale Electrum tip poisons nLockTime

A buyer wallet that briefly synced Bitkit's default staging-regtest
Electrum (height ~160623) before the Fulcrum override was applied kept that
height as tip. ldk-node anti-fee-sniping then stamped
`nLockTime=160623`. The deployed chain was ~1114. bitcoind rejected the
broadcast as non-final. The UI showed "Bitcoin Sent." LDK logged a
successful Electrum broadcast. The daemon dropped the tx. Wallet state
lived in remote VSS, so reinstalling the app did not clear it.

Remediation that worked: erase the simulator, seed `electrumServer` +
`paykitUiEnabled` **before first launch**, sync genesis → deployed chain.
Finality run (2026-08-22): swipe-to-pay broadcast
`cc85df0e24b54be353a57700429d144b35264c1af97f3de41c503dc52f1e4792`,
confirmed at height 77318, bundle `DHWGS5V5A3RCQ7YGQAHWVVVNX0` completed,
credentialed read 200.

Whether the "Bitcoin Sent" / quiet drop is ldk-node, Electrum, or Bitkit
UI is **unproven**. The operational rule is yours to keep or change: a
wallet that has ever seen a taller foreign tip on the same network name
will produce non-final sends on a shorter chain, and the user is told the
send succeeded.

### 3.5 Homegate-provisioned write allowlist (not Bitkit)

Bitkit/Homegate staging identities could write `/pub/paykit/**` and got
`403 Write to this path is not allowed` on `/pub/locks.app/**` and
`/pub/pubky.app/**`. That blocked publishing marketplace content as the
Bitkit seller identity. Isolated with a delegated-session probe; the locks
server surfaced it as a 500 on `publish`. This is a **homeserver /
Homegate** allowlist, not a Bitkit bug. Listed so you are not asked to
debug a 500 that is not yours.

---

## 4. Hypercolor payment handoff

Hypercolor does not embed Bitkit. It builds a BIP-21-style URI and asks the
OS to open it.

- `src/services/payments/walletHandoff.ts` (present at Hypercolor HEAD
  `46b65dbc`; introduced on the line that includes
  `a0937be84efffe2a1be08aef3cbe2f541588a4ca`): `lightning:<bolt11>` or
  `bitcoin:<address>?amount=<btc>`. Lightning invoices are mainnet-only
  and amount-bound (exact match, or amountless with a warning). On-chain
  addresses are checksum-validated. Injection (`javascript:`, swapped
  amount, swapped destination) fails closed before `Linking.openURL`.
- iOS `Info.plist` queries `lightning` and `bitcoin`
  (`LSApplicationQueriesSchemes`). Hypercolor's own URL scheme is
  `hypercolor` only.
- Proof row P4 (`docs/PROOF.md`) requires a registered handler to receive
  that exact URI. Preferred closer: one real payment via Bitkit. Dummy
  `proofData` hex does not close the row.

**Simulator observation (session, 2026-08-30 era; not a Bitkit code
defect):** `Linking.openURL` of a `lightning:` URI on an iOS simulator
with **no wallet installed** never returned. It hung the live-proof suite
for the full timeout instead of taking the `canOpenURL == false` → "No
wallet installed" / copy-URI path in `openBuiltUri`. Hypercolor already
queries the schemes. The hang is RN/OS behavior when no handler exists.
Whether Bitkit **installed on the same simulator** is seen as a
`lightning:` handler, and whether an incoming URI opens Send with the
bound amount, is **unproven**. The marketplace wallet leg never used
inter-app deep links; it used the in-app scanner and the in-app Payment
Request sheet.

What Hypercolor needs from Bitkit, if you want that row closable:

- Keep registering `lightning` / `LIGHTNING` / `bitcoin` / `BITCOIN` (you
  already do, iOS `Info.plist` and Android `AndroidManifest.xml`).
- A stated contract for an incoming `lightning:<bolt11>` or
  `bitcoin:<addr>?amount=` from another app: which screen, whether
  `amount` is honored, what happens on network mismatch (Hypercolor
  currently emits mainnet invoices only).
- Optional: a `bitkit:` URI with a payment-request reference, if you would
  rather own the request object than BIP-21. We are not blocked on that.

---

## 5. Our Bitkit-owned forks are not product forks

`BitcoinErrorLog` has GitHub forks of `bitkit-ios`, `bitkit-android`,
`bitkit-core`, and `bitkit`. They are not where the marketplace or
Hypercolor logic lives.

| Checkout | Remote (`git remote -v`) | HEAD (verified) | What it is |
| --- | --- | --- | --- |
| `/Users/johncarvalho/work/bitkit-ios-bel` | `BitcoinErrorLog/bitkit-ios` | `f0382b790ccf9e8370957a801f4038c8fa49610c` (2026-03-26, "disable all automatic workflow triggers") | Local clone stores **one** commit (no parent object). GitHub API reports a parent; we could not `cat-file` that parent here. Treat as a CI-disabled snapshot, not a feature branch. |
| `/Users/johncarvalho/work/bitkit-core` | `BitcoinErrorLog/bitkit-core` | `92461042957847a43a35346b659d62425c0b5fab` (2026-02-07, "chore: update Rust code") | Same shape locally (one commit). Tree still has `src/modules/paykit` and `pubky_sdk`. Current `synonymdev/bitkit-core` has `pubky` (no `paykit` module) and is a different line. |
| `/Volumes/vibedrive/vibes-dev/_archive/bitkit-experiment-2026-07-31/bitkit-android` | `BitcoinErrorLog/bitkit-android` | `4154c7c44696fe4a72bbcfc9ecae034a293d76e4` (2026-03-26, same "disable all automatic workflow triggers") | Full history. HEAD is the CI-disable commit. GitHub `BitcoinErrorLog/bitkit-android` matches this SHA. |
| `/Volumes/vibedrive/vibes-dev/bitkit` | `BitcoinErrorLog/bitkit` | `4c967f7af8a9368eece05ee87202fe40f32cd755` | RN production app, last commit 2025-11-27. Unused by us. |

February 2026 session notes
(`session-summaries/session-2026-02-07-170000-pubky-stack-finalization-complete.md`,
`session-2026-02-08-164010-android-contact-avatars.md`) describe Paykit
wiring inside those BEL trees. That work is **not** on current
`synonymdev` master as a delta we own, and the BEL HEADs above are not
something we will rebase onto you. Ignore them.

**bitkit-core `pubky` module.** `CLAUDE.md` / `AGENTS.md` on
`synonymdev/bitkit-core` list `src/modules/pubky`. History on that clone:
`25ced3b3` "feat: add pubky module" and later Homegate / profile /
contacts commits, all on `origin/master`. Not a local add.

**Uncommitted iOS diagnostics** (vibes-dev clone only, not pushed):
`AppScene.swift`, `PaykitPaymentRequestService.swift`,
`PrivatePaykitService+Payments.swift`, `PubkyService.swift`. They log
resolve status, candidate identifier/payload, and intake batches under the
`WALLETLEG` prefix. Useful to us; not a request that you take them.

---

## 6. What we built around Bitkit, and why

- **Protocol proof without the app.** `paykit-reader-demo` + a regtest
  bitcoind pay. That is how `payments-env/` stays green. It is also why
  three issuer defects reached staging: the demo accepted shapes Bitkit
  rejects. We will not ask you to become that demo.
- **Issuer-side interop on the paykit-server fork**, not in Bitkit. Network
  identifiers, lowercase `btc`, JSON payloads. See the Paykit brief.
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
  hold the identity secret or run Bitkit. It is a Paykit Server extension,
  asked of that team, not of you. Bitkit's companion path remains the
  phone-wallet path we proved.

`payments-env/README.md` in this umbrella still says the wallet-app UX
leg is unproven. That paragraph is **stale** as of 2026-08-22
(`SUMMARY.md` and `README.md` at repo root are current). Ignore the
compose README on that point.

---

## 7. Open and unproven

- Exact `bitkit-ios` commit of the 2026-08-22 Debug build. Unrecorded.
  Behavior above was re-checked against today's `9b51fac3` source.
- Inter-app `lightning:` / `bitcoin:` into a Bitkit install (device or
  simulator). Unproven.
- Android companion claim and Android incoming Payment Request
  presentation. Absent from `efc9bcd65` `app/src/main` as searched. Not
  run.
- Root cause of the stale-tip "Bitcoin Sent" / non-final drop. Unproven.
- Noise outbox slot-1 gap (one wallet-leg run; the finality run did not
  reproduce). That is paykit-server / pubky-noise, not Bitkit. Already on
  the Paykit brief.
- Guarded-content 404 after a day. Lock Server / homeserver, not Bitkit.

No independent security review of this integration. Pre-1.0 rails.
Regtest coins only.

---

## 8. What we are not asking for

**Do not investigate the `BitcoinErrorLog/bitkit*` forks as if they were
our proposed Bitkit patches.** They are CI-disabled or stale snapshots
(§5). The marketplace and Hypercolor do not ship them.

**Do not investigate `/Volumes/vibedrive/vibes-dev/bitkit-migration-review`.**
It is not a git repo. It is a 2026-01-14 RN → native migration audit
(`AUDIT_FINDINGS.md`, `REMEDIATION_PLAN.md`) about LDK channel restore and
passphrase handling. It has no marketplace, Paykit Payment Request, or
Hypercolor content.

**Do not take the uncommitted `WALLETLEG` logs.** They are local
diagnostics on a synonymdev clone.

**Do not treat Homegate path 403s as a Bitkit bug.** §3.5.

**Do not treat `BitcoinErrorLog/bitkit` (RN) as in play.** Unused.

---

## 9. Asks

Each item is a real question. "Not now" is a valid answer.

1. **De facto issuer contract.** Will you document (or point us at) the
   three filters in §2 — network-correct identifier, lowercase `"btc"`,
   JSON `{"value":"<address>"}` — as the Bitkit requirement for Paykit
   issuers? We already patched the server fork. A one-page note would stop
   the next issuer from repeating the false-green demo.

2. **Incoming-request rejection UX.** When an incoming Payment Request
   fails those filters (`noEndpoint` / `unsupportedEndpoint` / empty
   accepted identifiers), should the user see anything, or is silent defer
   + one log line after five attempts the intended product? Contact-pay
   already toasts.

3. **`pubkyauth://` on iOS.** Should Bitkit register `pubkyauth` in
   `CFBundleURLTypes` so a setup URL can open the approval sheet, or is
   "scan / paste only" the contract? Android already declares the scheme.

4. **Android companion claim.** Does `Docs/watch-only-account-claim-v1.md`
   overstate Android, or is the claim surface on a branch we did not pull?
   Marketplace seller-on-phone today is iOS-only because of this.

5. **Android incoming Payment Requests.** Is an in-app incoming-request
   sheet on the Android roadmap, or should issuers assume iOS-only for
   that path?

6. **Linked-peers-only polling.** Is "add as contact before any Payment
   Request is received" a permanent invariant? If yes, we will keep
   documenting it as a buyer prerequisite. If you later poll unlinked
   counterparties, the marketplace copy should change.

7. **Stale-tip non-final send.** When Electrum broadcast succeeds and
   bitcoind drops a non-final tx, do you want the UI to stay on "Bitcoin
   Sent," or is a mempool/reject signal in scope? We are not attaching a
   failing test; we have the 2026-08-21 log + the 2026-08-22 clean-wallet
   counterexample.

8. **Hypercolor / BIP-21 handoff.** If Bitkit is installed, will an
   incoming `lightning:<bolt11>` or `bitcoin:<addr>?amount=` from another
   app open Send with that destination and amount (including on a
   simulator)? If the supported contract is `bitkit:` plus a reference
   instead, what is the URI shape?

9. **Simulator as a proof target.** P4 cannot close on a sim with no
   wallet handler. Is "install Bitkit Debug on the same sim and open
   `lightning:`" a combination you expect to work, or should we only
   prove handoff on a physical device?
