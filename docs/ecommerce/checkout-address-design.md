# Checkout delivery address

A US buyer types City / Region / Postal code / Country. Region is required only where the postal system needs a subdivision. US and CA use a searchable closed list. US ZIP fills City and State on the device. Street autocomplete stays off until John puts a restricted Places key in runtime config.

## Why Region was required

Checkout, the address book, pickup, and `checkout.create` / `offer.checkout` copied the durable service rule: `delivery_address.region` is `validate_trimmed` min 1, max 100, for every country (`crates/domain/src/commands.rs` `validate_delivery_address`). That is Shop's contract, not a universal carrier rule.

Ship-from already allows an empty region (shipping-contract drift). USPS still needs a state for a US label (New Bedford, MA 02740). GB, DE, NL, FR, JP do not. The live failure was a free-text **Region** field that was always required, including on the default US checkout.

Region is required only for countries whose postal system uses a subdivision (US, CA, AU, BR, IN, MX, and a short free-text set). The label follows the country: **State** (US/AU/MX/BR/IN), **Province** (CA), **Prefecture** (JP), **Region** otherwise. Closed lists store ISO 3166-2 suffixes (`NY`, `ON`), not `US-NY`.

The Shop command schema now matches that table. The live Rust service still rejects an empty `region` on every country until a service change; sandbox checkout uses the Shop command schema, so GB-without-region works there. Default country is US, which still requires State.

## Subdivision lists

| Country        | Control                                                             | Stored value            |
| -------------- | ------------------------------------------------------------------- | ----------------------- |
| US             | Searchable combobox: 50 states + DC + AS, GU, MP, PR, VI + AA/AE/AP | ISO suffix (`MA`)       |
| CA             | Searchable combobox: 10 provinces + 3 territories                   | ISO suffix (`ON`)       |
| AU             | Searchable combobox: 6 states + 2 territories                       | ISO suffix (`NSW`)      |
| Other required | Free text                                                           | Trimmed string, max 100 |
| Other optional | Free text, not required                                             | Empty string allowed    |

## Address autocomplete

Street suggest-as-you-type always sends the prefix to a geocoder. Delivery addresses are sensitive (W10.5 sealed path + shipping contract), so the browser never contacts a geocoder directly.

| Provider                    | Fit                                                 | What leaves the device                                                                               |
| --------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| OpenStreetMap via Photon    | Free, autocomplete allowed, weaker rooftop coverage | The typed Address line 1 and country go to the marketplace service, which forwards only the query    |
| Smarty / USPS-backed        | Excellent US delivery points                        | Auth-id/token is server-shaped: a Shop BFF would see the finished address, a second plaintext holder |
| Privacy-preserving ZIP fill | ZIP → city + state; postal-shape checks per country | Nothing. Bundled GeoNames US ZIPs (CC-BY 4.0) + USPS ZIP3 prefixes                                   |

**Decision:** ZIP → City + State and per-country format validation run on the device. Address line 1 type-ahead uses OpenStreetMap data through the marketplace service's proxy; see [`address-autocomplete-design.md`](address-autocomplete-design.md). Manual entry always works.

GeoNames US postal file: https://download.geonames.org/export/zip/US.zip, Creative Commons Attribution 4.0.
