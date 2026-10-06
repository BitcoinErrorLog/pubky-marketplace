import { describe, expect, it } from 'vitest';
import { asOpaque } from '@/test-utils/type-assertions';
import type { MarketplaceCartItem } from './useMarketplaceCart';
import { groupMarketplaceCartItems, marketplaceCartShippingTotals } from './useMarketplaceCart';

function cartItem({
  sellerPubky,
  title,
  variantId,
  quantity,
  amountMinor,
  currency,
  exponent,
  shippingOptions = [],
}: {
  sellerPubky: string;
  title: string;
  variantId: string;
  quantity: number;
  amountMinor: number;
  currency: string;
  exponent: number;
  shippingOptions?: unknown[];
}): MarketplaceCartItem {
  return asOpaque<MarketplaceCartItem>({
    id: `${sellerPubky}:${title}:${variantId}`,
    listingId: `${sellerPubky}:${title}`,
    variantId,
    quantity,
    listing: {
      record: {
        ownerPubky: sellerPubky,
        listingId: title,
        title,
        variants: [{ id: variantId, options: {}, quantity: 10 }],
        sale: { format: 'fixed_price', unitPrice: { amountMinor, currency, exponent }, acceptsOffers: false },
        media: [],
        shippingOptions,
      },
    },
  });
}

describe('groupMarketplaceCartItems', () => {
  it('groups cart lines by seller in first-seen order', () => {
    const firstSeller = 's'.repeat(52);
    const secondSeller = 'o'.repeat(52);

    const groups = groupMarketplaceCartItems([
      cartItem({
        sellerPubky: firstSeller,
        title: 'boots',
        variantId: '42',
        quantity: 1,
        amountMinor: 1200,
        currency: 'USD',
        exponent: 2,
      }),
      cartItem({
        sellerPubky: secondSeller,
        title: 'camera',
        variantId: 'body',
        quantity: 1,
        amountMinor: 4500,
        currency: 'USD',
        exponent: 2,
      }),
      cartItem({
        sellerPubky: firstSeller,
        title: 'jacket',
        variantId: 'm',
        quantity: 1,
        amountMinor: 8900,
        currency: 'USD',
        exponent: 2,
      }),
    ]);

    expect(groups.map((group) => group.sellerPubky)).toEqual([firstSeller, secondSeller]);
    expect(groups[0].items.map((item) => item.listing.record.title)).toEqual(['boots', 'jacket']);
    expect(groups[1].items.map((item) => item.listing.record.title)).toEqual(['camera']);
  });

  it('keeps per-seller subtotals separated by pricing asset', () => {
    const sellerPubky = 's'.repeat(52);

    const [group] = groupMarketplaceCartItems([
      cartItem({
        sellerPubky,
        title: 'boots',
        variantId: '42',
        quantity: 2,
        amountMinor: 1200,
        currency: 'USD',
        exponent: 2,
      }),
      cartItem({
        sellerPubky,
        title: 'camera',
        variantId: 'body',
        quantity: 3,
        amountMinor: 15000,
        currency: 'BTC',
        exponent: 8,
      }),
    ]);

    expect(group.subtotals).toEqual([
      { amountMinor: 2400, currency: 'USD', exponent: 2 },
      { amountMinor: 45000, currency: 'BTC', exponent: 8 },
    ]);
  });

  it('adds one seller flat shipping charge to the pre-order total', () => {
    const sellerPubky = 's'.repeat(52);
    const [group] = groupMarketplaceCartItems([
      cartItem({
        sellerPubky,
        title: 'boots',
        variantId: '42',
        quantity: 1,
        amountMinor: 1200,
        currency: 'USD',
        exponent: 2,
        shippingOptions: [
          {
            id: 'ground',
            pricing: 'flat',
            label: 'Ground',
            price: { amountMinor: 500, currency: 'USD', exponent: 2 },
            estimatedMinDays: 3,
            estimatedMaxDays: 7,
          },
        ],
      }),
    ]);

    expect(marketplaceCartShippingTotals([group], () => 'shipping')).toEqual({
      totals: [{ amountMinor: 500, currency: 'USD', exponent: 2 }],
      hasCalculatedShipping: false,
    });
    expect(marketplaceCartShippingTotals([group], () => 'pickup').totals).toEqual([]);
  });

  it('charges flat shipping once per seller order line', () => {
    const sellerPubky = 's'.repeat(52);
    const group = groupMarketplaceCartItems([
      cartItem({
        sellerPubky,
        title: 'boots',
        variantId: '42',
        quantity: 1,
        amountMinor: 1200,
        currency: 'USD',
        exponent: 2,
        shippingOptions: [
          {
            id: 'ground',
            pricing: 'flat',
            label: 'Ground',
            price: { amountMinor: 500, currency: 'USD', exponent: 2 },
            estimatedMinDays: 3,
            estimatedMaxDays: 7,
          },
        ],
      }),
      cartItem({
        sellerPubky,
        title: 'jacket',
        variantId: 'm',
        quantity: 1,
        amountMinor: 8900,
        currency: 'USD',
        exponent: 2,
        shippingOptions: [
          {
            id: 'ground',
            pricing: 'flat',
            label: 'Ground',
            price: { amountMinor: 500, currency: 'USD', exponent: 2 },
            estimatedMinDays: 3,
            estimatedMaxDays: 7,
          },
        ],
      }),
    ]);

    expect(marketplaceCartShippingTotals(group, () => 'shipping')).toEqual({
      totals: [{ amountMinor: 1000, currency: 'USD', exponent: 2 }],
      hasCalculatedShipping: false,
    });
    // Digital delivery design §3 "Mixed carts": the jacket's buyer took the digital version.
    expect(
      marketplaceCartShippingTotals(group, (item) => (item.listing.record.title === 'jacket' ? 'digital' : 'shipping')),
    ).toEqual({
      totals: [{ amountMinor: 500, currency: 'USD', exponent: 2 }],
      hasCalculatedShipping: false,
    });
  });

  it('charges priceable lines while flagging calculated lines', () => {
    const sellerPubky = 's'.repeat(52);
    const group = groupMarketplaceCartItems([
      cartItem({
        sellerPubky,
        title: 'boots',
        variantId: '42',
        quantity: 1,
        amountMinor: 1200,
        currency: 'USD',
        exponent: 2,
        shippingOptions: [
          {
            id: 'shippo',
            pricing: 'calculated',
            label: 'Calculated',
            provider: 'shippo',
            serviceCode: 'ground',
            estimatedMinDays: 3,
            estimatedMaxDays: 7,
          },
        ],
      }),
      cartItem({
        sellerPubky,
        title: 'jacket',
        variantId: 'm',
        quantity: 1,
        amountMinor: 8900,
        currency: 'USD',
        exponent: 2,
        shippingOptions: [
          {
            id: 'ground',
            pricing: 'flat',
            label: 'Ground',
            price: { amountMinor: 500, currency: 'USD', exponent: 2 },
            estimatedMinDays: 3,
            estimatedMaxDays: 7,
          },
        ],
      }),
    ]);

    expect(marketplaceCartShippingTotals(group, () => 'shipping')).toEqual({
      totals: [{ amountMinor: 500, currency: 'USD', exponent: 2 }],
      hasCalculatedShipping: true,
    });
  });

  it('charges shipping once for a quantity-two line', () => {
    const sellerPubky = 's'.repeat(52);
    const [group] = groupMarketplaceCartItems([
      cartItem({
        sellerPubky,
        title: 'boots',
        variantId: '42',
        quantity: 2,
        amountMinor: 1200,
        currency: 'USD',
        exponent: 2,
        shippingOptions: [
          {
            id: 'ground',
            pricing: 'flat',
            label: 'Ground',
            price: { amountMinor: 500, currency: 'USD', exponent: 2 },
            estimatedMinDays: 3,
            estimatedMaxDays: 7,
          },
        ],
      }),
    ]);

    expect(marketplaceCartShippingTotals([group], () => 'shipping')).toEqual({
      totals: [{ amountMinor: 500, currency: 'USD', exponent: 2 }],
      hasCalculatedShipping: false,
    });
  });

  it('reports calculated shipping instead of inventing a client-side amount', () => {
    const sellerPubky = 's'.repeat(52);
    const [group] = groupMarketplaceCartItems([
      cartItem({
        sellerPubky,
        title: 'boots',
        variantId: '42',
        quantity: 1,
        amountMinor: 1200,
        currency: 'USD',
        exponent: 2,
        shippingOptions: [
          {
            id: 'shippo',
            pricing: 'calculated',
            label: 'Calculated',
            provider: 'shippo',
            serviceCode: 'ground',
            estimatedMinDays: 3,
            estimatedMaxDays: 7,
          },
        ],
      }),
    ]);

    expect(marketplaceCartShippingTotals([group], () => 'shipping')).toEqual({
      totals: [],
      hasCalculatedShipping: true,
    });
  });
});
