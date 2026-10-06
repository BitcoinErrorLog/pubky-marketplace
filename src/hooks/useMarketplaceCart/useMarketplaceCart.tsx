'use client';

import { useRouter } from 'next/navigation';
import { useLiveQuery } from 'dexie-react-hooks';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { ToastAction } from '@/atoms/Toast/Toast';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useRequireAuth } from '@/hooks/useRequireAuth/useRequireAuth';
import { commerceListingShippingMinor } from '@/libs/commerce/marketplace-records';
import type { MarketplaceFulfillmentMethod } from '@/libs/commerce/pickup';
import { sumMoneyByAsset } from '@/libs/commerce/pricing';
import type { CommerceListingModelSchema } from '@/models/commerce/commerce.schema';
import { toast } from '@/molecules/Toaster/use-toast';
import { useAuthStore } from '@/stores/auth/auth.store';

export interface MarketplaceCartItem {
  id: string;
  listingId: string;
  variantId: string;
  quantity: number;
  awardId?: string | null;
  awardOfferRevision?: number | null;
  pricingSource?: 'listing' | 'offer';
  listing: CommerceListingModelSchema;
}

export interface MarketplaceCartGroup {
  sellerPubky: string;
  items: MarketplaceCartItem[];
  subtotals: ReturnType<typeof sumMoneyByAsset>;
}

/** Shipping for the lines that ship: a pickup or digital line adds none, even beside shipped ones. */
export function marketplaceCartShippingTotals(
  groups: MarketplaceCartGroup[],
  fulfillmentForItem: (item: MarketplaceCartItem) => MarketplaceFulfillmentMethod | undefined,
): { totals: ReturnType<typeof sumMoneyByAsset>; hasCalculatedShipping: boolean } {
  const shippingLines: Array<{ money: { amountMinor: number; currency: string; exponent: number }; quantity: number }> =
    [];
  let hasCalculatedShipping = false;
  for (const group of groups) {
    for (const item of group.items) {
      if (fulfillmentForItem(item) !== 'shipping') continue;
      const options = item.listing.record.shippingOptions ?? [];
      if (options.length === 0) continue;
      const shippingMinor = commerceListingShippingMinor(options);
      const option = options.find(
        (candidate) =>
          (candidate.pricing === 'flat' && candidate.price.amountMinor === shippingMinor) ||
          (candidate.pricing === 'free' && shippingMinor === 0),
      );
      if (!option) {
        hasCalculatedShipping = true;
        continue;
      }
      const price = priceForCartItem(item);
      if (price) {
        shippingLines.push({ money: { ...price, amountMinor: shippingMinor }, quantity: 1 });
      }
    }
  }
  return { totals: sumMoneyByAsset(shippingLines), hasCalculatedShipping };
}

function priceForCartItem(item: MarketplaceCartItem) {
  const variant = item.listing.record.variants.find(({ id }) => id === item.variantId);
  return (
    variant?.priceOverride ??
    (item.listing.record.sale.format === 'fixed_price' ? item.listing.record.sale.unitPrice : null)
  );
}

export function groupMarketplaceCartItems(items: MarketplaceCartItem[]): MarketplaceCartGroup[] {
  const groups = new Map<string, MarketplaceCartItem[]>();
  for (const item of items) {
    const sellerPubky = item.listing.record.ownerPubky;
    groups.set(sellerPubky, [...(groups.get(sellerPubky) ?? []), item]);
  }
  return [...groups.entries()].map(([sellerPubky, groupItems]) => ({
    sellerPubky,
    items: groupItems,
    subtotals: sumMoneyByAsset(
      groupItems.flatMap((item) => {
        const price = priceForCartItem(item);
        return price ? [{ money: price, quantity: item.quantity }] : [];
      }),
    ),
  }));
}

export function useMarketplaceCart() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const { requireAuth } = useRequireAuth();
  const router = useRouter();
  const items = useLiveQuery(async () => {
    if (!currentUserPubky) return [];
    const rows = await CommerceController.getCartItems();
    const enriched = await Promise.all(
      rows.map(async (row) => {
        const separator = row.listing_id.indexOf(':');
        const listing = await CommerceController.getListing(
          row.listing_id.slice(0, separator),
          row.listing_id.slice(separator + 1),
        );
        return listing
          ? {
              id: row.id,
              listingId: row.listing_id,
              variantId: row.variant_id,
              quantity: row.quantity,
              awardId: row.award_id ?? null,
              awardOfferRevision: row.award_offer_revision ?? null,
              pricingSource: row.pricing_source ?? 'listing',
              listing: {
                id: listing.id,
                seller_id: listing.seller_id,
                listing_id: listing.listing_id,
                record: listing.record,
                revision: listing.revision,
                state: listing.state,
                category_id: listing.category_id,
                format: listing.format,
                currency: listing.currency,
                price_minor: listing.price_minor,
                sync_status: listing.sync_status,
                updated_at: listing.updated_at,
              },
            }
          : null;
      }),
    );
    return enriched.filter((item) => item !== null);
  }, [currentUserPubky]);

  const add = async (listingId: string, variantId: string, quantity = 1) => {
    const mutation = requireAuth(async () => {
      if (currentUserPubky && listingId.startsWith(`${currentUserPubky}:`)) {
        toast({ variant: 'error', description: 'You cannot buy your own listing' });
        return;
      }
      try {
        await CommerceController.commitUpsertCartItem(listingId, variantId, quantity);
        toast({
          title: 'Added to cart',
          action: (
            <ToastAction altText="View cart" onClick={() => router.push(MARKETPLACE_ROUTES.CART)}>
              View cart
            </ToastAction>
          ),
        });
      } catch {
        toast({ variant: 'error', description: 'Could not add this item to the cart.' });
      }
    });
    await mutation;
  };

  const update = async (listingId: string, variantId: string, quantity: number) => {
    await CommerceController.commitUpsertCartItem(listingId, variantId, quantity);
  };

  const addAward = async (
    listingId: string,
    variantId: string,
    quantity: number,
    awardId: string,
    offerRevision: number,
  ): Promise<boolean> => {
    try {
      await CommerceController.commitUpsertAwardCartItem(listingId, variantId, quantity, awardId, offerRevision);
      return true;
    } catch {
      toast({ variant: 'error', description: 'Could not start checkout for this offer.' });
      return false;
    }
  };

  const remove = async (listingId: string, variantId: string, awardId?: string) => {
    await CommerceController.commitDeleteCartItem(listingId, variantId, awardId);
  };

  const clear = async () => {
    await CommerceController.commitClearCart();
  };

  // One subtotal per pricing asset: minor units of different assets (USD
  // cents, bitcoin base units) are never added into one false number.
  const cartItems = items ?? [];
  const ordinaryItems = cartItems.filter((item) => item.pricingSource === 'listing');
  const awardItems = cartItems.filter((item) => item.pricingSource === 'offer');
  const subtotals = sumMoneyByAsset(
    ordinaryItems.flatMap((item) => {
      const price = priceForCartItem(item);
      return price ? [{ money: price, quantity: item.quantity }] : [];
    }),
  );

  return {
    items: cartItems,
    ordinaryItems,
    awardItems,
    itemCount: cartItems.reduce((total, item) => total + item.quantity, 0),
    subtotals,
    groups: groupMarketplaceCartItems(ordinaryItems),
    isLoading: items === undefined,
    add,
    addAward,
    update,
    remove,
    clear,
  };
}
