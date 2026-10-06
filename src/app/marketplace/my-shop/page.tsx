import { gatedMarketplaceMetadata } from '@/app/marketplace/gated-metadata';
import { MARKETPLACE_ROUTES } from '@/app/routes';

export { MarketplaceMyShop as default } from '@/templates/Marketplace/MarketplaceMyShop';

export function generateMetadata() {
  return gatedMarketplaceMetadata(
    'My shop | Pubky Marketplace',
    'Manage your shop on Pubky Marketplace.',
    MARKETPLACE_ROUTES.MY_SHOP,
  );
}
