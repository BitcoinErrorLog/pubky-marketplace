# Address autocomplete

Address line 1 suggests addresses from OpenStreetMap data. It is offered wherever the shared `MarketplaceAddressFields` renders (checkout, the address book and the seller pickup editor) and only where the marketplace service is available. Manual entry always works.

## Provider

[Photon](https://github.com/komoot/photon), an OpenStreetMap geocoder built for search-as-you-type, reached through the marketplace service. The public Nominatim instance is not an option: its usage policy forbids autocomplete. The service calls the public Photon instance by default (`ADDRESS_SEARCH_UPSTREAM_URL`), which asks for reasonable use and gives no availability guarantee, so upstream traffic is capped and cached. A self-hosted Photon replaces it with one environment variable.

OpenStreetMap coverage is thinner than a commercial geocoder. Photon often knows the street but not the house number. A street-only match keeps the number the buyer typed, and the buyer confirms the result.

## Data flow

1. The buyer types in Address line 1. After 4 characters and a 300 ms pause, the browser sends `POST {marketplace}/v0/address/suggest` with `{ "q": "<line 1 text>", "country": "US" }`. No cookies, Referer or other form field is sent. Recent answers are remembered for the life of the form.
2. The service checks its per-client limit and its cache, then asks Photon. Photon sees the service's address and the query. It sees no buyer address, cookie, Referer or language header.
3. The service answers with up to five suggestions, each carrying the whole address (`line1`, `city`, `region`, `postal_code`, `country_code`). There is no second "details" request.
4. Picking a suggestion fills line 1, city, state and postal code. It never overwrites Address line 2 or the country. In countries with a closed state list (US, CA, AU) an unrecognised state name is left blank for the buyer to choose.
5. The finished address takes the existing `checkout.create` path unchanged.

## Privacy

The service sees the text typed into Address line 1 while the buyer types. The route is unauthenticated, so a query is never tied to a session. The query is in a POST body, is never logged or stored, and cache keys are salted hashes held in memory. Nothing is written to the database. The service README lists the limits and the kill switch.

## Rate limits and failure

The browser stays quiet for the service's `Retry-After` after a 429 or 503. The service limits each client, limits the upstream across all clients, shares one upstream call between identical concurrent queries, and opens a 60-second breaker when the upstream fails.

## Attribution

A caption under Address line 1, "Address suggestions © OpenStreetMap contributors", links to the [OpenStreetMap copyright page](https://www.openstreetmap.org/copyright). It is visible whenever suggestions are on, as the OpenStreetMap Foundation's attribution guideline requires for geocoders.

## Fallback

No service, no network, a rate limit or an upstream failure all mean no suggestions. The form behaves as before, and after a failed lookup a line under Address line 1 reads "Address suggestions are unavailable. Enter the address manually."

ZIP → city and state fill (GeoNames, CC-BY 4.0) runs on the device and is independent of suggestions. See [`checkout-address-design.md`](checkout-address-design.md).
