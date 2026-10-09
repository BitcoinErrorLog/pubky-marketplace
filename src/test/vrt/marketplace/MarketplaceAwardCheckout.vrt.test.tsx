// Intentional import order — browser-mode mocks rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { expectVrtSurface, renderForVRT } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceCheckout } from '@/templates/Marketplace/MarketplaceCheckout';
import { toCamelCaseWire } from '@/libs/commerce/wire-casing';
import { ACCEPTED_OFFER_AWARD_WIRE_FIXTURE } from '@/test/fixtures/commerce/offers';
import type { MarketplaceOffer } from '@/services/marketplace/marketplace';
import { asOpaque } from '@/test-utils/type-assertions';

const state = vi.hoisted(() => ({
  outcome: 'active' as 'active' | 'expired' | 'success',
}));

const offer = asOpaque<MarketplaceOffer>({
  id: '00000000-0000-0000-0000-000000000901',
  state: 'accepted',
  buyerPubky: 'b'.repeat(52),
  award: toCamelCaseWire(ACCEPTED_OFFER_AWARD_WIRE_FIXTURE) as MarketplaceOffer['award'],
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams('offer=00000000-0000-0000-0000-000000000901'),
  usePathname: () => '/marketplace/checkout',
}));
vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock('@/hooks/useMarketplaceOffers/useMarketplaceOffers', () => ({
  useMarketplaceOffers: () => ({
    offers: [offer],
    isLoading: false,
    refresh: vi.fn(async () => {}),
  }),
}));
vi.mock('@/hooks/useMarketplaceCart/useMarketplaceCart', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useMarketplaceCart/useMarketplaceCart')>();
  return {
    ...actual,
    useMarketplaceCart: () => ({
      items: [],
      ordinaryItems: [],
      awardItems: [{ awardId: offer.award!.id, listingId: 's:boots', variantId: 'variant_42' }],
      groups: [],
      subtotals: [],
      isLoading: false,
      remove: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    }),
  };
});
vi.mock('@/hooks/useMarketplaceCartCount/useMarketplaceCartCount', () => ({
  useMarketplaceCartCount: () => 3,
}));
vi.mock('@/hooks/useMarketplaceActivityUnread/useMarketplaceActivityUnread', () => ({
  useMarketplaceActivityUnread: () => 2,
}));
vi.mock('@/hooks/useMarketplaceCheckout/useMarketplaceCheckout', async () => {
  const { useForm } = await import('react-hook-form');
  const { marketplaceCheckoutDefaults } = await import('@/hooks/useMarketplaceCheckout/useMarketplaceCheckout.types');
  return {
    useMarketplaceCheckout: () => ({
      form: useForm({
        defaultValues: {
          ...marketplaceCheckoutDefaults,
          name: 'Alice Buyer',
          line1: '1 Market Street',
          city: 'New York',
          region: 'NY',
          postalCode: '10001',
          countryCode: 'US',
          acceptsGuarantee: true,
        },
      }),
      submit: vi.fn(async () => false),
      pay: vi.fn(async () => ({ ok: false, orderIds: [], boundOrders: [] })),
      isPaying: false,
      needsSession: false,
      sessionError: null,
      hasMarketplaceSession: true,
      addresses: [
        {
          id: 'home',
          label: 'Home',
          name: 'Alice Buyer',
          line1: '1 Market Street',
          line2: '',
          city: 'New York',
          region: 'NY',
          postal_code: '10001',
          country_code: 'US',
          is_default: true,
        },
      ],
      selectedAddressId: 'home',
      selectAddress: vi.fn(),
      fulfillmentOptionsForSeller: () => ['shipping'],
      fulfillmentForSeller: () => 'shipping',
      setFulfillmentChoice: vi.fn(),
      requiresDeliveryAddress: true,
      hasFulfillmentConflict: false,
      isPickupCapabilityLoadingForSeller: () => false,
      orderCount: 1,
      rememberAddress: vi.fn(async () => {}),
      fulfillmentForItem: () => 'shipping',
      setDigitalChoice: vi.fn(),
      canChooseDigitalForItem: () => false,
      digitalKindForItem: () => undefined,
      isDigitalCapabilityLoading: false,
      digitalNotReadyItemIds: [],
      isDigitalReady: true,
      requiresDeliveryEmail: false,
      hasInstantDigitalLine: false,
      hasManualDigitalLine: false,
    }),
  };
});
vi.mock('@/hooks/useMarketplaceOrders/useMarketplaceOrders', () => ({
  useMarketplaceOrders: () => ({
    orders: [],
    isLoading: false,
    error: null,
    needsSession: false,
    adapterMode: 'sandbox',
    refresh: vi.fn(),
    advancePayment: vi.fn(),
    actOnOrder: vi.fn(),
  }),
}));
vi.mock('@/hooks/useMarketplaceOfferCheckout/useMarketplaceOfferCheckout', () => ({
  useMarketplaceOfferCheckout: () => ({
    isSubmitting: false,
    submit: vi.fn(async () =>
      state.outcome === 'success' ? { ok: true, orderId: '' } : { ok: false, code: 'AWARD_EXPIRED' },
    ),
  }),
}));
vi.mock('@/config/commerce', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/commerce')>();
  return { ...actual, getCommerceAdapterMode: () => 'sandbox' };
});
vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>();
  return { ...actual, getDeployEnv: () => 'staging' };
});
vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getShop: vi.fn(async () => null),
    getSellerPaymentConfig: vi.fn(async () => ({
      bitcoinAvailable: true,
      bitcoinOfferAvailable: true,
      paypalAvailable: false,
    })),
    getIndicativeBtcRate: vi.fn(async () => null),
  },
}));
vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) =>
    selector({ currentUserPubky: 'b'.repeat(52) }),
}));
vi.mock('@/organisms/Marketplace/MarketplaceIndicativePrice', () => ({
  MarketplaceIndicativePrice: ({ money }: { money: { currency: string } }) =>
    money.currency === 'USD' ? <span>≈ ₿137,000</span> : null,
}));

describe('Marketplace award checkout — visual regression', () => {
  beforeEach(() => {
    state.outcome = 'active';
  });

  async function capture(scene: string, viewport = VRT_VIEWPORT_DESKTOP) {
    await renderForVRT(<MarketplaceCheckout />, { viewport });
    if (state.outcome === 'active') {
      await vi.waitFor(() => {
        const pay = document.querySelector('[data-testid="marketplace-checkout-pay"]');
        if (!(pay instanceof HTMLButtonElement) || pay.disabled) {
          throw new Error('Award Pay is not ready yet.');
        }
      });
    }
    const surface = await expectVrtSurface('marketplace-checkout');
    await expect(surface).toMatchScreenshot(scene);
  }

  it('captures the active award checkout at desktop viewport', async () => {
    await capture('award-checkout-desktop');
  });

  it('captures the active award checkout at mobile viewport', async () => {
    await capture('award-checkout-mobile', VRT_VIEWPORT_MOBILE);
  });

  it('captures the expired state', async () => {
    state.outcome = 'expired';
    await renderForVRT(<MarketplaceCheckout />, { viewport: VRT_VIEWPORT_DESKTOP });
    await vi.waitFor(() => {
      const pay = document.querySelector('[data-testid="marketplace-checkout-pay"]');
      if (!(pay instanceof HTMLButtonElement) || pay.disabled) {
        throw new Error('Award Pay is not ready yet.');
      }
    });
    const pay = document.querySelector('[data-testid="marketplace-checkout-pay"]');
    if (!(pay instanceof HTMLButtonElement)) throw new Error('Award Pay is missing.');
    await userEvent.click(pay);
    await vi.waitFor(() => {
      if (!document.body.textContent?.includes('Offer expired')) {
        throw new Error('Award expired copy has not rendered yet.');
      }
    });
    const surface = await expectVrtSurface('marketplace-checkout');
    await expect(surface).toMatchScreenshot('award-checkout-expired-desktop');
  });

  it('captures the success state', async () => {
    state.outcome = 'success';
    await renderForVRT(<MarketplaceCheckout />, { viewport: VRT_VIEWPORT_DESKTOP });
    await vi.waitFor(() => {
      const pay = document.querySelector('[data-testid="marketplace-checkout-pay"]');
      if (!(pay instanceof HTMLButtonElement) || pay.disabled) {
        throw new Error('Award Pay is still disabled.');
      }
    });
    const pay = document.querySelector('[data-testid="marketplace-checkout-pay"]');
    if (!(pay instanceof HTMLButtonElement)) throw new Error('Award Pay is missing.');
    await userEvent.click(pay);
    await vi.waitFor(() => {
      if (!document.body.textContent?.includes('Checkout started')) {
        throw new Error('Award checkout success has not rendered yet.');
      }
    });
    const surface = await expectVrtSurface('marketplace-checkout');
    await expect(surface).toMatchScreenshot('award-checkout-success-desktop');
  });
});
