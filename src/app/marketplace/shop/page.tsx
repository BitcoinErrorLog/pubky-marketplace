import { gatedMarketplaceMetadata } from '@/app/marketplace/gated-metadata';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { MarketplaceSellerEntry } from '@/templates/Marketplace/MarketplaceSellerEntry';

export default MarketplaceSellerEntry;

export function generateMetadata() {
  return gatedMarketplaceMetadata(
    'Seller setup | Pubky Marketplace',
    'Set up your seller account on Pubky Marketplace.',
    MARKETPLACE_ROUTES.SHOP,
  );
}
