# Marketplace SEO & Link Previews

What every marketplace route emits for search engines and link unfurlers (Slack, X,
Telegram, WhatsApp, ...), and how to verify it.

## What is generated

| Route                                                                                                              | Metadata                                                                                                                                                                   | Preview image                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `/marketplace`                                                                                                     | Static marketplace title/description, canonical, indexable                                                                                                                 | Branded card (keyhole mark, "Pubky Marketplace", static tagline, host footer)                                            |
| `/marketplace/listing/[seller]/[listingId]`                                                                        | `generateMetadata` from the canonical listing record: `«title» — «price» \| Pubky Marketplace`, description from the record (clamped ~160 graphemes), canonical, indexable | Dynamic card: title, price (lime), condition badge, honest state badge for paused/ended, first photo as right-side inset |
| `/marketplace/shop/[seller]`                                                                                       | `generateMetadata` from the canonical `shop.json`: `«name» — Shop \| Pubky Marketplace`, bio-derived description (no bio → description suppressed, never invented)         | Dynamic card: avatar (brand-circle fallback), name, bio; banner as dark-scrimmed background when set                     |
| Auth-gated pages (orders, offers, messages, dashboard, my-shop, sell, cart, notifications, settings, listing edit) | Static generic copy via `gatedMarketplaceMetadata`, `noindex, nofollow`, zero user data                                                                                    | The `/marketplace` branded card, referenced explicitly (Next file-convention images do not cascade to nested routes)     |

Twitter cards are `summary_large_image` everywhere; the `twitter-image` routes re-serve
the same PNG as the `opengraph-image` routes.

### Truthfulness rules

- All listing/shop preview text comes verbatim (clamped) from the canonical record on
  the seller's homeserver — no invented copy.
- Auctions are labeled `Auction from «starting price»` rather than pretending a fixed price.
- Paused/ended listings still render but carry an explicit state notice in the
  description and a badge on the card. `removed` listings are never previewed —
  they fall back to the generic marketplace card.
- **Adult-only listings never expose a photo** in the public preview; the branded
  text-only card renders instead (`resolveListingOgCoverUri`).

### Fallback ladder

1. Record fetch fails / missing / fails schema validation / `removed` → generic
   marketplace metadata + branded marketplace card (`renderMarketplaceOg`).
2. Cover/avatar/banner photo fetch fails → same card without that asset.
3. The satori render pipeline itself throws → 307 redirect to the static
   `/preview.webp` brand asset (`renderFallbackOg`).

## Where the code lives

- Pure builders (titles, descriptions, truncation, photo suppression):
  `src/libs/commerce/seo.ts` (+ unit tests in `seo.test.ts`).
- Server record fetchers: `src/libs/og/ogCommerceData.ts` — reads
  `/pub/pubky.app/marketplace/v1/...?pubky-host=<seller>` from the deployment's
  configured homeserver, validates with the strict record schemas (serialized
  nulls stripped).
- Card renderers: `src/libs/og/renderListingOg.tsx`, `renderShopOg.tsx`,
  `renderMarketplaceOg.tsx` (shared satori/`ImageResponse` pipeline, Inter Tight,
  design tokens from `ogConstants.ts`).

## Cache policy

- Record and media fetches: Next Data Cache with `revalidate: 300` (5 min,
  `OG_COMMERCE_REVALIDATE`) — fresh enough that state changes (paused/ended,
  price) propagate quickly without hammering homeservers on crawler bursts.
- Image route segments: `revalidate = 300` (literal, kept in sync).
- Rendered PNGs: `Cache-Control: public, max-age=300, s-maxage=300,
stale-while-revalidate=86400` (`OG_COMMERCE_CACHE_HEADERS`).
- Social/post/profile OG routes keep their existing 1-hour policy.

Platforms additionally cache unfurls on their side (often 24h+); after content
changes, re-scrape with the platform debugger (below).

## How to test

Local:

```bash
# Head tags
curl -s "http://localhost:3000/marketplace/listing/<seller>/<listingId>" | grep -o '<meta[^>]*og:[^>]*>'
# Rendered card
curl -s "http://localhost:3000/marketplace/listing/<seller>/<listingId>/opengraph-image" -o card.png
```

Against the live deploy, use the platform debuggers (these also bust their caches):

- Facebook/Meta: https://developers.facebook.com/tools/debug/
- LinkedIn: https://www.linkedin.com/post-inspector/
- X/Twitter: card validator inside the post composer preview
- Slack/Telegram: paste the URL in a private channel; Telegram supports
  `@WebpageBot` to force a re-scrape.

Note: platform-specific unfurl quirks (e.g. Slack's preference order, WhatsApp's
image size limits) can only be fully verified against the live deployment.
