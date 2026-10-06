import type { Metadata as NextMetadata } from 'next';
import { getMarketplaceListingRoute } from '@/app/routes';
import { buildListingDescription, buildListingTitle, MARKETPLACE_STATIC_SEO } from '@/libs/commerce/seo';
import { fetchListingForMetadata } from '@/libs/og/ogCommerceData';
import { Metadata } from '@/molecules/Metadata/Metadata';
import { MarketplaceListing } from '@/templates/Marketplace/MarketplaceListing';

// Metadata reads the seller's listing record on every request; a prerendered page would pin a stale copy.
export const dynamic = 'force-dynamic';

export interface MarketplaceListingPageProps {
  params: Promise<{
    sellerPubky: string;
    listingId: string;
  }>;
}

/**
 * Dynamic metadata for a listing page, built strictly from the canonical
 * listing record on the seller's homeserver (deduped by the Data Cache with
 * the `opengraph-image` route). The preview image comes from the dynamic
 * `opengraph-image` / `twitter-image` file convention, so static images are
 * omitted (`omitImages`). A missing/removed/unparseable record falls back to
 * the static marketplace copy (never inventing listing details), keeping the
 * canonical URL.
 */
export async function generateMetadata({ params }: MarketplaceListingPageProps): Promise<NextMetadata> {
  const { sellerPubky, listingId } = await params;
  const canonical = getMarketplaceListingRoute(sellerPubky, listingId);

  const fallback = () => {
    const { openGraph, twitter, alternates } = Metadata({
      title: MARKETPLACE_STATIC_SEO.title,
      description: MARKETPLACE_STATIC_SEO.description,
      url: canonical,
      omitImages: true,
    });
    return {
      title: MARKETPLACE_STATIC_SEO.title,
      description: MARKETPLACE_STATIC_SEO.description,
      openGraph,
      twitter,
      alternates,
    };
  };

  const result = await fetchListingForMetadata(sellerPubky, listingId);
  if (result.kind !== 'found') return fallback();

  const title = buildListingTitle(result.record);
  const description = buildListingDescription(result.record);
  const { openGraph, twitter, alternates } = Metadata({ title, description, url: canonical, omitImages: true });

  return { title, description, openGraph, twitter, alternates };
}

export default async function MarketplaceListingPage({ params }: MarketplaceListingPageProps) {
  const { sellerPubky, listingId } = await params;
  return <MarketplaceListing sellerPubky={sellerPubky} listingId={listingId} />;
}
