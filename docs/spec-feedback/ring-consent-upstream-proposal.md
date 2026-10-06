# Pubky Ring: consent quality for `pubkyauth://` requests

Upstream ask for `pubky/pubky-ring`. Four proposals (A–D), independently shippable.

## Provenance of every citation below

| Repo | Path root | Ref read | Date |
| --- | --- | --- | --- |
| Pubky Ring (fork) | `/Volumes/vibedrive/vibes-dev/pubky-ring` | `bba331c` (working tree) | 2026-09-01 |
| Pubky Ring (upstream) | same repo, `upstream/main` | `8154dfa` | 2026-09-04 |
| pubky-core | `/Volumes/vibedrive/vibes-dev/pubky-core` | `21ca23a` branch `feat/molt-drop` | 2026-09-03 |
| Bitkit Android | `/Volumes/vibedrive/vibes-dev/bitkit-android` | `9182771` branch `master` | 2026-08-31 |
| Bitkit iOS | `/Volumes/vibedrive/vibes-dev/bitkit-ios` | `9b51fac` branch `master` | 2026-08-20 |
| Shop design doc | `/Users/johncarvalho/work/mp-ux` branch `marketplace/pr25-ux` | working tree | 2026-09-08 |

The fork moved the permission sheet from `src/screens/ConfirmAuth.tsx` (upstream) to `src/components/ConfirmAuth.tsx` (fork). Where a claim matters for the upstream ask, both line numbers are given. Nothing in this document is fork-only behaviour unless it says so.

## 1. Summary

Ring's permission sheet renders whatever capability list the requesting app sends, including an empty one, and the Authorize button is never conditioned on that list.
`Capabilities::from_url` silently discards malformed entries, so a request that displays as "no permissions" and a request whose entries were all dropped are indistinguishable to the user.
Ring's Auto Auth is one global switch that approves every future request from every app, and Ring stores nothing about which app it just authorized, so there is no per-app memory to make a returning app cheaper or a malicious one visible.
Bitkit Android and Bitkit iOS reimplement capability parsing and rendering with looser rules than pubky-core, so the same URL can display differently on three signers.
Proposals: (A) reject empty and malformed capability strings at the signer; (B) one written spec for capability rendering, adopted by all three sheets; (C) per-app grant memory plus a Connected Apps screen; (D) audience-bound approval, analysed honestly against the dual-present interim that Shop already ships.

## 2. Observed problems

### P1. An empty capability list renders a blank section and is still approvable

Ring maps the capability array with no empty case (`src/components/ConfirmAuth.tsx:59-71`; upstream `src/screens/ConfirmAuth.tsx:200-204`). The section header still reads "Requested Permissions" (`src/components/ConfirmAuth.tsx:227-229`; `src/i18n/locales/en.json:74`). The Authorize button's only guard is `disabled={authorizing}` (`src/components/ConfirmAuth.tsx:255-263`; upstream `src/screens/ConfirmAuth.tsx:231-238`).

Bitkit Android: `PermissionsSection` is a bare `forEach` (`app/src/main/java/to/bitkit/ui/screens/profile/PubkyAuthApprovalSheet.kt:446-460`), and the Authorize button is unconditional (`…/PubkyAuthApprovalSheet.kt:335-355`).

Bitkit iOS: `permissionsSection` is a bare `ForEach` (`Bitkit/Views/Sheets/PubkyAuthApproval/PubkyAuthApprovalSheet.swift:274-284`), Authorize is unconditional (`…/PubkyAuthApprovalSheet.swift:171-187`).

User-visible consequence: the user is asked to authorize with their root identity key while the sheet shows an empty list, which reads as "this grants nothing" and is not what happens — the token is a valid identity proof for anyone who receives it.

### P2. iOS renders a sentence with a hole in it when the capability list is empty

`serviceText` joins `serviceNames` (`…/PubkyAuthApprovalSheet.swift:250-252`), and `serviceNames` is derived only from the capability paths (`Bitkit/Models/PubkyAuthRequest.swift:70-73`). With no capabilities the description composes to "A service is requesting permission to access and edit your  data." (`Bitkit/Resources/Localization/en.lproj/Localizable.strings:685-686`, joined at `…/PubkyAuthApprovalSheet.swift:256`).

Android has a fallback string for the same case, "Unknown service" (`…/PubkyAuthApprovalViewModel.kt:76-77`; `app/src/main/res/values/strings.xml:604-605`), so the two Bitkit platforms already disagree on the same input.

User-visible consequence: on iOS the consent sentence is grammatically broken and names nothing the user can evaluate.

### P3. Malformed capability entries are silently dropped, not surfaced

pubky-core requires exactly one `:` and a leading `/` (`pubky-common/src/capabilities.rs:250-256`), and `Capabilities::from_url` collects only entries that parse, dropping the rest without signal — the doc comment says so: "Invalid entries are ignored" (`pubky-common/src/capabilities.rs:358, 368-382`). The signer path Ring calls builds the token from exactly that (`pubky-sdk/src/actors/signer/auth.rs:46, 53`; the `From<&Url>` shim is `pubky-common/src/capabilities.rs:531-535`).

Bitkit's own parsers are looser than pubky-core: Android accepts any segment with a colon not in position 0 and never checks the leading `/` (`app/src/main/java/to/bitkit/models/PubkyAuthRequest.kt:133-142`); iOS checks only that path and access are non-empty (`Bitkit/Models/PubkyAuthRequest.swift:114-130`).

User-visible consequence: a request such as `caps=chessky:rw` displays as a granted folder named `chessky` on both Bitkit sheets, while pubky-core drops it, so the token that is actually minted carries zero capabilities — the sheet shows a permission that was never granted.

### P4. Auto Auth is global, all-or-nothing, and permanent until manually revoked

One boolean in settings (`src/types/settings.ts:4`; `src/store/shapes/settings.ts:10`), toggled by one switch (`src/screens/SettingsScreen.tsx:238-248`; upstream `src/screens/SettingsScreen.tsx:141-147`), read once per request with no scoping of any kind (`src/utils/actions/authAction.ts:61-70`; upstream `src/utils/actions/authAction.ts:98-108`). When true, `handleAutoAuth` signs and delivers with no sheet at all (`src/utils/actions/authAction.ts:83-113`).

The fork additionally auto-approves whenever `__DEV__` is true (`src/utils/e2eAutoApprove.ts:10-12`, consumed at `src/utils/actions/authAction.ts:61`). That is fork-only and out of scope for the upstream ask; it is listed so nobody mistakes it for stock behaviour.

User-visible consequence: a user who enables Auto Auth once for convenience with one app has silently pre-approved every future request from every app, including a request that arrives from a QR they did not initiate.

### P5. Ring stores nothing about the app it just authorized

`performAuth` calls `auth(authUrl, secretKey)` and returns (`src/utils/pubky.ts:611-658`, call at `:640`). Nothing about the relay, the capability set, or the time is written. The only `addSession` dispatches in the codebase are for Ring's own homeserver session, from signup and sign-in (`src/utils/pubky.ts:504-510` and `:562-568`), and the session model has no app identity field (`src/types/pubky.ts:1-6`).

The pubky-auth spec assumes the opposite: "the user can always access all active sessions and revoke any session that they don't like, all from the `Authenticator` app" (`docs/mdbook/src/spec/auth.md:120`).

User-visible consequence: a user cannot answer "what have I granted to this app, and when" from inside Ring, and every return visit by a known app costs the same full sheet as an unknown one.

### P6. Capability rendering is implemented three times with three sets of rules

Ring renders one row per capability with folder icon, path verbatim, and READ/WRITE derived by substring test (`src/components/ConfirmAuth.tsx:73-93`). Android trims one trailing slash and maps characters to "READ"/"WRITE" (`app/src/main/java/to/bitkit/models/PubkyAuthRequest.kt:48-63`, rendered at `…/PubkyAuthApprovalSheet.kt:462-484`). iOS does the same in Swift (`Bitkit/Models/PubkyAuthRequest.swift:35-49`, rendered at `…/PubkyAuthApprovalSheet.swift:286-299`).

The trust warnings have already drifted: Ring says "this relay, service, browser, or device" (`src/i18n/locales/en.json:76`), both Bitkit apps say "the service, browser, or device" with no mention of the relay (`app/src/main/res/values/strings.xml:609`; `Bitkit/Resources/Localization/en.lproj/Localizable.strings:696`). Ring displays the relay URL (`src/components/ConfirmAuth.tsx:219-224`); neither Bitkit sheet displays it at all.

User-visible consequence: the same authorization request produces materially different consent copy depending on which app the user happens to scan with, and the relay — the party that will actually receive the token — is invisible on two of the three.

### P7. The signer has no app identity to bind consent to

The `pubkyauth://` URL carries `relay`, `caps`, and `secret` and nothing else (`docs/mdbook/src/spec/auth.md:50-64`). The signer reads only `relay` and `secret` and ignores every other query parameter (`pubky-sdk/src/actors/signer/auth.rs:81-87`, the `_ => {}` arm). The AuthToken itself has no audience or origin field (`pubky-common/src/auth.rs:23-42`).

User-visible consequence: "shop.pubky.app is asking" is not something Ring can truthfully say today; it can only say "a relay URL is asking, for these paths".

### P8. Token validity numbers in circulation do not match this tree

In-tree `pubky-common` uses a 45-second window in each direction (`pubky-common/src/auth.rs:19`, applied at `:89-98`), matching the spec's recommendation (`docs/mdbook/src/spec/auth.md:103`). Shop's design cites 180 s for the pinned `pubky-common` 0.11.0 crate and a 120 s service-side cap (`docs/ecommerce/single-approval.md:230-238`). Replay rejection is a per-verifier in-memory set that does not survive a restart (`pubky-common/src/auth.rs:141-165`).

UNVERIFIED: which crate version the deployed production and staging homeservers run, and therefore which window applies in practice. Any proposal below that quotes a window quotes the in-tree 45 s.

## 3. Proposal A — Reject empty or malformed capability strings at the signer

### Rule

At parse time, before the sheet is shown, classify the request:

1. **Empty.** `caps` is absent, present-but-empty, or every entry is whitespace. Today `parseInput` produces `caps: []` and proceeds (`src/utils/inputParser.ts:477-492`); Ring's own test suite asserts that an empty `caps=` still yields `InputAction.Auth` (`src/utils/__tests__/inputParser.test.ts:127-142`).
2. **Malformed.** At least one comma-separated entry fails `Capability::try_from` — not exactly one `:`, or no leading `/`, or an action character outside `r`/`w` (`pubky-common/src/capabilities.rs:250-271`). `chessky:rw` and `/pub/app` are both malformed; `/pub/app/:rw` is well formed.
3. **Well formed.** Every entry parses. Only this class reaches the approve path.

The check must run on the raw `caps` string, not on the parsed array, because the parsed array cannot distinguish "the app asked for nothing" from "everything the app asked for was dropped" (`pubky-common/src/capabilities.rs:376-379`).

### What the sheet shows instead

Do not silently deny; show the request and refuse to arm the button.

- **Empty:** title "Nothing to authorize". Body: this request asks for no permissions, so Ring will not sign anything for it. One button: Close. Rationale for refusing rather than warning: an empty-capability token is still a full identity proof for any verifier that accepts it (`pubky-common/src/auth.rs:44-63`), so "approve nothing" is not a safe reading of an empty list.
- **Malformed:** title "This request is not valid". Body: the requested permissions could not be read, plus the offending entries verbatim in a monospace block. One button: Close. A secondary "Copy request" affordance is useful for app developers; Ring already has `copyToClipboard` (`src/utils/clipboard.ts`, used at `src/components/ConfirmAuth.tsx:177`).

Both states must be reachable from every entry point that reaches `handleAuthAction`, and must bypass Auto Auth: `handleAutoAuth` (`src/utils/actions/authAction.ts:83-113`) must not sign a request that the classifier rejected. That is the whole point — Auto Auth today would sign an empty request with no sheet at all.

### Backward compatibility

The known real-world consumer of empty capabilities is Shop's `generateAuthTokenFlow('')`, whose purpose is identity proof only, documented as intentional (`docs/ecommerce/single-approval.md:39`). Proposal A breaks that call site. That is the intended outcome — that flow is exactly the "user was asked to approve a blank list" case — but it must not break silently:

- Ship A behind a deprecation window: for one release, show the empty-capability sheet with an explicit "This app is asking only to prove who you are" body and an armed Authorize button, plus a console-visible deprecation notice. Then flip to refusal.
- Provide the migration in the same release: an app that wants identity-only proof asks for a capability that says so, rather than nothing. See Proposal D §6.2 for the concrete shape.
- Malformed rejection has no known legitimate consumer; pubky-core already discards those entries, so no app can be relying on them being granted.

An audit of `caps=` values in the wild is needed before the window closes; nobody has done it. UNVERIFIED.

### Test plan

- Unit, `parseInput`: `caps=` absent, `caps=`, `caps=,`, `caps=%20` all classify as empty; the existing test at `src/utils/__tests__/inputParser.test.ts:127-142` inverts to assert the empty classification.
- Unit: `caps=chessky:rw`, `caps=/pub/app`, `caps=/pub/app:rwx`, `caps=/a:r,/b` classify as malformed; the offending entry is carried through to the UI payload for display.
- Unit: `caps=/pub/pubky.app/:rw,/pub/paykit/:rw` classifies as well formed; `caps=/pub/app/:rw,/pub/app/:r` classifies as well formed and is deduplicated the way `sanitize_caps` does (`pubky-common/src/capabilities.rs:606-641`).
- Unit: with Auto Auth on, an empty and a malformed request each reach the refusal sheet and `performAuth` is never called.
- Negative test (required): a fixture that is well formed must not be refused — a rejection gate that rejects everything is not a gate.
- E2E: the existing Maestro authorize flow (`.maestro/shared/authorize.yaml`) plus two new flows that assert the Authorize button is absent on the refusal sheets.

## 4. Proposal B — One capability rendering spec, three implementations

### What is shared

A written spec, versioned in `pubky/pubky-core` next to the auth spec (`docs/mdbook/src/spec/auth.md`), named "Capability presentation". Not shared code: Ring is React Native, Bitkit is Kotlin and Swift, and a shared package would bind three release trains together for a few hundred lines of formatting. Share the normative text and the fixture file instead.

The spec fixes:

1. **Parsing is pubky-core's.** A signer must classify entries with the same rules as `Capability::try_from` (`pubky-common/src/capabilities.rs:240-276`). Bitkit's looser parsers (`app/src/main/java/to/bitkit/models/PubkyAuthRequest.kt:133-142`; `Bitkit/Models/PubkyAuthRequest.swift:114-130`) become non-conforming and must be tightened.
2. **Normalization before display.** Merge duplicate scopes and drop scopes covered by a broader one, exactly as `sanitize_caps` does (`pubky-common/src/capabilities.rs:606-641`), so `/:rw,/pub/app/:r` displays as one root row and not two.
3. **Grouping.** Group rows by the first path segment after `/pub/` — the "service name" both Bitkit apps already extract (`app/src/main/java/to/bitkit/models/PubkyAuthRequest.kt:144-148`; `Bitkit/Models/PubkyAuthRequest.swift:132-141`). A root scope `/` is its own group, rendered first, with distinct wording.
4. **Wording.** Fixed English strings for: root access, read-only, read and write, private-namespace access (`/priv/...`), and the trust warning. The trust warning must name the relay, because the relay is the party that receives the token (`docs/mdbook/src/spec/auth.md:106-108`).
5. **Relay is mandatory on the sheet.** Ring shows it (`src/components/ConfirmAuth.tsx:219-224`); the spec makes that a requirement, closing the Bitkit gap.
6. **Refusal states.** The two states from Proposal A, with their copy.

### Fixture file

Ship `capability-presentation-fixtures.json` in the same directory: an array of `{ caps, classification, groups[], rows[] }`. Each signer writes one test that walks the fixtures and asserts its own renderer produces those groups and rows. This is what keeps three implementations honest without shared code, and it is the artifact a reviewer can check.

### How Bitkit adopts it

Both Bitkit sheets already have the right shape — a permissions section over a list of `(path, accessLevel)` (`…/PubkyAuthApprovalSheet.kt:446-484`; `…/PubkyAuthApprovalSheet.swift:274-299`). Adoption is: tighten the parser to pubky-core's rules, add the grouping pass, add the relay row, replace the trust-warning string, add the two refusal states, add the fixture test. No architectural change on either platform.

## 5. Proposal C — Per-app grant memory

### Data model

Ring keeps, per identity (pubky), a list of grant records:

| Field | Source | Notes |
| --- | --- | --- |
| `relayOrigin` | scheme + host + port of the `relay` param | The only app-attributable value in the URL today (`docs/mdbook/src/spec/auth.md:50-64`) |
| `appOrigin` | optional, from Proposal D's `app` parameter | Absent for every app that has not adopted D |
| `capabilities` | the well-formed, normalized capability set | Store the normalized form, not the raw string |
| `firstGrantedAt`, `lastGrantedAt` | device clock | |
| `grantCount` | | |
| `label` | user-editable, defaults to the derived service name | |

Storage is the existing Redux-persist store; this is a new slice next to `pubkysSlice` and `settingsSlice`, plus a migration entry (`src/store/migrations/index.ts`). Grants are per-pubky: switching identity must not surface another identity's grants.

### Returning app, same or narrower scope

Recommendation: **one-tap confirm, not silent approval.**

The rule: if a record exists for this `relayOrigin` (and `appOrigin`, when present) and every requested capability is covered by the stored set under `Capability::covers` semantics (`pubky-common/src/capabilities.rs:125-134` — `/:rw` covers `/pub/app/:rw`; that method is private today, so Ring reimplements the rule or upstream exports it), show a compact sheet: app label, "same access as last time" or "less access than last time", the granted-at date, one Authorize button, one Deny button, and a link that expands the full capability list.

Anything else — no record, an unknown relay, or any capability not covered by the stored set — shows the full sheet unchanged.

Why one-tap confirm and not silent, under P3 ("additional prompts only when explainable in one sentence"): the one-sentence explanation is "you already gave this app this access on 12 March; tap to confirm it again." Silent approval has no sentence at all, because the user is not there to read one. The consent moment is what keeps a swapped QR from being free, and the swapped-QR case is precisely the one where the user did not initiate the request. Coverage matching, not string equality, is load-bearing here: exact-equality matching would fail a returning app that legitimately narrowed its request, retraining users to expect full sheets and defeating the feature.

### Interaction with Auto Auth

Recommendation: **scope it, do not delete it, and do not leave it.**

Replace the global boolean (`src/types/settings.ts:4`) with a per-grant flag, set from the full sheet at approval time ("Don't ask again for this app"). `handleAuthAction` then reads the flag from the matched grant record rather than from settings (`src/utils/actions/authAction.ts:61`). Requests that do not match a grant, or that widen scope, always show the full sheet regardless of any flag.

Migration for existing users with the global flag on: do not carry it forward as a wildcard. On first launch after upgrade, turn it off and show a one-time notice explaining that Auto Auth is now per-app. Silently converting a global switch into per-app grants is impossible anyway — there are no grant records to convert to, because nothing was ever recorded (P5).

Keep a developer escape hatch equivalent to today's behaviour only if the maintainers want one; if so, it belongs behind the same hidden-settings gate the toggle already sits behind (`src/screens/SettingsScreen.tsx:222, 235`) and should be labelled as such.

### Connected Apps screen

A screen listing grant records for the selected pubky: label, relay origin, capability summary, last used, and a Revoke action. Revoke deletes the record and clears any "don't ask again" flag; it does **not** revoke the app's homeserver session, because Ring does not hold one for it. That distinction has to be in the copy, or the screen lies.

Ring already renders homeserver sessions with capability chips and a sign-out action (`src/components/PubkyDetail/SessionItem.tsx:59-72, 33-36`). Connected Apps should sit beside that list, not merge with it: one is "sessions the homeserver knows about", the other is "apps this device has approved". Merging them would imply revoking one revokes the other.

### Threat model

The attack that matters is a malicious app impersonating a remembered one to get the one-tap sheet.

- **What binds a grant today.** Only `relayOrigin`. An attacker who can serve from the same relay origin as a remembered app inherits its record. Public relays make this cheap: two unrelated apps using `https://httprelay.io/link` share an origin. Mitigation: never key a grant on a relay origin that appears in a bundled list of known-shared public relays; those apps always get the full sheet. This is a real limitation, not a solved problem.
- **What binds a grant under Proposal D.** `appOrigin` is asserted by the app and unauthenticated at the signer, so it narrows the impersonation set but does not close it. It becomes meaningful only if the signer can check the assertion — for example by fetching a well-known document at that origin that names the relay, which adds a network round trip to the consent path. That trade-off is a separate decision; do not present `appOrigin` in the UI as verified unless it was checked.
- **Scope widening.** A matched app that asks for more than the stored set gets the full sheet. This is the single most important rule in C, because it means impersonation buys the attacker at most what the user already granted the real app.
- **Device compromise.** Grant records are not credentials; reading them leaks which apps a user uses. They must be wiped with the identity — any wipe or sign-out path that clears `pubkysSlice` must clear the grants slice in the same commit, with a test that enumerates persisted slices against that path.
- **What C does not fix.** A user who taps through the one-tap sheet without reading is no better protected than today. C reduces prompt fatigue so the full sheet means something again; it does not make consent attentive.

## 6. Proposal D — Audience-bound approval

### Starting point

Shop's §4.2 records the interim it ships and the two upstream designs it prefers: "One Ring consent, two tokens" and "Homeserver-issued token exchange" (`docs/ecommerce/single-approval.md:117-121`). The interim presents the same AuthToken bytes to two verifiers — the homeserver and the marketplace — which works because each keeps its own replay ledger (`docs/ecommerce/single-approval.md:48-53`; ledger at `pubky-common/src/auth.rs:141-165`). Shop's own threat table calls the widening out: a stolen in-flight token now mints a wide homeserver cookie as well as a marketplace bearer, which is worse than the empty-capability token it replaces (`docs/ecommerce/single-approval.md:163, 176`).

The consent defect is narrower than the security one and is the reason this belongs in Ring: the user approved a grant for their homeserver, and a second, unrelated service also accepted it. Nothing on Ring's sheet said that would happen.

### 6.1 The protocol sketch

**Request.** The app adds one parameter to the `pubkyauth://` URL:

```
pubkyauth:///?relay=<relay>&secret=<b64url>&caps=/pub/pubky.app/:rw,/pub/paykit/:rw
             &aud=<https origin of the second verifier>
             &aud_caps=<capability list for that verifier>
             &aud_secret=<b64url of a second 32-byte client secret>
```

Unknown parameters are already ignored by every existing signer (`pubky-sdk/src/actors/signer/auth.rs:81-87`), and Bitkit already relies on that property for its own `x-bitkit-claim` parameter (`app/src/main/java/to/bitkit/models/PubkyAuthRequest.kt:14, 96-106`). So a D-aware app talking to a stock Ring degrades to exactly today's single-token behaviour.

**Approval.** Ring signs two independent v0 AuthTokens from one approval:

- Token 1: `caps`, delivered to `relay/base64url(hash(secret))` as today (`pubky-sdk/src/actors/signer/auth.rs:53-72`).
- Token 2: `aud_caps`, delivered to `relay/base64url(hash(aud_secret))`.

Two channels rather than one concatenated payload, because the payload today is a single encrypted token and the decoder expects exactly that (`pubky-sdk/src/actors/auth_flow.rs:238-240, 312-313`). Two channels need no format change on the relay, no new decrypt path, and no new token version.

**What the user sees.** The sheet gains a second block below the first:

> **shop.pubky.app** wants permission to access and edit your `pubky.app` and `paykit` data.
> **Its order service at api.shop.pubky.app** also wants to prove your identity. It gets no access to your data.

One Authorize button covering both, because two buttons implies they can be approved separately and they cannot — the app needs both or neither. Deny denies both. If `aud_caps` is non-empty, the second block renders its capability rows with the same spec as the first (Proposal B); the "no access to your data" sentence is only correct for the empty case.

**Replay and expiry.** Unchanged. Two tokens have two `(pubky, timestamp)` ids, so each verifier's ledger sees a token minted for it. This is strictly better than the interim, where one id is consumed at two ledgers and a restart at either verifier re-opens a replay window (`pubky-common/src/auth.rs:141-144, 169-176`; Shop's restart and multi-replica rows at `docs/ecommerce/single-approval.md:167-169`). Both tokens carry the same signer timestamp, so the same 45 s in-tree window applies to both (`pubky-common/src/auth.rs:19, 89-98`).

### 6.2 The identity-only capability

Proposal A refuses empty capability strings, and the second token's natural capability set is empty. These have to be reconciled. Options:

1. A reserved scope with a display meaning, for example `/:i` where `i` is a new `Action` — requires a pubky-core change to `Action::try_from` (`pubky-common/src/capabilities.rs:240-271`) and would be dropped by every existing verifier as an unparseable action character. Clean semantics, real deployment cost.
2. Treat "empty `aud_caps` in the presence of a valid `aud`" as an explicit, allowed empty request. No protocol change at all; the sheet has a sentence to show because `aud` supplies the audience name. This is the cheaper path and the one recommended here.

Under option 2, Proposal A's rule becomes: empty is refused **unless** it is the `aud_caps` of a well-formed audience block.

### 6.3 Is it worth the protocol change?

Arguments that it is:

- It is the only version of this that the user can be told the truth about. The interim cannot be described accurately on Ring's sheet, because Ring does not know a second verifier exists.
- It removes a real replay asymmetry, not just a UX one: one token id spent at two ledgers means a restart at either verifier re-opens a window on a token the other already accepted.
- It costs no new token version and no homeserver change. Everything above is query parameters and a second relay channel, both already supported.

Arguments that it is not:

- Shop's own conclusion is that the fork/upstream path is not worth it for this wave, on blast radius rather than effort: three components change together, and every tester would need a non-store Ring build to sign in at all (`docs/ecommerce/single-approval.md:124-128`).
- What it buys against a stolen token is bounded. The attacker window is already capped at the strictest verifier's clock window, and an attacker who can read in-flight token bytes has script execution on the app origin, which after sign-in already yields the cookie and the bearer (`docs/ecommerce/single-approval.md:129, 176`).
- Two tokens from one approval invites a worse pattern if it is not fenced: an app asking for five audiences in one sheet is less comprehensible than five sheets. A cap — one audience per approval — should be part of the proposal, not a later fix.
- The alternative in Shop §4.2 item 2, a homeserver-issued exchange token, keeps the wide grant away from the third party entirely and does not need Ring to change at all. It needs homeserver work instead. Nobody has costed it. UNVERIFIED.

Honest position: D is the right consent design and is not urgent. Ship A, B, and C first; they are Ring-local and they fix defects that affect every app today. Open D as its own upstream issue with the audience cap in the text, and let the homeserver-exchange alternative be evaluated beside it rather than assumed away. There is no consensus here, and this document does not claim one.

## 7. Sequencing and compatibility

| Proposal | Depends on | Touches outside Ring | Stock behaviour for non-adopting apps |
| --- | --- | --- | --- |
| A | none | none | Well-formed requests behave exactly as today; empty and malformed ones stop being approvable |
| B | A (for the refusal states) | doc + fixtures in pubky-core; parser tightening in both Bitkit apps | No change — rendering only |
| C | A (only well-formed grants are recorded) | none | An app that never returns never matches a record and always sees the full sheet |
| D | A §6.2, B (renders the second block), C (records `appOrigin`) | app side must emit `aud*`; no homeserver or pubky-core change under option 2 | Unknown parameters are ignored, so a stock signer produces exactly today's single token |

A, B, and C are independent of pubky-core and of the homeserver. D under option 2 is also independent of both; D under option 1 needs a new `Action` in `pubky-common` and would not be understood by deployed verifiers.

What must not be attempted as a shortcut: a new AuthToken version carrying an audience field. `AuthToken::verify` rejects any version above 0 outright (`pubky-common/src/auth.rs:80-83`), so a v1 token is unusable against every deployed homeserver until they all upgrade, and postcard's field-ordered encoding makes the addition a hard format break (`pubky-common/src/auth.rs:111-119`).

Stock Ring after all four ships, for an app that adopts nothing: same QR, same full sheet, same token, same relay delivery. The only behaviour it loses is the ability to have an empty or malformed capability list approved — which is the point.

## 8. Open questions for maintainers

1. Is there any legitimate deployed use of `caps=` empty other than identity proof, and how long a deprecation window does the ecosystem need before Proposal A refuses it?
2. Should the malformed-request sheet name the offending entries verbatim, or is that a phishing surface worth avoiding?
3. Should grant records key on relay origin at all, given that public relays are shared, or should C be gated on Proposal D's `app` parameter landing first?
4. Is a network fetch to verify an app-asserted origin (well-known document naming the relay) acceptable on the consent path, or is unverified display with explicit "unverified" wording preferred?
5. Auto Auth: scope it per app as proposed, remove it entirely, or keep the global switch behind the hidden-settings gate for developers?
6. Should Connected Apps and homeserver sessions be two lists or one, given that revoking a grant does not revoke a session?
7. For Proposal D, is one audience per approval the right cap, and should the audience block be refusable independently of the primary grant?
8. Which `pubky-common` version do the deployed homeservers actually run — 45 s or 180 s window — since the consent copy for token lifetime depends on it?

## 9. Appendix — Bitkit team variant

Scope: `bitkit-android` `PubkyAuthApprovalSheet.kt` / `PubkyAuthRequest.kt`, `bitkit-ios` `PubkyAuthApprovalSheet.swift` / `PubkyAuthRequest.swift`. Ring-side proposals C and D do not apply; Bitkit is a signer, and per-app memory there is a separate decision.

1. **Tighten capability parsing to pubky-core's rules.** Android currently accepts any segment with a colon after position 0 and never checks the leading `/` (`PubkyAuthRequest.kt:133-142`); iOS checks only non-empty path and access (`PubkyAuthRequest.swift:114-130`). pubky-core requires exactly one `:`, a leading `/`, and actions in `r`/`w` (`pubky-common/src/capabilities.rs:250-271`). Today `caps=chessky:rw` displays as a folder both apps say they are granting and pubky-core drops.
2. **Add the two refusal states.** Empty capability list and malformed capability list both show a sheet with no Authorize button. Android: `AuthorizeContent` (`PubkyAuthApprovalSheet.kt:335-355`). iOS: `authorizeContent` (`PubkyAuthApprovalSheet.swift:171-187`). Neither guards on the permission list today.
3. **Fix the iOS empty-service sentence.** With no capabilities, `serviceText` is empty (`PubkyAuthApprovalSheet.swift:250-252`) and the copy renders "…access and edit your  data." (`Localizable.strings:685-686`). Android already falls back to "Unknown service" (`PubkyAuthApprovalViewModel.kt:76-77`; `strings.xml:605`). Once refusal states land this is unreachable, but fix the fallback anyway.
4. **Show the relay.** Neither sheet displays it; Ring does (`ConfirmAuth.tsx:219-224`). The relay receives the token, so the user should see it.
5. **Align the trust warning.** Both Bitkit strings omit the relay (`strings.xml:609`; `Localizable.strings:696`) where Ring's names it (`en.json:76`). Adopt the shared wording from Proposal B.
6. **Group rows by service and normalize before display,** per `sanitize_caps` (`pubky-common/src/capabilities.rs:606-641`), so a root scope does not render beside scopes it already covers.
7. **Add the shared fixture test.** One test per platform walking `capability-presentation-fixtures.json` and asserting classification, groups, and rows. This is what keeps three signers from drifting again.

The `watch-only-account-v1` claim path (`PubkyAuthRequest.kt:90-131`; `PubkyAuthRequest.swift:86-112`) is unaffected: it already requires an exact capability set, so it is well formed by construction and passes the new gate unchanged.
