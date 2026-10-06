import { gatedMarketplaceMetadata } from '@/app/marketplace/gated-metadata';
import { MARKETPLACE_ROUTES } from '@/app/routes';

export { MarketplaceInventoryAutomations as default } from '@/templates/Marketplace/MarketplaceInventoryAutomations';

export function generateMetadata() {
  return gatedMarketplaceMetadata(
    'Automations | Pubky Marketplace',
    'Manage shop sessions and webhook endpoints on Pubky Marketplace.',
    MARKETPLACE_ROUTES.INVENTORY_AUTOMATIONS,
  );
}
