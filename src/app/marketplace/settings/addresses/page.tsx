import { gatedMarketplaceMetadata } from '@/app/marketplace/gated-metadata';
import { MARKETPLACE_ROUTES } from '@/app/routes';

export { MarketplaceAddressSettings as default } from '@/templates/Marketplace/MarketplaceAddressSettings';

export function generateMetadata() {
  return gatedMarketplaceMetadata(
    'Delivery addresses | Pubky Marketplace',
    'Manage the delivery addresses saved privately on this device.',
    MARKETPLACE_ROUTES.SETTINGS_ADDRESSES,
  );
}
