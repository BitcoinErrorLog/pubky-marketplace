import { gatedMarketplaceMetadata } from '@/app/marketplace/gated-metadata';
import { MARKETPLACE_ROUTES } from '@/app/routes';

export { MarketplaceMyShop as default } from '@/templates/Marketplace/MarketplaceMyShop';

export function generateMetadata() {
  return gatedMarketplaceMetadata(
    'Storefront | Pubky Marketplace',
    'Manage your storefront on Pubky Marketplace.',
    MARKETPLACE_ROUTES.MY_SHOP,
  );
}
