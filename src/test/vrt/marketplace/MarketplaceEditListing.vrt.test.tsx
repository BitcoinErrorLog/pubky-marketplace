// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore, createMarketplaceVrtCommerceController } from '@/test/mocks/marketplace-vrt';
import { describe, expect, it, vi } from 'vitest';
import { expectVrtSurface, renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MobileHeader } from '@/molecules/MobileHeader/MobileHeader';
import { MarketplaceEditListing } from '@/templates/Marketplace/MarketplaceEditListing';

// Existing photos resolve to a deterministic data-URI so the edit studio
// shows real thumbnails without fetching homeserver bytes.
const MEDIA_DATA_URL = vi.hoisted(
  () =>
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGN4UaKEFTEMLQkAgnNfgXMIh2kAAAAASUVORK5CYII=',
);

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  const { createMarketplaceMediaHooks } = await import('@/test/mocks/marketplace-media-hooks');
  return createMarketplaceMediaHooks((uri) => (uri ? MEDIA_DATA_URL : null));
});

const fixtures = vi.hoisted(async () => {
  const { createCommerceListingFixture, COMMERCE_FIXTURE_SELLER } = await import('@/test/fixtures/commerce/commerce');
  const seller = COMMERCE_FIXTURE_SELLER;
  const image = (id: string, altText: string) => ({
    id,
    type: 'image' as const,
    url: `pubky://${seller}/pub/pubky.app/marketplace/v1/media/${id}`,
    contentHash: 'c'.repeat(64),
    mimeType: 'image/jpeg',
    byteSize: 10_000,
    width: 1_200,
    height: 1_600,
    altText,
  });
  // A complete shipped listing's delivery facts: hydration fills the
  // shipping/package fields from these, so the publish checklist renders
  // complete (a shipping record without them would leave "Shipping details"
  // outstanding — and the auction coercion to shipping would surface it).
  const shipping = {
    fulfillmentMethods: ['physical' as const],
    shippingOptions: [
      {
        id: 'ship_01',
        pricing: 'flat' as const,
        label: 'Standard shipping',
        price: { amountMinor: 1_200, currency: 'USD', exponent: 2 },
        estimatedMinDays: 3,
        estimatedMaxDays: 7,
      },
    ],
    package: { weightGrams: 800, lengthMillimeters: 320, widthMillimeters: 220, heightMillimeters: 120 },
  };
  return {
    seller,
    record: createCommerceListingFixture({
      ...shipping,
      media: [image('image_01', 'Front view'), image('image_02', 'Sole view')],
    }),
    // A digital-only listing (digital delivery design §2): no package facts,
    // no shipping option, so the edit studio hides those fields.
    digitalRecord: createCommerceListingFixture({
      listingId: 'field_guide',
      title: 'Printable field guide',
      fulfillmentMethods: ['digital' as const],
      shippingOptions: [],
      package: undefined,
      media: [image('image_01', 'Guide cover')],
    }),
    auctionRecord: createCommerceListingFixture({
      ...shipping,
      listingId: 'rangefinder_camera',
      title: '35mm rangefinder camera',
      sale: {
        format: 'auction',
        startingPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
        minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
        startsAt: '2026-08-19T20:00:00.000Z',
        endsAt: '2026-08-29T20:00:00.000Z',
        antiSnipingWindowSeconds: 120,
        antiSnipingExtensionSeconds: 120,
      },
    }),
  };
});

const view = vi.hoisted(() => ({
  record: undefined as unknown,
  currentUserPubky: '',
  digitalAvailable: false,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace/listing',
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: createMarketplaceVrtAuthStore({
    getCurrentUserPubky: () => view.currentUserPubky,
  }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    ...createMarketplaceVrtCommerceController(),
    getOrFetchListing: () =>
      view.record ? Promise.resolve(view.record) : Promise.reject(new Error('listing unavailable')),
    commitCreateMedia: () => Promise.resolve(),
    commitUpsertListing: () => Promise.resolve(),
    getShippingPresets: () => Promise.resolve([]),
    commitUpsertShippingPreset: () => Promise.resolve(),
    // Pickup is unavailable on this capture's deployment: the studio renders
    // the deterministic unavailability note, not an async capability race.
    fetchPickupAvailable: () => Promise.resolve(false),
    fetchDigitalDeliveryCapability: () =>
      Promise.resolve({ available: view.digitalAvailable, maxBytes: view.digitalAvailable ? 52_428_800 : null }),
    // The seller's owner read (handlers/digital.rs): a live file at version 2
    // with one older version still downloaded.
    fetchSellerDigitalDelivery: () =>
      Promise.resolve({
        listingAggregateId: 'listing:field_guide',
        current: {
          kind: 'file',
          deliverableId: 'a'.repeat(32),
          version: 2,
          createdAt: '2026-09-25T10:00:00.000Z',
          contentType: 'application/pdf',
          sizeBytes: 12_582_912,
          fileName: 'Field Guide.pdf',
        },
        lastVersion: 2,
        pinnedVersions: [
          { version: 1, liveOrders: 3 },
          { version: 2, liveOrders: 1 },
        ],
      }),
  },
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

async function waitForHydration(screen: { container: HTMLElement }, title: string) {
  await vi.waitFor(() => {
    const input = screen.container.querySelector<HTMLInputElement>('#title');
    if (input?.value !== title) throw new Error('The edit form has not hydrated yet.');
  });
}

describe('Marketplace edit listing — visual regression', () => {
  it('renders the prefilled edit studio with existing photos at desktop viewport', async () => {
    const { seller, record } = await fixtures;
    view.record = record;
    view.currentUserPubky = seller;

    const screen = await renderForVRT(<MarketplaceEditListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await waitForHydration(screen, record.title);
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('edit-listing-prefilled-desktop');
  });

  it('renders the prefilled edit studio at mobile viewport', async () => {
    const { seller, record } = await fixtures;
    view.record = record;
    view.currentUserPubky = seller;

    const screen = await renderForVRT(<MarketplaceEditListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: VRT_VIEWPORT_MOBILE,
    });
    await waitForHydration(screen, record.title);
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('edit-listing-prefilled-mobile');
  });

  it('keeps every step of both rails below the main header after scrolling at desktop viewport', async () => {
    const { seller, record } = await fixtures;
    view.record = record;
    view.currentUserPubky = seller;

    const screen = await renderForVRT(<MarketplaceEditListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await waitForHydration(screen, record.title);
    const root = screen.getByTestId(VRT_ROOT_TESTID).element() as HTMLElement;
    root.scrollTop = 900;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    expect(root.scrollTop).toBe(900);

    const headerOffset = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue('--header-offset-main'),
    );
    expect(headerOffset).toBe(144);
    const rootTop = root.getBoundingClientRect().top;
    for (const testId of ['listing-section-rail']) {
      const rail = screen.getByTestId(testId).element() as HTMLElement;
      expect(rail.closest('aside')!.getBoundingClientRect().top - rootTop).toBeCloseTo(headerOffset, 0);
      const steps = Array.from(rail.querySelectorAll('button'));
      expect(steps).toHaveLength(5);
      for (const step of steps) {
        expect(step.getBoundingClientRect().top - rootTop).toBeGreaterThanOrEqual(headerOffset);
      }
    }
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('edit-listing-rails-scrolled-desktop');
  });

  it('keeps the mobile step bar and step jumps below the mobile header at mobile viewport', async () => {
    const { seller, record } = await fixtures;
    view.record = record;
    view.currentUserPubky = seller;

    // ContentLayout is mocked in this file; the edit page's real mobile chrome
    // is this header with both side buttons off.
    const screen = await renderForVRT(
      <>
        <MobileHeader showLeftButton={false} showRightButton={false} />
        <MarketplaceEditListing sellerPubky={seller} listingId="boots_01" />
      </>,
      { viewport: VRT_VIEWPORT_MOBILE },
    );
    await waitForHydration(screen, record.title);
    const root = screen.getByTestId(VRT_ROOT_TESTID).element() as HTMLElement;
    const header = root.firstElementChild as HTMLElement;
    const stepper = screen.getByTestId('listing-mobile-stepper').element() as HTMLElement;
    const rootTop = () => root.getBoundingClientRect().top;
    const headerBottom = header.getBoundingClientRect().bottom - rootTop();
    expect(headerBottom).toBe(96);
    expect(parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-offset-mobile'))).toBe(
      headerBottom,
    );

    root.scrollTop = 1_200;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    // Firefox reports sub-pixel scroll and layout positions.
    expect(root.scrollTop).toBeCloseTo(1_200, 0);
    expect(header.getBoundingClientRect().bottom - rootTop()).toBeCloseTo(headerBottom, 0);
    expect(stepper.getBoundingClientRect().top - rootTop()).toBeGreaterThanOrEqual(headerBottom - 0.5);

    const section = document.getElementById('listing-section-item') as HTMLElement;
    const nextFrames = () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    // The step jump scrolls smoothly, and in Firefox the frame a smooth scroll
    // settles on varies run to run. This scene checks where the jump lands, not
    // the animation, so it jumps instantly here.
    const nativeScrollIntoView = Element.prototype.scrollIntoView;
    const instantScrollIntoView = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (
      this: Element,
      arg?: boolean | ScrollIntoViewOptions,
    ) {
      nativeScrollIntoView.call(this, typeof arg === 'object' ? { ...arg, behavior: 'instant' } : arg);
    });
    root.style.scrollBehavior = 'auto';
    try {
      await screen.getByRole('button', { name: 'Next' }).click();
      expect(instantScrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'start' }));
      expect(instantScrollIntoView.mock.contexts).toContain(section);
    } finally {
      instantScrollIntoView.mockRestore();
    }
    await nextFrames();
    // The jump lands on the section's resting position: its offset in the
    // scroller less its scroll-margin. It can be a half pixel (1010.5 here);
    // pin it as is. Firefox ignores a rounded assignment from a half pixel.
    const offsetInScroller = section.getBoundingClientRect().top - rootTop() + root.scrollTop;
    const restingScrollTop = offsetInScroller - parseFloat(getComputedStyle(section).scrollMarginTop);
    expect(Math.abs(restingScrollTop - 1_200)).toBeGreaterThan(1);
    expect(Math.abs(root.scrollTop - restingScrollTop)).toBeLessThan(1);
    root.scrollTop = restingScrollTop;
    window.scrollTo(0, 0);
    await nextFrames();
    expect(Math.abs(root.scrollTop - restingScrollTop)).toBeLessThan(0.5);
    const stepperBottom = stepper.getBoundingClientRect().bottom - rootTop();
    const sectionTop = section.getBoundingClientRect().top - rootTop();
    expect(stepperBottom).toBeGreaterThan(headerBottom);
    expect(sectionTop).toBeGreaterThanOrEqual(stepperBottom - 0.5);
    expect(sectionTop - stepperBottom).toBeLessThan(48);
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('edit-listing-mobile-stepper-scrolled-mobile');
  });

  it('renders a digital-only listing in the edit studio at desktop viewport', async () => {
    const { seller, digitalRecord } = await fixtures;
    view.record = digitalRecord;
    view.currentUserPubky = seller;
    view.digitalAvailable = true;

    const screen = await renderForVRT(<MarketplaceEditListing sellerPubky={seller} listingId="field_guide" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await waitForHydration(screen, digitalRecord.title);
    await vi.waitFor(() => {
      const digital = screen.container.querySelector('#listing-delivery-digital');
      if (digital?.getAttribute('data-state') !== 'checked') throw new Error('Digital delivery is not checked yet.');
      if (!screen.container.querySelector('[data-testid="digital-delivery-current"]')) {
        throw new Error('The digital delivery panel has not loaded yet.');
      }
    });
    screen.container.querySelector('[data-testid="listing-delivery-options"]')?.scrollIntoView({ block: 'center' });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('edit-listing-digital-desktop');
    await expect(await expectVrtSurface('digital-delivery-editor')).toMatchScreenshot('edit-listing-digital-panel-desktop');
    view.digitalAvailable = false;
  });

  it('renders the locked auction terms notice at desktop viewport', async () => {
    const { seller, auctionRecord } = await fixtures;
    view.record = auctionRecord;
    view.currentUserPubky = seller;

    const screen = await renderForVRT(<MarketplaceEditListing sellerPubky={seller} listingId="rangefinder_camera" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await waitForHydration(screen, auctionRecord.title);
    // The price/sale-format lockout note sits in the pricing card below the
    // crop; bring it into view for the baseline.
    screen.container.querySelector('#saleFormat')?.scrollIntoView({ block: 'center' });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('edit-listing-auction-locked-desktop');
  });

  it('renders the not-owner refusal at desktop viewport', async () => {
    const { seller, record } = await fixtures;
    view.record = record;
    view.currentUserPubky = 'z'.repeat(52);

    const screen = await renderForVRT(<MarketplaceEditListing sellerPubky={seller} listingId="boots_01" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await vi.waitFor(() => {
      if (!screen.container.textContent?.includes('Only the seller can edit this listing')) {
        throw new Error('The refusal state has not rendered yet.');
      }
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('edit-listing-not-owner-desktop');
  });

  it('renders the load-failure state at desktop viewport', async () => {
    const { seller } = await fixtures;
    view.record = undefined;
    view.currentUserPubky = seller;

    const screen = await renderForVRT(<MarketplaceEditListing sellerPubky={seller} listingId="gone_listing" />, {
      viewport: VRT_VIEWPORT_DESKTOP,
    });
    await vi.waitFor(() => {
      if (!screen.container.textContent?.includes('Listing unavailable')) {
        throw new Error('The load-failure state has not rendered yet.');
      }
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('edit-listing-unavailable-desktop');
  });
});
