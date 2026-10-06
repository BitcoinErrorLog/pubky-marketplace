# Multi-Operator Design: Per-Shop Transaction Services

Status: design + first honest increment (2026-08-23). The spec field and the
client's mismatch guard exist; per-shop routing does not yet, and this
document is the plan for it — sequenced so no increment ships a half-truth.

## The problem

The 2026-08 architecture review's exit criterion (b): _"a shop record can
point at a different transaction service and still sell."_ Today the client
talks to exactly one configured service (`PUBKY_RUNTIME_MARKETPLACE_URL`),
shop records historically said nothing about which authority the seller
uses, and the deployed system is one operator in fact. Pubky's pitch is
interchangeable components; orders should not be the exception.

## What already works in the operator's favor

- **Registration is not exclusive.** `listing.sync` derives a listing
  aggregate from the seller-signed homeserver document, not from a client
  payload. Any service deployment can register any public listing into its
  own database — two services registering the same listing do not conflict,
  because each holds its own inventory authority and they never share state.
  The _data model_ problem is not registration; it is that nothing tells a
  buyer's client which authority the seller actually honors.
- **Trust already routes through the seller's signature.** The shop record
  is seller-signed on the seller's homeserver. A `transactionService` claim
  inside it carries exactly the trust the listing itself carries.

## The spec field (shipped, specs `0.6.2-marketplace.7`)

`shop.transactionService` — optional HTTPS base URL, no userinfo/query/
fragment, ≤ 300 chars. Semantics: _the transaction service authority this
shop sells through._ Clients MUST resolve transactional commands (checkout,
offers, bids, orders) for this shop against it when present, falling back to
their configured default when absent. Absence means "the deployment
default," which keeps every existing record valid. This client's shop
editor deliberately does not offer the field yet: on a single-service
deployment the only thing a divergent value could do is block the seller's
own sales here — the editor affordance ships with increment 2's routing.

## Increment 1 (shipped with the field): the mismatch guard

Routing to arbitrary services is not implemented yet, so the client must not
pretend. When a shop record declares a `transactionService` whose origin
differs from the client's configured service, the client:

- surfaces the declared authority on the shop and listing pages, and
- refuses to send transactional commands for that seller to the configured
  default — with copy stating the seller sells through a different service
  this deployment does not route to yet —

instead of silently registering the seller's listing into an authority the
seller never declared. An absent field keeps today's behavior exactly.

## Increment 2 (not started): real per-shop routing

What full resolution requires, and why it is a project rather than a patch:

1. **Sessions keyed by origin.** The bearer session
   (`marketplace-session.ts`, localStorage key
   `pubky.marketplace.session.v1`) is account-scoped but single-service. It
   becomes keyed by `(account, serviceOrigin)`; the connect dialog names the
   origin it is authorizing ("this approval authorizes
   `market.example.com`"); AuthTokens already bind audience per approval, so
   the flow repeats per service, deliberately.
2. **Transport parameterized by origin.** Every call in
   `marketplace-transaction.ts` takes the resolved origin instead of reading
   `getMarketplaceUrl()`. Resolution: the seller's shop record field, else
   the configured default. The runtime-config fail-closed rules apply per
   origin (https, explicit allowlist for real-payment modes).
3. **A service registry.** Dexie records every origin the account has
   transacted with (first-use timestamp, last-seen). This is what makes
   fan-out reads bounded and auditable, and it is user-visible (settings:
   "marketplace services this account uses").
4. **Fan-out read models.** `GET /v1/orders`, offers, notifications, and
   receipts exist per service. The orders timeline becomes a merge across
   the registry's origins with per-origin error isolation (one dead service
   grays out its rows; it must not blank the timeline). Revision-CAS
   semantics are unchanged — revisions never cross services.
5. **Payment config and fiat rails per origin.** The `/v0` payment-method
   surface, Stripe/PayPal verification, and Locks correlation all live on
   the seller's declared service; the guard in increment 1 already prevents
   the wrong-authority case, so increment 2 only moves the calls.

Nothing above requires service-side changes: a second operator deploys the
existing service unchanged. What a _shared_ listing across operators would
eventually need service-side — cross-service inventory awareness — is
explicitly out of scope: each service is a full authority for the orders it
accepts, and a seller who declares one authority in their shop record has
chosen their serialization point. Overselling across authorities is
prevented by that declaration, not by coordination.

## Exit criterion mapping

Review criterion (b) is met when increment 2 lands and a seller on a second
operator's deployment (same service codebase, different DB and attestor)
sells to a buyer whose client resolved the authority from the shop record —
with the session approval naming that origin. Criterion (c) — operator death
leaving verifiable history — is handled separately by portable receipts
(`/priv/pubky.app/marketplace/v1/receipts/…`, ADR 0019 receipts +
`pubky-order-receipt+v1` attestations), which work identically under any
number of operators.
