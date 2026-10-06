# Shop Changelog

Public changelog for Shop, the Pubky marketplace vibe. Newest changes first.

## 2026-09-09

- [implemented] Marketplace toasts and rendered failure text now map machine-readable reasons to static, client-owned strings in `src/libs/commerce/failure-messages.ts`; server-supplied error messages never reach the toast or `errorMessage`, while typed client-side validation messages remain verbatim. Commits `ea62f5e9`, `f0d82dba`, and `7dcdd63d` shipped in production as part of merge `4607a692c` on `marketplace/pr25-ux` (deploy `pubky-marketplace-production-ccat1hufk`, alias `shop.pubky.app`; staging `pubky-marketplace-staging-k7uzbc06f`); the cleanup commits `148db15ed` and `91e041c9c` follow in the next deploy from `pr25-ux`.
- [implemented] DM `pubky_app.dm.v0` messages now emit `sent_at` as a Unix-millisecond integer, with inbound parsing accepting integer or legacy ISO strings under a bounded-range guard; legacy ISO rows normalize on read. Commits `ce566979` and `c694b192`. Shipped as `c694b192` on `pr25-ux`; production deploy `pubky-marketplace-production-371i2l41j`, staging deploy `gm8z9ndvp`, then superseded by production merge `4607a692c` and deploy above.
- [implemented] Shop now redirects `/` to `/marketplace` with a non-permanent redirect. Shipped 2026-09-09 on `marketplace/pr25-ux` at `e6ffcf6e`; production deploy `pubky-marketplace-production-fg6z17e36` (alias `shop.pubky.app`) and staging deploy `pubky-marketplace-staging-1iabskwrx`.
- [implemented] Shop auto-hides Bitcoin when `bitcoin_available` and `bitcoin_offer_available` do not both permit the offer. This is hop 3 of a 3-hop contract: paykit-server publishing the field on `/health/ready` is in progress (hop 1), and marketplace-service consuming/caching it and avoiding payment-config `503` responses during Paykit outages is implemented but under review (hop 2); both remain undeployed, so the client defaults an absent field to `true` with no behavior change. Shipped 2026-09-09 on `marketplace/pr25-ux` at `e6ffcf6e`; fixture commit `71c2ece6` was required because VRT mocks bypass the Zod default. Production deploy `pubky-marketplace-production-fg6z17e36` (alias `shop.pubky.app`); staging `pubky-marketplace-staging-1iabskwrx`.

## 2026-09-08

- [implemented] Single-approval Shop sign-in shipped on `marketplace/one-approval`. One Pubky Ring approval now dual-presents the same `AuthToken` bytes to the homeserver first and the marketplace transaction service second, minting both sessions. `singleApprovalSignIn` (`PUBKY_RUNTIME_SINGLE_APPROVAL_SIGN_IN`) defaults to true; disabling it keeps the legacy two-step flow. Feature `c213ae9f`, tests `454828c5`, fixer round `454828c5..3e737732`, cleanup batch `e482e603..8881f90f`, and N-1 follow-up `ac593082`. Review record: round 1 Kimi SHIP on the security lens plus Opus FIX-FIRST (5 P1, 4 P2, 3 P3); the fixer closed all findings; round 2 Kimi SHIP plus Opus SHIP; cleanup batch Opus SHIP; N-1 fix Opus SHIP. Marketplace outage does not block sign-in; bridged and direct ceremonies share one single-flight guard; joined dialogs report that approval is already in progress; closing a joined dialog does not cancel the owner; wrong-identity step-up is rejected before the marketplace POST and preserves the signed-in user's bearer; and failures tear down newly minted bearer state from memory, `localStorage`, and the commerce store. The marketplace capability string is echoed but not stored; see the marketplace-service record.
- [proven live] Shop staging `pubky-marketplace-staging.vercel.app` deployed at 19:33 on 2026-09-08. Production `shop.pubky.app` and `pubky-marketplace-production.vercel.app` deployed at 19:37. The `ac593082` N-1 fix was deployed 2026-09-08 evening.
- [known gap] Between 12:53 and 19:37 on 2026-09-08, the P1 credential-leak fix and session-fixation fix were pushed to GitHub but not deployed to Vercel; production continued serving the 07:47 build (`383b6d3e`). Push is not deploy: every merge to `pr25-ux` that changes `src/` must be followed by `vercel --prod --yes` (or `npx vercel --prod --yes`) from `mp-ux` (staging) and `mp-prod-deploy` (production), with the deploy timestamp recorded.
- [known gap] Commerce store persistence can lag `currentUserPubky` after reload; before restore completes, a wrong-Ring step-up can clear the signed-in user's localStorage-only bearer once. A possible fix is using the persisted mirror's owner pubky when the store is empty.
- [known gap] A wrong-identity step-up can replace the signed-in user's homeserver cookie before the gate rejects it; the gate signs the other identity out, leaving `authStore` on the signed-in identity without a live cookie. Pre-existing and strictly better than before.
- [known gap] `getSignupAuthUrl` remains outside the ceremony guard; a signup-page mount during the ceremony POST window can wipe local state.
- [known gap] The guard is released before `initializeAuthenticatedSession` finishes (legacy parity, waived).
- [known gap] The guard is bounded by the token wait; a `/session` POST that never settles holds the ceremony until the 120-second flow timeout.
- [known gap] `marketplaceError` from a partial ceremony failure is logged but not surfaced directly; reconnect is inferred from the absent marketplace session.
- [proven live] `https://shop.pubky.app` now serves the Vercel production project `pubky-marketplace-production` and returns HTTP 200. Visitors now receive the production runtime configuration: production homeserver, Nexus, Homegate, marketplace service, and marketplace Nexus; the staging Shop remains at `https://pubky-marketplace-staging.vercel.app`. Money rails remain on test networks by owner decision, so this is not a real-money launch.
- [known gap] During the domain move, `shop.pubky.app` returned 404 for about two hours. Vercel mints a fresh `_vercel` TXT token on every attach because DNS is external; a second attach while waiting invalidated the published record. Restored after the owner published the new token. Procedure: `docs/ecommerce/runbook-production.md` at `790ca03e`.
- [known gap] Production Nexus stores retain 26 stale staging-derived listings from an earlier crash-loop period. Those cards appear in the production catalog, but their detail pages say `Listing unavailable`; new production listings index normally. The owner deliberately declined a wipe-and-replay because the old listings have no value.
- [implemented] Auth and credential HTTP helpers no longer copy response-body excerpts into error logs on parse failure (`9e18155c`, helper `30c1060e`). Session mint, Locks credentials, Homegate signup, and other private endpoints stay silent on the body; ordinary APIs must opt in. A broken session-mint salvage path that could have bound a forged bearer was removed before it shipped (`cbc22659`).
- [implemented] Pickup refusal toasts use static client copy (`7561200b`). A refused pickup command can include the meeting point in the server message; that text is not shown.
- [proven] VRT pixel tolerance was tightened (`98a0610e` / `a977f093`) so a one-word marketplace badge rewrite fails (80 px / 0.005%, with a denser override only on feed/onboarding chrome). A negative test rejects a scene that is not a production `data-surface`.
- [known gap] Linux VRT baselines were not regenerated on this branch: `.github/workflows/vrt.yml` runs on `master`/`dev` only (or a manual dispatch).
- [implemented] Wave 7 local pickup safe subset (Part A) shipped and deployed. Sellers can publish shipping, local pickup, or both. The public listing contains only fulfillment choice; seller meeting-point details are sealed at rest in the transaction service with XChaCha20-Poly1305 under a key-gated configuration, and pickup is off without that key and on sandbox deployments.
- [implemented] The paying buyer sees a meeting-point snapshot only after payment confirmation. The snapshot is pinned at confirmation, held only in app memory, and masked from telemetry. Either party may confirm handover; seller-attested handovers do not count toward reputation until buyer confirmation or the confirmation window passes. Seller changes to pickup terms permit unilateral buyer cancellation; a bounded buyer withdrawal runs from first reveal to handover. Sellers may clear details, while versions tied to paid unfinished orders remain.
- [implemented] marketplace-service `462ed54` on `main` (migrations 0020 and 0021) deployed to staging and production. Production `/health` reports `pickup_available:true`; staging reports false because it is sandbox. Client data-layer commits `691b810f`, `5a6454f2` and UI commits `2aea0170`..`383b6d3e` (all Part A) deployed to `shop.pubky.app` and the production alias.
- [proven] Every slice passed an Opus adversarial review and Kimi security/privacy audit. Wave 7.1 received one fix round for the key-rotation job's 100-row stall, an unpinned reveal stamping the withdrawal window, and a confirm-path panic; Wave 7.2a received one for malformed response excerpts reaching logs/Sentry; Wave 7.2b received two for pickup-marked auction fixtures hidden by VRT tolerance, a missing listing-form capability gate, and an unreachable create-mode editor.
- [known gap] Pickup-only listing detail still shows shipping copy; the capability gate is open during its initial null read (the service still refuses); and pre-Wave-7 listings marked pickup need a meeting point before pickup orders can complete.
- [deferred] Wave 7b (Part B): scheduling time slots, pickup returns and return-address reveal, and `location_key` grouping.
- [implemented] Igor's PR #22 (`BitcoinErrorLog/pubky-app`) is credited in code; its silent-shipping-fallback item is fixed.

## 2026-09-07

- [implemented] Wave 6 backlog batch merged and deployed at `9483446f` on `marketplace/pr25-ux`. SSR catalog seeds shop names; the catalog URL lives as a libs-only constant; messaging VRT on firefox is deterministic; Duplicate asks before replacing an unsaved draft and seeds before deleting; SSR shop fetch is capped at 6 concurrent.
- [implemented] Graduation dossier added at `2e022af5` (`docs/vibes/graduation-dossier.md`).
- [implemented] Teammate PRs on `BitcoinErrorLog/pubky-app`: #20 (tax removal, icota) closed as superseded by Wave 2b; its guard test was cherry-picked as `c003e374` under his authorship. #22 (local pickup with post-payment reveal, icota) has changes requested and is being absorbed into Wave 7.
- [known gap] Wave 7 kickoff: "Local pickup with scheduling". Design is in progress at `docs/ecommerce/local-pickup-design.md` on branch `marketplace/w7-design`. Owner decisions recorded: buyer may cancel if pickup terms change after payment; seller may delete details; one meeting point per order; pickup off without the encryption key; either party confirms handover, no automatic delivery; no pickup details on sandbox deployments; returns re-choose pickup or shipping with optional seller label.
- [implemented] Address-sharing policy (unchanged product rule, restated): a physical address is shared only when its owner chooses to, for a reason shown to them, with the one person who needs it; buyer→seller only the delivery address for shipped items once the order exists; seller→buyer nothing by default except a deliberately published pickup point revealed only to the paying buyer.
- [implemented] marketplace-service `c697e5f` deployed to both stacks (delivery auto-complete worker, return flow surfacing); migration 0019 verified.

## 2026-09-06

- [implemented] Wave 6 UX remediation shipped on `marketplace/pr25-ux` as `6554dd1f..420856c1` (HEAD `420856c1`)
  and deployed 17:52 to `pubky-marketplace-production.vercel.app`, `shop.pubky.app`, and `shop-rehearsal.pubky.app`
  (all `locks-paykit`). Nine slices, each Opus-reviewed; U1/U6/U8 Kimi-audited (U1 r3 SHIP). Source: two Opus
  surface reviews of 65 VRT baselines plus 68 live screenshots, a capability inventory, and five review claims
  dismissed after verification. Honesty labels, dual-truth drops, device-local watchlist, privacy-by-design
  addresses, direct-pay copy, and attestation review tiers were preserved. Return-path after sign-in
  (`6554dd1f`), the kill-switch drill runbook, and per-stack Paykit signing keys were recorded earlier today
  and are not repeated here.
- [implemented] U1 checkout: three steps; `Approve in Pubky Ring` up front when there is no marketplace session;
  Place order stays disabled until approval and a valid form; purchase-guarantee opt-in is default unchecked;
  the marketplace session store clears from a single `onSessionEnded` signal (service → controller) covering
  every transport path.
- [implemented] U2 seller identity: shop name with pubky fallback; attestation-derived rating and review count;
  `New seller · no reviews yet`; `Shipping: calculated at checkout`. Seller-stated tenure was dropped.
- [implemented] U3 commerce copy: offer dialog shows asking price and % vs asking (hidden on currency mismatch);
  bid dialog `Set your maximum bid`; `Commerce activity` → `Transaction history`; promo dismissal persisted;
  drop-ended `Watch this seller` / `Browse similar`; vitest woff2 font plugin.
- [implemented] U4 orders: tabs To ship / In transit / Completed / All; `You bought` / `You sold`; accessible
  5-star input.
- [implemented] U5 operator surfaces: notifications All / Marketplace / Social (type-exhaustive); dashboard
  Action-needed strip; drop status Draft / Scheduled / Live / Ended with sync detail under Technical details;
  `/marketplace/shop` added (was a 404); delivery-addresses orientation line.
- [implemented] U6 payment settings `How you get paid`: cards PayPal → Card (Stripe) → Bitcoin with truthful
  pills (PayPal is `Email saved`, never Connected; Bitcoin Connected only with Lock Server + Paykit claim);
  protocol detail under Technical details; payloads unchanged.
- [implemented] U7 mobile: `My marketplace` sheet, compact mobile promo, dashboard KPI chip strip, listing
  thumbnails; Duplicate listing creates a new local draft (photos not copied; auctions copied as fixed price).
- [implemented] U8 packing slip: optional local-only pasted address in component state; cleared on close, print,
  and route; Sentry-masked; truthful print caveat. See `docs/ecommerce/shipping.md`.
- [implemented] U9 seller studio: shared `ShopProfileCard` (shop page + My Shop live preview); aria-labels on
  icon-only seller controls with a real a11y test; Orders `Needs attention` tab; `Seller studio` namespace.
- [known gap] Sprint 3 is in progress, not shipped: sectioned listing studio, delivery auto-complete timer plus
  return/refund surfacing in the service, guest-indexable catalog, multi-seller cart grouping.
- [implemented] Buyer approval UX was tightened on `marketplace/pr25-ux` at `f036a76d`. Signed-in users now have an
  Orders entry in the marketplace tools row, the listing page no longer shows the Pubky Ring approval card before intent,
  and signed-out-of-approval buyers see it only when checkout, Place a bid, or Make offer asks for a durable marketplace
  session. Add to cart and watchlist writes stay local and need no approval.
- [implemented] Buyer-facing approval copy now consistently says `Approve purchases in Pubky Ring` /
  `Approve in Pubky Ring`, including the approval card, dialog, success toast
  `Purchases approved in Pubky Ring`, and the drop ready-check.
- [implemented] The dead `message` prop was removed from `MarketplaceSessionRequiredCard`; 33 VRT baselines were
  regenerated for the approval UX change.
- [proven live] The buyer UX fixes passed Opus gating review after one fix round and were merged at `f036a76d`, then
  deployed to Vercel production project `pubky-marketplace-production` at
  `pubky-marketplace-production.vercel.app` (`EAqqVuQq1BkstYJwwciMS3C981tv`) and staging project
  `pubky-marketplace-staging` at `shop.pubky.app` (`3tPXUhr9Zb5voJqjYRuuGfyz6fZP`).
- [known gap] Same-site bridged-entry rehearsal is deployed but domain verification is still pending. `bridge.pubky.app`
  and `shop-rehearsal.pubky.app` are attached to Vercel projects `pubky-app-bridge-rehearsal` and
  `shop-bridge-rehearsal`, but both still need `_vercel.pubky.app` TXT records of the form
  `vc-domain-verify=<host>,<token>` because the `pubky.app` apex is owned by another Vercel team.

## 2026-09-05

- [implemented] Shared pubky.app sign-in was added in consumer mode. A signed-in pubky.app user can arrive in Shop without a second sign-in once pubky.app deploys its session bridge; until then Shop's normal Ring sign-in remains the path.
- [implemented] Step-up approval was made explicit for commerce and private scopes. First checkout uses an empty-capability marketplace service token; private storage, receipts, watchlist sync, and messaging ask for the wider homeserver grant only when needed.
- [implemented] Receipt publication under a narrow grant no longer disappears silently. Shop records a visible reconnect state when private receipt storage needs a fresh approval.
- [implemented] Messaging custody was hardened. The receiver Noise secret and link snapshots are wrapped at rest with AES-GCM-256 under a non-extractable device keyring key, with no plaintext fallback on new writes.
- [implemented] Disputes, reports, the moderator role, and tax were removed from Shop. The owner decision is peer-to-peer trade with no operator authority over trades.
- [implemented] The production homeserver stack was stood up separately from staging. The public alias is `https://pubky-marketplace-production.vercel.app` until the `shop.pubky.app` cutover; commerce stays on `locks-paykit` with testnet money.
- [proven live] The production client alias was reachable, the production marketplace service health check returned 200, and production Nexus replay had reached cursor 201,061 of about 213,000 while the owner's first production listing already appeared in `/v0/stream/listings`.
- [known gap] `shop.pubky.app` still pointed at staging in the plan state. Bridged entry from real production pubky.app depends on upstream deployment of the session bridge.
- [known gap] Paykit request signing still uses the shared staging key because the reused Paykit server trusts one marketplace key; the backlog is to support a trusted-key list and rotate.
- [known gap] Production `/priv` durability needs a new production cadence. Staging had passed T+1h and T+25h.

## 2026-08-28

- [implemented] The marketplace Nexus review backfill gap was closed. `ReviewBackfill1787905961` listed every indexed user's review directory, ran normal attestation verification and reputation recompute, and completed across 1,948 indexed users in about 4.5 minutes.
- [known gap] The backfill found zero pre-cursor reviews on staging because staging had no review records; the earlier reviews proof ran against a testnet homeserver.

## 2026-08-27

- [implemented] Social/v1 record-layer alignment was recorded. Marketplace records need zero additions to the planned social/v1 spec, five conflicting fork rules were reversed without a wire break, records became open-world, and the never-written tombstone record type was deleted.
- [known gap] The v1 break still waits on the `app.marketplace` namespace, PostEnvelope listing/drop records, private bookmarks, media-by-hash, microsecond time, and editId-based listing sync.

## 2026-08-24

- [implemented] Shippo shipping labels were implemented end to end with seller-direct custody. The seller stores their own sealed Shippo token, quotes real rates, buys the label, prints the PDF, and reuses the label tracking number for the ship transition.
- [known gap] Shippo labels are not yet proven against Shippo's live API; the ledger says this needs a seller with a real Shippo test token.
- [implemented] Checkout inventory rules changed: ordinary checkout no longer holds stock. Stock is acquired only when payment starts, with bounded server-time windows; drop claims remain the deliberate FCFS exception.

## 2026-08-23

- [proven live] FCFS drops passed a two-buyer race on the fully deployed staging stack. Exactly one buyer won the last unit, the loser received the pinned sold-out refusal after refetch, the drop ended sold out, and the winner's private receipt carried a verified edition 1 of 1.
- [implemented] Drops use server time and service-side stock redaction. The client shows `live` and `sold out` only from the service projection and labels calendar buckets as estimates.
- [implemented] The durable service rejects sandbox payment advance unless the deployment opts in with `SANDBOX_PAYMENTS_ENABLED`; durable deployments do not fake payment.

## 2026-08-22

- [proven live] Real payments were proven through the Bitkit wallet leg on deployed regtest rails: seller watch-only claim in Bitkit, buyer in-app Payment Request, swipe-to-pay, broadcast, on-chain confirmation, service completion, credential, and guarded read.
- [proven live] Stripe test-mode payment was proven on the deployed stack from USD lock through hosted Checkout, webhook detection, settlement delay, confirmation, completion, credential, and guarded content read.
- [proven live] PayPal sandbox payment was proven on the deployed stack with hosted approval, gateway-notified detection, settlement, confirmation, completion, credential, and guarded content read.
- [proven live] Cross-device private watchlist sync passed against the real staging homeserver, including private read and directory-list denial to another identity.
- [proven live] A live DM reached the real app UI: a throwaway identity completed Noise XX with a signed-in app account and the message appeared in `/messages` with an unread badge.

## 2026-08-21

- [proven live] Durable-mode messaging was proven against the real staging homeserver over public relays, with token-gated signup, marker publish/discovery, Noise XX handshake, bidirectional chat, and snapshot restore.
- [implemented] The durable transaction service architecture described by ADR 0019 was implemented in Rust with PostgreSQL and Pubky AuthToken authentication; the in-memory service remains a labeled sandbox only.
- [implemented] Portable reputation was accepted: reviews embed long-lived, publicly verifiable purchase attestations signed by an attestor Pubky identity.

## Sources

- `docs/ecommerce/status.md`
- `docs/ecommerce/FEATURES.md`
- `docs/adr/0019-marketplace-transaction-authority.md`
- `docs/adr/0020-marketplace-public-records.md`
- `docs/adr/0024-portable-reputation.md`
- `docs/adr/0026-marketplace-drops.md`
- `docs/adr/0027-social-v1-migration.md`
- `docs/adr/0029-vibe-session-consumer.md`
- `.cursor/plans/vibes-first_marketplace_master_plan_d8646c7a.plan.md`
