import { redirect } from 'next/navigation';
import { gatedMarketplaceMetadata } from '@/app/marketplace/gated-metadata';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { getMarketplaceOfferCheckoutRoute } from '@/libs/commerce/checkout-phase';

export function generateMetadata() {
  return gatedMarketplaceMetadata(
    'Checkout | Pubky Marketplace',
    'Review and pay the terms accepted for your marketplace offer.',
    MARKETPLACE_ROUTES.CHECKOUT,
  );
}

export default async function AwardCheckoutRedirectPage({
  searchParams,
}: {
  searchParams: Promise<{ offer?: string }>;
}) {
  const { offer } = await searchParams;
  redirect(getMarketplaceOfferCheckoutRoute(offer));
}
