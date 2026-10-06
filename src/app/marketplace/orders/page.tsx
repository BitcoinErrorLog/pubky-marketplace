import { gatedMarketplaceMetadata } from '@/app/marketplace/gated-metadata';
import { MARKETPLACE_ROUTES } from '@/app/routes';

export { MarketplaceOrders as default } from '@/templates/Marketplace/MarketplaceOrders';

export function generateMetadata() {
  return gatedMarketplaceMetadata(
    'Orders | Pubky Marketplace',
    'Track your Pubky Marketplace purchases and sales.',
    MARKETPLACE_ROUTES.ORDERS,
  );
}
