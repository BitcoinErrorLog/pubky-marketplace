import { OG_CONTENT_TYPE, OG_SIZE } from '@/libs/og/ogConstants';
import { renderListingOg } from '@/libs/og/renderListingOg';

// Metadata exports read by Next for the injected <meta> tags.
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = 'Pubky Marketplace listing preview';

// Dynamic responses let Cache-Control decide whether found or fallback images cache.
export const dynamic = 'force-dynamic';

export default async function Image({ params }: { params: Promise<{ sellerPubky: string; listingId: string }> }) {
  const { sellerPubky, listingId } = await params;
  return renderListingOg({ sellerPubky, listingId });
}
