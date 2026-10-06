# Marketplace Social Layer: Official vs. Community Metadata

Status: implemented on `marketplace/pr24-social`. Read [`status.md`](status.md) first for the overall real/simulated map.

## The design decision

Marketplace objects carry two distinct metadata layers, and the product deliberately keeps them separate instead of merging them into one tag cloud:

1. **The official layer — seller-declared attributes.** Category, condition, and keywords live inside the owner-signed listing record (`PubkyAppListing.tags`, `categoryId`, `condition`). Only the seller can write them, they are validated by the specs, and they are what the Nexus marketplace index filters on. In the UI they render under the "Seller's keywords" label on the listing page.

2. **The community layer — social tags.** Anyone on Pubky can tag a listing or a shop, exactly the way tagging works on posts and users today: the tag is a `PubkyAppTag` record written to the _tagger's_ homeserver, whose `uri` field points at the canonical listing/shop URI. The seller cannot edit or delete other people's tags; reputation and discovery signals accrue socially. In the UI these render under the "Community tags" label, with the same tag pills, taggers, and toggle interactions as post tags.

Keeping the layers visually and structurally separate means a buyer always knows whether a claim ("vintage", "trusted", "fast-shipping") is the seller's own marketing or the community's judgement.

## What was built, and what it reuses

- **Spec:** `pubky-app-specs` fork build `0.6.2-marketplace.2` (GitHub release tarball, branch `feat/marketplace-objects-0.6.x` at BitcoinErrorLog). Tag records could already target any valid URI — `.2` adds tests locking that in for listing/shop URIs, and extends Collection `items` validation to accept canonical marketplace listing URIs alongside post URIs.
- **Tag writes** reuse the entire existing tag stack: `TagController.commitCreate/commitDelete` → `TagNormalizer` (now builds listing/shop URIs via the specs' `listingUriBuilder`/`shopUriBuilder`) → `TagApplication` (local-first write with homeserver PUT/DELETE and compensation rollback). Marketplace targets get their own local table (`marketplace_tags`, folded into the unreleased Dexie version 3) via `LocalMarketplaceTagService`, which mirrors the post tag service minus the counts models marketplace targets don't have.
- **Tag reads** come from `useMarketplaceTags`: local cache first (viewer's own write-through renders immediately), then one fetch from the marketplace Nexus tag endpoints, merged with the same viewer-marker policy post tags use.
- **Collections** reuse the exact post flow: the same save picker body (`SavePickerContent`, extracted from `PostSavePicker`), the same `PostController.commitUpdateCollectionItem` (now with an `itemKind: 'listing'` that builds the canonical listing URI), and the same `commitCreateCollection`. The collection page renders listing items in a dedicated section with the catalog's `MarketplaceListingCard`, hydrated through the existing `getOrFetchListing` cache-first path. Bookmarks are deliberately NOT offered for listings — the bookmark flow is post-scoped and offering it would be a fake affordance.

## How reads degrade before Nexus aggregation is deployed

The tag aggregate endpoints (`GET v0/listing/{seller_id}/{listing_id}/tags`, `GET v0/shop/{seller_id}/tags`) landed on the marketplace Nexus (branch `feat/marketplace-indexing` of pubky-nexus) and are served by the deployed marketplace-indexing Nexus on Railway (see [`status.md`](status.md)). Against a Nexus that does not serve them (the official staging Nexus, or a target whose event replay has not reached the tag records yet):

- The endpoints answer **404**, which the client treats as "aggregation not available": it returns an empty aggregate and does NOT touch the local cache.
- The panel then shows exactly what is locally true — the viewer's own tags — and nothing else. No invented counts, no placeholder taggers.
- The moment the endpoints answer, aggregates from other users merge in without a client change.

## Social discovery surfaces (feed shelf + Hot modules)

Implemented on `marketplace/pr30-feeds`. This completes the "listings in general social feeds / Hot" follow-up below at the client-composition level — listings now appear ON the social surfaces as dedicated marketplace modules, but they are never injected into post streams, post data models, or Hot's tag/post ranking. Nexus-side feed/graph parity (listings ranked inside the actual post timeline) remains out of scope.

### What surfaces exist

- **Home feed — "From sellers you follow" shelf** (`MarketplaceFollowedSellersShelf`, between the composer and the post timeline). A horizontally scrollable strip of catalog cards (`MarketplaceListingCard`) showing recent active listings from sellers the viewer follows. It is content, not promo: there is no dismissal, no empty shell, and no skeleton — the shelf renders nothing unless a followed seller actually has active listings, and carries a "Marketplace" label plus a "See all" link to the catalog. Signed-in only, since it is defined by the viewer's follows.
- **Hot page — "Ending soon" and "Fresh listings" modules** (`MarketplaceHotSection`, above Trending posts; grouped with the Posts tab on mobile). "Ending soon" comes from the Nexus auction end-time stream (`sorting=ends_at&order=ascending`); "Fresh listings" from the indexing timeline, deduplicated against the ending-soon cards. Each module renders only when it has real cards. Public, like the rest of Hot — the listing stream is an unauthenticated read.
- **Cross-links.** Every card links to its listing page. Each module's "See all" opens the full catalog; the Hot modules pre-select the catalog's matching sort (`ending_soon` / `newest`) so the catalog opens on the ordering the module showed.
- **Gating.** Both surfaces are gated on the marketplace adapter mode exactly like the nav entry: `unavailable` (the production default) renders nothing and issues no reads. Sandbox mode keeps its seeded, Nexus-free catalog.

### Ranking honesty

Ordering is strictly what the client can know from the index: record-update recency (shelf, fresh listings) and auction deadlines (ending soon). There is deliberately no bid-count, popularity, or "trending" ranking for listings — bids live in the transaction service's projections, not in the Nexus listing index, and views are not tracked at all, so any such ordering would be fabricated. Auctions whose stale index rows predate the auction-term fields are excluded from "Ending soon" rather than ranked by a guessed end time, and no client-side clock decides whether an auction "already ended" — listing state comes from the index.

### Cost model

The Nexus listing stream accepts a single `seller_id` per request, so intersecting a follow graph with the index can never be one query. The composition (`CommerceApplication.fetchFollowedSellerCatalogListings`) bounds the cost instead of hiding it, in the same spirit as the auction card's viewport-lazy bid read (`useMarketplaceLiveBid`):

1. One slice of the viewer's Nexus-fed follow stream (capped at 30 most recent follows) — never a request per follow.
2. One shared global page of the newest active listings — the same read the catalog grid does; it refreshes the cache and cheaply discovers followed accounts that recently listed.
3. Per-seller refreshes only for follows already **known** to sell (a cached shop record or cached index entry), capped at 6 per refresh, `allSettled` so one unreachable seller cannot empty the shelf.

The Hot modules cost at most two stream requests (end-time order + timeline order) through the existing catalog-cache path. Everything renders from the Dexie catalog cache (`commerce_catalog_entries` — no new tables), so an unreachable Nexus degrades to cached listings, and an empty index (for example while the marketplace Nexus replays history) honestly renders nothing.

## Explicitly out of scope (honest follow-ups)

- **Listings ranked inside post streams / Hot tag ranking.** The surfaces above are dedicated client-composed modules; marketplace objects still do not appear in post streams or Hot's tag/post ranking itself. That feed/graph parity is Nexus-side work beyond tag aggregation.
- **Tag-based notifications.** Tagging a listing/shop notifies nobody today; the notification pipeline only watches post/user tags.
- **Shop-page collections shelf.** A "collections by this seller containing listings" shelf was skipped: there is no indexed read path for that query (the author-collections stream exists, but filtering it to collections containing listings would require client-side hydration of every envelope — a scan, not a read path). The profile's Collections tab already lists a user's collections honestly.
- **Add-by-URL for listings.** The collection page's "paste post url" affordance still accepts post URLs only.
- **Reordering listing items.** The drag-reorder grid renders listing cells and preserves them on save, but the sortable flow was designed for the post stream; listing items keep their envelope position semantics (unordered relative to posts until explicitly dragged).
