import { gatedMarketplaceMetadata } from '@/app/marketplace/gated-metadata';
import { MARKETPLACE_ROUTES } from '@/app/routes';

export { MarketplaceInventory as default } from '@/templates/Marketplace/MarketplaceInventory';

export function generateMetadata() {
  return gatedMarketplaceMetadata(
    'Inventory | Pubky Marketplace',
    'View and set listing stock on Pubky Marketplace.',
    MARKETPLACE_ROUTES.INVENTORY,
  );
}
