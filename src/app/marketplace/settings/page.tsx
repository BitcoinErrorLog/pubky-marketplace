import { gatedMarketplaceMetadata } from '@/app/marketplace/gated-metadata';
import { MARKETPLACE_ROUTES } from '@/app/routes';

export { MarketplacePaymentSettings as default } from '@/templates/Marketplace/MarketplacePaymentSettings';

export function generateMetadata() {
  return gatedMarketplaceMetadata(
    'Payment settings | Pubky Marketplace',
    'Configure how you pay and get paid on Pubky Marketplace.',
    MARKETPLACE_ROUTES.SETTINGS,
  );
}
