// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore, createMarketplaceVrtCommerceController } from '@/test/mocks/marketplace-vrt';
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { Header } from '@/organisms/Header/Header';
import { MarketplaceEditListing } from '@/templates/Marketplace/MarketplaceEditListing';

// The edit studio inside the real app shell: the root layout's `Header` and
// the page's real `ContentLayout` (not mocked here). The VRT root is the
// scroller, as the window is in the app. Sticky step rails stick only when
// no ancestor between them and that scroller clips overflow.

const MEDIA_DATA_URL = vi.hoisted(
  () =>
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGN4UaKEFTEMLQkAgnNfgXMIh2kAAAAASUVORK5CYII=',
);

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
  return {
    seller,
    record: createCommerceListingFixture({
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
      media: [image('image_01', 'Front view'), image('image_02', 'Sole view')],
    }),
  };
});

const SELLER = vi.hoisted(() => 'y'.repeat(52));

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  const { createMarketplaceMediaHooks } = await import('@/test/mocks/marketplace-media-hooks');
  return createMarketplaceMediaHooks((uri) => (uri ? MEDIA_DATA_URL : null));
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => `/marketplace/listing/${SELLER}/boots_01/edit`,
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({ sellerPubky: SELLER, listingId: 'boots_01' }),
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: createMarketplaceVrtAuthStore({ currentUserPubky: SELLER }),
}));

vi.mock('@/hooks/useRequireAuth/useRequireAuth', () => ({
  useRequireAuth: () => ({ requireAuth: (action: () => void) => action() }),
}));

vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>();
  return { ...actual, getDeployEnv: () => 'staging' };
});

vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: () => null,
}));
vi.mock('@/hooks/useMarketplaceCartCount/useMarketplaceCartCount', () => ({
  useMarketplaceCartCount: () => 0,
}));
vi.mock('@/hooks/useMarketplaceActivityUnread/useMarketplaceActivityUnread', () => ({
  useMarketplaceActivityUnread: () => 0,
}));
vi.mock('@/hooks/useMarketplaceNavAttention/useMarketplaceNavAttention', () => ({
  useMarketplaceNavAttention: () => 0,
}));
vi.mock('@/hooks/useMessagesUnread/useMessagesUnread', () => ({
  useMessagesUnread: () => 0,
}));
vi.mock('@/hooks/useCurrentUserProfile/useCurrentUserProfile', () => ({
  useCurrentUserProfile: () => ({
    userDetails: { name: 'Satoshi', image: null, indexed_at: 0 },
    currentUserPubky: SELLER,
  }),
}));
vi.mock('@/hooks/useCollectionsNavDiscovery/useCollectionsNavDiscovery', () => ({
  useCollectionsNavDiscovery: () => ({ showCollectionsNew: false, markCollectionsNavSeen: vi.fn() }),
}));
vi.mock('@/hooks/useHotTags/useHotTags', () => ({
  useHotTags: () => ({ tags: [], rawTags: [], isLoading: false, error: null, refetch: async () => {} }),
}));

vi.mock('@/controllers/commerce/commerce', async () => {
  const { record } = await fixtures;
  return {
    CommerceController: {
      ...createMarketplaceVrtCommerceController(),
      getOrFetchListing: () => Promise.resolve(record),
      commitCreateMedia: () => Promise.resolve(),
      commitUpsertListing: () => Promise.resolve(),
      getShippingPresets: () => Promise.resolve([]),
      commitUpsertShippingPreset: () => Promise.resolve(),
      fetchPickupAvailable: () => Promise.resolve(false),
    },
  };
});

const DESKTOP_WIDTHS = [1024, 1280, 1440, 1920] as const;

function nextFrames(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

describe('Marketplace edit listing in the app shell — visual regression', () => {
  for (const width of DESKTOP_WIDTHS) {
    it(`keeps both step rails below the real app header after scrolling at ${width}px`, async () => {
      const { seller, record } = await fixtures;
      expect(seller, 'the signed-in user must own the listing').toBe(SELLER);

      const screen = await renderForVRT(
        <>
          <Header />
          <MarketplaceEditListing sellerPubky={seller} listingId="boots_01" />
        </>,
        { viewport: { width, height: 900 } },
      );
      await vi.waitFor(() => {
        const input = screen.container.querySelector<HTMLInputElement>('#title');
        if (input?.value !== record.title) throw new Error('The edit form has not hydrated yet.');
      });
      const root = screen.getByTestId(VRT_ROOT_TESTID).element() as HTMLElement;
      const header = root.querySelector('header');
      if (!(header instanceof HTMLElement)) throw new Error('The app header is not mounted.');
      expect(getComputedStyle(header).display).not.toBe('none');

      root.scrollTop = 1_200;
      await nextFrames();
      expect(root.scrollTop).toBeCloseTo(1_200, 0);

      const rootTop = root.getBoundingClientRect().top;
      const headerBottom = header.getBoundingClientRect().bottom - rootTop;
      expect(headerBottom).toBeCloseTo(
        parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--header-offset-main')),
        0,
      );
      for (const testId of ['listing-section-rail', 'listing-section-status-rail']) {
        const rail = screen.getByTestId(testId).element() as HTMLElement;
        const steps = Array.from(rail.querySelectorAll('a'));
        expect(steps).toHaveLength(5);
        for (const step of steps) {
          const rect = step.getBoundingClientRect();
          expect(rect.top - rootTop).toBeGreaterThanOrEqual(headerBottom - 0.5);
          expect(rect.bottom - rootTop).toBeLessThanOrEqual(900);
        }
      }
      await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(`edit-listing-app-shell-rails-${width}`);
    });
  }
});
