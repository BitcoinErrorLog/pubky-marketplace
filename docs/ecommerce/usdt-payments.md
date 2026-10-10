# USDT payments (flagged, default off)

The Shop can carry USDT (USDT0 on Arbitrum One) as a payment method beside Bitcoin and PayPal. It ships behind one flag and is off by default: with the flag off the Shop's behaviour for Bitcoin and PayPal is unchanged and nothing USDT-shaped is rendered.

## The flag

| Where                         | Name                                                          | Default | Meaning                                                                     |
| ----------------------------- | ------------------------------------------------------------- | ------- | --------------------------------------------------------------------------- |
| Shop runtime config           | `PUBKY_RUNTIME_USDT_PAYMENTS_ENABLED` (`usdtPaymentsEnabled`) | `false` | The Shop may offer USDT                                                     |
| Marketplace service `/health` | `usdt_payments: { available: true }`                          | absent  | The service has USDT on; absent when its own `USDT_PAYMENTS_ENABLED` is off |

The service is authoritative. A new USDT offer needs both: the Shop flag on AND `/health` reporting `usdt_payments.available`. `useUsdtPaymentsAvailable()` (via `CommerceController.fetchUsdtPaymentsAvailable`) is the one gate. It is false while loading and after a failed read, and with the Shop flag off it never calls `/health`.

The gate covers new offers only. An order that already carries `payment_method: "usdt"` is always parsed and displayed, so it never shows as Bitcoin and never strands money after a flag flip.

The flag does not cover the Locks path. Once locks#75 and a `[usdt]` Paykit config are deployed, a Locks invoice for a USD-priced locked listing offers USDT to every buyer of a seller who approved a USDT address, whatever this flag says: the invoice offers every approved option and neither the service nor the Shop shapes it. The flag only controls whether the Shop mentions USDT on that path. A `locked` settlement can also carry a USDT payment after locks#75, and the Shop will not know the rail, so a locked receipt must not be labelled "Bitcoin".

## Payment option model

`src/libs/commerce/payment-options.ts` separates the buyer-facing method label from what the buyer sends and where it settles:

- Method label (`PaymentMethodKind`, wire `payment_method`): `bitcoin`, `usdt`, `paypal`, `stripe`.
- Asset: `BTC`, `USDT` (fiat methods carry none; the asset is the order's own currency).
- Network: `bitcoin`, `arbitrum-one`.
- Settlement mode: `locked` (Lock Server entitlement) or a service-verified mode: `paykit`, `gateway-notified`, `processor`, `seller-attested`.
- Option id: `{method}.{asset}.{network}`, or `{method}.fiat` for fiat methods: `paykit.btc.bitcoin`, `paykit.usdt.arbitrum-one`, `paypal.fiat`, `stripe.fiat`.

The order projection accepts the optional, display-only `paymentAsset`, `paymentNetwork`, `paymentAmountMinor`, `paymentExponent` and `paymentQuoteBasis`. A value the Shop does not recognise is dropped for that order; it never fails the order parse. `formatUsdt` renders USDT millionths with six decimals.

Listings stay priced in `USD/2` or `BTC/8`; USDT is a payment method, never a price currency. The same rule applies to Locks and Paykit requests: the lock or request asset is the price denomination, and a USD-priced listing may be paid in quoted BTC or USDT.

## Gated surfaces

- The seller's "How you get paid" settings render a USDT card (below) only when `useUsdtPaymentsAvailable()` is true.
- `availablePaymentMethods(config, { usdtPaymentsAvailable })` offers `usdt` only when the gate is on AND the seller's public config carries `usdtAvailable: true`. Callers that omit the option get today's result.
- `getUsdtPaymentsEnabled()` (`@/config/commerce`) reads the runtime flag.
- The `/health` capability read sits beside `getDigitalDeliveryCapability` in `MarketplaceGatewayService`.

## Seller settings: Accept USDT

`MarketplaceGetPaidSettings` adds a "USDT" card after the Bitcoin card when the gate is on (`MarketplaceUsdtSellerSetup`). Flag off, the DOM and the save request are unchanged.

**Wire contract** (own payment configuration, `GET`/`PUT /v0/sellers/me/payment-config`; pinned in `src/libs/commerce/usdt-seller-setup.ts`, fixtures in `src/test/fixtures/commerce/seller-payment-config-usdt.wire.ts`). The fields exist only while the service's USDT flag is on:

| Field (wire / Shop)                     | Values                                   | Meaning                                                                             |
| --------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `usdt_enabled` / `usdtEnabled`          | boolean                                  | The seller's Shop-level consent, written by the toggle                              |
| `usdt_setup` / `usdtSetup`              | `ready`, `setup_required`, `unavailable` | The service's signed Paykit `/setup/status {asset: "USDT"}` result                  |
| `usdt_setup_action` / `usdtSetupAction` | `setup`, `reconnect`, `null`             | The Bitkit flow for a `setup_required` seller; `null` when `ready` or `unavailable` |

`deriveUsdtSellerReadiness` collapses them to `ready`, `setup`, `reconnect` or `unavailable`. Only a `ready` status from the service means ready: the sign-in type never decides it, and a Ring-only seller is never ready. A missing or unknown status, or `setup_required` without a usable action, fails closed to `unavailable`, and `unavailable` never offers an authorization flow. A seller who has never saved a payment configuration has no own view (the service answers `null`), so the card reads `unavailable` until a first save.

**States and copy.**

| State         | Shown                                                              | Action                                                  |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------------------- |
| `ready`       | "USDT ready"; the Accept USDT toggle is usable                     | none                                                    |
| `reconnect`   | "USDT needs Bitkit. Pubky Ring can't share a USDT address."        | "Add USDT in Bitkit" (reconnect iframe)                 |
| `setup`       | the same line                                                      | "Set up Bitkit payments" (setup iframe, as for Bitcoin) |
| `unavailable` | the same line, "USDT can't be checked right now. Try again later." | "Check again" (re-reads the own configuration only)     |

The toggle stays disabled until `ready` (it can always be switched off), and the seller's consent saves with the rest of the form. A save sends `usdt_enabled` whenever the service reported it or the gate is on, so saving PayPal or Bitcoin never resets the consent; with the service flag off the key is never sent (the service refuses unknown fields).

**Reconnect.** `CommerceController.getPaykitReconnectUrl` builds `GET <setup origin>/setup/reconnect?creator&return_to&state` beside the setup URL builder. Reconnect requires `creator` and upstream `/setup` rejects it, so reconnect always sends it. It runs in the same embedded iframe and `paykit-setup-callback` listener as setup. On completion the Shop re-reads the own configuration and closes the dialog only when the service now reports `ready`; otherwise it says Bitkit did not confirm a USDT address and offers Retry. The Shop never receives or displays the USDT address: it lives in Bitkit and paykit-server.

## Deploy order

The Shop that accepts `usdt` in its order projection must be deployed before the service's USDT flag is ever turned on: an older Shop rejects an unknown `payment_method` and breaks the order page.

## Checkout, status and refusals (W3)

### Checkout

USDT is its own picker option, never a merged "Bitcoin or USDT" entry. It appears at cart, drop and offer checkout only when all of these hold:

- the gate is on (`useUsdtPaymentsAvailable`), and a sandbox checkout never reads it;
- every seller's public config says `usdtAvailable: true` (a multi-seller cart offers only options all sellers offer);
- every total is `USD/2`. USDT is quoted at exact parity, so one cent is 10,000 millionths and nothing rounds. A Bitcoin-priced cart never offers it.

The bind sends `{ method: 'usdt' }`. Once USDT is chosen the summary shows "25.000000 USDT · USDT0 on Arbitrum One · pay with Bitkit" and "Pay with a Bitkit version that supports USDT.", and the indicative bitcoin estimate is hidden. There is no accept-by line and no pre-check of the buyer's wallet: a missing Paykit wallet is the existing refusal, read in USDT copy.

An unbound order's method picker (the status card) offers "Continue with USDT" under the same rules.

### Order status

Everything below renders whenever an order carries `payment_method: "usdt"`, whatever the flag says. It lives in `usdt-buyer-status.ts` as its own rail-keyed table; the Bitcoin tables are untouched and a USDT order that carries a Paykit request state is never read as a Bitcoin order.

| Phase                                                      | Buyer                                                                            | Seller                                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| awaiting                                                   | Waiting for your USDT payment                                                    | Waiting for the buyer's USDT payment                                                         |
| received (paid at inclusion, finality `pending` or absent) | USDT payment received. The seller ships once Arbitrum finalizes it.              | Payment received. Don't ship yet: Arbitrum hasn't finalized it. Shipping unlocks on its own. |
| final                                                      | USDT payment confirmed                                                           | Payment final. You can ship.                                                                 |
| re-checking (finality `reverted`)                          | Your payment is being re-checked on Arbitrum. You don't need to do anything yet. | The buyer's payment is being re-checked on Arbitrum. Don't ship.                             |

A paid order shows "$137.00, paid as 137.000000 USDT" and the network on the status card and in the receipt. A manual-review USDT payment reuses the existing review copy; an amount mismatch reads "The USDT amount does not match. The seller is reviewing it."

A Locks-verified (`locked`) receipt carries no payment method, so it is never labelled Bitcoin; after locks#75 the rail that paid it may be USDT and the Shop does not know which.

### The pinned service contract

`src/libs/commerce/usdt-settlement-contract.ts` holds everything the Shop assumes about the upcoming service status work (S3), so the real fields swap in at one file:

- `payment_finality` on the order projection: `pending | final | reverted`, tolerant (an unknown value reads as absent). Absent on a paid USDT order fails closed to "received, not final".
- The command refusal `error.reason === "payment_not_final"` on `fulfillment.ship`, `fulfillment.mark_ready` and `fulfillment.confirm_pickup`.

`src/test/fixtures/commerce/usdt-orders.ts` pins the wire shapes. They are hand-written from the plan until a real service build produces captured responses.

### Fulfilment gate

Until a USDT payment is `final`, Add tracking, the shipping label's "Mark shipped", Mark ready for pickup and the pickup handover are disabled, and the seller sees "Wait to ship: this USDT payment isn't final on Arbitrum yet. This usually takes a few minutes." A refusal from the service shows the same copy. Service-sealed digital orders release at inclusion and are never gated.

### Refusals

| Reason                                                                                | Copy                                                                                                                  |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `usdt_unavailable`                                                                    | USDT payments aren't available right now. Choose another payment method.                                              |
| `usdt_seller_not_ready`                                                               | This seller can't take USDT right now. Choose another payment method, or contact the seller.                          |
| `buyer_usdt_wallet_required` (reserved)                                               | Your wallet doesn't support USDT yet. Pay with a Bitkit version that supports USDT, or choose another payment method. |
| `buyer_paykit_wallet_required`, `paykit_*`, `seller_account_unclaimed` on a USDT bind | The existing Bitcoin string with "USDT" for "Bitcoin" (`USDT_PAYMENT_METHOD_REASON_MESSAGES`)                         |

A bind for `usdt` tags its refusal with `context.paymentMethod: "usdt"` so the toast picks the USDT string; a Bitcoin or PayPal refusal is unchanged. `buyer_usdt_wallet_required` is reserved until Paykit types it.

### Not in W3

- Notification copy: the closed notification types carry no asset, and the service has not named USDT types.
- A Locks pay-step hint "Bitcoin or USDT": it needs locks#75 deployed, and nothing signals that to the Shop yet.
- The seller manual-review resolution for a USDT payment, and the USDT refund address and hash (W4).
