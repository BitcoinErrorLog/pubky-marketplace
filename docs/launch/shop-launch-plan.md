# Pubky Shop: beta launch and handoff plan

Scope: [shop.pubky.app](https://shop.pubky.app), built from the fork [BitcoinErrorLog/pubky-app](https://github.com/BitcoinErrorLog/pubky-app) (branch `release/shop-v0.6.8`), handed to a dev team for about two weeks, ending in a beta for real users. Facts were checked on 1 Oct 2026 against the repos, the live sites and GitHub, and reviewed against the code as it stood that day and the 1 Oct issue triage of the [pubky-marketplace tracker](https://github.com/BitcoinErrorLog/pubky-marketplace/issues). Sizes are for one developer and include tests and review: **XS** under half a day, **S** half a day to 2 days, **M** 3 to 5 days, **L** more than a week.

## Today (1 Oct)

### Being coded today by us

| Item | Scope | Review |
|---|---|---|
| **F1 link-out, Shop side** | Social redirects and nav (§2). The redirects sit behind a social-host build variable that is unset by default, so the change merges with no effect. Someone with Vercel access sets the variable when John wants it live. Includes the component fixes the first draft missed: the route guard's `AUTHENTICATED_ROUTES.redirectTo`, the Logo, the Header and MobileFooter Home items, about 8 `router.push(APP_ROUTES.HOME)` calls (all to `/marketplace`), and the marketplace profile links | Sol |
| **F4 Passport "Continue with Google"** | Sign-in, plus the service grant at first purchase, through the Passport popup (§3). Passport users get **no messaging yet**, the same as Bitkit grant sessions. The refusal copy ("Messages need a Pubky Ring sign-in for now") must change. Ships after Kimi clears it; the proof needs a Google test account from John | Sol + Kimi |
| **[#62](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/62)** order cards show no date, and the hold time has no day | Show `createdAt` on order cards; give the restock time a day | Sol |
| **[#63](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/63)** listing editor step 1 hides under the header | Fix the sticky offset of the step rail | Sol |
| **[#49](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/49)** Bitkit sign-up copy | Bitkit scanning the sign-up QR is supported. Copy changes so it no longer implies only Ring can create an identity. The authorize failure is Bitkit's to fix: [bitkit-android#1398](https://github.com/synonymdev/bitkit-android/issues/1398) | Sol |
| **F5 sign-out copy** | For Ring (cookie) sessions, the copy says Shop sign-out also signs pubky.app out in this browser. A "Shop only" and "everywhere" split needs the Shop off cookies, which is blocked (§3) | Sol |
| **F7 handoff docs** | Repo-local release runbook and proof scripts, with no seat keys or machine paths. Fix the stale README deploy line. Drop the two `#s=` release-proof checks (steps 3 and 6), which test a path that can no longer run | Sol |

### John's decisions, made today

- **D5:** Ring sign-in requests both sites' scopes as a stopgap. Accepted widening: the Shop gets pubky.app's `/priv/social`. See §3 for the scope of the change.
- **D6:** delete the 16 production test listings with seat keys where held.
- **Default branch:** switch the Shop repo's default branch from `pubchi/v1` to `release/shop-v0.6.8`. It is still `pubchi/v1` on GitHub as of this writing.
- **[paykit-server#23](https://github.com/BitcoinErrorLog/paykit-server/pull/23):** review with Sol + Kimi and merge on the fork; John deploys.

### In progress elsewhere

- **[#61](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/61) address search 503.** The fix is in progress. The issue shows closed on GitHub, but the service's 60-second breaker still trips on Photon failures.
- **Rebase of [#164](https://github.com/BitcoinErrorLog/pubky-app/pull/164)** (icota). It conflicts with #166 in `commerce.ts`, and the unguarded read-back it fixes is still live.
- **Token redaction on [pubky/pubky-nexus#1099](https://github.com/pubky/pubky-nexus/pull/1099):** redact every query value, per Greptile's P1.
- **Triage cleanup:**
  - [#53](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/53#issuecomment-5926953768) closed;
  - [#54 reply](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/54#issuecomment-5926954329) posted;
  - 86 merged-PR branches deleted, and auto-delete turned on in four repos.
- **Shop v0.6.42:**
  - [#170](https://github.com/BitcoinErrorLog/pubky-app/pull/170) deleted-listing wording;
  - [#171](https://github.com/BitcoinErrorLog/pubky-app/pull/171) message retry backoff reset, for [#59](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/59);
  - session-bridge variables removed. Both live builds already have them unset; v0.6.42 removes them from the build configuration.

## 1. Recommendation in one page

1. **Two sites, linked both ways.** pubky.app adds **Marketplace** and **Messaging** to its top menu. The Shop sends feed, profile, post, collection and settings links to pubky.app, and keeps marketplace, messages, sign-in and sign-out.
2. **Single sign-on (SSO) is required, and it is built on grants, not cookies.** The homeserver deprecates cookie sessions and schedules them for removal, and grants are bound to one app's key. The design: **one signer approval issues a grant to each first-party app** (§3).
   - Ring, Bitkit and Passport sign every grant with the user's key.
   - This needs no homeserver change. It does need an SDK bundle format, signer updates and a companion frame on each site.
   - **It has a hard prerequisite that is not in the beta path.** The Shop's messaging library (`paykit-wasm`) works only with cookie sessions, so the Shop can't move Ring users to grants yet.
   - Until that library gains grant-session support, there is no full SSO for Ring users.
   - Ring's grant sign-in is also merged but not yet released ([pubky-ring#360](https://github.com/pubky/pubky-ring/pull/360); not in v1.19), so Ring users can't be moved to grants until Ring ships it.
   - The beta stopgaps don't depend on it:
     - D5 is a Ring cookie sign-in;
     - F4 is Passport's own grant flow;
     - F5 is copy.
3. **For the beta: one approval per site, without the two sites breaking each other.** D5's stopgap stops a Shop sign-in from stripping pubky.app. Passport (F4) gives Google users a way in. F5 makes sign-out honest.
4. **Freeze features.** Launch existing flows. The backlog in §5 stays post-launch unless John moves an item up.
5. **Infra is one of two choices.** **R:** John runs Railway alone. **S:** Synonym DevOps builds new instances on Synonym's cloud. Recommendation: S, with cutover before the beta (§7).

## 2. Seam 1: navigation between pubky.app and the Shop

**The problem.** The Shop forked upstream `dev` on 20 Aug ([#2340](https://github.com/pubky/pubky-app/pull/2340), commit `6348001555`). It is now 161 upstream commits behind and 1,406 ahead. Its nav keeps users inside its own copy of the social app. That copy lacks what pubky.app has shipped since:

- Passport sign-in ([#2587](https://github.com/pubky/pubky-app/pull/2587));
- the new onboarding steps;
- Locks pay-to-unlock ([#2689](https://github.com/pubky/pubky-app/pull/2689));
- the 1.12.0 release that is waiting to ship ([#2719](https://github.com/pubky/pubky-app/pull/2719)).

### Options

| Option | What changes | Size | Verdict |
|---|---|---|---|
| A. Status quo | Nothing | 0 | Users drift into a stale social app |
| **B. The Shop links out to pubky.app** | Shop redirects and nav; pubky.app adds two menu links | M (Shop) + S (pubky.app) | **Recommended (D1); Shop side being coded today** |
| C. A marketplace-only Shop | Delete the social routes and shell from the fork | L | The end state; too risky in two weeks (per the marketplace seam analysis, an internal doc) |
| D. Merge into pubky.app as a module | In-repo module, then upstream | L (240–360 h) | Out of the window |

### Option B in detail

**Redirects.** Social routes 307-redirect to the same path on pubky.app (on staging, to `staging.pubky.app`) from `redirects()` in [`next.config.ts`](https://github.com/BitcoinErrorLog/pubky-app/blob/release/shop-v0.6.8/next.config.ts). They are gated on the social-host build variable.

| Path on the Shop | Goes to | Note |
|---|---|---|
| `/home`, `/feed/*`, `/hot`, `/search`, `/who-to-follow` | pubky.app, same path | Shop-only shelves become unreachable; remove them later, after a workspace-wide dead-code check |
| `/post/:user/:id`, `/collections/*` | pubky.app, same path | Saved listings stay in the Shop watchlist |
| `/profile`, `/profile/:pubky/*` | pubky.app, same path | `/profile/notifications` goes to `/marketplace/notifications` |
| `/settings/*` | pubky.app, same path | Shop settings stay at `/marketplace/settings/*`, plus Shop sign-out |
| `/onboarding/*` | Stays in the Shop | D4 |
| `/marketplace/*`, `/messages/*`, `/sign-in`, `/logout`, `/copyright`, `/invite/*`, `/offline`, `/share` | Stays | `/` already redirects to `/marketplace` |

**Component fixes. A redirect list alone is not enough,** because several places send users to `/home` themselves. Without SSO, each of these would land a signed-in user on a signed-out pubky.app. All of them point to `/marketplace` instead:

- `AUTHENTICATED_ROUTES.redirectTo` in [`routes.ts`](https://github.com/BitcoinErrorLog/pubky-app/blob/release/shop-v0.6.8/src/app/routes.ts), which the route guard uses;
- the `Logo`;
- the Header and MobileFooter Home items;
- about 8 `router.push(APP_ROUTES.HOME)` calls.

**Nav.** Marketplace, Messages, and one **Pubky** link to pubky.app. Use plain `<a>` tags for off-site links.

**Profile links in the marketplace.** In `MarketplaceShop`, `MarketplaceReviewsSection` and `MessagesConversation`, a seller's name links to the seller's shop page, plus a small "Profile on Pubky" link to pubky.app.

**Return path.** pubky.app's two menu items are the way back. The user is signed in on arrival only once SSO exists. Until then, each site keeps its own sign-in.

## 3. Seam 2: single sign-on between pubky.app and the Shop

### What the protocol and our code allow today

- **Cookie sessions are on their way out.**
  - The homeserver's [grant-auth guide](https://github.com/pubky/pubky-homeserver/blob/main/docs/v0.10-migration/grant-auth.md) marks cookie auth "deprecated and scheduled for removal".
  - It explains why: every site shares the one homeserver cookie, so site B can use site A's permissions.
  - The old cookie bridge ([#2484](https://github.com/pubky/pubky-app/pull/2484), Shop ADR 0029) is not the SSO answer. Its build variables are unset in both live Shop builds.
- **Grants are per app.**
  - A grant is bound to one client id and that app's own proof-of-possession (PoP) key.
  - In the browser that key is a non-extractable WebCrypto key in that origin's store.
  - **A grant is signed by the user's own key, which lives in the signer (Ring, Bitkit or Passport).** The homeserver verifies it on its own and stores it idempotently ([grant module docs](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/src/client_server/auth/grant/mod.rs): "Ring … signs only at Grant creation").
  - A grant request (`signin_grant`) carries one client id, one client public key, the scopes and a relay channel ([`signin_grant.rs`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/src/actors/auth/deep_links/signin_grant.rs)).
  - So **a signer can issue grants to several apps in one approval with no homeserver change**. What's missing is a request format that carries several apps' requests, and signer support for it.
- **pubky.app is moving to grants** ([#2614](https://github.com/pubky/pubky-app/pull/2614)).
- **Ring's grant sign-in is merged but not released.**
  - It merged to `main` on 3 Sep in [pubky-ring#360](https://github.com/pubky/pubky-ring/pull/360).
  - The latest release, [v1.19](https://github.com/pubky/pubky-ring/releases/tag/v1.19) (4 Sep), doesn't list it. Ring's developer confirms grant auth is "still to be released, not in v1.19".
  - The v1.19 tag's source does contain the merge, so ask Ring which release actually turns it on.
  - Released Ring supports cookie auth only. Grant sign-in through Ring is unavailable to users until that release.
- **The Shop's messaging library only works with cookie sessions, and it is ours.**
  - The vendored `paykit-wasm` 0.1.0-rc50 exists only in our fork [BitcoinErrorLog/paykit-rs-official](https://github.com/BitcoinErrorLog/paykit-rs-official) (`paykit-wasm/`).
  - It is built on pubky 0.8, and its session API is `restoreSession` and `resumeSessionFromCookie` (`paykit-wasm/src/session.rs`).
  - Upstream [pubky/paykit-rs](https://github.com/pubky/paykit-rs) is on pubky 0.12 and already uses grant sessions in `paykit-sdk`, but it ships **no WASM binding**.
  - That is why Bitkit grant sessions get no messaging today, and why Passport users won't have it either.
  - If Ring sign-in moved to grants now, three things would break:
    - every Ring user would lose messaging;
    - Ring's single approval (one AuthToken to both the homeserver and the service, per [single-approval.md](https://github.com/BitcoinErrorLog/pubky-app/blob/release/shop-v0.6.8/docs/ecommerce/single-approval.md)) would become two;
    - the messaging fallback would set a narrow `/pub/paykit/:rw` cookie, which brings the overwrite back.
- **The Shop needs a second grant.** Its transaction service needs its own grant, approved at the first purchase for grant sessions.

### The SSO design: one signer approval issues a grant to each first-party app (recommended)

This is the "update Ring" route, done properly: Ring signs, but **Ring alone isn't enough**.

1. **Sign-in starts on either site.** The page opens a hidden **companion frame** from the sibling site, for example `shop.pubky.app/auth-companion` inside pubky.app. The two sites are same-site, so the frame's storage is the sibling's own unpartitioned storage.
2. **Each app makes its own request.** The companion creates the Shop's own non-extractable PoP key in the Shop's `BrowserSessionStore`. It starts the Shop's grant flow (client id `shop.pubky.app`, the Shop's scopes) and fetches the transaction service's grant request.
3. **Only request URLs cross over.** The companion returns just those authorization URLs (public keys and relay channels) to the parent page, by exact-origin `postMessage`.
4. **One QR or deep link.** The parent shows one QR or deep link carrying a **bundle** of all the requests: pubky.app's, the Shop's and the service's.
5. **One screen in the signer.** Ring, Bitkit or Passport shows one screen listing each app and its scopes. It signs one grant per request with the user's key and posts each to its own relay channel.
6. **Each app collects its own grant.** The companion saves the Shop session in the Shop's own store, so the Shop is already signed in when the user opens it, and the first purchase needs no approval. The same works with the Shop as the first stop.
7. **Revocation and sign-out.** Each grant is user-signed and revocable on its own. "Sign out of Shop" revokes the Shop's grants. "Sign out everywhere" has each companion revoke its app's grant.

**Why this is safe.**

- No credential crosses origins.
- The parent page sees the Shop's relay secret, but a grant read from that channel is useless without the Shop's PoP key.
- The user's key stays in the signer (the cold-key model).
- The homeserver changes nothing.

**Limits.**

- It covers the apps present at sign-in. A Shop session lost later (cleared storage, a new browser) needs one more approval.
- **Ring can't safely auto-approve "trusted first-party apps" on its own.** A grant's client id is self-declared ("the security boundary is capability scoping, not `client_id`", per the homeserver grant docs). Ring also can't tell which website showed a QR, so a malicious site could claim `shop.pubky.app`.
- Ring's existing auto-auth setting (`getAutoAuthFromStore` in `src/utils/actions/authAction.ts`) already approves *every* request without a screen. It isn't a per-app trust list.
- So remembered auto-approval is not a safe SSO mechanism. The explicit one-screen bundle is.

**Can any of it work without the hidden frame or delegation?**

- **One approval per app:** always works; this is the beta today.
- **Sequential requests:** pubky.app shows the Shop's request right after its own. Two scans or taps, no new protocol.
- **One approval for both** needs the sibling's public key in the request. That means a frame (or a page visit) on the sibling origin, because the key must be created and kept there.
- No path gives one approval for both apps without some first-party coordination. The companion frame is the least of it: only public data moves.

### What SSO depends on (Ring-led design)

| # | Piece | Owner | Size | In the beta path? |
|---|---|---|---|---|
| G1 | **Grant sessions in the messaging library.** The library must use the Shop's own grant session, whose PoP key is non-extractable in the SDK's store, so it has to borrow the app's session. Two ways: (a) **ours**: port `paykit-wasm` in our fork to pubky 0.11/0.12 grant sessions, borrowing the app's session (needs a JS SDK accessor upstream or the pubky-noise storage callback); or (b) **upstream**: Paykit ships a supported WASM package on its grant-based `paykit-sdk` that borrows the app's session (convergence ask 3, dzdidi). Either way the Shop's SDK (0.11.0) and Paykit's pubky (0.12) must line up (see the internal paykit-wasm grant-session analysis and messaging plan) | us (a) or Paykit team (b) | L | **No** |
| F3 | Ring sign-in on grants. Possible only after G1, without losing messaging or doubling approvals, **and after a Ring release that ships grant auth** (merged in [pubky-ring#360](https://github.com/pubky/pubky-ring/pull/360), not in v1.19) | Shop | M after G1 and the Ring release (Sol + Kimi) | **No, blocked on G1 and the Ring release** |
| S1 | **SDK grant-bundle request:** build and parse a deep link that carries several `signin_grant`/`signup_grant` requests, plus a signer call that approves the bundle with one key unlock. Rust SDK, JS binding, and the FFI Ring uses | Pubky core (pubky/pubky-homeserver `pubky-sdk`, pubky-core-ffi, react-native-pubky) | M (design review) | No |
| R1 | **Ring:** parse a bundle, one confirmation screen listing each app and its scopes, approve all; reject bundles that mix pubkys or homeservers | Ring team ([pubky/pubky-ring](https://github.com/pubky/pubky-ring)) | M | No |
| R2 | **Bitkit:** the same bundle support | Bitkit team | M | No |
| R3 | **Passport:** the same, in its `/authorize` page | Passport team ([pubky/pubky-passport](https://github.com/pubky/pubky-passport)) | S–M | No |
| P2 | **pubky.app:** sign-in builds the bundle with the Shop's companion frame; hosts its own `/auth-companion` for the reverse direction; on grants first ([#2614](https://github.com/pubky/pubky-app/pull/2614)) | pubky-app maintainers | M | No |
| F6 | **Shop:** an `/auth-companion` route (key, grant flow, service request, session save, exact-origin `postMessage`, revoke on "sign out everywhere"); a bundle on Shop sign-in; retire the cookie consumer (`src/libs/vibe-session/*`) after a workspace-wide dead-code check | us | M (Sol + Kimi) | No |
| — | Homeserver | — | **None** | — |

Full SSO for Ring users needs G1, F3, S1, R1, P2 and F6, plus a Ring release that ships grant auth (merged in [pubky-ring#360](https://github.com/pubky/pubky-ring/pull/360), not in v1.19). R1 builds on that release. Bitkit and Passport users need S1, R2 or R3, P2 and F6, and they get messaging only with G1.

**If a signer team can't ship the bundle (S1 plus R1–R3):** fall back to sequential requests, with two scans or taps and no new protocol.

### Compared with delegated grants (the previous design)

| | Ring-led bundle (recommended) | Delegated grants via a pubky.app broker |
|---|---|---|
| Homeserver change | None | L, a protocol change (child grants, subset checks, cascade revocation) |
| Who holds minting power | Only the signer (cold user key) | A web app's grant can mint grants for other apps: a hot key with new power, and an XSS on pubky.app mints Shop grants |
| Signer change | M (Ring, Bitkit), S–M (Passport), plus the SDK bundle (M) | S each (display a delegation scope) |
| Web plumbing | A companion frame at sign-in (public data only) | A broker frame at any time (grant issuance) |
| Session lost later | One more approval | Silent re-issue while pubky.app is signed in |
| Revocation | Per grant | Per grant, plus cascade from the parent |
| Fits the homeserver's model | Yes ("Ring signs only at Grant creation") | Extends it; the homeserver lists no delegation today |
| Messaging (G1) | Still needed | Still needed |

Delegation's only real advantage is silent re-issue after a lost session. It costs a protocol change and puts minting power in a browser app. Recommendation: the Ring-led bundle. Keep delegation as a later option if silent re-issue proves necessary.

### For the beta (what ships instead)

- **D5 stopgap, the scope union.**
  - **Change:** Ring cookie sign-in requests the union of pubky.app 1.12.0's scopes and the Shop's: `/pub/pubky.app/:rw,/pub/paykit/:rw,/priv/pubky.app/:rw,/priv/social/:rw,/priv/app.locks/content/:r`. Use the final 1.12.0 string.
  - **Scope of the change:** Bitkit grants keep the current constant. The exact-set checks (`capabilitiesMatchFullGrant`, the step-up comparison) need a separate constant, so Bitkit sessions are unaffected.
  - **Effect:** a Shop sign-in no longer strips pubky.app's Locks access. A later pubky.app cookie sign-in still narrows the Shop, because pubky.app doesn't request the Shop's scopes. The Shop's existing degrade paths (`needs_reauth`, the messaging enable prompt) handle that, and QA checks it.
  - **Size and review:** 4–6 h, Sol + Kimi. The accepted widening is that the Shop holds `/priv/social`.
- **F4 Passport,** being coded today.
  - [Passport](https://github.com/pubky/pubky-passport) approves grant requests from any app, with no allowlist. It creates the identity for new Google users during authorization ([integration guide](https://github.com/pubky/pubky-passport/blob/main/docs/integration.md)).
  - SDK 0.11.0 already has `startGrantAuthFlow` and `tryPollOnce`. The Shop adds the button, the callback page and a `Cross-Origin-Opener-Policy: same-origin-allow-popups` header.
  - No Passport change is needed.
  - **Limit: no messaging** until G1. The refusal copy must say so without naming Ring as the only way.
- **F5 sign-out copy,** being coded today. Ring cookie sessions: Shop sign-out ends the shared cookie, so pubky.app is signed out in that browser too. Bitkit and Passport grant sessions: only the Shop is signed out.
- **Dead bridge (formerly F2): done.** Both live builds have the variables unset. Cold signed-out loads make no bridge request. v0.6.42 removes the variables from the config, and F7 drops the two `#s=` proof checks.

## 4. Change list

pubky.app, homeserver, SDK, Paykit and signer changes belong to their teams. We don't push to `pubky/*` or `synonymdev/*`.

| # | Repo | Change | Size | Status |
|---|---|---|---|---|
| P1 | pubky.app | Top-menu **Marketplace** and **Messaging** items, URL from runtime config | S | Ask the pubky-app team |
| P2 | pubky.app | Bundle sign-in with the Shop's companion frame, plus its own `/auth-companion` (after #2614) | M | SSO; not in the beta |
| P3 | pubky.app | Optional "Message" on a profile, linking to the Shop | S | Optional |
| S1 | Pubky SDK + FFI | Grant-bundle deep link and signer approve-bundle call | M | SSO; not in the beta |
| R1 | Ring | Bundle approval screen | M | SSO |
| R2 | Bitkit | Bundle approval | M | SSO |
| R3 | Passport | Bundle approval | S–M | SSO |
| G1 | messaging library: our `paykit-wasm` fork, or an upstream Paykit WASM package | Grant-session support for messaging | L | SSO prerequisite; not in the beta |
| — | homeserver | No change | — | — |
| F1 | Shop | Link-out behind a build flag, plus the component fixes (§2) | M | **Coding today** |
| F2 | Shop | Unset the bridge variables | XS | **Done** (v0.6.42 cleans the config) |
| F3 | Shop | Ring sign-in on grants | M after G1 | **Blocked on G1 and on a Ring release with grant auth**; D5 stopgap instead |
| D5 | Shop | Ring cookie sign-in requests both sites' scopes | S | Decided; next |
| F4 | Shop | Passport sign-in and service grant | M | **Coding today**; ships after Kimi |
| F5 | Shop | Sign-out copy by session type | XS | **Coding today** |
| F6 | Shop | `/auth-companion`, bundle on Shop sign-in, retire the cookie consumer | M | SSO; not in the beta |
| F7 | Shop | Handoff docs, repo runbook, drop the `#s=` proof checks | S | **Coding today** |

## 5. Launch-blocking vs post-launch

### Launch-blocking

| Item | Status | Size |
|---|---|---|
| F1, F4, F5, F7 | Coding today | see §4 |
| [#62](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/62), [#63](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/63) | Coding today | S each |
| [#49](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/49) Bitkit sign-up | Copy coding today. The authorize failure is [bitkit-android#1398](https://github.com/synonymdev/bitkit-android/issues/1398) (Bitkit team); retest once Bitkit ships it | XS + external |
| D5 scope stopgap | Decided; build after F4 is in review | S |
| P1 menu links | Ask the pubky-app team | S |
| D6 production test listings | Delete the 16 with seat keys where held (ops). A reindex re-indexes any that remain, and the Nexus fork's moderation doesn't cover listings. Any without held keys need a listing denylist (3–4 h) or stay | S (ops) |
| Nexus reset and full reindex, then the stale-listing dry run. On new instances, this is the cutover | At cutover (§7) | S (ops) |
| [#61](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/61) address search 503 | In progress elsewhere. Closed on GitHub; breaker fix pending | S |
| [#164](https://github.com/BitcoinErrorLog/pubky-app/pull/164) acked publish reported as failed | Rebase in progress; for v0.6.42 | S |
| v0.6.42 (#170, #171) | In progress elsewhere | — |
| [paykit-server#23](https://github.com/BitcoinErrorLog/paykit-server/pull/23) relink on recovery marker | Sol + Kimi review, merge on the fork; John deploys | S |
| QA retests: [#50](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/50) quantity-1, including whether unpaid orders lapse; [#12](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/12) packing slip, needs a paid shipping order | Waiting on Pav | QA |
| Ownership: on-call owner, Sentry alert routing, Postgres backups with one restore test | §7 | S (ops) |

**Done, removed from this list:**

- 429/500 homeserver write retries ([#155](https://github.com/BitcoinErrorLog/pubky-app/pull/155), v0.6.36). Residual about 1 h: confirm that Encrypted Link sends and outbox clears are covered by #171's backoff.
- `listing_deleted` handling ([#168](https://github.com/BitcoinErrorLog/pubky-app/pull/168), v0.6.40).
- The dead bridge variables.
- The deleted-listing wording, now #170 in v0.6.42.
- [#58](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/58) and [#59](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/59), closed by Pav.
- The paid canary on [#54](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/54). PayPal and Bitcoin are each paid on production; #54 stays open for Piotr's v0.6.40 UI check.

### Decide now: launch-blocking or not

Recommendation: post-launch unless noted.

- **Show Paykit refusals to users.** This needs a design first. A minimal message is launch-blocking only if the beta promotes Bitcoin checkout.
- **[paykit-server#24](https://github.com/BitcoinErrorLog/paykit-server/issues/24):** "Open in Bitkit" opens an app chooser on Android, and picking Ring breaks the seller claim. S, with an independent review. Recommendation: launch-blocking if Android sellers are in the beta.

### Post-launch backlog

- **SSO chain:** G1, F3, S1, R1–R3, P2 and F6 (§3). Messaging for Passport and Bitkit users arrives with G1.
- **Messaging rebuild** on Paykit/pubky-noise storage seams (internal messaging plan). This overlaps G1.
- **Upstream convergence:** Locks and Paykit to `pubky/*` (internal convergence plan); [#44](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/44), [#35](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/35).
- **Zero-conf payments** (internal Locks zero-conf plan).
- **Nexus fork work:** tag race round 4, backfill retry, cache-fill guard, autocomplete race, rebase and slim, specs v1 (internal Nexus fork audit).
- **Deferred products:** Shopify real-store proof; the single-shop storefront SF1–SF9 (internal storefront plan); Stripe (paused); the PayPal partner tier.
- **Module extraction and upstream:** the upstream sync of 161 commits, and the eventual merge into pubky.app.
- **Smaller items:** the Ring/Bitkit keychain test, paykit-wasm call timeouts, `/priv` P4s, send-lock residuals, test hygiene.

## 6. Two-week timeline

Roles:

- **Shop lead:** owns the release train.
- **Shop dev**
- **Backend dev:** Rust; owns the service and the Nexus fork.
- **DevOps:** Synonym.
- **QA:** Pav, Piotr.
- **Designer**
- **pubky.app maintainer**
- **John:** product owner.

Today's items (top of this document) are day 0. Suggested start: Mon 5 Oct. Beta: Thu 15 Oct.

| Days | Work | Owner |
|---|---|---|
| 0 (1 Oct) | F1, F4, F5, F7, #62, #63, #49 copy; paykit-server#23 review; default-branch switch | us, John |
| 1 | Access: GitHub, the Vercel `synonymdev` team, Sentry. Read the [team brief](shop-team-brief.md). Run locally | All |
| 1 | Ask the pubky-app team for P1. Ask DevOps to confirm capacity for S | John |
| 1–2 | First release cut by the new team (v0.6.42 or the next train) with John watching, using the F7 runbook | Shop lead |
| 1–3 | F4 Kimi audit and fixes; Google test-account proof | Shop dev |
| 2–4 | D5 scope stopgap, with Sol + Kimi | Shop dev |
| 2–5 | P1 menu links | pubky.app maintainer |
| 1–7 | New instances on Synonym's cloud, production and staging (§7) | DevOps, Backend dev |
| 3–8 | Design PRs through the train | Designer, Shop lead |
| 5 | D6 test-listing deletion; decide what to do with listings whose keys we don't hold | Backend dev |
| 7 | Feature freeze. Set the social-host variable on staging; QA the link-out | Shop lead, QA |
| 8 | Cutover to new instances with clean databases; Nexus reindex; Shop runtime-config switch | DevOps, Backend dev |
| 8–9 | Production QA. Cross-site matrix: Ring, Bitkit and Passport sign-in on each site; sign-out on each; Shop sign-in, then pubky.app Locks still works; pubky.app sign-in, then Shop degrade prompts appear; deep links both ways; the Passport no-messaging copy | QA |
| 9 | Go/no-go; set the social-host variable on production | John, leads |
| 10 | Beta opens; pubky.app ships P1 the same day | All |
| From day 1, in parallel | G1 design (ours or Paykit's), and the S1 bundle design with the Pubky core, Ring, Bitkit and Passport teams | Backend dev, upstream teams |

## 7. Infrastructure

There are two options:

- **R.** John runs the Railway services alone.
- **S.** Synonym DevOps creates new instances on Synonym's cloud.

### Inventory (1 Oct)

| Piece | Where | Account | Public host |
|---|---|---|---|
| Shop production | Vercel, production project | Vercel team `synonymdev` | [shop.pubky.app](https://shop.pubky.app) |
| Shop staging | Vercel, staging project | same | Generated Vercel staging host (ask John) |
| Shop cron | `/api/marketplace/grant-cleanup`, every minute | same | — |
| Marketplace service + Postgres | Railway, marketplace production project | John's personal Railway workspace | Generated Railway host |
| Paykit server (fork) + Postgres | Railway, marketplace production project | same | `paykit-shop.pubky.app` |
| Marketplace Nexus (fork), Neo4j, Redis | Railway, marketplace Nexus project | same | Generated Railway host |
| Old marketplace Nexus | Railway, marketplace production project | same | Stopped 30 Sep; volumes kept |
| Locks server (fork) + Postgres | Railway, marketplace staging project (its only environment is named `production`) | same | Generated Railway host, used by the production Shop. Confirm in the dashboard |
| Staging service, Paykit, regtest `bitcoind` and Fulcrum, `fiat-verifier` (sandbox) | Railway, marketplace staging project | same | `staging-api.pubky.app` |
| Social Nexus, homeservers (production and staging), relay, Homegate, pkarr, Passport, DNS | Synonym-run | Synonym | `nexus.pubky.app`, `homeserver.pubky.app`, `homeserver.staging.pubky.app`, … |
| Images | GHCR `ghcr.io/bitcoinerrorlog/*`, pinned by digest | BitcoinErrorLog | — |
| Shop SDK | npm `@bitcoinerrorlog/pubky-shop` | BitcoinErrorLog | — |

### Quirks a new owner must know

- **Staging has its own homeserver** (`homeserver.staging.pubky.app`), service and Paykit. **Only the marketplace Nexus is shared** with production.
  - On 1 Oct the staging Shop's runtime config also listed the production Locks URL. Check whether staging actually uses it.
- **The Railway hosts are generated Railway names**, baked into the Shop's runtime config.
- **The Nexus fork is a second full indexer.** It is 86 commits ahead and 154 behind upstream, and pins a specs fork (internal Nexus fork audit). Its moderation covers posts, tags and users, not listings.
- **The Paykit fork** is 278 ahead and 65 behind. The Locks fork goes away in the convergence plan.

### The two options

| | R. John runs Railway alone | S. Synonym DevOps runs new instances (recommended) |
|---|---|---|
| Who deploys backend | John only. The dev team merges backend PRs; John deploys (as for paykit-server#23 today) | DevOps, from the repos' images, with their own manifests |
| Dev team access | Shop (Vercel) only | What DevOps grants |
| Work before the beta | None | Provision and cut over: L for DevOps, with backend-dev support |
| Data | Kept | Clean databases at cutover, allowed by the pre-launch policy. Export the canary orders first. Sellers reconnect Paykit and Locks; Nexus reindexes. D6 deletions must happen first, or the reindex brings those listings back |
| Nexus fork | Stays John's bespoke service | DevOps runs two Nexus codebases. Freeze fork features until it is slimmed to a marketplace indexer |
| Single point of failure | John | DevOps on-call |

**Recommendation:** S, with cutover on day 8. John's Railway services are stopped (not deleted) as rollback until a week after the beta. If DevOps can't confirm capacity by day 2, the beta runs on R.

### Transition plan for S

1. **Days 1–2:** DevOps gets the inventory, image digests and resource use. The backend dev lists variable names only. John passes out of band only the secrets that can't be regenerated.
2. **Days 2–5:** build production and staging sets. Each set has:
   - the service + Postgres;
   - Paykit + Postgres;
   - Locks + Postgres;
   - the marketplace Nexus + Neo4j + Redis.
   Staging also gets regtest `bitcoind` and Fulcrum, and the sandbox `fiat-verifier`. Staging gets its **own** marketplace Nexus.
3. **New secrets and hostnames.** DevOps generates new secrets wherever possible. Hostnames go under `pubky.app` (for example `api.shop.pubky.app`, `nexus.shop.pubky.app`, `locks.shop.pubky.app`), with staging equivalents.
4. **Days 6–7:** switch the staging Shop and run the staging release proof.
5. **Day 8:** production cutover.
   - Clean databases and a reindex.
   - The Shop runtime-config switch and the signed-in production proof.
   - PayPal webhook targets updated.
   - John's Railway services stopped.
6. **After the beta is stable:** delete the Railway projects. Decide GHCR and npm ownership (D8).

## 8. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| G1 (paykit-wasm grant sessions) is slow upstream | No Ring SSO, and no messaging for Passport and Bitkit users | Start the design on day 1; beta copy says messaging needs Ring for now |
| A signer team can't ship bundle support | No one-approval SSO for that signer's users | Sequential requests (two scans or taps); delegation stays a later option |
| D5 widening | The Shop holds `/priv/social`; a Shop compromise reaches pubky.app's private social data | Accepted by John; Sol + Kimi on the change; removed when F3/F6 land |
| A pubky.app cookie sign-in still narrows the Shop | Shop messaging and watchlist sync ask for re-approval | Degrade paths exist; QA cross-site matrix |
| Passport users expect messaging | Confusion | Clear refusal copy (F4) |
| The pubky.app team can't take P1 in time | No entry point from pubky.app | The Shop launches on its own URL either way |
| DevOps capacity for S | Cutover slips | Decide by day 2; R fallback |
| Cutover reindex brings back test listings | Real users see "do not buy" listings | D6 before cutover; a denylist for listings whose keys we don't hold |
| Release knowledge on John's Mac | The team can't release alone | F7, plus a first release with John watching |
| Bitkit authorize bug (bitkit-android#1398) | Bitkit sign-up can fail after a wipe | Copy fix; retest when Bitkit ships |

## 9. Decisions

### Made today (1 Oct)

- **D5:** the scope-union stopgap, with the `/priv/social` widening accepted.
- **D6:** delete the 16 test listings with seat keys where held.
- **Default branch:** switch to `release/shop-v0.6.8`.
- **paykit-server#23:** Sol + Kimi review, merge on the fork; John deploys.
- **#49:** Bitkit scanning the sign-up QR is supported.
- **D1:** link-out, coded today behind a flag that John switches on.

### Still open

Each has a recommendation:

1. **D2 Beta and SSO.** *Recommended:* open the beta on day 10 with the stopgaps (one approval per site). Commit to the **Ring-led bundle** design as post-beta work: G1 messaging grant sessions, S1 SDK bundle, R1–R3 signers, P2 pubky.app, F6 Shop. No homeserver change. Start G1 and S1 on day 1. *Alternatives:* hold the beta until SSO lands, which is all outside the two weeks; or the delegated-grant design (§3 comparison), which needs a homeserver protocol change and puts minting power in a browser app.
2. **D2a Messaging library (G1) owner.** *Recommended:* ask Paykit (dzdidi) on day 1 for a supported WASM package on their grant-based `paykit-sdk`, and port our fork's `paykit-wasm` ourselves only if they can't commit. *Alternative:* port our fork first.
3. **D4 New-user sign-up.** *Recommended:* keep the Shop's own sign-up, which covers Ring, Bitkit and, with F4, Passport. *Alternative:* send new users to pubky.app onboarding.
4. **D6 follow-up.** *Recommended:* for test listings whose seat keys we don't hold, a listing denylist in the Shop runtime config or the Nexus fork (3–4 h). *Alternative:* leave them.
5. **D7 Staging.** *Recommended:* its own marketplace Nexus on the new instances. *Alternative:* keep sharing the production marketplace Nexus.
6. **D8 Infra.** *Recommended:* S, cutover on day 8. *Alternative:* R, John runs Railway alone and deploys every backend change.
7. **D9 Paykit refusals and paykit-server#24.** *Recommended:* post-launch, unless the beta promotes Bitcoin checkout or includes Android sellers.
