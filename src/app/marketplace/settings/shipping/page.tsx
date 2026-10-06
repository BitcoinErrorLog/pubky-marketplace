import { gatedMarketplaceMetadata } from '@/app/marketplace/gated-metadata';
import { MARKETPLACE_ROUTES } from '@/app/routes';

export { MarketplaceShippingSettings as default } from '@/templates/Marketplace/MarketplaceShippingSettings';

export function generateMetadata() {
  return gatedMarketplaceMetadata(
    'Shipping presets | Pubky Marketplace',
    'Manage the reusable shipping option templates saved on this device.',
    MARKETPLACE_ROUTES.SETTINGS_SHIPPING,
  );
}
