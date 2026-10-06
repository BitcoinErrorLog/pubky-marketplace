import { gatedMarketplaceMetadata } from '@/app/marketplace/gated-metadata';
import { MARKETPLACE_ROUTES } from '@/app/routes';

export { MarketplaceCart as default } from '@/templates/Marketplace/MarketplaceCart';

export function generateMetadata() {
  return gatedMarketplaceMetadata('Cart | Pubky Marketplace', 'Your Pubky Marketplace cart.', MARKETPLACE_ROUTES.CART);
}
