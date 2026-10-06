import { gatedMarketplaceMetadata } from '@/app/marketplace/gated-metadata';
import { getMarketplaceListingEditRoute } from '@/app/routes';
import { MarketplaceEditListing } from '@/templates/Marketplace/MarketplaceEditListing';

export interface MarketplaceEditListingPageProps {
  params: Promise<{
    sellerPubky: string;
    listingId: string;
  }>;
}

// Seller-only editor: static generic copy (no record fetch — nothing about the
// listing belongs in this page's preview) and noindex.
export async function generateMetadata({ params }: MarketplaceEditListingPageProps) {
  const { sellerPubky, listingId } = await params;
  return gatedMarketplaceMetadata(
    'Edit listing | Pubky Marketplace',
    'Edit your Pubky Marketplace listing.',
    getMarketplaceListingEditRoute(sellerPubky, listingId),
  );
}

export default async function MarketplaceEditListingPage({ params }: MarketplaceEditListingPageProps) {
  const { sellerPubky, listingId } = await params;
  return <MarketplaceEditListing sellerPubky={sellerPubky} listingId={listingId} />;
}
