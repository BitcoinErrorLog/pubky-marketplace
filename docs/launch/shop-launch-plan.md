# Pubky Shop: beta launch and handoff plan

Scope: [shop.pubky.app](https://shop.pubky.app), built from this repository, [pubky/pubky-marketplace](https://github.com/pubky/pubky-marketplace) (branch `master`; the code and its history came from the fork `BitcoinErrorLog/pubky-app`, branch `release/shop-v0.6.8`, which is frozen for Shop work from 6 Oct), handed to a dev team for about two weeks, ending in a beta for real users. Facts were checked on 1 Oct 2026 against the repos, the live sites and GitHub (status, blockers, timeline and decisions refreshed 5 Oct), and reviewed against the code as it stood that day and the 1 Oct issue triage of the [pubky-marketplace tracker](https://github.com/pubky/pubky-marketplace/issues). Sizes are for one developer and include tests and review: **XS** under half a day, **S** half a day to 2 days, **M** 3 to 5 days, **L** more than a week.

## Status, deadlines and freeze (5 Oct)

Current status per repo, the release and rollback table, and who to ask are in the [team brief](shop-team-brief.md). This section carries what the plan needs.

**Shipped.** The 1 Oct "coding today" items shipped in Shop v0.6.45 (1 Oct): F1 (behind a flag that is off), F4, F5, F7, #62, #63 and #49 copy. The release also carried D5 and the #164 fix via #178. F4 still needs its Google-login production proof. Four merged fixes wait for v0.6.46.

**Date numbering.** Day 1 was set as Mon 5 Oct and the beta as Thu 15 Oct, day 10. Those disagree by one day: day 10 counted from Mon 5 Oct is Wed 14 Oct. The recommendation (§9) keeps the beta on Thu 15 Oct and counts day 1 as Tue 6 Oct. Until John decides, dates below show both counts where they differ.

### This week's deadlines

Where a row says "team to assign", the owning team names the person.

| When | What | Owner |
|---|---|---|
| **Tue 6 Oct** (day 1 or 2) | DevOps confirms capacity for S. If not, the beta runs on R (§7) | Vlad (Synonym DevOps); John declares R or S |
| Mon 5 – Tue 6 Oct | Assign the Paykit port owner and decide which branch the port starts from (D10) | Paykit team — team to assign |
| **Thu 8 Oct, 17:07 UTC** | GitHub and Railway write invites expire (Railway staging at 17:35 UTC) | Vlad accepts; the current maintainers resend if missed |
| End of the week of 5 Oct, or the week after | Paykit launch (Ben, 2 Oct) | Paykit team |
| Fri 9 or Sat 10 Oct (day 5, depending on the anchor) | Denylist the remaining test listings; prepare a separate staging index | Nexus team — team to assign; every listing under our deletion control is already deleted |
| Sun 11 or Mon 12 Oct (day 7) | Feature freeze; set the social-host variable on staging; QA the link-out | Shop team — team to assign; QA |
| Mon 12 or Tue 13 Oct (day 8) | Production cutover to the new instances (if S); Nexus reset and reindex | Vlad; Nexus team — team to assign |
| Thu 15 Oct | Beta opens | All |

### What's frozen

- **Features:** launch existing flows only; the post-launch backlog stays in §5.
- **Handoff freeze (John, 2 Oct):** nothing that could disrupt anything major. Read-only checks, small safe fixes and docs only; anything risky needs John's explicit OK.
- **Shop messaging:** frozen as beta on Paykit Encrypted Links until the pubky-chat MLS cutover (SSO-E1). The chat Phase 0 fixes are the exception (§5).
- **Nexus fork features:** frozen until the fork is slimmed to a marketplace indexer. Tag-race round 4 and the backfill retry are parked post-launch.
- **Paykit fork (rc55):** no new features. The only work is the port and deploying approved fixes; the [paykit-server#27](https://github.com/BitcoinErrorLog/paykit-server/issues/27) fix landed via [#29](https://github.com/BitcoinErrorLog/paykit-server/issues/29) on 5 Oct.
- **Deprioritized:** the Shopify real-store proof, the single-shop storefront (SF1–SF9), Stripe.
- **Pre-launch policy:** fix forward; roll back only on data loss or money moving wrongly.

## 1. Recommendation in one page

1. **Two sites, linked both ways.** pubky.app adds **Marketplace** and **Messaging** to its top menu. The Shop sends feed, profile, post, collection and settings links to pubky.app, and keeps marketplace, messages, sign-in and sign-out.
2. **Single sign-on (SSO) is required, and it is built on grants, not cookies.** The homeserver deprecates cookie sessions and schedules them for removal, and grants are bound to one app's key.
   - **The target design: delegated grants through a Passport agent** ([pubky-sso-design.md](../sso/pubky-sso-design.md); team version [sso-proposal-for-team.md](../sso/sso-proposal-for-team.md); summary in §3).
     - The signer approves once per browser, giving Passport a grant it can delegate from.
     - Passport issues each app its own grant, labelled with the verified origin.
   - It needs a homeserver change (delegable grants) plus two small homeserver prerequisites:
     - several bearers per grant, vlada's multi-tab finding;
     - no cookie fallback for bearer requests.
   - pubky.app's half is [#2614](https://github.com/pubky/pubky-app/issues/2614).
   - **It has a hard prerequisite that is not in the beta path.** The Shop's messaging library (`paykit-wasm`) works only with cookie sessions, so the Shop can't move Ring users to grants yet.
   - Until messaging runs on the app's grant session, there is no full SSO for Ring users. That arrives with SSO-E1: the Shop on the shared pubky-chat library (MLS), per the [chat plan](https://github.com/pubky/pubky-chat/blob/main/docs/chat-unification-plan.md). The Paykit asks (SSO-Y1, Y2) are withdrawn (Ben, 2 Oct).
   - Ring's grant auth shipped in [v2.0](https://github.com/pubky/pubky-ring/releases/tag/v2.0) (5 Oct), on both Android and iOS (James, 7 Oct). [v1.19](https://github.com/pubky/pubky-ring/releases/tag/v1.19) has no grant auth on either platform ([pubky-ring#375](https://github.com/pubky/pubky-ring/issues/375)); users on 1.19 just need to update. Ring is therefore no longer a blocker for moving Ring users to grants; the messaging library above is.
   - The beta stopgaps don't depend on it:
     - D5 is a Ring cookie sign-in;
     - F4 is Passport's own grant flow;
     - F5 is copy.
3. **For the beta: one approval per site, without the two sites breaking each other.** D5's stopgap stops a Shop sign-in from stripping pubky.app. Passport (F4) gives Google users a way in. F5 makes sign-out honest.
4. **Freeze features.** Launch existing flows. The backlog in §5 stays post-launch unless John moves an item up.
5. **Infra is one of two choices.** **R:** the current Railway deployment stays, and the current maintainers keep deploying. **S:** Synonym DevOps builds new instances on Synonym's cloud. Recommendation: S, with cutover before the beta (§7).
6. **Paykit server moves onto upstream before the beta.** Upstream Paykit rc59 is wire-incompatible with our fork (rc55), and Paykit launches at the end of the week of 5 Oct or the week after (Ben, 2 Oct). The recommended starting point, pending D10, is upstream paykit-server rc9 (released 7 Oct; see the 8 Oct update below). It targets the Paykit rc Bitkit pins (rc62 on 5 Oct; rc71 in rc9), and lands before the Shop launch, in about two weeks. Ben published Paykit [rc60](https://github.com/pubky/paykit-rs/releases/tag/v0.1.0-rc60), [rc61](https://github.com/pubky/paykit-rs/releases/tag/v0.1.0-rc61) and [rc62](https://github.com/pubky/paykit-rs/releases/tag/v0.1.0-rc62) on 3 Oct, all as prereleases. rc60 pins pubky-noise at revision `42e00f22`, so [pubky-noise#39](https://github.com/pubky/pubky-noise/issues/39) no longer gates us. rc61 fixed a link-lease bug introduced in rc60, and rc62 keeps rc61's API and persisted format. Request delivery on staging isn't down to a few seconds yet. We're pre-launch, so there is no Bitcoin pause plan. The Paykit team assigns its owner and decides which branch the port starts from (§9 D10). Ben answered our port questions on 5 Oct ([paykit-rs#169](https://github.com/pubky/paykit-rs/issues/169#issuecomment-5991461514)):
   - Both Bitkit PRs pin rc62. There's no production date, and rc62 isn't promised as the shipping version while performance testing continues.
   - rc60 state is readable by rc61 and rc62. The only fresh-state boundary is rc59 → rc60, so following Bitkit's pin within rc6x needs no reset.
   - Bitkit is the authorizer, for identities it creates and for Ring identities it reads through the shared keychain on the same device. It publishes the signed Paykit key and delegates Paykit access to the server without the Pubky secret.
   - ~~There's no paykit-server release on rc62 and no date for one, so the port bumps Paykit on rc8 itself.~~ **Update 8 Oct:** upstream paykit-server [`v0.1.0-rc9`](https://github.com/pubky/paykit-server/releases/tag/v0.1.0-rc9) (7 Oct, 22:41 UTC) carries Paykit rc71 and the signed-key authorization ([#46](https://github.com/pubky/paykit-server/issues/46), merged 7 Oct 20:40 UTC) and the Android Bitkit intent link ([#49](https://github.com/pubky/paykit-server/issues/49), which took over #44 and closed #31). The port starts from rc9. rc9 requires homeserver 0.15+ on every serving instance ([#48](https://github.com/pubky/paykit-server/issues/48)), **Update 9 Oct:** production `homeserver.pubky.app` has been on v0.15.0 since 9 Oct 2026 (James), so that requirement is satisfied on production and the Paykit cutover needs no further homeserver bump. The critical path is the port itself, then Bitkit's release. Also **update 9 Oct:** upstream is now [`v0.1.0-rc10`](https://github.com/pubky/paykit-server/releases/tag/v0.1.0-rc10) (8 Oct, 20:07 UTC): Reader admission ([#52](https://github.com/pubky/paykit-server/issues/52)), the `[signed_services]` allowlist with key rotation ([#55](https://github.com/pubky/paykit-server/issues/55), PK-4), reader proposal deadlines ([#53](https://github.com/pubky/paykit-server/issues/53)) and reader payments without private-list sharing ([#54](https://github.com/pubky/paykit-server/issues/54)). Still open upstream: prepare/activate/void and resolve (PK-5, PK-6). The homeserver 0.15 requirement is met on production.

## 2. Seam 1: navigation between pubky.app and the Shop

**The problem.** The Shop forked upstream `dev` on 20 Aug ([#2340](https://github.com/pubky/pubky-app/issues/2340), commit `6348001555`). It is now 161 upstream commits behind and 1,406 ahead. Its nav keeps users inside its own copy of the social app. That copy lacks what pubky.app has shipped since:

- Passport sign-in ([#2587](https://github.com/pubky/pubky-app/issues/2587));
- the new onboarding steps;
- Locks pay-to-unlock ([#2689](https://github.com/pubky/pubky-app/issues/2689));
- the 1.12.0 release that is waiting to ship ([#2719](https://github.com/pubky/pubky-app/issues/2719)).

### Options

| Option | What changes | Size | Verdict |
|---|---|---|---|
| A. Status quo | Nothing | 0 | Users drift into a stale social app |
| **B. The Shop links out to pubky.app** | Shop redirects and nav; pubky.app adds two menu links | M (Shop) + S (pubky.app) | **Recommended (D1); Shop side shipped in v0.6.45, flag off** |
| C. A marketplace-only Shop | Delete the social routes and shell from the fork | L | The end state; too risky in two weeks (per the marketplace seam analysis, an internal doc) |
| D. Merge into pubky.app as a module | In-repo module, then upstream | L (240–360 h) | Out of the window |

### Option B in detail

**Redirects.** Social routes 307-redirect to the same path on pubky.app (on staging, to `staging.pubky.app`) from `redirects()` in [`next.config.ts`](../../next.config.ts). They are gated on the social-host build variable.

| Path on the Shop | Goes to | Note |
|---|---|---|
| `/home`, `/feed/*`, `/hot`, `/search`, `/who-to-follow` | pubky.app, same path | Shop-only shelves become unreachable; remove them later, after a workspace-wide dead-code check |
| `/post/:user/:id`, `/collections/*` | pubky.app, same path | Saved listings stay in the Shop watchlist |
| `/profile`, `/profile/:pubky/*` | pubky.app, same path | `/profile/notifications` goes to `/marketplace/notifications` |
| `/settings/*` | pubky.app, same path | Shop settings stay at `/marketplace/settings/*`, plus Shop sign-out |
| `/onboarding/*` | Stays in the Shop | D4 |
| `/marketplace/*`, `/messages/*`, `/sign-in`, `/logout`, `/copyright`, `/invite/*`, `/offline`, `/share` | Stays | `/` already redirects to `/marketplace` |

**Component fixes. A redirect list alone is not enough,** because several places send users to `/home` themselves. Without SSO, each of these would land a signed-in user on a signed-out pubky.app. All of them point to `/marketplace` instead:

- `AUTHENTICATED_ROUTES.redirectTo` in [`routes.ts`](../../src/app/routes.ts), which the route guard uses;
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
  - The old cookie bridge ([#2484](https://github.com/pubky/pubky-app/issues/2484), Shop ADR 0029) is not the SSO answer. Its build variables are unset in both live Shop builds.
- **Grants are per app.**
  - A grant is bound to one client id and that app's own proof-of-possession (PoP) key.
  - In the browser that key is a non-extractable WebCrypto key in that origin's store.
  - **A grant is signed by the user's own key, which lives in the signer (Ring, Bitkit or Passport).** The homeserver verifies it on its own and stores it idempotently ([grant module docs](https://github.com/pubky/pubky-homeserver/blob/main/pubky-homeserver/src/client_server/auth/grant/mod.rs): "Ring … signs only at Grant creation").
  - A grant request (`signin_grant`) carries one client id, one client public key, the scopes and a relay channel ([`signin_grant.rs`](https://github.com/pubky/pubky-homeserver/blob/main/pubky-sdk/src/actors/auth/deep_links/signin_grant.rs)).
  - **Every grant needs a signer approval**, so without delegation each app costs one approval per browser. The homeserver has no delegation today; the target design adds it (below).
  - **A grant can have only one live bearer.**
    - `replace_for_grant` deletes the grant's previous session in v0.11.0 and `main` alike, so two tabs on one grant invalidate each other's bearer.
    - vlada reported this in #pubky-core on 21 Sep. It is a named prerequisite, SSO-H5 below.
- **pubky.app's grant migration is draft PR [#2614](https://github.com/pubky/pubky-app/issues/2614)** (vlada).
  - New logins get per-app grants; legacy cookies keep restoring.
  - Ordinary login asks only for `/pub/pubky.app/:rw`. Locks steps up to `/priv/social/:rw,/priv/locks.app/:r`.
  - It is gated on three things: several bearers per grant, no cookie fallback, and shipped Ring grant builds.
  - It is the pubky.app half of the target design (SSO-A1).
- **Ring's grant auth ships from v2.0, on Android and iOS.**
  - [v2.0](https://github.com/pubky/pubky-ring/releases/tag/v2.0) (5 Oct) is the first Ring release that approves `signin_grant`. Ring's developer confirmed this on [pubky-ring#375](https://github.com/pubky/pubky-ring/issues/375), and the v1.19 Android APK has no `signin_grant` parser. Grant auth merged to `main` on 3 Sep in [pubky-ring#360](https://github.com/pubky/pubky-ring/issues/360).
  - Ring 2.0 is out on both platforms (James, 7 Oct).
  - Ring 2.x caveat ([#126](https://github.com/pubky/pubky-marketplace/issues/126)): 2.0 crashes on launch on iOS 27, and the fix, 2.0.1, is waiting on App Store review with no date; on Android, updating to 2.0 loses logins until the user restores from backup. The Ring 2.0+ requirement stands; users on 2.0 take 2.0.1 when it ships.
  - [v1.19](https://github.com/pubky/pubky-ring/releases/tag/v1.19) (4 Sep) signs in with cookie auth only. Users still on it just need to update.
- **Shop purchase approval needs Ring 2.0 or later, or Bitkit, after [#94](https://github.com/pubky/pubky-marketplace/pull/94).**
  - #94 (merged 6 Oct, ships with the next Shop release) makes every signed-in purchase approval a `signin_grant` link while the grant flow is on, as it is in production. That is the link Bitkit accepts. The dialog says it needs "Pubky Ring 2.0 or later, or Bitkit". Ring 2.0 is on Android and iOS.
  - Ring 1.19 still signs in. With single approval on (production), that sign-in also creates the purchase session, so a Ring 1.19 user can buy straight after signing in. If that session later expires or is refused, signing in with Ring again restores it.
  - Accounts created with the Ring sign-up QR start without a purchase session. On Ring 1.19 they need one sign-in with Ring.
  - Ring 1.19 users fix this by updating to Ring 2.0. No Shop workaround is planned.
- **The Shop's messaging library only works with cookie sessions, and it is ours.**
  - The vendored `paykit-wasm` 0.1.0-rc50 exists only in our fork [BitcoinErrorLog/paykit-rs-official](https://github.com/BitcoinErrorLog/paykit-rs-official) (`paykit-wasm/`).
  - It is built on pubky 0.8, and its session API is `restoreSession` and `resumeSessionFromCookie` (`paykit-wasm/src/session.rs`).
  - Upstream [pubky/paykit-rs](https://github.com/pubky/paykit-rs) is on pubky 0.12 and already uses grant sessions in `paykit-sdk`, but it ships **no WASM binding**, and Ben confirmed on 2 Oct that none is planned.
  - That is why Bitkit grant sessions get no messaging today, and why Passport users won't have it either.
  - **The fix is the chat plan, not Paykit.** Shop messaging is frozen as beta and moves to the shared pubky-chat library on MLS (SSO-E1). Until that cutover it stays on Ring cookie sessions, and the cutover is what gates messaging for Passport and Bitkit users.
  - If Ring sign-in moved to grants now, three things would break:
    - every Ring user would lose messaging;
    - Ring's single approval (one AuthToken to both the homeserver and the service, per [single-approval.md](../../docs/ecommerce/single-approval.md)) would become two;
    - the messaging fallback would set a narrow `/pub/paykit/:rw` cookie, which brings the overwrite back.
- **The transaction service authenticates separately today.**
  - Ring cookie sessions post the same `AuthToken` to the homeserver and the service.
  - Grant sessions (Bitkit, Passport) approve a second grant for the service at the first purchase.
  - A Ring cookie session that needs a new purchase approval gets the same grant link (#94), which only Ring 2.0 or later, or Bitkit, approves.
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
| SSO-R0 | Ring release with grant auth ([#360](https://github.com/pubky/pubky-ring/issues/360), [#375](https://github.com/pubky/pubky-ring/issues/375)). **Shipped** in [v2.0](https://github.com/pubky/pubky-ring/releases/tag/v2.0) (5 Oct) on Android and iOS (James, 7 Oct). v1.19 has no grant auth; its users update. Caveat ([#126](https://github.com/pubky/pubky-marketplace/issues/126)): 2.0 crashes on launch on iOS 27 (2.0.1 is in App Store review) and loses logins on Android until restored from backup; the 2.0+ requirement stands | Ring team | S | No |
| SSO-A1 | pubky.app on grants: [#2614](https://github.com/pubky/pubky-app/issues/2614), client id set to the origin host | pubky-app maintainers (vlada) | M | No |
| SSO-H1, K1, K3, K4 | Delegable grants: `d` action, child-grant verification, cascade revocation, SDK signer and delegate APIs, agent protocol spec, SDK gaps | Pubky core | L + M + S + S | No |
| SSO-P1, P2 | Passport as the account agent, plus a Ring-linked mode | Passport team | L + M | No |
| SSO-R1, R2, B1 | <ul><li>Ring and Bitkit: show the client id and plain-word scopes. **Agreed** by Ring.</li><li>A distinct agent-grant screen.</li><li>A session list with per-grant revoke, which **exists** as Ring draft [#369](https://github.com/pubky/pubky-ring/issues/369), pending FFI and react-native-pubky releases.</li></ul> | Ring and Bitkit teams | M; S for R2 after #369 | No |
| ~~SSO-Y1, Y2~~ | Paykit storage interface and WASM package. **Withdrawn (Ben, 2 Oct):** messaging moves to pubky-chat, and payments need nothing in the browser | — | — | — |
| SSO-K6 | Scoped keys: signer-derived, delivered beside the grant in the encrypted relay payload; Passport holds scoped seeds and derives locally | Pubky core (Andrei, in progress); Ring, Bitkit, Passport | M | No |
| SSO-F1 | Shop: one sign-in through the agent; remove the cookie path, the bridge, the `AuthToken` dual post and the scope union, after a dead-code check | us | M (independent review + security review) | No |
| SSO-E1 | Replaces SSO-F2. Shop messaging on the shared pubky-chat library (MLS), on the Shop's own grant session ([chat plan](https://github.com/pubky/pubky-chat/blob/main/docs/chat-unification-plan.md)) | us | L | No |
| SSO-F3 | Marketplace service and Lock Server fork accept the Shop's grant | us | M (independent review + security review) | No |
| SSO-A2 | pubky.app gets its grant from the agent | pubky-app maintainers | S–M | No |

**Ring users on grants** (formerly F3 here) means SSO-F1 for Ring users. It needs SSO-R0, SSO-H5, SSO-H6 and, so they keep messaging, SSO-E1.

**Full SSO** needs, in addition: SSO-H1, K1, K3, P1 (and P2 for Ring), R1, R2 or B1, A2 and F1. Delegated grants (SSO-H1) are still core's open item.

**Messaging library choice (D2a): settled.** Paykit won't ship a storage interface, a WASM package or a custom-message API (Ben, 2 Oct). Messaging moves to pubky-chat (SSO-E1), and we don't port our fork's `paykit-wasm`.

### Rejected alternatives

| Alternative | Why rejected |
|---|---|
| **Ring bundle.** One signer approval issues a grant to each first-party app, with a companion frame on each site and an SDK bundle request. This was earlier the recommendation here | <ul><li>Covers only apps present and coordinated at sign-in. Each app hosts a frame for every other app, and third-party frames are partitioned.</li><li>A new app, a new scope or a lost session goes back to the signer.</li><li>It is consent to several apps at once, not SSO.</li><li>Its only advantage, no homeserver change, doesn't outweigh that.</li></ul> |
| **Cookie bridge** ([#2484](https://github.com/pubky/pubky-app/issues/2484), Shop ADR 0029) | <ul><li>Keeps the ambient shared cookie: every site rides one scope set, and the last sign-in wins.</li><li>Off-domain apps break on Safari.</li><li>It is deprecated. Its variables are unset in both live builds.</li></ul> |
| **Ring auto-approve**, or remembered consent in Ring | <ul><li>A grant's client id is self-declared, and Ring can't tell which website showed a QR, so a phishing page could claim `shop.pubky.app`.</li><li>Ring's existing auto-auth (`getAutoAuthFromStore`) is a developer setting, off by default. It only needs to stay unreachable in release builds.</li></ul> |
| **A user session at the homeserver** that issues per-app grants | <ul><li>It is cross-origin to every app, so it is a cookie again, or partitioned storage.</li><li>It doesn't carry to mirrors.</li><li>It makes the storage provider an identity provider.</li></ul> |
| **pubky.app as the broker** | The site that renders user content, the most exposed to injected script, would hold minting power. The agent is a small static origin instead |
| **One tab owns the bearer**, shared through a BroadcastChannel or a SharedWorker | <ul><li>Background tabs freeze, and SharedWorker is missing on Chrome for Android.</li><li>Every app and library would need election code.</li><li>No security gain.</li></ul> SSO-H5 fixes it once in the homeserver. Detail: [pubky-sso-design.md §4](../sso/pubky-sso-design.md) |

### For the beta (what ships instead)

- **D5 stopgap, the scope union.**
  - **Change:** Ring cookie sign-in requests the union of pubky.app 1.12.0's scopes and the Shop's: `/pub/pubky.app/:rw,/pub/paykit/:rw,/priv/pubky.app/:rw,/priv/social/:rw,/priv/app.locks/content/:r`. Use the final 1.12.0 string.
  - **Scope of the change:** Bitkit grants keep the current constant. The exact-set checks (`capabilitiesMatchFullGrant`, the step-up comparison) need a separate constant, so Bitkit sessions are unaffected.
  - **Effect:** a Shop sign-in no longer strips pubky.app's Locks access. A later pubky.app cookie sign-in still narrows the Shop, because pubky.app doesn't request the Shop's scopes. The Shop's existing degrade paths (`needs_reauth`, the messaging enable prompt) handle that, and QA checks it.
  - **Size and review:** 4–6 h, independent review + security review. The accepted widening is that the Shop holds `/priv/social`.
  - **How it interacts with [#2614](https://github.com/pubky/pubky-app/issues/2614):**
    - Once #2614 ships, new pubky.app logins are grants. They no longer read the cookie, so the union matters only for pubky.app users still on legacy cookies.
    - #2614 moves Locks' creator-originals path to `/priv/locks.app/`. Change the Locks entry in the union to whatever path pubky.app actually ships.
    - Until SSO-H6 lands, the Shop's broad cookie could authorize a pubky.app grant request whose bearer failed. #2614 lists that as a release gate, and QA should include it.
- **F4 Passport,** shipped in v0.6.45; the Google-login production proof is pending.
  - [Passport](https://github.com/pubky/pubky-passport) approves grant requests from any app, with no allowlist. It creates the identity for new Google users during authorization ([integration guide](https://github.com/pubky/pubky-passport/blob/main/docs/integration.md)).
  - SDK 0.11.0 already has `startGrantAuthFlow` and `tryPollOnce`. The Shop adds the button, the callback page and a `Cross-Origin-Opener-Policy: same-origin-allow-popups` header.
  - No Passport change is needed.
  - **Limit: no messaging** until SSO-E1. The refusal copy must say so without naming Ring as the only way.
- **F5 sign-out copy,** shipped in v0.6.45. Ring cookie sessions: Shop sign-out ends the shared cookie, so pubky.app is signed out in that browser too. Bitkit and Passport grant sessions: only the Shop is signed out.
- **Dead bridge (formerly F2): done.** Both live builds have the variables unset. Cold signed-out loads make no bridge request. v0.6.42 removes the variables from the config, and F7 drops the two `#s=` proof checks.

## 4. Change list

pubky.app, homeserver, SDK, Paykit and signer changes belong to their teams. We don't push to `pubky/*` or `synonymdev/*`.

**Launch work:**

| # | Repo | Change | Size | Status |
|---|---|---|---|---|
| P1 | pubky.app | Top-menu **Marketplace** and **Messaging** items, URL from runtime config | S | Ask the pubky-app team |
| P3 | pubky.app | Optional "Message" on a profile, linking to the Shop | S | Optional |
| F1 | Shop | Link-out behind a build flag, plus the component fixes (§2) | M | Shipped in v0.6.45; flag off |
| F2 | Shop | Unset the bridge variables | XS | **Done** (v0.6.42 cleans the config) |
| D5 | Shop | Ring cookie sign-in requests both sites' scopes | S | Shipped in v0.6.45 |
| F4 | Shop | Passport sign-in and service grant | M | Shipped in v0.6.45; Google-login production proof pending |
| F5 | Shop | Sign-out copy by session type | XS | Shipped in v0.6.45 |
| F7 | Shop | Handoff docs, repo runbook, drop the `#s=` proof checks | S | Shipped in v0.6.45 |

**SSO work (post-beta; full list in [sso-proposal-for-team.md §3.3](../sso/sso-proposal-for-team.md#33-change-list-per-repo)):**

| # | Repo | Change | Status |
|---|---|---|---|
| SSO-H5, H6 | homeserver | Several bearers per grant; no cookie fallback | Ask core first; gates #2614 |
| SSO-R0 | Ring | Release grant auth | In progress (Ring, 1 Oct) |
| SSO-A1 | pubky.app | [#2614](https://github.com/pubky/pubky-app/issues/2614) | In review; we offer to review |
| SSO-H1, K1, K3, K4 | homeserver, SDK | Delegable grants, agent protocol, SDK gaps | Ask core (proposal §4, Q1) |
| ~~SSO-Y1, Y2~~ | Paykit | Storage interface and WASM package | Withdrawn (Ben, 2 Oct) |
| SSO-K6 | SDK, signers | Scoped keys delivered beside the grant | SDK in progress (Andrei); then Ring, Bitkit, Passport |
| SSO-P1, P2 | Passport | Account agent; Ring-linked mode | Ask Passport |
| SSO-R1, R2, B1 | Ring, Bitkit | Consent and session screens | Ring: origin and scopes agreed; grant list in [#369](https://github.com/pubky/pubky-ring/issues/369); agent screen explained in [proposal §2.8](../sso/sso-proposal-for-team.md#28-rings-side-of-the-agent-grant). Ask Bitkit |
| SSO-F1, E1, F3 | Shop, service, Lock Server fork | Agent sign-in, messaging on pubky-chat (MLS), service accepts the Shop's grant | us, after the above; E1 after pubky-chat Phase 2 |
| SSO-A2 | pubky.app | Grant from the agent | After P1 |

## 5. Launch-blocking vs post-launch

### Launch-blocking

| Item | Status | Size |
|---|---|---|
| Infra access and the R-or-S decision (D8) | DevOps capacity answer due Tue 6 Oct; GitHub and Railway invites pending, expiring Thu 8 Oct 17:07 UTC. No write invite yet for [pubky-payment-rails](https://github.com/pubky/pubky-payment-rails) (the Locks source, which production checkout depends on), `pubky-chat`, `pubky-app-specs` or `pubky-shop` | ops |
| F4 Passport Google-login production proof | Shipped in v0.6.45; the proof is pending. Shop team — team to assign | XS |
| [#67](https://github.com/pubky/pubky-marketplace/issues/67) buyer inbox never loads, "Message seller" does nothing (v0.6.45) | Triaged: the mute-list 404s are expected; an untimed messaging status check is the likely blocker. Unassigned. Shop team — team to assign; before the freeze | S |
| Chat Phase 0 fixes ([chat plan](https://github.com/pubky/pubky-chat/blob/main/docs/chat-unification-plan.md)): P0-1 receive cap defers instead of consuming unread; P0-2 sign-out keeps the encrypted history | No issue or PR yet. Shop team — team to assign; security review | S each |
| [#49](https://github.com/pubky/pubky-marketplace/issues/49) Bitkit sign-up | Copy shipped in v0.6.45. The authorize failure is [bitkit-android#1398](https://github.com/synonymdev/bitkit-android/issues/1398) (Bitkit team); retest once Bitkit ships it | external |
| P1 menu links | Ask the pubky-app team; not yet confirmed as asked | S |
| Remaining production test listings | Every listing under our deletion control is deleted. Test-style listings whose source records we do not control remain ([#69](https://github.com/pubky/pubky-marketplace/issues/69)). The Nexus team owns the denylist for those records and the separate staging index; day 4 or 5 | S (ops) |
| Nexus reset and full reindex, then the stale-listing dry run. On new instances, this is the cutover | Nexus team, at cutover (§7), day 8. Apply the denylist first so the remaining source records do not return | S (ops) |
| [#61](https://github.com/pubky/pubky-marketplace/issues/61) address search 503 | Closed on GitHub 1 Oct; confirm the breaker no longer trips on Photon failures | S |
| v0.6.46 ([#183](https://github.com/BitcoinErrorLog/pubky-app/issues/183), [#184](https://github.com/BitcoinErrorLog/pubky-app/issues/184), [#185](https://github.com/BitcoinErrorLog/pubky-app/issues/185), [#186](https://github.com/BitcoinErrorLog/pubky-app/issues/186)) | Merged, unreleased. Ship as a normal train with a team member shadowing (§9) | — |
| [paykit-server#27](https://github.com/BitcoinErrorLog/paykit-server/issues/27) a buyer's request must never go to their own claim inbox | Fix landed on `master` via [#29](https://github.com/BitcoinErrorLog/paykit-server/issues/29) on 5 Oct; deploy remains | S |
| **Paykit server port onto upstream, matching Bitkit's Paykit pin (rc71 in upstream rc9).** <ul><li>Recommended pending D10: start from upstream paykit-server rc9 and re-implement the marketplace contract the service and Shop use.</li><li>Fresh database; exactly one process (upstream's rule).</li><li>The server stays a delegated Paykit app and never holds identity secrets.</li><li>Seller Bitcoin setup needs Bitkit holding the seller's identity, either created in Bitkit or a Ring identity on the same device. Bitkit publishes the signed key and delegates (Ben, 5 Oct). Other sellers see a connect-Bitkit step; PayPal is unaffected.</li><li>Shop side: the buyer pre-check reads the App Registry and the signed Noise-key record, and the Get Paid copy says that Paykit Server can read and write the seller's Paykit data.</li></ul> | Lands before the Shop launch (about 2 weeks), ahead of or with Paykit's launch (end of the week of 5 Oct or the week after). Pre-launch, so no Bitcoin pause plan. **The Paykit team assigns the owner and decides the starting branch** (§9 D10). The merge-forward in [paykit-server#28](https://github.com/BitcoinErrorLog/paykit-server/issues/28) departs from the never-holds-identity-secrets rule on its manual-claim path; hold it until a protocol design review checks it. On rc6x, a server-minted Paykit secret can't carry a signed key authorization, because that needs the Pubky secret. Deploy once, on the target infra, so sellers reconnect Paykit only once. **Critical path:** the port itself: upstream `v0.1.0-rc9` (7 Oct) carries Paykit rc71 and requires homeserver 0.15+ on every serving instance ([paykit-server#48](https://github.com/pubky/paykit-server/issues/48)). **Update 9 Oct:** production runs v0.15.0 since 9 Oct 2026 (James), so that requirement is satisfied on production; the target is [`v0.1.0-rc10`](https://github.com/pubky/paykit-server/releases/tag/v0.1.0-rc10) (8 Oct; #52 Reader admission, #55 `[signed_services]` allowlist, #53, #54); PK-5/PK-6 are still open. rc60 state stays readable through rc62, so following Bitkit's pin needs no further reset. Pin Paykit by tag and SHA. rc59 state is unsupported upstream (no compatibility fallback), so staging and production start from fresh databases | L, sensitive: design review, independent protocol review, security review, staging proof on Android and iOS |
| ~~Production homeserver on v0.14 with WebDAV locks~~ | **Done 5 Oct** ([pubky/pubky-stack#338](https://github.com/pubky/pubky-stack/issues/338)). Production advertises `webdav-locks`, and our stack showed no breakage. **Update 8 Oct:** paykit-server rc9 requires homeserver 0.15+ ([paykit-server#48](https://github.com/pubky/paykit-server/issues/48)); grants need no bump. **Update 9 Oct: done.** Production `homeserver.pubky.app` is on v0.15.0 as of 9 Oct 2026 (James), so the rc9+ requirement is satisfied on production. v0.15.0 carries the same-path 500 → 429 fix ([#662](https://github.com/pubky/pubky-homeserver/issues/662)) and the lock-gap fix ([#654](https://github.com/pubky/pubky-homeserver/issues/654)). It does not carry the SSO work ([#680](https://github.com/pubky/pubky-homeserver/issues/680), [#668](https://github.com/pubky/pubky-homeserver/pull/668), [#681](https://github.com/pubky/pubky-homeserver/pull/681)); without [#668](https://github.com/pubky/pubky-homeserver/pull/668), grants with the Shop `e` scope still fail at session exchange ([#684](https://github.com/pubky/pubky-homeserver/issues/684) is open and not in v0.15.0), so SSO is not live and the Shop's `e` scope still needs a later homeserver release | External |
| QA retests: [#50](https://github.com/pubky/pubky-marketplace/issues/50) quantity-1, including whether unpaid orders lapse; [#12](https://github.com/pubky/pubky-marketplace/issues/12) packing slip, needs a paid shipping order | Waiting on Pav; before go/no-go | QA |
| Ownership: beta-week on-call, Sentry, uptime checks, one Postgres restore test | None exists yet. Shop Sentry is off in both environments; backends alert through log lines only; no restore test is recorded, and nothing backs up Neo4j or Redis. Operations team — team to assign; before the beta | S (ops) |

**Done, removed from this list:**

- 429/500 homeserver write retries ([#155](https://github.com/BitcoinErrorLog/pubky-app/issues/155), v0.6.36; checked 5 Oct).
  - `retryHomeserverWrite` retries every Shop PUT and DELETE on 429, 500 and 503, honouring `Retry-After`.
  - Encrypted Link sends retry on the per-pair backoff schedule.
  - On the homeserver side, the same-path 500 → 429 fix (#662) is in v0.15.0, which production has run since 9 Oct 2026. Keep the 500 retry anyway: users on other homeservers may still be on an older release.
  - The lock-gap fix (#654; a write can no longer publish after its lock was lost) is also in v0.15.0 on production.
- `listing_deleted` handling ([#168](https://github.com/BitcoinErrorLog/pubky-app/issues/168), v0.6.40).
- The dead bridge variables.
- F1, F4 (code), F5, F7, D5, [#62](https://github.com/pubky/pubky-marketplace/issues/62), [#63](https://github.com/pubky/pubky-marketplace/issues/63), #49 copy and the [#164](https://github.com/BitcoinErrorLog/pubky-app/issues/164) fix via [#178](https://github.com/BitcoinErrorLog/pubky-app/issues/178), shipped in v0.6.45 (1 Oct).
- v0.6.42 (#170, #171).
- [paykit-server#23](https://github.com/BitcoinErrorLog/paykit-server/issues/23), closed on 1 Oct without merging.
- The deleted-listing wording, now #170 in v0.6.42.
- [#58](https://github.com/pubky/pubky-marketplace/issues/58) and [#59](https://github.com/pubky/pubky-marketplace/issues/59), closed by Pav.
- The paid canary on [#54](https://github.com/pubky/pubky-marketplace/issues/54). PayPal and Bitcoin are each paid on production; #54 stays open for Piotr's v0.6.40 UI check.

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
- **Messaging rebuild:** the [chat plan](https://github.com/pubky/pubky-chat/blob/main/docs/chat-unification-plan.md) (MLS through pubky-chat; SSO-E1). It replaces the earlier rebuild on Paykit/pubky-noise storage seams, whose upstream asks are withdrawn.
- **Upstream convergence:** Locks to `pubky/*` (internal convergence plan); [#44](https://github.com/pubky/pubky-marketplace/issues/44), [#35](https://github.com/pubky/pubky-marketplace/issues/35). The Paykit server port is pre-launch work now (§5). After it, upstream [paykit-server#26](https://github.com/pubky/paykit-server/issues/26) is the route to retiring our marketplace-specific layer.
- **Zero-conf payments** (internal Locks zero-conf plan).
- **Nexus fork work:** tag race round 4, backfill retry, cache-fill guard, autocomplete race, rebase and slim, specs v1 (internal Nexus fork audit).
- **Deferred products:** Shopify real-store proof; the single-shop storefront SF1–SF9 (internal storefront plan); Stripe (paused); the PayPal partner tier.
- **Module extraction and upstream:** the upstream sync of 161 commits, and the eventual merge into pubky.app.
- **Smaller items:** the Ring/Bitkit keychain test, paykit-wasm call timeouts, `/priv` P4s, send-lock residuals, test hygiene.

## 6. Two-week timeline

Roles:

- **Shop lead:** owns the release train.
- **Shop dev**
- **Backend dev:** Rust; owns the marketplace service.
- **Nexus team:** owns the marketplace index, including test-listing policy, staging separation, reset and reindex.
- **DevOps:** Synonym.
- **QA:** Pav, Piotr.
- **Designer**
- **pubky.app maintainer**
- **John:** product owner.

Each owning team assigns the people behind these roles: the Shop team its Shop lead and Shop dev, the marketplace backend team its backend dev, the Nexus team its index owner, the Paykit team the port owner (D10), and the operations team the beta-week on-call.

Day 0 was 1 Oct. Beta: Thu 15 Oct. Day numbers below follow the recommended anchor (day 1 = Tue 6 Oct, so day 10 = Thu 15 Oct); see the date note at the top of this document.

| Days | Work | Owner |
|---|---|---|
| 0 (1 Oct) | F1, F4, F5, F7, D5, #62, #63, #49 copy and the #164 fix via #178, all shipped in v0.6.45; default-branch switch, done | Current maintainers, John |
| 1 | Access: accept the GitHub and Railway invites (they expire Thu 8 Oct, 17:07 UTC), Sentry. Read the [team brief](shop-team-brief.md). Run locally | All |
| 1 | Assign the Paykit port owner and decide the port's starting branch (D10) | Paykit team |
| 1 | Ask the pubky-app team for P1. Ask DevOps to confirm capacity for S | John |
| 1–2 | v0.6.46 as a normal train, with a team member shadowing and writing down every step `release.md` doesn't cover | Shop lead |
| 1–3 | F4 Google-login production proof; triage #67 | Shop dev |
| 1–5 | Beta-week on-call named; Shop Sentry DSN on staging, then production; uptime checks; one Postgres restore drill | Operations team |
| 2–5 | P1 menu links | pubky.app maintainer |
| 1–7 | New instances on Synonym's cloud, production and staging (§7) | DevOps, Backend dev |
| 3–8 | Design PRs through the train | Designer, Shop lead |
| 4–5 | Apply the denylist for remaining test listings; prepare the separate staging index. Every listing under our deletion control is already deleted | Nexus team |
| 1–9 | Paykit server port onto upstream (latest Paykit rc6x, matching Bitkit's pin), staging proof with rc6x Bitkit builds on Android and iOS, including request-delivery latency, then production on a fresh database with sellers reconnecting | Port owner, assigned by the Paykit team (D10). Until the cutover, deploys go through the current maintainers |
| 7 | Feature freeze. Set the social-host variable on staging; QA the link-out | Shop lead, QA |
| 8 | Cutover to new instances with clean databases; Nexus reset and reindex; Shop runtime-config switch | DevOps, Nexus team |
| 8–9 | Production QA. Cross-site matrix: Ring, Bitkit and Passport sign-in on each site; sign-out on each; Shop sign-in, then pubky.app Locks still works; pubky.app sign-in, then Shop degrade prompts appear; deep links both ways; the Passport no-messaging copy | QA |
| 9 | Go/no-go; set the social-host variable on production | John, leads |
| 10 | Beta opens; pubky.app ships P1 the same day | All |
| From day 1, in parallel | <ul><li>Send the [team proposal](../sso/sso-proposal-for-team.md) to core, Ring, Bitkit, Passport, Paykit and pubky.app.</li><li>Ask core for SSO-H5 and H6 first (they gate #2614).</li><li>~~Ask James when production moves to homeserver v0.14.~~ Done 5 Oct.</li><li>Follow which rc Bitkit ships (rc62 in both PRs on 5 Oct, not promised final; upstream paykit-server rc9 is on rc71 since 7 Oct).</li><li>Review #2614.</li></ul> | John, backend dev, upstream teams |

## 7. Infrastructure

There are two options:

- **R.** The current Railway deployment stays, and the current maintainers run it through the beta.
- **S.** Synonym DevOps creates new instances on Synonym's cloud.

### Inventory (1 Oct, sharing re-checked 5 Oct)

| Piece | Where | Run by | Public host |
|---|---|---|---|
| Shop production | Vercel, production project | Current maintainers | [shop.pubky.app](https://shop.pubky.app) |
| Shop staging | Vercel, staging project | same | Generated Vercel staging host |
| Shop cron | `/api/marketplace/grant-cleanup`, every minute | same | — |
| Marketplace service + Postgres | Railway, marketplace production project | Current maintainers | Generated Railway host |
| Paykit server (fork) + Postgres | Railway, marketplace production project | same | `paykit-shop.pubky.app` |
| Marketplace Nexus (fork), Neo4j, Redis | Railway, marketplace Nexus project | same | Generated Railway host |
| Old marketplace Nexus | Railway, marketplace production project | same | Stopped 30 Sep; volumes kept |
| Locks server (fork) + Postgres | Railway, marketplace staging project (its only environment is named `production`) | same | Generated Railway host, used by both the production and staging Shops |
| Staging service, Paykit, regtest `bitcoind` and Fulcrum, `fiat-verifier` (sandbox) | Railway, marketplace staging project | same | `staging-api.pubky.app` |
| Social Nexus, homeservers (production and staging), relay, Homegate, pkarr, Passport, DNS | Synonym-run | Synonym | `nexus.pubky.app`, `homeserver.pubky.app`, `homeserver.staging.pubky.app`, … |
| Images | GHCR `ghcr.io/bitcoinerrorlog/*`, pinned by digest | BitcoinErrorLog | — |
| Shop SDK | npm `@bitcoinerrorlog/pubky-shop` | BitcoinErrorLog | — |

### Quirks a new owner must know

- **Staging has its own homeserver** (`homeserver.staging.pubky.app`), service and Paykit. **Only the marketplace Nexus is shared** with production.
  - Checked live on 5 Oct: the production and staging Shops both use the same Locks server and the same marketplace Nexus. Production checkout therefore depends on a Locks instance that sits in the staging project.
- **Provenance gaps.** The Locks image is built from the public [pubky-payment-rails](https://github.com/pubky/pubky-payment-rails) repo. Railway records no source for `bitcoind`, Fulcrum or `fiat-verifier`. IaC exists only for the marketplace service and the Nexus fork; Paykit and Locks have none.
- **The Railway hosts are generated Railway names**, baked into the Shop's runtime config.
- **The Nexus fork is a second full indexer.** It is 86 commits ahead and 154 behind upstream, and pins a specs fork (internal Nexus fork audit). Its moderation covers posts, tags and users, not listings.
- **The Paykit fork** is 278 ahead and 65 behind, on rc55. It is being ported onto upstream, on the latest Paykit rc6x, before the beta (§5). The ported server must run as **exactly one process**: restoring the same grant in a second process invalidates the first one's bearer, so deploys stop the old process before starting the new one. The Locks fork goes away in the convergence plan. Locks rc8 (2 Oct) shipped the terminal `expired` mapping that plan waited on. **Update 8 Oct:** Locks [`v0.1.0-rc9`](https://github.com/pubky/locks/releases/tag/v0.1.0-rc9) (7 Oct) reads only the nested Paykit status shape ([locks#73](https://github.com/pubky/locks/issues/73), no fallback), so it can't run against the rc55 fork and ships together with the Paykit port and Shop [#97](https://github.com/pubky/pubky-marketplace/issues/97). ~~Locks still has no grant connect ([locks#69](https://github.com/pubky/locks/issues/69), LK-1 open).~~ **Update 9 Oct:** Locks [`v0.1.0-rc10`](https://github.com/pubky/locks/releases/tag/v0.1.0-rc10) (8 Oct, 20:06 UTC) ships opt-in `grant-connect` ([locks#77](https://github.com/pubky/locks/issues/77), LK-1; one `signin_grant` QR, a reconnect per seller) and accepts a late Paykit `200` under a live claim ([locks#76](https://github.com/pubky/locks/issues/76)), so Bitkit-held sellers can connect Locks once rc10 is deployed.

### The two options

| | R. The current Railway deployment stays | S. Synonym DevOps runs new instances (recommended) |
|---|---|---|
| Who deploys backend | The current maintainers. The dev team merges backend PRs; the current maintainers deploy staging then production | DevOps, from the repos' images, with their own manifests |
| Dev team access | Shop (Vercel) only | What DevOps grants |
| Work before the beta | None | Provision and cut over: L for DevOps, with backend-dev support |
| Data | Kept | Clean databases at cutover, allowed by the pre-launch policy. Export the canary orders first. Sellers reconnect Paykit and Locks; Nexus reindexes. Every listing under our deletion control is already deleted; the Nexus team's denylist must land first so the remaining source records do not return |
| Nexus fork | Stays a bespoke service run by the current maintainers | DevOps runs two Nexus codebases. Freeze fork features until it is slimmed to a marketplace indexer |
| Single point of failure | One Railway deployment, with the current maintainers as the only deployers | DevOps on-call |

**Recommendation:** S, with cutover on day 8. The current Railway services are stopped (not deleted) as rollback until a week after the beta. If DevOps can't confirm capacity by day 2, the beta runs on R.

### Transition plan for S

1. **Days 1–2:** DevOps gets the inventory, image digests and resource use. The backend dev lists variable names only. The Nexus team defines the remaining-listing denylist and the separate staging index. New secrets are generated wherever possible; only secrets that can't be regenerated are transferred, through an agreed end-to-end-encrypted channel.
2. **Days 2–5:** build production and staging sets. Each set has:
   - the service + Postgres;
   - Paykit (the ported rc6x build, one process, no deploy overlap) + Postgres;
   - Locks + Postgres;
   - the marketplace Nexus + Neo4j + Redis.
   Staging also gets regtest `bitcoind` and Fulcrum, and the sandbox `fiat-verifier`. Staging gets its **own** marketplace Nexus.
3. **New secrets and hostnames.** DevOps generates new secrets wherever possible. Hostnames go under `pubky.app` (for example `api.shop.pubky.app`, `nexus.shop.pubky.app`, `locks.shop.pubky.app`), with staging equivalents.
4. **Days 6–7:** switch the staging Shop and run the staging release proof.
5. **Day 8:** production cutover.
   - Clean databases and a reindex.
   - The Shop runtime-config switch and the signed-in production proof.
   - PayPal webhook targets updated.
   - The current Railway services stopped.
6. **After the beta is stable:** delete the Railway projects. Decide GHCR and npm ownership (D8).

## 8. Risks

| Risk | Effect | Mitigation |
|---|---|---|
| The Paykit server port slips past Paykit's launch, or has no owner | Upgraded Bitkit users can't receive the Shop's payment requests, and sellers on the new Bitkit can't connect | The Paykit team assigns the owner now (D10); start on staging with the rc6x Bitkit builds; PayPal is unaffected |
| ~~Production homeserver isn't on v0.14 by Paykit's launch~~ | Retired 5 Oct: production runs v0.14.0 with WebDAV locks | — |
| ~~Production homeserver locks run without the lock-gap fix (#654), and same-path races still return 500 until #662 ships~~ | Retired 9 Oct: production runs v0.15.0, which carries #654 and #662. Keep retrying 500 as well as 429 for users on other homeservers | — |
| Bitkit ships a different rc6x than rc62, or ships later than the Shop launch (no production date yet; Ben, 5 Oct) | The port has to follow the new pin, and upgraded-Bitkit Bitcoin checkout waits on Bitkit's release | The port follows upstream rc9's pin (Paykit rc71, 7 Oct). rc60 state stays readable through rc62, so following the pin within rc6x needs no reset. PayPal is unaffected. |
| ~~paykit-server rc9 and rc10 require homeserver 0.15+ ([paykit-server#48](https://github.com/pubky/paykit-server/issues/48)); production runs v0.14~~ | Retired 9 Oct: production `homeserver.pubky.app` runs v0.15.0 (James), so the Paykit cutover isn't blocked on the homeserver. Users on other homeservers aren't verifiable | — |
| A seller's identity isn't in Bitkit on that device, for example created in Passport or held in Ring on another phone | No authorizer can publish the seller's signed Paykit key, so Bitcoin setup can't finish | Show a connect-Bitkit step; PayPal is unaffected. Asked Ben on [#169](https://github.com/pubky/paykit-rs/issues/169) whether another authorizer path is planned |
| Request delivery on staging is still slow (rc61 and rc62 say few-second delivery isn't established yet) | Slow Bitcoin payment requests at checkout | Measure delivery latency in the port's staging proof; treat it as a go/no-go input |
| ~~[#169](https://github.com/pubky/paykit-rs/issues/169) handshake gap~~ | — | Closed 3 Oct; Jasonvdb approved, and dzdidi's re-review is pending |
| Pubky-chat (SSO-E1) is slow | No Ring move to grants, and no messaging for Passport and Bitkit users | Beta copy says messaging needs Ring for now |
| Core declines or delays delegable grants (SSO-H1) | No silent SSO for Ring users | Grants per app still ship: one approval per app per browser. Passport-key users still get SSO from the agent |
| SSO-H5 and H6 slip | #2614 and the Shop can't go grant-only. Tabs invalidate each other, and an ambient cookie can stand in for a failed bearer | Ask core first; these are small changes, and the homeserver team already offered the multi-bearer fix |
| D5 widening | The Shop holds `/priv/social`; a Shop compromise reaches pubky.app's private social data | Accepted by John; independent review + security review on the change; removed when SSO-F1 lands |
| A pubky.app cookie sign-in still narrows the Shop | Shop messaging and watchlist sync ask for re-approval | Degrade paths exist; QA cross-site matrix |
| Passport users expect messaging | Confusion | Clear refusal copy (F4) |
| The pubky.app team can't take P1 in time | No entry point from pubky.app | The Shop launches on its own URL either way |
| DevOps capacity for S | Cutover slips | Decide by day 2; R fallback |
| Cutover reindex brings back test listings | Real users see "do not buy" listings | Every listing under our deletion control is deleted; the Nexus team applies the denylist for the remaining source records before the reset and reindex |
| Release and deploy steps not yet in the repos | The team can't release or deploy alone | `release.md` is in the Shop repo; backend deploy docs are listed in the [team brief](shop-team-brief.md) release table; a team member shadows v0.6.46 |
| Bitkit authorize bug (bitkit-android#1398) | Bitkit sign-up can fail after a wipe | Copy fix; retest when Bitkit ships |

## 9. Decisions

### Made 1 Oct

- **D5:** the scope-union stopgap, with the `/priv/social` widening accepted.
- **Default branch:** switch to `release/shop-v0.6.8`.
- **paykit-server#23:** review and merge on the fork. It was closed on 1 Oct without merging.
- **#49:** Bitkit scanning the sign-up QR is supported.
- **D1:** link-out behind a flag that John switches on (shipped in v0.6.45, flag off).
- **Create account QR (CQ1, 9 Oct):** the Shop keeps the single Ring sign-up QR ([#94](https://github.com/pubky/pubky-marketplace/issues/94), v0.6.48); Bitkit accepts it and purchase approval is a grant link either way. It moves to a `signup_grant` QR only after [bitkit-android#1448](https://github.com/synonymdev/bitkit-android/issues/1448) and [bitkit-ios#902](https://github.com/synonymdev/bitkit-ios/issues/902) are fixed in a released Bitkit, because approving `signup_grant` with an existing identity republishes `_pubky` to the QR's homeserver.

### Made 2 Oct, on Ben's Paykit answers

- **D2a settled:** SSO-Y1, Y2 and the custom-message API are withdrawn. Messaging moves to pubky-chat (SSO-E1). Shop messaging stays on Ring cookie sessions until that cutover, which gates messaging for Passport and Bitkit users.
- **Paykit scope narrowing dropped:** shared state per identity is by design.
- **Paykit server port:** onto upstream, targeting the latest Paykit rc6x and matching Bitkit's pin, before the Shop launch, with no Bitcoin pause plan, since we're pre-launch. Its owner is D10.

### Still open

Each has a recommendation unless noted:

1. **D2 Beta and SSO.**
   - *Recommended:* open the beta on day 10 with the stopgaps (one approval per site). Commit to **delegated grants through a Passport agent** as post-beta work ([pubky-sso-design.md](../sso/pubky-sso-design.md), [team proposal](../sso/sso-proposal-for-team.md)).
   - Send the proposal on day 1. Ask core for SSO-H5 and H6 first, because they unblock pubky.app's #2614 and our own move to grants.
   - *Alternatives:* hold the beta until SSO lands, which is all outside the two weeks; or the Ring bundle, rejected in §3 because it isn't SSO for new apps, new scopes or lost sessions.
2. **D4 New-user sign-up.** *Recommended:* keep the Shop's own sign-up, which covers Ring, Bitkit and, with F4, Passport. *Alternative:* send new users to pubky.app onboarding.
3. **D8 Infra (John, on Vlad's 6 Oct answer).** *Recommended:* S, cutover on day 8. *Alternative:* R, the current maintainers keep deploying every backend change on the current Railway deployment through the beta.
4. **D9 Paykit refusals and paykit-server#24 (John).** *Recommended:* post-launch, unless the beta promotes Bitcoin checkout or includes Android sellers. The port changes the refusal states (reconnect required, `reader_not_payable`, parked peer), so design the copy against the port, not the fork.
5. **D10 Paykit server port: owner and starting branch (Paykit team).** The Paykit team assigns the owner and makes the technical decision on which branch the port starts from: a fresh port from upstream paykit-server `v0.1.0-rc9` (`v0.1.0-rc8` when this was written) on a fresh database (the plan in §5), or the merge-forward in [paykit-server#28](https://github.com/BitcoinErrorLog/paykit-server/issues/28) into the fork's `marketplace-rails` branch.
   - *Recommended:* decide by Tue 6 Oct. Hold #28 until a protocol design review checks it against the delegated-app rule: as written, its manual-claim path has the server generate and keep the seller's Paykit identity secret. #28 also has a failing PostgreSQL E2E check and no review yet.
   - How a seller authorizes Paykit without the server holding the identity secret is answered upstream (Ben, 5 Oct). Bitkit is the authorizer, for identities it creates and for Ring identities it reads through the shared keychain on the same device. It publishes the signed key and delegates Paykit access to the server without the Pubky secret. The server can't authorize itself, because on rc6x the signed key needs the Pubky secret. A browser-only seller therefore connects Bitkit before Bitcoin setup. The design review checks the port and #28 against that.
6. **Shop hosting for the beta (John).** *Recommended:* production stays on its current Vercel hosting through the beta, and the cutover only switches runtime config; DevOps builds a Cloud Run staging Shop; production moves after the beta.
7. **Locks at cutover (John, with the backend dev).** *Recommended:* run the current fork image, pinned by digest, as separate production and staging instances, and switch to upstream Locks after the port.
8. **Secrets handoff (John and Vlad).** *Recommended:* agree one end-to-end-encrypted channel and a regenerate-or-transfer list; regenerate everything except the pinned Locks key and secrets that can't be reissued.
9. **Team test seats (John).** *Recommended:* mint new team test seats rather than handing over existing ones.
10. **v0.6.46 (John).** *Recommended:* ship now as a normal train, with a team member shadowing.
11. **Review rule on `master` (Shop team).** *Recommended:* an independent reviewer on every PR, plus a security review for auth, crypto, Paykit and messaging changes.
12. **Date anchor (John).** *Recommended:* keep the beta on Thu 15 Oct and count day 1 as Tue 6 Oct.
