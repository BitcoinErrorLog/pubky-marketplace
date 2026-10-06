// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseContractFaithfulOffer } from '@/test/fixtures/commerce/offer-award';
import { expectVrtSurface, parkVrtHover, renderForVRT, VRT_DENSE_CHROME_SCREENSHOT } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceCart } from '@/templates/Marketplace/MarketplaceCart';

// Deterministic BTC/USD rate for the capture (1 BTC = $100,000): the "≈"
// estimates render from this fixed value, never from the network.
vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: (enabled: boolean) =>
    enabled ? { satUsd: 0.001, btcUsd: 100_000, lastUpdatedAt: new Date('2026-08-21T00:00:00Z') } : null,
}));

// Cart rows show the listing's cover photo (record media order, first image);
// a deterministic data-URI keeps the capture free of network fetches.
const MEDIA_DATA_URL = vi.hoisted(
  () =>
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGN4UaKEFTEMLQkAgnNfgXMIh2kAAAAASUVORK5CYII=',
);

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  const { createMarketplaceMediaHooks } = await import('@/test/mocks/marketplace-media-hooks');
  return createMarketplaceMediaHooks((uri) => (uri ? MEDIA_DATA_URL : null));
});

const fixtures = vi.hoisted(async () => {
  const { createCommerceListingFixture } = await import('@/test/fixtures/commerce/commerce');
  const { toCommerceListingModel } = await import('@/test/fixtures/commerce/listing-models');

  const otherSeller = 'n'.repeat(52);
  const boots = toCommerceListingModel(
    createCommerceListingFixture({
      variants: [
        { id: 'variant_42', options: { size: '42' }, quantity: 3, mediaIds: ['image_01'], enabled: true },
        { id: 'variant_43', options: { size: '43' }, quantity: 1, mediaIds: ['image_01'], enabled: true },
      ],
    }),
  );
  const jacket = toCommerceListingModel(
    createCommerceListingFixture({
      listingId: 'selvedge_jacket',
      title: 'Selvedge denim jacket',
      categoryId: 'fashion-jackets',
      condition: 'excellent',
      variants: [{ id: 'variant_01', options: { size: 'M' }, quantity: 2, mediaIds: ['image_01'], enabled: true }],
      sale: {
        format: 'fixed_price',
        unitPrice: { amountMinor: 8_900, currency: 'USD', exponent: 2 },
        acceptsOffers: true,
      },
    }),
  );
  const camera = toCommerceListingModel(
    createCommerceListingFixture({
      ownerPubky: otherSeller,
      listingId: 'rangefinder_camera',
      title: '35mm rangefinder camera',
      categoryId: 'electronics-cameras-film',
      condition: 'excellent',
      variants: [{ id: 'variant_01', options: {}, quantity: 1, mediaIds: ['image_01'], enabled: true }],
      sale: {
        format: 'fixed_price',
        unitPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
        acceptsOffers: false,
      },
    }),
  );

  const item = (listing: ReturnType<typeof toCommerceListingModel>, variantId: string, quantity: number) => ({
    id: `${listing.id}:${variantId}`,
    listingId: listing.id,
    variantId,
    quantity,
    listing,
  });

  return {
    singleSeller: [item(boots, 'variant_42', 1), item(boots, 'variant_43', 1)],
    multiSeller: [item(boots, 'variant_42', 2), item(jacket, 'variant_01', 1), item(camera, 'variant_01', 1)],
    staleItem: [item(boots, 'variant_42', 1), item(jacket, 'variant_gone', 1)],
  };
});

interface CartItemMoneyLike {
  amountMinor: number;
  currency: string;
  exponent: number;
}

interface CartItemLike {
  quantity: number;
  variantId: string;
  pricingSource?: 'listing' | 'offer';
  listing: {
    record: {
      variants: Array<{ id: string; priceOverride?: CartItemMoneyLike }>;
      sale: { format: string; unitPrice?: CartItemMoneyLike };
    };
  };
}

const view = vi.hoisted(() => ({
  items: [] as unknown[],
  offers: [] as unknown[],
  isLoading: false,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace/cart',
}));

vi.mock('@/hooks/useMarketplaceCart/useMarketplaceCart', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useMarketplaceCart/useMarketplaceCart')>();
  const { sumMoneyByAsset } = await import('@/libs/commerce/pricing');
  return {
    ...actual,
    useMarketplaceCart: () => {
      const items = view.items as CartItemLike[];
      return {
        items,
        ordinaryItems: items.filter((item) => item.pricingSource !== 'offer'),
        awardItems: items.filter((item) => item.pricingSource === 'offer'),
        itemCount: items.reduce((total, item) => total + item.quantity, 0),
        subtotals: sumMoneyByAsset(
          items.flatMap((item) => {
            const variant = item.listing.record.variants.find(({ id }) => id === item.variantId);
            const price =
              variant?.priceOverride ??
              (item.listing.record.sale.format === 'fixed_price' ? item.listing.record.sale.unitPrice : null);
            return price ? [{ money: price, quantity: item.quantity }] : [];
          }),
        ),
        isLoading: view.isLoading,
        add: vi.fn(),
        update: vi.fn(),
        remove: vi.fn(),
        clear: vi.fn(),
        groups: actual.groupMarketplaceCartItems(items.filter((item) => item.pricingSource !== 'offer') as never),
      };
    },
  };
});

vi.mock('@/hooks/useMarketplaceOffers/useMarketplaceOffers', () => ({
  useMarketplaceOffers: () => ({ offers: view.offers, isLoading: false, error: null, needsSession: false }),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

vi.mock('@/hooks/useMarketplaceSellerSummary/useMarketplaceSellerSummary', () => ({
  useMarketplaceSellerSummary: (sellerPubky: string, options?: { includeReputation?: boolean }) => ({
    shop: null,
    reputation: options?.includeReputation === false ? { status: 'unavailable' } : { status: 'new_seller' },
    displayName: sellerPubky === 'n'.repeat(52) ? 'Film Camera Supply' : 'Satoshi Vintage',
  }),
}));

// The display store persists to localStorage, which the VRT browser shares
// across test files — pin the defaults so captures never depend on what a
// previously-run file left behind.
beforeEach(async () => {
  const { useMarketplaceDisplayStore } = await import('@/stores/marketplace-display/marketplace-display.store');
  useMarketplaceDisplayStore.setState({ showFxEstimate: true, measurementSystem: 'metric' });
  view.offers = [];
  view.isLoading = false;
});

describe('Marketplace cart — visual regression', () => {
  it('rejects a missing production surface marker', () => {
    expect(() => expectVrtSurface('missing-marketplace-cart')).toThrow(
      'no production [data-surface="missing-marketplace-cart"] root is mounted',
    );
  });

  async function captureCart(sceneName: string) {
    await parkVrtHover();
    const surface = expectVrtSurface('marketplace-cart');
    await expect(surface).toMatchScreenshot(sceneName, VRT_DENSE_CHROME_SCREENSHOT);
  }

  function expectDesktopSummaryGeometry(viewportHeight: number) {
    const surface = document.querySelector('[data-surface="marketplace-cart"]');
    const summary = document.querySelector('[data-testid="marketplace-cart-summary"]');
    if (!(surface instanceof HTMLElement) || !(summary instanceof HTMLElement)) {
      throw new Error('VRT geometry rejected: production cart surface or summary is missing');
    }

    const surfaceRect = surface.getBoundingClientRect();
    const summaryRect = summary.getBoundingClientRect();
    expect(summaryRect.top).toBeGreaterThanOrEqual(surfaceRect.top);
    expect(Math.abs(summaryRect.top - surfaceRect.top)).toBeLessThanOrEqual(2);
    expect(summaryRect.bottom).toBeLessThanOrEqual(viewportHeight);
    expect(summaryRect.right).toBeLessThanOrEqual(document.documentElement.clientWidth);
    expect(summaryRect.left).toBeGreaterThanOrEqual(0);
  }

  function expectMobileWorkflowGeometry() {
    const surface = document.querySelector('[data-surface="marketplace-cart"]');
    if (!(surface instanceof HTMLElement)) throw new Error('VRT geometry rejected: production cart surface is missing');

    const items = surface.querySelector('[data-testid="marketplace-cart-items"]');
    const summary = surface.querySelector('[data-testid="marketplace-cart-summary"]');
    const checkout = surface.querySelector('[aria-label="Checkout"]');
    if (!(items instanceof HTMLElement) || !(summary instanceof HTMLElement) || !(checkout instanceof HTMLElement)) {
      throw new Error('VRT geometry rejected: missing cart items, summary, or Checkout region');
    }
    expect(items.getBoundingClientRect().top).toBeLessThanOrEqual(summary.getBoundingClientRect().top);
    expect(checkout.getBoundingClientRect().bottom - surface.getBoundingClientRect().top).toBeLessThanOrEqual(
      surface.scrollHeight,
    );
  }

  it('renders a single-seller cart at desktop viewport', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;
    view.isLoading = false;

    await renderForVRT(<MarketplaceCart />, { viewport: VRT_VIEWPORT_DESKTOP });
    await captureCart('cart-single-seller-desktop');
  });

  it('renders a single-seller cart at mobile viewport', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;
    view.isLoading = false;

    await renderForVRT(<MarketplaceCart />, { viewport: VRT_VIEWPORT_MOBILE });
    await captureCart('cart-single-seller-mobile');
  });

  it('renders a multi-seller cart at desktop viewport', async () => {
    const { multiSeller } = await fixtures;
    view.items = multiSeller;
    view.isLoading = false;

    await renderForVRT(<MarketplaceCart />, { viewport: VRT_VIEWPORT_DESKTOP });
    await captureCart('cart-multi-seller-desktop');
  });

  it('keeps the desktop summary aligned and above the fold for multi-seller carts', async () => {
    const { multiSeller } = await fixtures;
    view.items = multiSeller;
    view.isLoading = false;

    await renderForVRT(<MarketplaceCart />, { viewport: VRT_VIEWPORT_DESKTOP });
    expectDesktopSummaryGeometry(VRT_VIEWPORT_DESKTOP.height);
  });

  it('rejects the old row-coupled desktop summary geometry', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;
    view.isLoading = false;

    await renderForVRT(<MarketplaceCart />, { viewport: VRT_VIEWPORT_DESKTOP });
    const summary = document.querySelector('[data-testid="marketplace-cart-summary"]');
    if (!(summary instanceof HTMLElement)) throw new Error('VRT calibration rejected: production summary is missing');
    summary.style.gridRowStart = '2';

    expect(() => expectDesktopSummaryGeometry(VRT_VIEWPORT_DESKTOP.height)).toThrow();
  });

  it('renders a multi-seller cart at mobile viewport', async () => {
    const { multiSeller } = await fixtures;
    view.items = multiSeller;
    view.isLoading = false;

    await renderForVRT(<MarketplaceCart />, { viewport: VRT_VIEWPORT_MOBILE });
    await captureCart('cart-multi-seller-mobile');
  });

  it('keeps mobile cart items above the Checkout summary', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;
    view.isLoading = false;

    await renderForVRT(<MarketplaceCart />, { viewport: VRT_VIEWPORT_MOBILE });
    expectMobileWorkflowGeometry();
  });

  it('renders a cart with a stale item whose variant is gone at desktop viewport', async () => {
    const { staleItem } = await fixtures;
    view.items = staleItem;
    view.isLoading = false;

    await renderForVRT(<MarketplaceCart />, { viewport: VRT_VIEWPORT_DESKTOP });
    await captureCart('cart-stale-item-desktop');
  });

  it('renders the empty cart at desktop viewport', async () => {
    view.items = [];
    view.isLoading = false;

    await renderForVRT(<MarketplaceCart />, { viewport: VRT_VIEWPORT_DESKTOP });
    await captureCart('cart-empty-desktop');
  });

  it('renders the loading state at desktop viewport', async () => {
    view.items = [];
    view.isLoading = true;

    await renderForVRT(<MarketplaceCart />, { viewport: VRT_VIEWPORT_DESKTOP });
    await captureCart('cart-loading-desktop');
  });

  it('renders an accepted-offer group without mixing it into ordinary checkout', async () => {
    const { singleSeller } = await fixtures;
    const offer = parseContractFaithfulOffer('accepted', 'active');
    view.items = [
      ...singleSeller,
      {
        ...singleSeller[0],
        id: 'award-cart-line',
        awardId: offer.award?.id,
        pricingSource: 'offer',
      },
    ];
    view.offers = [offer];
    view.isLoading = false;

    await renderForVRT(<MarketplaceCart />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    expect(document.querySelector('[data-surface="marketplace-award-cart-group"]')).toBeTruthy();
    await captureCart('cart-award-group-desktop');
  });
});
