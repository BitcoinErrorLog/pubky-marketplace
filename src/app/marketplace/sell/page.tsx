import { gatedMarketplaceMetadata } from '@/app/marketplace/gated-metadata';
import { MARKETPLACE_ROUTES } from '@/app/routes';

export { MarketplaceSell as default } from '@/templates/Marketplace/MarketplaceSell';

export function generateMetadata() {
  return gatedMarketplaceMetadata(
    'Sell | Pubky Marketplace',
    'Create a listing on Pubky Marketplace.',
    MARKETPLACE_ROUTES.SELL,
  );
}
