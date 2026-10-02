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
2. **Single sign-on (SSO) is required, and it is built on grants, not cookies.** The homeserver deprecates cookie sessions and schedules them for removal, and grants are bound to one app's key.
   - **The target design: delegated grants through a Passport agent** ([pubky-sso-design.md](../sso/pubky-sso-design.md); team version [sso-proposal-for-team.md](../sso/sso-proposal-for-team.md); summary in §3).
     - The signer approves once per browser, giving Passport a grant it can delegate from.
     - Passport issues each app its own grant, labelled with the verified origin.
   - It needs a homeserver change (delegable grants) plus two small homeserver prerequisites:
     - several bearers per grant, vlada's multi-tab finding;
     - no cookie fallback for bearer requests.
   - pubky.app's half is [#2614](https://github.com/pubky/pubky-app/pull/2614).
   - **It has a hard prerequisite that is not in the beta path.** The Shop's messaging library (`paykit-wasm`) works only with cookie sessions, so the Shop can't move Ring users to grants yet.
   - Until messaging runs on the app's grant session, there is no full SSO for Ring users. That arrives with SSO-E1: the Shop on the shared pubky-chat library (MLS), per the [chat plan](https://github.com/BitcoinErrorLog/pubky-chat/blob/main/docs/chat-unification-plan.md). The Paykit asks (SSO-Y1, Y2) are withdrawn (Ben, 2 Oct).
   - Ring's grant sign-in is also merged but not yet released ([pubky-ring#360](https://github.com/pubky/pubky-ring/pull/360); not in v1.19), so Ring users can't be moved to grants until Ring ships it.
   - The beta stopgaps don't depend on it:
     - D5 is a Ring cookie sign-in;
     - F4 is Passport's own grant flow;
     - F5 is copy.
3. **For the beta: one approval per site, without the two sites breaking each other.** D5's stopgap stops a Shop sign-in from stripping pubky.app. Passport (F4) gives Google users a way in. F5 makes sign-out honest.
4. **Freeze features.** Launch existing flows. The backlog in §5 stays post-launch unless John moves an item up.
5. **Infra is one of two choices.** **R:** John runs Railway alone. **S:** Synonym DevOps builds new instances on Synonym's cloud. Recommendation: S, with cutover before the beta (§7).
6. **Paykit server moves onto upstream before the beta.** Upstream Paykit rc59 is wire-incompatible with our fork (rc55), and Paykit launches at the end of the week of 5 Oct or the week after (Ben, 2 Oct). The port targets rc60 and lands before the Shop launch, in about two weeks. We're pre-launch, so there is no Bitcoin pause plan. Its owner is still to be decided (§5, §9 D10).

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
  - **Every grant needs a signer approval**, so without delegation each app costs one approval per browser. The homeserver has no delegation today; the target design adds it (below).
  - **A grant can have only one live bearer.**
    - `replace_for_grant` deletes the grant's previous session in v0.11.0 and `main` alike, so two tabs on one grant invalidate each other's bearer.
    - vlada reported this in #pubky-core on 21 Sep. It is a named prerequisite, SSO-H5 below.
- **pubky.app's grant migration is draft PR [#2614](https://github.com/pubky/pubky-app/pull/2614)** (vlada).
  - New logins get per-app grants; legacy cookies keep restoring.
  - Ordinary login asks only for `/pub/pubky.app/:rw`. Locks steps up to `/priv/social/:rw,/priv/locks.app/:r`.
  - It is gated on three things: several bearers per grant, no cookie fallback, and shipped Ring grant builds.
  - It is the pubky.app half of the target design (SSO-A1).
- **Ring's grant sign-in is merged but not released.**
  - It merged to `main` on 3 Sep in [pubky-ring#360](https://github.com/pubky/pubky-ring/pull/360).
  - The latest release, [v1.19](https://github.com/pubky/pubky-ring/releases/tag/v1.19) (4 Sep), doesn't list it. Ring's developer confirms grant auth is "still to be released, not in v1.19".
  - The v1.19 tag's source does contain the merge, so ask Ring which release actually turns it on.
  - Released Ring supports cookie auth only. Grant sign-in through Ring is unavailable to users until that release.
- **The Shop's messaging library only works with cookie sessions, and it is ours.**
  - The vendored `paykit-wasm` 0.1.0-rc50 exists only in our fork [BitcoinErrorLog/paykit-rs-official](https://github.com/BitcoinErrorLog/paykit-rs-official) (`paykit-wasm/`).
  - It is built on pubky 0.8, and its session API is `restoreSession` and `resumeSessionFromCookie` (`paykit-wasm/src/session.rs`).
  - Upstream [pubky/paykit-rs](https://github.com/pubky/paykit-rs) is on pubky 0.12 and already uses grant sessions in `paykit-sdk`, but it ships **no WASM binding**, and Ben confirmed on 2 Oct that none is planned.
  - That is why Bitkit grant sessions get no messaging today, and why Passport users won't have it either.
  - **The fix is the chat plan, not Paykit.** Shop messaging is frozen as beta and moves to the shared pubky-chat library on MLS (SSO-E1). Until that cutover it stays on Ring cookie sessions, and the cutover is what gates messaging for Passport and Bitkit users.
  - If Ring sign-in moved to grants now, three things would break:
    - every Ring user would lose messaging;
    - Ring's single approval (one AuthToken to both the homeserver and the service, per [single-approval.md](https://github.com/BitcoinErrorLog/pubky-app/blob/release/shop-v0.6.8/docs/ecommerce/single-approval.md)) would become two;
    - the messaging fallback would set a narrow `/pub/paykit/:rw` cookie, which brings the overwrite back.
- **The transaction service authenticates separately today.**
  - Ring cookie sessions post the same `AuthToken` to the homeserver and the service.
  - Grant sessions (Bitkit, Passport) approve a second grant for the service at the first purchase.
  - The target design removes both: the service accepts the Shop's own grant (SSO-F3).

### Target SSO design: delegated grants through a Passport agent

The target design is [pubky-sso-design.md](../sso/pubky-sso-design.md). The team-facing version, with the change list, phases and questions, is [sso-proposal-for-team.md](../sso/sso-proposal-for-team.md). In short:

1. **Grants are the only session type.** Each app holds its own grant, bound to its own non-extractable key. Nothing is ambient.
2. **The signer approves once per browser** (Ring, Bitkit, or Passport's own key). It gives an **agent grant** to Pubky Passport (`passport.pubky.app`), a browser account agent.
   - The agent grant's capabilities carry a `d` (delegate) action: the ceiling of what the agent may grant onward.
   - The ceiling grows by signer step-up when an app needs more.
3. **The agent issues each app's grant.**
   - `client_id` is set from the origin the browser reports, and any mismatch is refused.
   - Scopes stay within the ceiling, and there is one level only.
   - First-party `*.pubky.app` apps get theirs silently through a same-site frame. Third-party apps get a one-click popup.
4. **The homeserver verifies child grants against their parent.** Revoking the agent's grant signs out every app in that browser. Ring's root session can revoke everything.
5. **Messaging runs on the app's own grant session** through the shared pubky-chat library (MLS). Paykit keeps Encrypted Links for payments. Paykit scope narrowing is dropped, because Paykit state is shared per identity by design (Ben, 2 Oct).
   - **Keys for private data travel beside the grant,** in the encrypted relay payload, never inside it. They are derived by the signer and scoped to the grant's paths (SSO-K6, Andrei; in progress).
6. **Services accept the app's own grant,** with a PoP addressed to them. That ends the `AuthToken` dual post and the second service grant.
7. **Two homeserver prerequisites** must land before any app is grant-only:
   - several bearers per grant (SSO-H5, vlada's multi-tab finding);
   - no cookie fallback for bearer requests (SSO-H6, from #2614).

**What users get:**

- one approval per browser;
- pubky.app and the Shop signed in together;
- no scope overwriting;
- sign-out per app, per browser or everywhere;
- messaging for every signer;
- apps can only get grants under their own origin.

**Without the delegation change (SSO-H1)**, everything else still works with one approval per app per browser. Passport-key users get full SSO from the Passport agent alone.

### What SSO depends on

Item IDs prefixed **SSO-** are the change list in [sso-proposal-for-team.md §3.3](../sso/sso-proposal-for-team.md#33-change-list-per-repo). Sizes there describe technical scope, not days.

| # | Piece | Owner | Size | In the beta path? |
|---|---|---|---|---|
| SSO-H5 | **Several bearers per grant.** `replace_for_grant` keeps up to a small bound (suggest 8) instead of deleting the previous bearer. Gates #2614 and the Shop | Pubky core | S | No |
| SSO-H6 | **No cookie fallback.** A request carrying `Authorization` ignores cookies; the SDK omits browser credentials for grant sessions | Pubky core | S | No |
| SSO-R0 | Ring release with grant auth ([#360](https://github.com/pubky/pubky-ring/pull/360) merged; [#375](https://github.com/pubky/pubky-ring/issues/375) Android library). **In progress:** release process started | Ring team | S | No |
| SSO-A1 | pubky.app on grants: [#2614](https://github.com/pubky/pubky-app/pull/2614), client id set to the origin host | pubky-app maintainers (vlada) | M | No |
| SSO-H1, K1, K3, K4 | Delegable grants: `d` action, child-grant verification, cascade revocation, SDK signer and delegate APIs, agent protocol spec, SDK gaps | Pubky core | L + M + S + S | No |
| SSO-P1, P2 | Passport as the account agent, plus a Ring-linked mode | Passport team | L + M | No |
| SSO-R1, R2, B1 | <ul><li>Ring and Bitkit: show the client id and plain-word scopes. **Agreed** by Ring.</li><li>A distinct agent-grant screen.</li><li>A session list with per-grant revoke, which **exists** as Ring draft [#369](https://github.com/pubky/pubky-ring/pull/369), pending FFI and react-native-pubky releases.</li></ul> | Ring and Bitkit teams | M; S for R2 after #369 | No |
| ~~SSO-Y1, Y2~~ | Paykit storage interface and WASM package. **Withdrawn (Ben, 2 Oct):** messaging moves to pubky-chat, and payments need nothing in the browser | — | — | — |
| SSO-K6 | Scoped keys: signer-derived, delivered beside the grant in the encrypted relay payload; Passport holds scoped seeds and derives locally | Pubky core (Andrei, in progress); Ring, Bitkit, Passport | M | No |
| SSO-F1 | Shop: one sign-in through the agent; remove the cookie path, the bridge, the `AuthToken` dual post and the scope union, after a dead-code check | us | M (Sol + Kimi) | No |
| SSO-E1 | Replaces SSO-F2. Shop messaging on the shared pubky-chat library (MLS), on the Shop's own grant session ([chat plan](https://github.com/BitcoinErrorLog/pubky-chat/blob/main/docs/chat-unification-plan.md)) | us | L | No |
| SSO-F3 | Marketplace service and Lock Server fork accept the Shop's grant | us | M (Sol + Kimi) | No |
| SSO-A2 | pubky.app gets its grant from the agent | pubky-app maintainers | S–M | No |

**Ring users on grants** (formerly F3 here) means SSO-F1 for Ring users. It needs SSO-R0, SSO-H5, SSO-H6 and, so they keep messaging, SSO-E1.

**Full SSO** needs, in addition: SSO-H1, K1, K3, P1 (and P2 for Ring), R1, R2 or B1, A2 and F1. Delegated grants (SSO-H1) are still core's open item.

**Messaging library choice (D2a): settled.** Paykit won't ship a storage interface, a WASM package or a custom-message API (Ben, 2 Oct). Messaging moves to pubky-chat (SSO-E1), and we don't port our fork's `paykit-wasm`.

### Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **Ring bundle.** One signer approval issues a grant to each first-party app, with a companion frame on each site and an SDK bundle request. This was earlier the recommendation here | <ul><li>Covers only apps present and coordinated at sign-in. Each app hosts a frame for every other app, and third-party frames are partitioned.</li><li>A new app, a new scope or a lost session goes back to the signer.</li><li>It is consent to several apps at once, not SSO.</li><li>Its only advantage, no homeserver change, doesn't outweigh that.</li></ul> |
| **Cookie bridge** ([#2484](https://github.com/pubky/pubky-app/pull/2484), Shop ADR 0029) | <ul><li>Keeps the ambient shared cookie: every site rides one scope set, and the last sign-in wins.</li><li>Off-domain apps break on Safari.</li><li>It is deprecated. Its variables are unset in both live builds.</li></ul> |
| **Ring auto-approve**, or remembered consent in Ring | <ul><li>A grant's client id is self-declared, and Ring can't tell which website showed a QR, so a phishing page could claim `shop.pubky.app`.</li><li>Ring's existing auto-auth (`getAutoAuthFromStore`) is a developer setting, off by default. It only needs to stay unreachable in release builds.</li></ul> |
| **A user session at the homeserver** that issues per-app grants | <ul><li>It is cross-origin to every app, so it is a cookie again, or partitioned storage.</li><li>It doesn't carry to mirrors.</li><li>It makes the storage provider an identity provider.</li></ul> |
| **pubky.app as the broker** | The site that renders user content, the most exposed to injected script, would hold minting power. The agent is a small static origin instead |
| **One tab owns the bearer**, shared through a BroadcastChannel or a SharedWorker | <ul><li>Background tabs freeze, and SharedWorker is missing on Chrome for Android.</li><li>Every app and library would need election code.</li><li>No security gain.</li></ul> SSO-H5 fixes it once in the homeserver. Detail: [pubky-sso-design.md §4](../sso/pubky-sso-design.md) |

### For the beta (what ships instead)

- **D5 stopgap, the scope union.**
  - **Change:** Ring cookie sign-in requests the union of pubky.app 1.12.0's scopes and the Shop's: `/pub/pubky.app/:rw,/pub/paykit/:rw,/priv/pubky.app/:rw,/priv/social/:rw,/priv/app.locks/content/:r`. Use the final 1.12.0 string.
  - **Scope of the change:** Bitkit grants keep the current constant. The exact-set checks (`capabilitiesMatchFullGrant`, the step-up comparison) need a separate constant, so Bitkit sessions are unaffected.
  - **Effect:** a Shop sign-in no longer strips pubky.app's Locks access. A later pubky.app cookie sign-in still narrows the Shop, because pubky.app doesn't request the Shop's scopes. The Shop's existing degrade paths (`needs_reauth`, the messaging enable prompt) handle that, and QA checks it.
  - **Size and review:** 4–6 h, Sol + Kimi. The accepted widening is that the Shop holds `/priv/social`.
  - **How it interacts with [#2614](https://github.com/pubky/pubky-app/pull/2614):**
    - Once #2614 ships, new pubky.app logins are grants. They no longer read the cookie, so the union matters only for pubky.app users still on legacy cookies.
    - #2614 moves Locks' creator-originals path to `/priv/locks.app/`. Change the Locks entry in the union to whatever path pubky.app actually ships.
    - Until SSO-H6 lands, the Shop's broad cookie could authorize a pubky.app grant request whose bearer failed. #2614 lists that as a release gate, and QA should include it.
- **F4 Passport,** being coded today.
  - [Passport](https://github.com/pubky/pubky-passport) approves grant requests from any app, with no allowlist. It creates the identity for new Google users during authorization ([integration guide](https://github.com/pubky/pubky-passport/blob/main/docs/integration.md)).
  - SDK 0.11.0 already has `startGrantAuthFlow` and `tryPollOnce`. The Shop adds the button, the callback page and a `Cross-Origin-Opener-Policy: same-origin-allow-popups` header.
  - No Passport change is needed.
  - **Limit: no messaging** until SSO-E1. The refusal copy must say so without naming Ring as the only way.
- **F5 sign-out copy,** being coded today. Ring cookie sessions: Shop sign-out ends the shared cookie, so pubky.app is signed out in that browser too. Bitkit and Passport grant sessions: only the Shop is signed out.
- **Dead bridge (formerly F2): done.** Both live builds have the variables unset. Cold signed-out loads make no bridge request. v0.6.42 removes the variables from the config, and F7 drops the two `#s=` proof checks.

## 4. Change list

pubky.app, homeserver, SDK, Paykit and signer changes belong to their teams. We don't push to `pubky/*` or `synonymdev/*`.

**Launch work:**

| # | Repo | Change | Size | Status |
|---|---|---|---|---|
| P1 | pubky.app | Top-menu **Marketplace** and **Messaging** items, URL from runtime config | S | Ask the pubky-app team |
| P3 | pubky.app | Optional "Message" on a profile, linking to the Shop | S | Optional |
| F1 | Shop | Link-out behind a build flag, plus the component fixes (§2) | M | **Coding today** |
| F2 | Shop | Unset the bridge variables | XS | **Done** (v0.6.42 cleans the config) |
| D5 | Shop | Ring cookie sign-in requests both sites' scopes | S | Decided; next |
| F4 | Shop | Passport sign-in and service grant | M | **Coding today**; ships after Kimi |
| F5 | Shop | Sign-out copy by session type | XS | **Coding today** |
| F7 | Shop | Handoff docs, repo runbook, drop the `#s=` proof checks | S | **Coding today** |

**SSO work (post-beta; full list in [sso-proposal-for-team.md §3.3](../sso/sso-proposal-for-team.md#33-change-list-per-repo)):**

| # | Repo | Change | Status |
|---|---|---|---|
| SSO-H5, H6 | homeserver | Several bearers per grant; no cookie fallback | Ask core first; gates #2614 |
| SSO-R0 | Ring | Release grant auth | In progress (Ring, 1 Oct) |
| SSO-A1 | pubky.app | [#2614](https://github.com/pubky/pubky-app/pull/2614) | In review; we offer to review |
| SSO-H1, K1, K3, K4 | homeserver, SDK | Delegable grants, agent protocol, SDK gaps | Ask core (proposal §4, Q1) |
| ~~SSO-Y1, Y2~~ | Paykit | Storage interface and WASM package | Withdrawn (Ben, 2 Oct) |
| SSO-K6 | SDK, signers | Scoped keys delivered beside the grant | SDK in progress (Andrei); then Ring, Bitkit, Passport |
| SSO-P1, P2 | Passport | Account agent; Ring-linked mode | Ask Passport |
| SSO-R1, R2, B1 | Ring, Bitkit | Consent and session screens | Ring: origin and scopes agreed; grant list in [#369](https://github.com/pubky/pubky-ring/pull/369); agent screen explained in [proposal §2.8](../sso/sso-proposal-for-team.md#28-rings-side-of-the-agent-grant). Ask Bitkit |
| SSO-F1, E1, F3 | Shop, service, Lock Server fork | Agent sign-in, messaging on pubky-chat (MLS), service accepts the Shop's grant | us, after the above; E1 after pubky-chat Phase 2 |
| SSO-A2 | pubky.app | Grant from the agent | After P1 |

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
| **Paykit server port onto upstream, targeting rc60.** <ul><li>Start from upstream master and re-implement the marketplace contract the service and Shop use.</li><li>Fresh database; exactly one process (upstream's rule).</li><li>The server stays a delegated Paykit app and never holds identity secrets.</li><li>Shop side: the buyer pre-check reads the App Registry and the signed Noise-key record, and the Get Paid copy says that Paykit Server can read and write the seller's Paykit data.</li></ul> | Lands before the Shop launch (about 2 weeks), ahead of or with Paykit's launch (end of the week of 5 Oct or the week after). Pre-launch, so no Bitcoin pause plan. **Owner to be decided** (§9 D10) | L, sensitive: design review, independent protocol review, fresh Kimi audit, staging proof on Android and iOS |
| Production homeserver on v0.14 with WebDAV locks | rc59 and rc60 take a lock for every shared-state write, and production `homeserver.pubky.app` doesn't advertise locks yet. James's call | External |
| QA retests: [#50](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/50) quantity-1, including whether unpaid orders lapse; [#12](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/12) packing slip, needs a paid shipping order | Waiting on Pav | QA |
| Ownership: on-call owner, Sentry alert routing, Postgres backups with one restore test | §7 | S (ops) |

**Done, removed from this list:**

- 429/500 homeserver write retries ([#155](https://github.com/BitcoinErrorLog/pubky-app/pull/155), v0.6.36). Residual about 1 h: confirm that Encrypted Link sends and outbox clears are covered by #171's backoff. On the homeserver side, tomos merged the same-path 500 fix (2 Oct); the lock-gap fix (a write can still publish after its lock expired) waits for Sev.
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

- **SSO chain** (§3 and the [team proposal](../sso/sso-proposal-for-team.md)):
  - SSO-H5, H6 and R0 first, which unblock #2614;
  - then SSO-H1, K1, K3, K4, K6, P1, P2, R1, R2, B1;
  - then SSO-F1, E1, F3 and A2.

  Messaging for Passport and Bitkit users arrives with SSO-E1.
- **Messaging rebuild:** the [chat plan](https://github.com/BitcoinErrorLog/pubky-chat/blob/main/docs/chat-unification-plan.md) (MLS through pubky-chat; SSO-E1). It replaces the earlier rebuild on Paykit/pubky-noise storage seams, whose upstream asks are withdrawn.
- **Upstream convergence:** Locks to `pubky/*` (internal convergence plan); [#44](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/44), [#35](https://github.com/BitcoinErrorLog/pubky-marketplace/issues/35). The Paykit server port is pre-launch work now (§5). After it, upstream [paykit-server#26](https://github.com/pubky/paykit-server/issues/26) is the route to retiring our marketplace-specific layer.
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
| 1–9 | Paykit server port onto upstream (rc60), staging proof with rc60 Bitkit builds on Android and iOS, then production on a fresh database with sellers reconnecting | Owner to be decided (D10). While on R, the owner deploys on John's Railway |
| 7 | Feature freeze. Set the social-host variable on staging; QA the link-out | Shop lead, QA |
| 8 | Cutover to new instances with clean databases; Nexus reindex; Shop runtime-config switch | DevOps, Backend dev |
| 8–9 | Production QA. Cross-site matrix: Ring, Bitkit and Passport sign-in on each site; sign-out on each; Shop sign-in, then pubky.app Locks still works; pubky.app sign-in, then Shop degrade prompts appear; deep links both ways; the Passport no-messaging copy | QA |
| 9 | Go/no-go; set the social-host variable on production | John, leads |
| 10 | Beta opens; pubky.app ships P1 the same day | All |
| From day 1, in parallel | <ul><li>Send the [team proposal](../sso/sso-proposal-for-team.md) to core, Ring, Bitkit, Passport, Paykit and pubky.app.</li><li>Ask core for SSO-H5 and H6 first (they gate #2614).</li><li>Ask James when production moves to homeserver v0.14.</li><li>Follow [paykit-rs#169](https://github.com/pubky/paykit-rs/pull/169) for the handshake static-key check.</li><li>Review #2614.</li></ul> | John, backend dev, upstream teams |

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
- **The Paykit fork** is 278 ahead and 65 behind, on rc55. It is being ported onto upstream at rc60 before the beta (§5). The ported server must run as **exactly one process**: restoring the same grant in a second process invalidates the first one's bearer, so deploys stop the old process before starting the new one. The Locks fork goes away in the convergence plan.

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
   - Paykit (the ported rc60 build, one process, no deploy overlap) + Postgres;
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
| The Paykit server port slips past Paykit's launch, or has no owner | Upgraded Bitkit users can't receive the Shop's payment requests, and sellers on the new Bitkit can't connect | Name the owner now (D10); start on staging with the rc60 Bitkit builds; PayPal is unaffected |
| Production homeserver isn't on v0.14 by Paykit's launch | rc59/rc60 shared-state writes fail without WebDAV locks | Ask James on day 1 |
| The rc60 handshake doesn't check the peer's static key against the signed key ([paykit-rs#169](https://github.com/pubky/paykit-rs/pull/169)) | A `/pub/paykit/:rw` holder on a peer's homeserver could swap a handshake message and impersonate that peer on a new link | Raised with Ben; track the fix and its negative test |
| Pubky-chat (SSO-E1) is slow | No Ring move to grants, and no messaging for Passport and Bitkit users | Beta copy says messaging needs Ring for now |
| Core declines or delays delegable grants (SSO-H1) | No silent SSO for Ring users | Grants per app still ship: one approval per app per browser. Passport-key users still get SSO from the agent |
| SSO-H5 and H6 slip | #2614 and the Shop can't go grant-only. Tabs invalidate each other, and an ambient cookie can stand in for a failed bearer | Ask core first; these are small changes, and the homeserver team already offered the multi-bearer fix |
| D5 widening | The Shop holds `/priv/social`; a Shop compromise reaches pubky.app's private social data | Accepted by John; Sol + Kimi on the change; removed when SSO-F1 lands |
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

### Made 2 Oct, on Ben's Paykit answers

- **D2a settled:** SSO-Y1, Y2 and the custom-message API are withdrawn. Messaging moves to pubky-chat (SSO-E1). Shop messaging stays on Ring cookie sessions until that cutover, which gates messaging for Passport and Bitkit users.
- **Paykit scope narrowing dropped:** shared state per identity is by design.
- **Paykit server port:** onto upstream at rc60, before the Shop launch, with no Bitcoin pause plan, since we're pre-launch. Its owner is D10.

### Still open

Each has a recommendation unless noted:

1. **D2 Beta and SSO.**
   - *Recommended:* open the beta on day 10 with the stopgaps (one approval per site). Commit to **delegated grants through a Passport agent** as post-beta work ([pubky-sso-design.md](../sso/pubky-sso-design.md), [team proposal](../sso/sso-proposal-for-team.md)).
   - Send the proposal on day 1. Ask core for SSO-H5 and H6 first, because they unblock pubky.app's #2614 and our own move to grants.
   - *Alternatives:* hold the beta until SSO lands, which is all outside the two weeks; or the Ring bundle, rejected in §3 because it isn't SSO for new apps, new scopes or lost sessions.
2. **D4 New-user sign-up.** *Recommended:* keep the Shop's own sign-up, which covers Ring, Bitkit and, with F4, Passport. *Alternative:* send new users to pubky.app onboarding.
3. **D6 follow-up.** *Recommended:* for test listings whose seat keys we don't hold, a listing denylist in the Shop runtime config or the Nexus fork (3–4 h). *Alternative:* leave them.
4. **D7 Staging.** *Recommended:* its own marketplace Nexus on the new instances. *Alternative:* keep sharing the production marketplace Nexus.
5. **D8 Infra.** *Recommended:* S, cutover on day 8. *Alternative:* R, John runs Railway alone and deploys every backend change.
6. **D9 Paykit refusals and paykit-server#24.** *Recommended:* post-launch, unless the beta promotes Bitcoin checkout or includes Android sellers.
7. **D10 Paykit server port owner.** No recommendation yet. The port (§5) must land before the beta.
   - *Option:* the incoming backend dev, paired with dzdidi.
   - *Option:* us, deploying staging then production. We run deploys on John's Railway ourselves until the infra cutover.
