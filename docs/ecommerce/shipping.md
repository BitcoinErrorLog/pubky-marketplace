# Shipping Tooling: Address Book, Presets, Tracking, Packing Slips

Post-purchase logistics for the marketplace: where each piece of shipping
data lives, who can read it, and what is deliberately not built. Read
[`status.md`](status.md) first for the general real-vs-simulated map.

Last updated: 2026-09-06.

## Where shipping data lives

| Data                         | Lives                                                                      | Who can read it                                                                                                                                                                                                                        |
| ---------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Buyer address book           | Account-scoped IndexedDB (`commerce_delivery_addresses`), this device only | Only this browser profile. Never on the homeserver, never in any public record, never in telemetry.                                                                                                                                    |
| Delivery address of an order | The transaction service's `orders.delivery_address` column                 | The bound seller may read it only from the seller's single-order projection while the order is `paid`/`processing` and `shipping`; all other projections withhold it. Encryption to the seller key is scheduled (ADR-0019 §8 interim). |
| Seller shipping presets      | Account-scoped IndexedDB (`commerce_shipping_presets`), this device only   | Only this browser profile. Presets are authoring convenience; nothing about them is published.                                                                                                                                         |
| Listing shipping option      | The owner-signed listing record (`shippingOptions`, one flat-rate entry)   | Public, like the rest of the listing record. The sell studio now authors its label, price, and min/max day estimates (previously label and days were fixed copy).                                                                      |
| Shipment carrier + tracking  | The transaction service's order `shipment` object                          | Both order participants, via their scoped order reads. `carrier` and `tracking_number` are structured fields in the existing ship command contract.                                                                                    |

## The delivery-address privacy boundary (exact)

This is load-bearing and verified against the service source
(`pubky-marketplace-service`):

1. The buyer's address travels **exactly once**: inside the buyer's own
   `checkout.create` command payload (`payload.delivery_address`, validated
   field-by-field: name 1–100, line1 1–200, line2 0–200, city 1–100, region
   1–100, postal code 1–32, ISO 3166-1 alpha-2 country).
2. The service stores it on the order row. Fresh checkout command results and
   exact replays redact it before returning to the command's author.
3. Ordinary read projections strip it: order lists, buyer reads, receipts,
   notifications, and all command results never carry it. The bound seller's
   single-order read is the narrow interim exception: it carries a tagged
   `plaintext_v1` value only while the order is `paid`/`processing` and
   `shipping`; unknown or untagged formats are unavailable. Encryption to the
   seller key is scheduled (ADR-0019 §8 interim).
4. Consequently **the seller's client only legitimately holds the buyer's
   address during that narrow seller order window**, and this client does not
   invent any other read path.

What that means for the tooling here:

- The **address book** is buyer-side only and purely device-local. The
  checkout picker fills the same form checkout always had; the address still
  goes only into the buyer's own command.
- The **packing slip** renders the tagged service-provided address when the
  seller's paid/processing shipping order projection carries `plaintext_v1`.
  If it is absent or unsupported, it says "Delivery address unavailable for
  this order — paste it below." and keeps the optional local paste field.
- The slip (and the order rows) now show the buyer's **variant snapshot**
  when the checkout carried one: `checkout.create` lines accept an optional
  `variant_id` plus up to three `{name, value}` option pairs (an ordered
  array, safe through the wire-casing layer), which both engines echo
  verbatim onto the order line. It is a buyer-supplied display snapshot —
  listing registration carries no variant inventory, so the service
  validates its shape, not its truth against the owner-signed listing
  content; like `quantity`, the seller sees the claim and fulfills or
  refuses it. Orders placed before the field existed simply have no
  variant line.

## Structured carrier tracking

The service's `fulfillment.ship` command already takes structured fields —
`carrier` (trimmed free string, 1–100 chars) and `tracking_number` — and
stores them in the participant-visible `shipment` object. **No contract
change was needed and none was made**; wire casing stays snake_case per
ADR-0019 §3 via the existing wire-casing layer. The service now additionally
rejects control characters in both fields (a charset floor, not a vocabulary
lock — international carrier names stay valid) and documents this client's
canonical carrier names as its soft vocabulary on `ShipOrderPayload.carrier`,
deliberately without an enum so foreign clients can ship other carriers.

Encoding decision: the ship dialog offers a curated carrier select, and the
client writes the selected carrier's **canonical display name** (e.g.
`Royal Mail`) into the existing `carrier` field. "Other" passes the seller's
free-text carrier name through verbatim. On read, the client resolves the
stored string back against the registry (case-insensitive, plus known
aliases like "Hermes" → Evri); resolution failure renders the carrier as
plain text with **no** tracking link — an unknown carrier never produces a
dead or wrong URL, and neither does a tracking number that does not look
like a real reference.

Curated registry (`src/libs/commerce/carriers.ts`), each with a public
tracking URL template: USPS, UPS, FedEx, DHL, Royal Mail, DPD, Evri
(Hermes), PostNL, Correos, La Poste, An Post, Deutsche Post, plus "Other"
(no template). Every template is unit-tested
(`src/libs/commerce/carriers.test.ts`).

The buyer's order timeline renders "Track package" linking to the carrier's
public tracking page when — and only when — the stored carrier resolves and
the tracking number is linkable. Existing orders shipped before the select
existed (arbitrary free-text carriers) keep rendering as plain text.

## Seller shipping presets

Sellers previously re-entered the flat shipping price per listing while the
option's label ("Seller shipping") and 3–7 day estimate were fixed copy. The
sell studio now authors all four fields (label, flat price, min/max days),
and presets template them:

- **Save as preset** in the sell studio's shipping section stores the current
  four fields; **Apply a saved preset** fills them while composing or
  editing.
- Presets are managed at `/marketplace/settings/shipping` (linked from My
  shop).
- The published record shape is **unchanged**: one flat-rate
  `shippingOptions` entry either way. A preset is never published, referenced,
  or synced.

## Buyer address book

- Saved/labeled addresses at `/marketplace/settings/addresses` and inline
  from checkout ("Save this address on this device for next time" + label).
- The checkout picker orders addresses default-first, then by most recent
  use; the top address pre-fills the form once (never over typed input), and
  editing a picked address turns the entry back into a new one.
- Validation follows the per-country table in [`postal-address.ts`](../../src/libs/commerce/postal-address.ts): region is required only where carriers need a subdivision (US/CA/AU/BR/IN/MX and similar), labelled State/Province/Region accordingly, with a type-to-filter list for US/CA/AU. US ZIP fills City + State on-device. Address line 1 suggests addresses from OpenStreetMap data through the marketplace service; see [`checkout-address-design.md`](checkout-address-design.md) and [`address-autocomplete-design.md`](address-autocomplete-design.md). A saved address is always submittable.
- The first saved address becomes the default; the default is exclusive and
  changeable from the settings surface.

## Packing slip

From a seller's view: a print-friendly slip (browser `@media print` CSS
keyed on `data-packing-slip` in `globals.css` — no PDF dependency) with the
order id, order date, line items and quantities, totals, the buyer's short
pubky, shipment facts once tracking exists, and a notes area. A paid or
processing shipping order can show the tagged service-provided destination.
Shipped, unsupported, absent, and non-shipping orders show the truthful
no-address notice and retain ruled space plus the local paste fallback.
Line items include the buyer's variant snapshot when the checkout carried one
(see "Where shipping data lives" above); orders placed before the field
existed have no variant line, and the slip shows exactly what the order record
holds.

### Optional pasted-address field

Sellers who already have the destination from the buyer (for example the
encrypted conversation) can paste it into the packing-slip dialog so it
prints in the "Deliver to" block instead of being copied by hand.

Guarantees:

- The value lives in **component state of that dialog instance only**. It is
  not written to Dexie, localStorage, sessionStorage, cookies, or the URL.
- It is **cleared** when the dialog closes, when the route changes, and when
  a print job completes (`afterprint`, when the browser fires it). Residue
  after an unreliable print event is still only in-memory React state.
- It is **never sent** to the marketplace, the transaction service, or any
  other server by this client.
- Sentry Replay is instructed not to capture it: the textarea carries
  `data-sentry-mask`, and client Replay is configured with `maskAllText` and
  `maskAllInputs`.
- It is **never logged**.
- **Print-output caveat:** using Print, including print-to-PDF or a network
  printer, puts the pasted text into that output. The file or print job is
  outside the app; delete it when you are done if you do not want a copy.

## Follow-ups (deliberately not built)

- **Encrypted seller-facing address delivery.** The interim
  `plaintext_v1` seller projection is deliberately bounded; encryption to the
  seller key remains a separate program and is not implemented here.
- **Service-side shipment enrichment** (shipped-at estimates, delivery-day
  windows, carrier enum server-side). The `carrier` field staying a free
  string is the service's contract; a server-side curated enum would be a
  service change, not a client one.
- **Label purchase / carrier APIs.** Buying postage, rate quotes, and live
  tracking status require carrier accounts and server-side credentials —
  out of scope for a client-only change and gated on the independent
  security review like everything real-funds-adjacent.
- **Multiple shipping options per listing.** The record supports up to 20;
  the sell studio still authors exactly one flat-rate option. Presets make
  the single option cheap to reuse; a multi-option composer is future work.
