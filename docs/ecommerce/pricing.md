# Pricing: Currencies, Indicative Conversions, and the Policy Gap

What a listing price is, what the "≈" estimates are and are not, and exactly where the
fiat↔BTC conversion question lives. Read [`status.md`](status.md) first for the general
real/simulated map.

## What a listing price is

Listing records carry structured money — `{amountMinor, currency, exponent}` — validated
by `commerceMoneySchema` (`src/libs/commerce/transaction-contracts.ts`). The schema
accepts any uppercase asset code with exponent 0–18; it is not a currency allowlist. The
record schema additionally forces one asset per listing: the primary price, every variant
price override, and the flat shipping price must share the same `{currency, exponent}`
(`src/libs/commerce/marketplace-records.ts`).

The sell studio deliberately authors exactly two of the assets that schema permits:

| Studio choice | Stored money                     | Input unit                                                          |
| ------------- | -------------------------------- | ------------------------------------------------------------------- |
| US dollars    | `{currency: "USD", exponent: 2}` | dollars with at most two decimals (`125.00` → `amountMinor: 12500`) |
| Bitcoin (₿)   | `{currency: "BTC", exponent: 8}` | whole bitcoin base units (`15000` → `amountMinor: 15000`)           |

Bitcoin base units ARE the minor unit of BTC at exponent 8 — no conversion happens on
input, ever.
This is the exact shape the live regtest purchase paid
(`unitPrice: {amountMinor: 15_000, currency: 'BTC', exponent: 8}` against a lock
criterion of `{amount: "15000", asset: "BTC"}` — see `src/test/live/locks-payment.live.ts`).
Offers, counteroffers, and auction bids are always made in the listing's own asset; the
record schema and the transaction service both reject cross-asset amounts. A listing
priced in any other asset (a foreign record, e.g. EUR) still renders, but the studio
refuses to edit it (`unsupported`) rather than silently rewriting its price into an asset
it did not have.

BTC-at-exponent-8 money displays per BIP-177 everywhere: the bitcoin symbol followed by
grouped integer base units (`₿15,000`), which is the same exact amount as
`BTC 0.00015000` stated in its own minor unit. The words "sats"/"satoshis" appear
nowhere in the UI.

## What the "≈" estimates are (indicative display only)

Wherever a listing price renders (cards, detail, cart lines and subtotals, order totals),
an approximate converted counterpart can appear beside it: fiat-priced money shows
"≈ ₿N", bitcoin-priced money shows "≈ $X". Honest treatment, enforced in code
(`src/libs/commerce/pricing.ts`, `MarketplaceIndicativePrice`):

- **Marked approximate.** Always prefixed "≈", with a tooltip: "At current rate,
  indicative only".
- **Rate source.** The BlockTank BTCUSD ticker at the runtime config's
  `exchangeRateApi` (default `https://api1.blocktank.to/api/fx/rates/btc`) — the same
  source the app's Homegate onboarding already uses — cached in memory and refetched
  when older than five minutes.
- **Rendered only when the rate fetch succeeds.** No rate → no estimate. Never a stale
  fallback, never an error state beside a price.
- **USD and BTC only.** Any other asset has no rate source here, so it gets no estimate.
- **User-controlled.** Marketplace settings → Display preferences → "Approximate price
  conversions" toggles the secondary display off; the preference persists on the device.
- **Display-only.** Nothing transactional reads the estimate. It cannot change what a
  buyer pays or a seller receives.

## What the payment rails do today

- **The BTC rail pays BTC-denominated lock criteria.** A content lock's
  `paykit-payment` criterion carries `{amount, asset}` fixed at **lock creation**; the
  Paykit Server accepts only `asset: "BTC"` (`CriterionAsset::parse` in
  `paykit-server/src/domain/invoice.rs`). A bitcoin-priced listing whose lock says
  `{amount: "<base units>", asset: "BTC"}` is payable end to end — that is the verified
  live flow.
- **Fiat-priced listings cannot take the BTC rail.** A USD-priced listing has no defined
  Bitcoin payment amount: no fiat↔BTC conversion code exists anywhere in this client,
  the marketplace service, or the verifier chain, and the criterion's asset must match
  what the verifier accepts. This is a fact about the rails, not an oversight in the
  display layer.
- **This app never authors content locks.** The listing studio cannot create a
  `digitalLock`; locks are created by external tooling against the Lock Server's
  creator-publishing API. So the studio's pricing choice does not by itself make a
  listing payable — the lock (where one exists) fixes the payable amount and asset.

## The conversion policy gap (deliberately not invented here)

For a fiat-priced listing to be paid over the BTC rail, someone must decide **when the
exchange rate is sampled and who bears the drift**: rate at lock creation, rate at
invoice creation, a bounded quote window, or something else. That decision belongs to
the payment rails — the Lock criterion fixes the amount at lock creation, and the
verifier attests against exactly that amount — not to a display layer, and not to this
client. Inventing a conversion here would produce a number nothing would honor.

The indicative estimates in this app are therefore explicitly NOT a conversion policy:
they are marked approximate, they are never consumed by any payment path, and they can
be switched off.

## What the fiat-rails design resolves

The fiat rails design (`docs/ecommerce/fiat-rails-design.md` on branch
`marketplace/pr34-fiat-design`) dissolves most of the gap rather than solving it with an
exchange rate: a USD-priced listing maps 1:1 to a `{amount: "<cents>", asset: "USD"}`
lock criterion — already valid at the Lock Server today — verified by a fiat verifier
speaking the existing Paykit wire contract, with Stripe/PayPal settling in the
criterion's own asset. No fiat↔BTC conversion happens there either; each rail pays
criteria denominated in its own asset. What remains open after that design, recorded in
its §9: a single listing payable by BOTH rails (buyer picks BTC or USD at checkout)
requires two locks per listing or upstream `Any`-logic criteria, and converting
fiat-priced listings onto the Bitcoin rail still needs the rate-at-lock-creation /
rate-at-invoice decision if anyone ever wants it.

## Package measurements (related display preference)

Package dimensions and weight are canonical metric in the record — exact integer
millimeters and grams (`commercePackageSchema`), never anything else. The measurement
preference (marketplace settings → Display preferences, defaulting from locale: `en-US`
→ imperial, otherwise metric) only changes what the seller types (cm/g or in/oz,
converted exactly on save: 1 in = 25.4 mm, 1 oz = 28.349523125 g) and what buyers read
(one-decimal display). Conversion math lives in `src/libs/commerce/units.ts` with
round-trip tests.
