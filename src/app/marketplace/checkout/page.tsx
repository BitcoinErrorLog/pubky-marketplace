import { gatedMarketplaceMetadata } from '@/app/marketplace/gated-metadata';
import { MARKETPLACE_ROUTES } from '@/app/routes';

export { MarketplaceCheckout as default } from '@/templates/Marketplace/MarketplaceCheckout';

export function generateMetadata() {
  return gatedMarketplaceMetadata(
    'Checkout | Pubky Marketplace',
    'Pay for items in your Pubky Marketplace cart.',
    MARKETPLACE_ROUTES.CHECKOUT,
  );
}
