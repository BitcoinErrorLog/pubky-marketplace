import { OG_CONTENT_TYPE, OG_SIZE } from '@/libs/og/ogConstants';
import { renderShopOg } from '@/libs/og/renderShopOg';

// Metadata exports read by Next for the injected <meta> tags.
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = 'Pubky Marketplace shop preview';

// Dynamic responses let Cache-Control decide whether found or fallback images cache.
export const dynamic = 'force-dynamic';

export default async function Image({ params }: { params: Promise<{ sellerPubky: string }> }) {
  const { sellerPubky } = await params;
  return renderShopOg({ sellerPubky });
}
