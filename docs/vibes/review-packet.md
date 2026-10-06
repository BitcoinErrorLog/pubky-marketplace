# Weekly Vibes Review Packet

Reusable packet for reviewing Shop as a Vibes experiment. Fill with repository or plan evidence only; write `not measured` where no server-side fact exists.

## Template

### Week Ending YYYY-MM-DD

**Live URLs**

- Public app:
- Production service:
- Production marketplace Nexus:
- Staging app:
- Staging service:
- Staging marketplace Nexus:

**What users did (server-side facts only)**

- Sign-ins:
- Listings/shops/drops:
- Checkouts/payments:
- Messages:
- Watchlist/private storage:
- Reviews/receipts:

**What broke**

- Incident:
- Detection source:
- Fix or current state:
- User impact:

**What it taught**

- Product boundary:
- Infrastructure boundary:
- Trust/security boundary:
- Documentation boundary:

**Recommended Next State Per Experiment**

- Catalog/index:
- Selling/listings:
- Checkout/orders:
- Payments:
- Drops:
- Reviews/receipts:
- Watchlist:
- Messaging:
- Shared sign-in:
- Step-up approval:

**Open Decisions**

- Decision:
- Owner:
- Blocking evidence:

## Week Ending 2026-09-09

**Review history**

- Static toast copy rule shipped in production 2026-09-09 as part of merge `4607a692c` on `marketplace/pr25-ux`. Opus round 1 was FIX-FIRST because three tests still asserted the old raw-message behavior; drop refusals were not classified. Round 2 was SHIP. The non-gating cleanup batch centralized the static fallback in `src/libs/commerce/failure-messages.ts`, removed dead `generic`, added real AppError sentinels, and added preservation tests (`148db15ed`, `91e041c9c`, deployed after the `4607a692c` build); parent proof recorded TSC 0, ESLint 0, and 806 unit tests. Deploys: `pubky-marketplace-production-ccat1hufk` / `shop.pubky.app`; staging `pubky-marketplace-staging-k7uzbc06f`.
- DM `sent_at` wire format shipped 2026-09-09 as `c694b192` on `pr25-ux`. The Kimi audit was SHIP with four non-gating findings, all fixed in `c694b192`: VRT fixture drift, a tightened emit-schema maximum, legacy ISO rows normalized on read, and a Paykit test asserting the normalized value. Production deploy was `pubky-marketplace-production-371i2l41j`, staging `gm8z9ndvp`; it was then superseded by the `4607a692c` deploy above.
- Shop shipped two UX fixes on 2026-09-09 at `e6ffcf6e` on `marketplace/pr25-ux`: `/` now redirects to `/marketplace` (production `pubky-marketplace-production-fg6z17e36`, alias `shop.pubky.app`; staging `pubky-marketplace-staging-1iabskwrx`), and Bitcoin auto-hides unless both `bitcoin_available` and `bitcoin_offer_available` are true. The auto-hide is hop 3 of a 3-hop contract: paykit-server publication on `/health/ready` is in progress (hop 1), while marketplace-service consumption/caching and payment-config `503` avoidance during Paykit outages is implemented but under review (hop 2); both are undeployed, so an omitted field defaults to `true` and behavior is unchanged. Fixture commit `71c2ece6` was necessary because VRT mocks bypass the Zod default; run the marketplace VRT subset when touching the payment schema.

**Known gaps**

- The buyer copy at `src/core/application/commerce/commerce.ts:644` still renders a seller-declared origin string; this is a backlog item and was not part of the toast copy shipment.
- `error.factories` and Sentry still carry the raw error message in error context; the message is scrubbed by a denylist, not removed. This remains a backlog item.

## Week Ending 2026-09-08

**Live URLs**

- Client `383b6d3e` (Wave 7) is on `https://shop.pubky.app` via Vercel project `pubky-marketplace-production`. Staging Shop is `https://pubky-marketplace-staging.vercel.app`. marketplace-service `462ed54` on `main` is deployed to staging and production; production `/health` reports `pickup_available:true`, while staging reports false because it is sandbox.

**Single-approval sign-in**

- Shipped 2026-09-08 on `marketplace/one-approval`. One Pubky Ring approval dual-presents the same `AuthToken` bytes to the homeserver first and the marketplace transaction service second, minting both sessions. `singleApprovalSignIn` (`PUBKY_RUNTIME_SINGLE_APPROVAL_SIGN_IN`) defaults to true; disabling it retains the legacy two-step flow.
- Commits: feature `c213ae9f`; tests `454828c5`; fixer round `454828c5..3e737732` (8 commits); cleanup batch `e482e603..8881f90f` (5 commits); N-1 follow-up `ac593082`.
- Review record: round 1 Kimi SHIP on the security lens plus Opus FIX-FIRST (5 P1, 4 P2, 3 P3); all findings were closed; round 2 Kimi SHIP plus Opus SHIP; cleanup batch Opus SHIP; N-1 fix Opus SHIP.
- Pinned behavior: marketplace outage does not block sign-in; bridged and direct ceremonies share one single-flight guard; joined dialogs show that approval is already in progress; closing a joined dialog does not cancel the owner; wrong-identity step-up is rejected before the marketplace POST and preserves the signed-in user's valid bearer; and every uncommitted sign-in failure removes any newly minted bearer from memory, `localStorage`, and the commerce store. The marketplace capability string is echoed but not stored; see the marketplace-service record.
- Deployments: staging `pubky-marketplace-staging.vercel.app` at 19:33 on 2026-09-08; production `shop.pubky.app` and `pubky-marketplace-production.vercel.app` at 19:37; the `ac593082` N-1 fix deployed 2026-09-08 evening.
- Process gap: between 12:53 and 19:37, the P1 credential-leak fix and session-fixation fix were pushed to GitHub but not deployed to Vercel; production continued serving the 07:47 build (`383b6d3e`). Push is not deploy: every merge to `pr25-ux` that changes `src/` must be followed by `vercel --prod --yes` (or `npx vercel --prod --yes`) from `mp-ux` (staging) and `mp-prod-deploy` (production), with the deploy timestamp recorded.

**Known gaps**

- P4: the commerce store is not persisted while `currentUserPubky` is; after reload and before restore completes, a wrong-Ring step-up can clear the signed-in user's localStorage-only bearer once. Possible fix: use the persisted mirror's owner pubky when the store is empty.
- P3: a wrong-identity step-up can replace the signed-in user's homeserver cookie before the gate rejects it; the gate signs the other identity out, leaving `authStore` on the signed-in identity without a live cookie. Pre-existing and strictly better than before.
- P3: `getSignupAuthUrl` remains outside the ceremony guard; a signup-page mount during the ceremony POST window can wipe local state.
- P3: the guard is released before `initializeAuthenticatedSession` finishes (legacy parity, waived).
- P3: the guard is bounded by the token wait; a `/session` POST that never settles holds the ceremony until the 120-second flow timeout.
- P4: `marketplaceError` from a partial ceremony failure is logged but not surfaced directly; reconnect is inferred from the absent marketplace session.

**What users did (server-side facts only)**

- Local pickup Part A is deployed. A seller may publish shipping, pickup, or both. Public listings contain the fulfillment choice only; seller meeting-point details are sealed at rest in the transaction service with XChaCha20-Poly1305, are key-gated, and are disabled without the key and in sandbox deployments.
- After payment confirmation, the buyer may read the meeting-point snapshot pinned at confirmation. It is held only in app memory and masked from telemetry. Either party may confirm handover; seller-only confirmation does not earn reputation until buyer confirmation or the confirmation window passes. Buyers may cancel if pickup terms change and may withdraw from first reveal until handover. Sellers may clear details, retaining versions for paid unfinished orders.

**What broke**

- Wave 4 cutover took `shop.pubky.app` offline for about two hours: Vercel minted a new TXT verification token after detach, and a second attach invalidated the published record (`790ca03e`).
- Wave 7.1 required one fix round: key rotation could stall past 100 rows; a reveal without a pinned snapshot stamped the withdrawal window; and the confirm path could panic.
- Wave 7.2a required one fix round because a malformed-response excerpt could reach logs/Sentry. A later pass (`9e18155c`) made body excerpts opt-in for all `parseResponseOrThrow` callers and closed a session-mint salvage hole before it shipped. Wave 7.2b required two: fixtures and seed data marked auctions as pickup, a defect the old VRT tolerance hid; the listing form was not capability-gated; and the create-mode editor was unreachable. Pickup refusal toasts were later mapped to static copy (`7561200b`) so a refusal cannot render the address.

**What it taught**

- Trust/security boundary: meeting points are not public listing data. The buyer receives only the payment-pinned snapshot; the app does not persist it or emit it to telemetry.
- Product boundary: Shop remains peer-to-peer with no dispute or report mechanism. Recourse is review plus the handover reputation asymmetry.

**Recommended Next State Per Experiment**

- Selling/listings and checkout/orders: harden. Fix pickup-only detail copy, the initial-null capability-gate exposure, and meeting-point setup for pre-Wave-7 pickup listings.
- Local pickup Part B: defer scheduling, pickup returns/return-address reveal, and `location_key` grouping to Wave 7b.

**Open Decisions**

- No new operator mechanism: disputes and reports remain out of scope by design.

## Week Ending 2026-09-07

**Live URLs**

- Unchanged from 2026-09-06: production alias `https://pubky-marketplace-production.vercel.app`; `https://shop.pubky.app` still staging until cutover; marketplace-service production `https://marketplace-service-production-ce23.up.railway.app`; Nexus production `https://nexusd-production-95a0.up.railway.app`. Money rails remain `locks-paykit` testnet.

**What users did (server-side facts only)**

- Sign-ins / listings / checkouts / messages / watchlist / reviews: not measured beyond the 2026-09-06 rows.
- Shop client: Wave 6 backlog batch `9483446f` merged and deployed (SSR catalog seeds shop names; libs-only catalog URL constant; deterministic firefox messaging VRT; Duplicate confirms before replacing an unsaved draft and seeds before deleting; SSR shop fetch capped at 6 concurrent). Graduation dossier `2e022af5`.
- marketplace-service `c697e5f` deployed to both stacks (delivery auto-complete worker, return flow surfacing); migration 0019 verified.

**What broke**

- No new incident recorded on 2026-09-07.
- Teammate PR #20 (tax removal) was closed as superseded by Wave 2b; the guard test was cherry-picked as `c003e374` under icota's authorship so a reintroduced tax field still fails CI.
- Teammate PR #22 (local pickup with post-payment reveal) has changes requested; work is absorbed into Wave 7 rather than merged as-is.

**What it taught**

- Product boundary: address sharing stays owner-chosen and reason-shown, to the one person who needs it. Buyer→seller is only the delivery address for shipped items once the order exists. Seller→buyer is nothing by default except a deliberately published pickup point revealed only to the paying buyer.
- Contribution boundary: overlapping teammate PRs are triaged against shipped waves; useful tests are kept, superseded product diffs are closed, and remaining design is folded into the next wave instead of dual-tracked.

**Recommended Next State Per Experiment**

- Catalog/index: harden. SSR catalog now seeds shop names and caps concurrent shop fetches at 6; guest-indexable catalog is still not the full Sprint 3 item.
- Selling/listings: harden. Duplicate listing now asks before replacing an unsaved draft and seeds before deleting; sectioned listing studio remains unshipped.
- Checkout/orders: harden. Service delivery auto-complete and return-flow surfacing shipped at `c697e5f`; Wave 7 local pickup is design-only (`docs/ecommerce/local-pickup-design.md` on `marketplace/w7-design`).
- Payments / drops / reviews / watchlist / messaging / shared sign-in / step-up: unchanged from 2026-09-06. Messaging VRT firefox flake is recorded as fixed in the backlog batch.

**Open Decisions**

- Wave 7 local pickup (owner-recorded, design in progress): buyer may cancel if pickup terms change after payment; seller may delete details; one meeting point per order; pickup off without the encryption key; either party confirms handover, no automatic delivery; no pickup details on sandbox deployments; returns re-choose pickup or shipping with optional seller label.
- Mainnet money, PayPal real purchase, Shippo live API, production `/priv` durability, messaging backup key, upstream bridge / TXT / cutover, Igor's $8.76 overpayment: still open as of 2026-09-06.

## Week Ending 2026-09-06

**Live URLs**

- Public production alias: `https://pubky-marketplace-production.vercel.app` on Vercel project
  `pubky-marketplace-production`, deployment `EAqqVuQq1BkstYJwwciMS3C981tv`.
- Production app target after cutover: `https://shop.pubky.app`; currently attached to Vercel staging project
  `pubky-marketplace-staging`, deployment `3tPXUhr9Zb5voJqjYRuuGfyz6fZP`.
- Production marketplace service: `https://marketplace-service-production-ce23.up.railway.app`.
- Production marketplace Nexus: `https://nexusd-production-95a0.up.railway.app`.
- Existing deployed staging app: `https://shop.pubky.app` before cutover.
- Payment rails are reused from `pubky-marketplace-staging`; money rails stay testnet/regtest. Wave 6 client
  (`6554dd1f..420856c1`) was deployed 2026-09-06 17:52 to `pubky-marketplace-production.vercel.app`,
  `shop.pubky.app`, and `shop-rehearsal.pubky.app`; all three remain `locks-paykit`.
- Bridge rehearsal: `bridge.pubky.app` for Vercel project `pubky-app-bridge-rehearsal` and
  `shop-rehearsal.pubky.app` for Vercel project `shop-bridge-rehearsal`; both are attached but pending
  `_vercel.pubky.app` TXT verification.

**What users did (server-side facts only)**

- Production sign-ins: owner production Ring sign-in happened on 2026-09-05. Count of other sign-ins: not measured.
- Listings/shops/drops: the owner published a production listing; by 2026-09-06 03:24Z the first production listing already appeared in `/v0/stream/listings`. Shop count, listing count, and drop count: not measured.
- Checkouts/payments: no production checkout fact is recorded. Planned proof rows include testnet BTC and Stripe/PayPal test purchases.
- Messages: no production message fact is recorded. Planned proof rows include production messaging handshake and message.
- Watchlist/private storage: production `/priv` durability probe must be reseeded; no production result is recorded. Staging had passed T+1h and T+25h in the plan.
- Reviews/receipts: no production review or receipt fact is recorded. Existing proof is staging/testnet, not production.
- Buyer UX: Orders entry shipped for signed-in users; Ring approval prompts moved off the listing view until checkout,
  Place a bid, or Make offer requires approval. Add to cart and watchlist writes are local and need no approval.
- Wave 6 UX remediation (2026-09-06): nine slices U1–U9 shipped on `marketplace/pr25-ux` `6554dd1f..420856c1`. Review
  evidence is two Opus surface reviews of 65 VRT baselines plus 68 live screenshots, a capability inventory, and five
  review claims dismissed after verification. U1/U6/U8 were Kimi-audited (U1 r3 SHIP). Sprint 3 (sectioned listing
  studio, delivery auto-complete timer plus return/refund surfacing, guest-indexable catalog, multi-seller cart
  grouping) is in progress, not shipped. Return-path after sign-in (`6554dd1f`), kill-switch drill, and per-stack
  Paykit signing keys were recorded earlier today.

**What broke**

- Production client env initially set `PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE=unavailable`; it was corrected to `locks-paykit` and redeployed on 2026-09-05.
- Upstream shared sign-in remained blocked by PR review state in the plan narrative, though the local plan todos later record #2483/#2484 P1s as fixed at PR heads and awaiting upstream re-review. Same-site bridge rehearsal is deployed, but the rehearsal domains still need `_vercel.pubky.app` TXT records because the apex belongs to another Vercel team.
- The VRT ledger remained 143/144 because Messaging firefox-mobile had a load-order flake that passed standalone.
- Shippo labels remained unproven against Shippo's live API.
- The fiat-verifier return-origin shape was inconsistent in the plan: the todos say per-request `return_origin` is being implemented, while Wave 1 text still describes the single-valued redirect as a staging limitation unless support exists.

**What it taught**

- Product boundary: Shop is peer-to-peer. Disputes, reports, operator moderation, and tax do not belong in the trade authority.
- Infrastructure boundary: production is a separate homeserver stack beside staging, not a flip of the staging project.
- Indexing boundary: full replay is necessary because tail-start would strand marketplace records whose users were not yet indexed.
- Trust/security boundary: shared sign-in can reuse public session metadata only; commerce AuthTokens, private storage, messaging, and Paykit/Locks claims still need explicit approval paths.
- Documentation boundary: shipped claims need the ledger labels and dates, not inferred completion from feature presence.
  Wave 6 named and kept honesty labels, dual-truth drops, device-local watchlist, privacy-by-design addresses,
  direct-pay copy, and attestation review tiers.

**Recommended Next State Per Experiment**

- Catalog/index: harden. Production replay was near completion and the first listing appeared, but post-cutover proof rows still need recording.
- Checkout/orders: harden. Wave 6 three-step checkout, order tabs (`To ship` / `In transit` / `Completed` / `All`,
  `You bought` / `You sold`, `Needs attention`), and packing-slip paste field shipped; production checkout proof is pending.
- Payments: graduate for testnet BTC, Stripe test-mode, and PayPal sandbox proofs; Wave 6 `How you get paid` pills are
  truthful (PayPal `Email saved`, never Connected). Harden before real PayPal or any mainnet money.
- Drops: graduate D1 FCFS on staging proof; Wave 6 Draft/Scheduled/Live/Ended status shipped; keep raffles/gated drops archived until designed.
- Selling/listings: harden. Wave 6 seller identity, `ShopProfileCard`, `/marketplace/shop`, Duplicate listing, and
  `Seller studio` namespace shipped; Sprint 3 sectioned listing studio is not shipped. Production shop/drop/media publish still need proof.
- Reviews/receipts: graduate portable receipts and review attestations for the proven stack; harden production receipt publication and attestor-publisher follow-ups.
- Watchlist: harden. Staging cross-device proof exists; production durability cadence is still open.
- Messaging: keep vibing. E2EE works at experiment grade, but live Ring approval and independent security review remain open.
- Shared sign-in: harden. Consumer mode is merged, and same-site rehearsal exists; live use depends on pubky.app bridge deployment, TXT verification, and cutover.
- Step-up approval: harden. Option C is implemented; Wave 6 checkout asks `Approve in Pubky Ring` up front when there
  is no marketplace session. Empty-capabilities Ring display and production step-up proof remain open.

**Open Decisions**

- Mainnet money: not now. The plan says money rails stay on testnet at production launch and mainnet is a later gated decision.
- PayPal real purchase: still open. The plan lists a real non-sandbox PayPal purchase as a standing thread.
- Shippo live API proof: still open. Needs a seller with a real Shippo test token.
- Production `/priv` durability: still open. Needs T+1h, T+1d, and T+7d production cadence.
- Messaging backup key: still open. The ledger says the multi-device backup-key decision is unmade.
- Upstream bridge deployment, rehearsal TXT verification, and `shop.pubky.app` cutover: still open.
- Igor's $8.76 overpayment: user call.

## Sources

- `docs/ecommerce/status.md`
- `docs/ecommerce/FEATURES.md`
- `docs/adr/0019-marketplace-transaction-authority.md`
- `docs/adr/0020-marketplace-public-records.md`
- `docs/adr/0024-portable-reputation.md`
- `docs/adr/0026-marketplace-drops.md`
- `docs/adr/0028-indexer-contract.md`
- `docs/adr/0029-vibe-session-consumer.md`
- `.cursor/plans/vibes-first_marketplace_master_plan_d8646c7a.plan.md`
