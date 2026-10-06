import { truncateByGraphemes } from '@/libs/utils/truncate';
import { listingDisplayState } from './auction-phase';
import { formatCommerceCondition, formatCommerceMoney } from './format';
import type { CommerceListingRecord, CommerceShopRecord } from './marketplace-records';

/**
 * Pure builders for marketplace SEO metadata (titles, descriptions, OG image
 * inputs). Everything here derives strictly from the canonical record — no
 * invented copy — so link previews always state what the listing/shop record
 * actually says. Server routes (`generateMetadata`, `opengraph-image`) and the
 * OG renderers share these so the HTML tags and the rendered card can't drift.
 */

/** Grapheme cap for meta descriptions (~160 chars is the SERP/unfurl sweet spot). */
export const SEO_DESCRIPTION_MAX_GRAPHEMES = 160;

const MARKETPLACE_SITE_LABEL = 'Pubky Marketplace';

/**
 * Honest price label for a listing: the fixed price, or the auction's starting
 * price explicitly labeled as such (an auction has no single "price").
 */
export function listingPriceLabel(listing: CommerceListingRecord): string {
  if (listing.sale.format === 'fixed_price') {
    return formatCommerceMoney(listing.sale.unitPrice);
  }
  return `Auction from ${formatCommerceMoney(listing.sale.startingPrice)}`;
}

/**
 * Human notice for non-active listing states, or `null` for active listings.
 * An auction past its end time reads as ended even when the record still
 * says `active`.
 * `removed` never reaches the builders (the data layer refuses to preview
 * removed listings), but it maps honestly anyway rather than throwing.
 */
export function listingStateNotice(listing: CommerceListingRecord, nowMs: number = Date.now()): string | null {
  switch (listingDisplayState(listing.state, listing.sale, nowMs)) {
    case 'active':
      return null;
    case 'paused':
      return 'Listing paused';
    case 'ended':
      return 'Listing ended';
    case 'removed':
      return 'Listing removed';
  }
}

/** `«title» — «price» | Pubky Marketplace` (title/price straight from the record). */
export function buildListingTitle(listing: CommerceListingRecord): string {
  return `${listing.title} — ${listingPriceLabel(listing)} | ${MARKETPLACE_SITE_LABEL}`;
}

/**
 * Meta description: the record's own description clamped to ~160 graphemes,
 * prefixed with the state notice for paused/ended listings so a stale unfurl
 * never implies the item is still purchasable.
 */
export function buildListingDescription(listing: CommerceListingRecord): string {
  const notice = listingStateNotice(listing);
  if (!notice) return truncateByGraphemes(listing.description, SEO_DESCRIPTION_MAX_GRAPHEMES);
  const prefix = `${notice}. `;
  return `${prefix}${truncateByGraphemes(listing.description, SEO_DESCRIPTION_MAX_GRAPHEMES - prefix.length)}`;
}

/**
 * The `pubky://` URI of the cover photo to embed in the listing's OG card, or
 * `null` when no photo may be shown. Adult-only listings NEVER expose a photo
 * in the public preview — the branded card renders without it.
 */
export function resolveListingOgCoverUri(listing: CommerceListingRecord): string | null {
  if (listing.adultOnly) return null;
  return listing.media.find((media) => media.type === 'image')?.url ?? null;
}

/** Condition label for the OG card badge (e.g. `like_new` → `Like New`). */
export function listingConditionLabel(listing: CommerceListingRecord): string {
  return formatCommerceCondition(listing.condition);
}

/** `«shop name» — Shop | Pubky Marketplace`. */
export function buildShopTitle(shop: CommerceShopRecord): string {
  return `${shop.name} — Shop | ${MARKETPLACE_SITE_LABEL}`;
}

/**
 * Meta description derived from the shop's bio, clamped to ~160 graphemes.
 * Empty when the shop has no bio — callers emit `null` (suppressing the
 * inherited generic app description) rather than inventing copy.
 */
export function buildShopDescription(shop: CommerceShopRecord): string {
  return truncateByGraphemes(shop.bio, SEO_DESCRIPTION_MAX_GRAPHEMES);
}

/**
 * Static copy for the marketplace home page and for listing/shop routes whose
 * record could not be fetched. Every claim maps to a shipped protocol feature:
 * listings/shops are records signed into the seller's own homeserver
 * (`marketplace-records.ts`), auctions are a supported sale format
 * (`commerceSaleSchema`), and buyer–seller messaging is end-to-end encrypted
 * (`messaging-contracts.ts`).
 */
export const MARKETPLACE_STATIC_SEO = {
  title: 'Pubky Marketplace',
  description:
    'Buy and sell on Pubky: listings and shops published to seller-owned homeservers, fixed prices and auctions, with encrypted buyer-seller messaging.',
} as const;
