import { effectiveListingState } from '@/libs/commerce/auction-phase';
import { commerceListingFulfillmentMethods } from '@/libs/commerce/marketplace-records';
import type { MarketplaceFulfillmentMethod } from '@/libs/commerce/pickup';
import type { CommerceMoney } from '@/libs/commerce/transaction-contracts';
import type {
  CommerceCatalogAuctionTerms,
  CommerceCatalogEntryModelSchema,
  CommerceListingModelSchema,
  CommerceReputationSnippet,
} from '@/models/commerce/commerce.schema';
import type { CommerceConditionFilter, CommerceSaleFormatFilter, CommerceSort } from '@/stores/commerce/commerce.types';

/**
 * Everything a catalog card renders, buildable from either source the
 * local-first catalog holds:
 *
 * - a cached canonical record (`commerce_listings`) — hydrated because the
 *   listing was opened, published by this user, or seeded by the sandbox
 * - a Nexus index projection (`commerce_catalog_entries`) — discovery data
 *   that never required contacting the seller's homeserver
 *
 * `auction` is `null` for fixed-price items and for auction items whose
 * index row predates Nexus carrying auction terms; for auctions, `price` is
 * the seller's starting price (the record's primary price), never a claim
 * about the current bid — live bid state is not available to the grid at all.
 */
export interface MarketplaceCatalogItem {
  id: string;
  sellerId: string;
  listingId: string;
  state: CommerceListingModelSchema['state'];
  title: string;
  description: string;
  categoryId: string;
  condition: CommerceListingModelSchema['record']['condition'];
  tags: string[];
  saleFormat: CommerceListingModelSchema['format'];
  price: CommerceMoney;
  auction: CommerceCatalogAuctionTerms | null;
  /**
   * Item specifics from the cached canonical record: `{}` when the record is
   * known to carry none, `null` when unknown — Nexus index projections do
   * not carry attributes (index-side attribute indexing is a follow-up), so
   * items rendered from a projection honestly report "unknown" rather than
   * "none".
   */
  attributes: Record<string, string | string[]> | null;
  location: { countryCode: string; region: string | null };
  /**
   * The fulfillment methods the listing publishes (local pickup design §A1),
   * derived exactly as the service derives them. `null` (or absent) when the
   * source does not carry the vocabulary (index rows cached before it was
   * kept), so the card renders no badge rather than guessing.
   */
  fulfillmentMethods?: MarketplaceFulfillmentMethod[] | null;
  /**
   * Media URIs for the card image, in display order: the record's image media
   * (videos excluded — a card cover is an image) or the index projection's
   * `media_urls`. Resolve with `resolveMarketplaceMediaUrl`; empty when the
   * source carried none, which keeps the gradient fallback.
   */
  mediaUrls: string[];
  /**
   * Seller-scoped reputation from the Nexus stream projection (buyer
   * reviews across all the seller's listings). Only index entries carry it:
   * a card built from a cached canonical record inherits the entry's value
   * in {@link buildMarketplaceCatalogItems}, and `null` renders nothing —
   * honest absence, never 0.0. Display only; never a ranking input
   * (ratified D4).
   */
  reputation: CommerceReputationSnippet | null;
  revision: number;
  updatedAt: number;
}

export interface MarketplaceCatalogFilters {
  query: string;
  categoryId: string | null;
  saleFormat: CommerceSaleFormatFilter;
  conditions: CommerceConditionFilter[];
  minimumPriceMinor: number | null;
  maximumPriceMinor: number | null;
  /** Seller-declared item location: ISO-3166-1 alpha-2, null = anywhere. */
  countryCode: string | null;
  sort: CommerceSort;
}

export function catalogItemFromListingModel(listing: CommerceListingModelSchema): MarketplaceCatalogItem {
  const record = listing.record;
  const auction: CommerceCatalogAuctionTerms | null =
    record.sale.format === 'auction'
      ? {
          startsAt: record.sale.startsAt,
          endsAt: record.sale.endsAt,
          buyNowPrice: record.sale.buyNowPrice ?? null,
          minimumIncrement: record.sale.minimumIncrement,
        }
      : null;
  return {
    id: listing.id,
    sellerId: listing.seller_id,
    listingId: listing.listing_id,
    state: listing.state,
    title: record.title,
    description: record.description,
    categoryId: record.categoryId,
    condition: record.condition,
    tags: record.tags,
    saleFormat: record.sale.format,
    price: record.sale.format === 'fixed_price' ? record.sale.unitPrice : record.sale.startingPrice,
    auction,
    attributes: record.attributes ?? {},
    location: { countryCode: record.location.countryCode, region: record.location.region ?? null },
    fulfillmentMethods: commerceListingFulfillmentMethods(record.fulfillmentMethods, record.digitalLock !== undefined),
    mediaUrls: record.media.filter(({ type }) => type === 'image').map(({ url }) => url),
    // Canonical records carry no aggregate; the catalog merge fills this in
    // from the index entry when one exists for the same listing.
    reputation: null,
    revision: listing.revision,
    updatedAt: listing.updated_at,
  };
}

export function catalogItemFromCatalogEntry(entry: CommerceCatalogEntryModelSchema): MarketplaceCatalogItem {
  return {
    id: entry.id,
    sellerId: entry.seller_id,
    listingId: entry.listing_id,
    state: entry.state,
    title: entry.title,
    description: entry.description,
    categoryId: entry.category_id,
    condition: entry.condition,
    tags: entry.tags,
    saleFormat: entry.sale_format,
    price: entry.price,
    auction: entry.auction,
    attributes: null,
    location: { countryCode: entry.country_code, region: entry.region },
    // Index rows carry no lock indicator, so a Locks listing badges as digital
    // here; the badge is display-only and checkout reads the record.
    fulfillmentMethods: entry.fulfillment_methods ? commerceListingFulfillmentMethods(entry.fulfillment_methods) : null,
    // Nullish fallback: entries cached before the model carried media_urls.
    mediaUrls: entry.media_urls ?? [],
    // Nullish fallback: entries cached before the model carried reputation.
    reputation: entry.reputation ?? null,
    revision: entry.revision,
    updatedAt: entry.updated_at,
  };
}

/**
 * Unions the two catalog sources into one card list. When both hold the same
 * listing, the cached canonical record wins unless the index has seen a newer
 * revision — then the index projection renders (fresher discovery data) and
 * the newer record is only fetched if the listing is opened (ADR-0020).
 */
export function buildMarketplaceCatalogItems(
  listings: CommerceListingModelSchema[],
  entries: CommerceCatalogEntryModelSchema[],
): MarketplaceCatalogItem[] {
  const items = new Map<string, MarketplaceCatalogItem>();
  for (const listing of listings) {
    items.set(listing.id, catalogItemFromListingModel(listing));
  }
  for (const entry of entries) {
    const cached = items.get(entry.id);
    if (!cached || entry.revision > cached.revision) {
      items.set(entry.id, catalogItemFromCatalogEntry(entry));
    } else {
      // The cached canonical record wins the card content, but reputation
      // only exists in the index projection — carry it over so a hydrated
      // listing does not lose its stars.
      items.set(entry.id, { ...cached, reputation: entry.reputation ?? null });
    }
  }
  return [...items.values()];
}

/**
 * The state a card is shown in at `nowMs`. Cached index rows and canonical
 * records keep `active` after an auction closes, so an auction whose end time
 * has been reached reads as `ended` here, whatever the source held.
 */
export function catalogItemState(
  item: MarketplaceCatalogItem,
  nowMs: number = Date.now(),
): MarketplaceCatalogItem['state'] {
  return effectiveListingState(item.state, item.auction?.endsAt, nowMs);
}

/** True for listings a buyer can act on at `nowMs`: active, and no closed auction. */
export function isCatalogItemOpen(item: MarketplaceCatalogItem, nowMs: number = Date.now()): boolean {
  return catalogItemState(item, nowMs) === 'active';
}

export function filterMarketplaceCatalog(
  items: MarketplaceCatalogItem[],
  filters: MarketplaceCatalogFilters,
  nowMs: number = Date.now(),
): MarketplaceCatalogItem[] {
  const query = filters.query.trim().toLocaleLowerCase('en-US');
  const filtered = items.filter((item) => {
    const searchable = [item.title, item.description, ...item.tags].join(' ').toLocaleLowerCase('en-US');
    return (
      isCatalogItemOpen(item, nowMs) &&
      (query === '' || searchable.includes(query)) &&
      (filters.categoryId === null ||
        item.categoryId === filters.categoryId ||
        item.categoryId.startsWith(`${filters.categoryId}-`)) &&
      (filters.saleFormat === 'all' || (filters.saleFormat !== 'drops' && item.saleFormat === filters.saleFormat)) &&
      (filters.conditions.length === 0 || filters.conditions.includes(item.condition)) &&
      (filters.minimumPriceMinor === null || item.price.amountMinor >= filters.minimumPriceMinor) &&
      (filters.maximumPriceMinor === null || item.price.amountMinor <= filters.maximumPriceMinor) &&
      (filters.countryCode === null || item.location.countryCode === filters.countryCode)
    );
  });

  return filtered.sort((left, right) => {
    switch (filters.sort) {
      case 'newest':
        return right.updatedAt - left.updatedAt;
      case 'price_low':
        return left.price.amountMinor - right.price.amountMinor;
      case 'price_high':
        return right.price.amountMinor - left.price.amountMinor;
      case 'ending_soon':
        return auctionEnd(left) - auctionEnd(right);
      case 'recommended':
        return recommendationScore(right) - recommendationScore(left);
    }
  });
}

/**
 * Applies attribute facet filters over items with KNOWN attributes: an item
 * matches when every active key has the filtered value (string equality or
 * list membership). Items whose attributes are unknown (`null` — rendered
 * from an index projection that does not carry attributes) are excluded
 * while any attribute filter is active; the filters UI says so.
 */
export function applyMarketplaceAttributeFilters(
  items: MarketplaceCatalogItem[],
  attributeFilters: Record<string, string>,
): MarketplaceCatalogItem[] {
  const activeFilters = Object.entries(attributeFilters);
  if (activeFilters.length === 0) return items;
  return items.filter(
    (item) =>
      item.attributes !== null &&
      activeFilters.every(([key, filterValue]) => {
        const value = item.attributes?.[key];
        return Array.isArray(value) ? value.includes(filterValue) : value === filterValue;
      }),
  );
}

/**
 * Facet values (with counts, descending) for the given attribute keys over
 * the items whose attributes are known.
 */
export function collectMarketplaceAttributeFacets(
  items: MarketplaceCatalogItem[],
  keys: string[],
): Map<string, Array<{ value: string; count: number }>> {
  const facets = new Map<string, Map<string, number>>(keys.map((key) => [key, new Map()]));
  for (const item of items) {
    if (item.attributes === null) continue;
    for (const key of keys) {
      const value = item.attributes[key];
      if (value === undefined) continue;
      const counts = facets.get(key)!;
      for (const entry of Array.isArray(value) ? value : [value]) {
        counts.set(entry, (counts.get(entry) ?? 0) + 1);
      }
    }
  }
  return new Map(
    [...facets].map(([key, counts]) => [
      key,
      [...counts]
        .map(([value, count]) => ({ value, count }))
        .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value)),
    ]),
  );
}

// Auctions with known terms sort by end time; auctions whose stale index row
// lacks terms could end at any moment, so they sort after known auctions but
// before fixed-price listings rather than being interleaved by a guess.
function auctionEnd(item: MarketplaceCatalogItem): number {
  if (item.saleFormat !== 'auction') return Number.MAX_SAFE_INTEGER;
  return item.auction ? Date.parse(item.auction.endsAt) : Number.MAX_SAFE_INTEGER - 1;
}

function recommendationScore(item: MarketplaceCatalogItem): number {
  const auctionBoost = item.saleFormat === 'auction' ? 10_000 : 0;
  const conditionBoost = item.condition === 'new' || item.condition === 'excellent' ? 5_000 : 0;
  return item.updatedAt + auctionBoost + conditionBoost;
}
