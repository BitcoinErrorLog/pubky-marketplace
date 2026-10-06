import { OG_CONTENT_TYPE, OG_SIZE } from '@/libs/og/ogConstants';
import { renderMarketplaceOg } from '@/libs/og/renderMarketplaceOg';

// Metadata exports read by Next for the injected <meta> tags. Serves the
// /marketplace home preview; auth-gated marketplace routes (orders, offers,
// sell, ...) point their og:image at this route via `gatedMarketplaceMetadata`
// (file-convention images do not cascade to nested routes). Listing/shop
// routes carry their own record-backed image routes.
export const size = OG_SIZE;
export const contentType = OG_CONTENT_TYPE;
export const alt = 'Pubky Marketplace';

// Segment config must be a statically-analyzable literal — Next won't resolve an
// imported constant here — kept in sync with OG_COMMERCE_REVALIDATE.
export const revalidate = 300;

export default async function Image() {
  return renderMarketplaceOg();
}
