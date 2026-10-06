import type { Metadata as NextMetadata } from 'next';
import { getMarketplaceDropRoute } from '@/app/routes';
import { MARKETPLACE_STATIC_SEO } from '@/libs/commerce/seo';
import { Metadata } from '@/molecules/Metadata/Metadata';
import { MarketplaceDrop } from '@/templates/Marketplace/MarketplaceDrop';

export interface MarketplaceDropPageProps {
  params: Promise<{
    sellerPubky: string;
    dropId: string;
  }>;
}

/**
 * Static marketplace metadata with the drop's canonical URL. Drop-specific
 * OG data would need a server-side record fetch helper (the listing page's
 * `ogCommerceData` equivalent) which does not exist for drops yet; static
 * copy never invents drop details.
 */
export async function generateMetadata({ params }: MarketplaceDropPageProps): Promise<NextMetadata> {
  const { sellerPubky, dropId } = await params;
  const canonical = getMarketplaceDropRoute(sellerPubky, dropId);
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
}

export default async function MarketplaceDropPage({ params }: MarketplaceDropPageProps) {
  const { sellerPubky, dropId } = await params;
  return <MarketplaceDrop sellerPubky={sellerPubky} dropId={dropId} />;
}
