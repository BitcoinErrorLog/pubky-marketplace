// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { expectVrtSurface, parkVrtHover, renderForVRT, VRT_DENSE_CHROME_SCREENSHOT } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceCheckout } from '@/templates/Marketplace/MarketplaceCheckout';

const VRT_VIEWPORT_LAPTOP = { width: 1280, height: 800 };

vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: (enabled: boolean) =>
    enabled ? { satUsd: 0.001, btcUsd: 100_000, lastUpdatedAt: new Date('2026-08-21T00:00:00Z') } : null,
}));

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

  const digitalListing = (
    listingId: string,
    title: string,
    fulfillmentMethods: Array<'physical' | 'shipping' | 'digital'>,
  ) =>
    toCommerceListingModel(
      createCommerceListingFixture({
        listingId,
        title,
        fulfillmentMethods,
        ...(fulfillmentMethods.includes('shipping') ? {} : { package: undefined, shippingOptions: [] }),
        variants: [{ id: 'variant_01', options: {}, quantity: 5, mediaIds: ['image_01'], enabled: true }],
        sale: {
          format: 'fixed_price',
          unitPrice: { amountMinor: 1_500, currency: 'USD', exponent: 2 },
          acceptsOffers: false,
        },
      }),
    );
  const guide = digitalListing('field_guide', 'Field guide to film cameras (PDF)', ['digital']);
  const album = digitalListing('night_train_album', 'Night Train, the album', ['physical', 'shipping', 'digital']);
  const pattern = digitalListing('jacket_pattern', 'Selvedge jacket sewing pattern', ['digital']);

  return {
    digitalOnly: [item(guide, 'variant_01', 1)],
    digitalMixed: [item(boots, 'variant_42', 1), item(album, 'variant_01', 1), item(pattern, 'variant_01', 1)],
    singleSeller: [item(boots, 'variant_42', 1), item(boots, 'variant_43', 1)],
    multiSeller: [item(boots, 'variant_42', 2), item(jacket, 'variant_01', 1), item(camera, 'variant_01', 1)],
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
  listing: {
    record: {
      variants: Array<{ id: string; priceOverride?: CartItemMoneyLike }>;
      sale: { format: string; unitPrice?: CartItemMoneyLike };
    };
  };
}

const view = vi.hoisted(() => ({
  items: [] as unknown[],
  isLoading: false,
  adapterMode: 'sandbox' as string,
  deployEnv: 'staging' as 'production' | 'staging' | undefined,
  hasMarketplaceSession: false,
  addresses: [] as unknown[],
  selectedAddressId: null as string | null,
  fulfillmentOptions: {} as Record<string, Array<'shipping' | 'pickup'>>,
  fulfillmentEffective: {} as Record<string, 'shipping' | 'pickup'>,
  requiresDeliveryAddress: true,
  orderCount: 1,
  fulfillmentByItem: {} as Record<string, 'shipping' | 'pickup' | 'digital'>,
  digitalKinds: {} as Record<string, 'file' | 'link' | 'text' | 'email' | 'message' | null>,
  digitalChoosable: [] as string[],
  requiresDeliveryEmail: false,
  hasInstantDigitalLine: false,
  hasManualDigitalLine: false,
  usdtAvailable: false,
}));

const savedAddresses = vi.hoisted(() => {
  const owner = 'b'.repeat(52);
  return [
    {
      id: `${owner}:addr_home`,
      owner_id: owner,
      label: 'Home',
      name: 'Alice Buyer',
      line1: '1 Market Street',
      line2: '',
      city: 'New York',
      region: 'NY',
      postal_code: '10001',
      country_code: 'US',
      is_default: true,
      last_used_at: 1_755_000_000_000,
      created_at: 1_754_000_000_000,
      updated_at: 1_755_000_000_000,
    },
    {
      id: `${owner}:addr_work`,
      owner_id: owner,
      label: 'Work',
      name: 'Alice Buyer',
      line1: '77 Broadway, Floor 4',
      line2: '',
      city: 'New York',
      region: 'NY',
      postal_code: '10006',
      country_code: 'US',
      is_default: false,
      last_used_at: null,
      created_at: 1_754_100_000_000,
      updated_at: 1_754_100_000_000,
    },
  ];
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/marketplace/checkout',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/config/commerce', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/commerce')>();
  return { ...actual, getCommerceAdapterMode: () => view.adapterMode };
});

vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>();
  return { ...actual, getDeployEnv: () => view.deployEnv };
});

vi.mock('@/hooks/useMarketplaceCart/useMarketplaceCart', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useMarketplaceCart/useMarketplaceCart')>();
  const { sumMoneyByAsset } = await import('@/libs/commerce/pricing');
  return {
    ...actual,
    useMarketplaceCart: () => {
      const items = view.items as CartItemLike[];
      return {
        items,
        ordinaryItems: items,
        awardItems: [],
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
        groups: actual.groupMarketplaceCartItems(items as never),
      };
    },
  };
});

vi.mock('@/hooks/useMarketplaceCheckout/useMarketplaceCheckout', async () => {
  const { useForm } = await import('react-hook-form');
  const { marketplaceCheckoutDefaults } = await import('@/hooks/useMarketplaceCheckout/useMarketplaceCheckout.types');
  return {
    useMarketplaceCheckout: () => ({
      form: useForm({ defaultValues: marketplaceCheckoutDefaults }),
      submit: vi.fn(async () => false),
      pay: vi.fn(async () => ({ ok: false, orderIds: [], boundOrders: [] })),
      isPaying: false,
      needsSession: false,
      sessionError: null,
      hasMarketplaceSession: view.hasMarketplaceSession,
      addresses: view.addresses,
      selectedAddressId: view.selectedAddressId,
      selectAddress: vi.fn(),
      fulfillmentOptionsForSeller: (sellerPubky: string) => view.fulfillmentOptions[sellerPubky] ?? ['shipping'],
      fulfillmentForSeller: (sellerPubky: string) => view.fulfillmentEffective[sellerPubky] ?? 'shipping',
      setFulfillmentChoice: vi.fn(),
      requiresDeliveryAddress: view.requiresDeliveryAddress,
      hasFulfillmentConflict: false,
      isPickupCapabilityLoadingForSeller: () => false,
      orderCount: view.orderCount,
      rememberAddress: vi.fn(async () => {}),
      fulfillmentForItem: (itemId: string) => {
        const line = (view.items as Array<{ id: string; listing: { record: { ownerPubky: string } } }>).find(
          ({ id }) => id === itemId,
        );
        return (
          view.fulfillmentByItem[itemId] ??
          view.fulfillmentEffective[line?.listing.record.ownerPubky ?? ''] ??
          'shipping'
        );
      },
      setDigitalChoice: vi.fn(),
      canChooseDigitalForItem: (itemId: string) => view.digitalChoosable.includes(itemId),
      digitalKindForItem: (itemId: string) => view.digitalKinds[itemId],
      isDigitalCapabilityLoading: false,
      digitalNotReadyItemIds: [],
      isDigitalReady: true,
      requiresDeliveryEmail: view.requiresDeliveryEmail,
      hasInstantDigitalLine: view.hasInstantDigitalLine,
      hasManualDigitalLine: view.hasManualDigitalLine,
    }),
  };
});

vi.mock('@/hooks/useMarketplaceOrders/useMarketplaceOrders', () => ({
  useMarketplaceOrders: () => ({
    orders: [],
    isLoading: false,
    error: null,
    needsSession: false,
    adapterMode: view.adapterMode,
    refresh: vi.fn(),
    advancePayment: vi.fn(),
    actOnOrder: vi.fn(),
  }),
}));

vi.mock('@/hooks/useMarketplaceOffers/useMarketplaceOffers', () => ({
  useMarketplaceOffers: () => ({ offers: [], isLoading: false, refresh: vi.fn(async () => {}) }),
}));

vi.mock('@/hooks/useMarketplaceOfferCheckout/useMarketplaceOfferCheckout', () => ({
  useMarketplaceOfferCheckout: () => ({ submit: vi.fn(), isSubmitting: false }),
}));

vi.mock('@/hooks/useMarketplaceCartCount/useMarketplaceCartCount', () => ({
  useMarketplaceCartCount: () => 3,
}));

vi.mock('@/hooks/useMarketplaceActivityUnread/useMarketplaceActivityUnread', () => ({
  useMarketplaceActivityUnread: () => 2,
}));

vi.mock('@/hooks/useMarketplaceSessionConnect/useMarketplaceSessionConnect', () => ({
  useMarketplaceSessionConnect: () => ({
    status: 'idle',
    authorizationUrl: '',
    errorMessage: null,
    requestsFullGrant: true,
    requestsGrantReconnect: false,
    start: vi.fn(),
    cancel: vi.fn(),
    copyAuthUrl: vi.fn(async () => {}),
    openInRing: vi.fn(),
    isOpeningRing: false,
  }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getSellerPaymentConfig: vi.fn(async () => ({
      bitcoinAvailable: true,
      bitcoinOfferAvailable: true,
      paypalAvailable: true,
      usdtAvailable: view.usdtAvailable,
    })),
    fetchUsdtPaymentsAvailable: vi.fn(async () => view.usdtAvailable),
    getIndicativeBtcRate: vi.fn(async () => null),
  },
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

beforeEach(async () => {
  const { useMarketplaceDisplayStore } = await import('@/stores/marketplace-display/marketplace-display.store');
  useMarketplaceDisplayStore.setState({ showFxEstimate: true, measurementSystem: 'metric' });
  view.items = [];
  view.isLoading = false;
  view.hasMarketplaceSession = false;
  view.adapterMode = 'sandbox';
  view.deployEnv = 'staging';
  view.addresses = [];
  view.selectedAddressId = null;
  view.fulfillmentOptions = {};
  view.fulfillmentEffective = {};
  view.requiresDeliveryAddress = true;
  view.orderCount = 1;
  view.fulfillmentByItem = {};
  view.digitalKinds = {};
  view.digitalChoosable = [];
  view.requiresDeliveryEmail = false;
  view.hasInstantDigitalLine = false;
  view.hasManualDigitalLine = false;
  view.usdtAvailable = false;
  window.history.replaceState(null, '', '/marketplace/checkout');
});

describe('Marketplace checkout — visual regression', () => {
  it('rejects a missing production surface marker', () => {
    expect(() => expectVrtSurface('missing-marketplace-checkout')).toThrow(
      'no production [data-surface="missing-marketplace-checkout"] root is mounted',
    );
  });

  async function waitForPaymentMethods() {
    await vi.waitFor(() => {
      if (!document.querySelector('[data-testid="marketplace-checkout-method-bitcoin"]')) {
        throw new Error('Payment methods have not loaded yet.');
      }
    });
  }

  async function captureCheckout(sceneName: string, waitForMethods = true) {
    if (waitForMethods) await waitForPaymentMethods();
    await parkVrtHover();
    const surface = await expectVrtSurface('marketplace-checkout');
    await expect(surface).toMatchScreenshot(sceneName, VRT_DENSE_CHROME_SCREENSHOT);
  }

  function expectDesktopSummaryGeometry(viewportHeight: number) {
    const summary = document.querySelector('[data-testid="marketplace-checkout-summary"]');
    const grid = summary?.parentElement;
    if (!(summary instanceof HTMLElement) || !(grid instanceof HTMLElement)) {
      throw new Error('VRT geometry rejected: production checkout summary or its grid is missing');
    }

    const gridRect = grid.getBoundingClientRect();
    const summaryRect = summary.getBoundingClientRect();
    const pay = document.querySelector('[data-testid="marketplace-checkout-pay"]');
    if (!(pay instanceof HTMLElement)) {
      throw new Error('VRT geometry rejected: production Pay control is missing');
    }
    const payRect = pay.getBoundingClientRect();
    expect(summaryRect.top).toBeGreaterThanOrEqual(gridRect.top);
    expect(Math.abs(summaryRect.top - gridRect.top)).toBeLessThanOrEqual(2);
    expect(payRect.bottom).toBeLessThanOrEqual(viewportHeight + 2);
    expect(summaryRect.right).toBeLessThanOrEqual(document.documentElement.clientWidth);
    expect(summaryRect.left).toBeGreaterThanOrEqual(0);
  }

  function expectMobileWorkflowGeometry() {
    const surface = document.querySelector('[data-surface="marketplace-checkout"]');
    if (!(surface instanceof HTMLElement)) {
      throw new Error('VRT geometry rejected: production checkout surface is missing');
    }

    const labels = ['Delivery address', 'Order summary', 'Payment method'];
    const regions = labels.map((label) => {
      const region = surface.querySelector(`[aria-label="${label}"]`);
      if (!(region instanceof HTMLElement)) throw new Error(`VRT geometry rejected: missing ${label} region`);
      return region;
    });
    expect(regions.map((region) => region.getBoundingClientRect().top)).toEqual(
      [...regions].map((region) => region.getBoundingClientRect().top).sort((left, right) => left - right),
    );
    expect(regions[2].getBoundingClientRect().bottom - surface.getBoundingClientRect().top).toBeLessThanOrEqual(
      surface.scrollHeight,
    );
  }

  it('renders a single-seller checkout at desktop viewport', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;

    await renderForVRT(<MarketplaceCheckout />, { viewport: VRT_VIEWPORT_DESKTOP });
    await captureCheckout('checkout-single-seller-desktop');
  });

  it('renders a single-seller checkout at mobile viewport', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;

    await renderForVRT(<MarketplaceCheckout />, { viewport: VRT_VIEWPORT_MOBILE });
    await captureCheckout('checkout-single-seller-mobile');
  });

  // Digital delivery design §3 "Checkout".
  it('renders an all-digital checkout at desktop viewport', async () => {
    const { digitalOnly } = await fixtures;
    const [guide] = digitalOnly;
    view.items = digitalOnly;
    view.requiresDeliveryAddress = false;
    view.fulfillmentByItem = { [guide.id]: 'digital' };
    view.digitalKinds = { [guide.id]: 'file' };
    view.hasInstantDigitalLine = true;

    await renderForVRT(<MarketplaceCheckout />, { viewport: VRT_VIEWPORT_DESKTOP });
    await captureCheckout('checkout-digital-only-desktop');
  });

  it('renders shipped, picked-digital and emailed lines from one seller at desktop viewport', async () => {
    const { digitalMixed } = await fixtures;
    const [, album, pattern] = digitalMixed;
    view.items = digitalMixed;
    view.orderCount = 2;
    view.fulfillmentByItem = { [album.id]: 'digital', [pattern.id]: 'digital' };
    view.digitalKinds = { [album.id]: 'link', [pattern.id]: 'email' };
    view.digitalChoosable = [album.id];
    view.requiresDeliveryEmail = true;
    view.hasInstantDigitalLine = true;
    view.hasManualDigitalLine = true;

    await renderForVRT(<MarketplaceCheckout />, { viewport: VRT_VIEWPORT_DESKTOP });
    await captureCheckout('checkout-digital-mixed-desktop');
    await expect(await expectVrtSurface('checkout-delivery-email')).toMatchScreenshot(
      'checkout-delivery-email-desktop',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  it('renders a multi-seller checkout at desktop viewport', async () => {
    const { multiSeller } = await fixtures;
    view.items = multiSeller;
    view.orderCount = 2;

    await renderForVRT(<MarketplaceCheckout />, { viewport: VRT_VIEWPORT_DESKTOP });
    await captureCheckout('checkout-multi-seller-desktop');
  });

  it('keeps the desktop summary aligned and above the fold', async () => {
    const { multiSeller } = await fixtures;
    view.items = multiSeller;
    view.orderCount = 2;

    await renderForVRT(<MarketplaceCheckout />, { viewport: VRT_VIEWPORT_DESKTOP });
    await waitForPaymentMethods();
    expectDesktopSummaryGeometry(VRT_VIEWPORT_DESKTOP.height);
  });

  it('keeps pickup guidance and guarantee before Pay at laptop width', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;
    view.fulfillmentEffective = { [singleSeller[0].listing.record.ownerPubky]: 'pickup' };
    view.fulfillmentOptions = { [singleSeller[0].listing.record.ownerPubky]: ['pickup'] };
    view.requiresDeliveryAddress = false;

    const screen = await renderForVRT(<MarketplaceCheckout />, { viewport: VRT_VIEWPORT_LAPTOP });
    await waitForPaymentMethods();

    const pay = screen.container.querySelector('[data-testid="marketplace-checkout-pay"]');
    const guarantee = screen.container.querySelector('[data-testid="marketplace-checkout-guarantee"]');
    if (!(pay instanceof HTMLElement) || !(guarantee instanceof HTMLElement)) {
      throw new Error('VRT geometry rejected: Pay control or guarantee is missing');
    }
    expect(guarantee.textContent).toContain('Local pickup');
    expect(guarantee.getBoundingClientRect().bottom).toBeLessThanOrEqual(pay.getBoundingClientRect().top);
    await captureCheckout('checkout-pickup-laptop-1280');
  });

  it('keeps mobile checkout regions in natural workflow order', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;

    await renderForVRT(<MarketplaceCheckout />, { viewport: VRT_VIEWPORT_MOBILE });
    await waitForPaymentMethods();
    expectMobileWorkflowGeometry();
  });

  it('renders the checkout with the saved-address picker at desktop viewport', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;
    view.addresses = savedAddresses;
    view.selectedAddressId = (savedAddresses[0] as { id: string }).id;

    await renderForVRT(<MarketplaceCheckout />, { viewport: VRT_VIEWPORT_DESKTOP });
    await captureCheckout('checkout-address-picker-desktop');
  });

  it('renders the checkout with the saved-address picker at mobile viewport', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;
    view.addresses = savedAddresses;
    view.selectedAddressId = (savedAddresses[0] as { id: string }).id;

    await renderForVRT(<MarketplaceCheckout />, { viewport: VRT_VIEWPORT_MOBILE });
    await captureCheckout('checkout-address-picker-mobile');
  });

  it('renders the empty checkout at desktop viewport', async () => {
    view.items = [];

    await renderForVRT(<MarketplaceCheckout />, { viewport: VRT_VIEWPORT_DESKTOP });
    await captureCheckout('checkout-empty-desktop', false);
  });

  it('renders the durable-mode checkout labels at desktop viewport', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;
    view.adapterMode = 'transaction-service';
    view.hasMarketplaceSession = true;

    await renderForVRT(<MarketplaceCheckout />, { viewport: VRT_VIEWPORT_DESKTOP });
    await captureCheckout('checkout-durable-desktop');
  });

  it('renders USDT beside Bitcoin and PayPal, unselected, at desktop viewport', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;
    view.adapterMode = 'transaction-service';
    view.deployEnv = 'production';
    view.hasMarketplaceSession = true;
    view.usdtAvailable = true;

    await renderForVRT(<MarketplaceCheckout />, { viewport: VRT_VIEWPORT_DESKTOP });
    await vi.waitFor(() => {
      if (!document.querySelector('[data-testid="marketplace-checkout-method-usdt"]')) {
        throw new Error('USDT has not loaded yet.');
      }
    });
    await captureCheckout('checkout-usdt-offered-desktop');
  });

  it('renders the USDT amount, network and Bitkit hint once USDT is chosen at desktop viewport', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;
    view.adapterMode = 'transaction-service';
    view.deployEnv = 'production';
    view.hasMarketplaceSession = true;
    view.usdtAvailable = true;

    await renderForVRT(<MarketplaceCheckout />, { viewport: VRT_VIEWPORT_DESKTOP });
    await vi.waitFor(() => {
      const button = document.querySelector('[data-testid="marketplace-checkout-method-usdt"]');
      if (!(button instanceof HTMLElement)) throw new Error('USDT has not loaded yet.');
      button.click();
    });
    await vi.waitFor(() => {
      if (!document.querySelector('[data-testid="marketplace-checkout-usdt-amount"]')) {
        throw new Error('The USDT amount has not rendered yet.');
      }
    });
    await captureCheckout('checkout-usdt-selected-desktop');
  });

  it('renders the USDT amount, network and Bitkit hint once USDT is chosen at mobile viewport', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;
    view.adapterMode = 'transaction-service';
    view.deployEnv = 'production';
    view.hasMarketplaceSession = true;
    view.usdtAvailable = true;

    await renderForVRT(<MarketplaceCheckout />, { viewport: VRT_VIEWPORT_MOBILE });
    await vi.waitFor(() => {
      const button = document.querySelector('[data-testid="marketplace-checkout-method-usdt"]');
      if (!(button instanceof HTMLElement)) throw new Error('USDT has not loaded yet.');
      button.click();
    });
    await vi.waitFor(() => {
      if (!document.querySelector('[data-testid="marketplace-checkout-usdt-amount"]')) {
        throw new Error('The USDT amount has not rendered yet.');
      }
    });
    await captureCheckout('checkout-usdt-selected-mobile');
  });

  it('renders the locks-paykit checkout labels at desktop viewport', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;
    view.adapterMode = 'locks-paykit';
    view.deployEnv = 'production';
    view.hasMarketplaceSession = true;

    await renderForVRT(<MarketplaceCheckout />, { viewport: VRT_VIEWPORT_DESKTOP });
    await captureCheckout('checkout-locks-paykit-desktop');
  });

  it('renders the unapproved durable checkout at desktop viewport', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;
    view.adapterMode = 'transaction-service';
    view.hasMarketplaceSession = false;

    await renderForVRT(<MarketplaceCheckout />, { viewport: { width: 1440, height: 1600 } });
    await captureCheckout('checkout-durable-unapproved-desktop');
  });

  it('renders the logged-out durable checkout at desktop viewport', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;
    view.adapterMode = 'transaction-service';
    view.hasMarketplaceSession = false;

    await renderForVRT(<MarketplaceCheckout />, { viewport: { width: 1440, height: 1600 } });
    await captureCheckout('checkout-logged-out-desktop');
  });

  it('renders the logged-out durable checkout at mobile viewport', async () => {
    const { singleSeller } = await fixtures;
    view.items = singleSeller;
    view.adapterMode = 'transaction-service';
    view.hasMarketplaceSession = false;

    await renderForVRT(<MarketplaceCheckout />, { viewport: VRT_VIEWPORT_MOBILE });
    await captureCheckout('checkout-logged-out-mobile');
  });
});
