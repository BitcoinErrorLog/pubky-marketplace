// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtCommerceController } from '@/test/mocks/marketplace-vrt';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceListingCard } from '@/organisms/Marketplace/MarketplaceListingCard';
import { MarketplaceReputationHeader } from '@/organisms/Marketplace/MarketplaceReputationHeader';
import { MarketplaceReviewsSection } from '@/organisms/Marketplace/MarketplaceReviewsSection';
import { useAuthStore } from '@/stores/auth/auth.store';
import { setSocialHost } from '@/test-utils/social-host';

// The Phase 2 public review surfaces in every honest state: stars on catalog
// cards (only when the index reported reviews), the rating header (rated /
// "New seller"), and the review list with the D5 labeling spectrum —
// verified-by-trusted-attestor, attested-by-unrecognized-signer, unverified —
// plus the D7 subject response threaded beneath and the subject's composer.

/** The staging service's attestor — one of the two entries on the client trust list (staging + production). */
const TRUSTED_ATTESTOR = 'ws343aqzmcahagojhmhkbri8odqz9iqg61woxbkh9fd3bxhqomdy';
const SELLER = 's'.repeat(52);
const BUYER_A = 'a'.repeat(52);
const BUYER_B = 'b'.repeat(52);
const BUYER_C = 'c'.repeat(52);

const controllerState = vi.hoisted(() => ({
  reputation: { status: 'unavailable' } as unknown,
  reviews: [] as unknown[],
  ownResponse: null as unknown,
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    ...createMarketplaceVrtCommerceController(),
    fetchSellerReputation: vi.fn(async () => controllerState.reputation),
    fetchSellerReviews: vi.fn(async () => ({ status: 'ok', reviews: controllerState.reviews })),
    fetchListingReviews: vi.fn(async () => ({ status: 'ok', reviews: controllerState.reviews })),
    getOwnMarketplaceReviewResponse: vi.fn(async () => controllerState.ownResponse),
    // The scenes render real MarketplaceListingCards against the real auth
    // store (one scene signs the seller in), so the cards' watch toggle
    // reaches the controller: keep the favorite statics on the mock.
    isFavorite: () => Promise.resolve(false),
    commitCreateFavorite: () => Promise.resolve(),
    commitDeleteFavorite: () => Promise.resolve(),
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace',
}));

// Deterministic BTC/USD rate and media, as in the other card VRTs.
vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: (enabled: boolean) =>
    enabled ? { satUsd: 0.001, btcUsd: 100_000, lastUpdatedAt: new Date('2026-08-21T00:00:00Z') } : null,
}));
vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  const { createMarketplaceMediaHooks } = await import('@/test/mocks/marketplace-media-hooks');
  return createMarketplaceMediaHooks(() => null);
});
vi.mock('@/hooks/useMarketplaceLiveBid/useMarketplaceLiveBid', () => ({
  useMarketplaceLiveBid: () => ({ ref: () => {}, bid: null }),
}));

function indexedReview(overrides: Record<string, unknown> = {}) {
  return {
    reviewId: '8Z8CWH8NVYQY39ZEBFGKQWWEKG',
    reviewerId: BUYER_A,
    subjectId: SELLER,
    listingOwnerId: SELLER,
    listingId: 'rangefinder_camera',
    role: 'buyer_reviewing_seller' as const,
    ratingOverall: 5,
    text: 'Exactly as described and shipped the same day.',
    verified: true,
    attestorId: TRUSTED_ATTESTOR,
    editedLate: false,
    createdAt: '2026-08-10T12:00:00.000Z',
    updatedAt: '2026-08-10T12:00:00.000Z',
    revision: 1,
    response: null,
    ...overrides,
  };
}

const REVIEW_SPECTRUM = [
  indexedReview(),
  indexedReview({
    reviewId: '8Z8CWH8NVYQY39ZEBFGKQWWEKH',
    reviewerId: BUYER_B,
    ratingOverall: 4,
    text: 'Solid seller, packaging could be sturdier.',
    attestorId: 'x'.repeat(52),
    response: {
      responderId: SELLER,
      text: 'Thanks — switched to double-boxing since this order.',
      createdAt: '2026-08-11T09:00:00.000Z',
      updatedAt: '2026-08-11T09:00:00.000Z',
      revision: 1,
    },
  }),
  indexedReview({
    reviewId: '8Z8CWH8NVYQY39ZEBFGKQWWEKJ',
    reviewerId: BUYER_C,
    ratingOverall: 2,
    text: 'Item arrived late.',
    verified: false,
    attestorId: null,
    editedLate: true,
  }),
];

const ratedSummary = {
  status: 'rated',
  summary: {
    count: 3,
    verifiedCount: 2,
    avg: 3.7,
    histogram: [0, 1, 0, 1, 1],
    responseCount: 1,
    editedLateCount: 1,
    attestors: { [TRUSTED_ATTESTOR]: 1, ['x'.repeat(52)]: 1 },
  },
};

const cardFixtures = vi.hoisted(async () => {
  const { catalogItemFromCatalogEntry } = await import('@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils');
  const { createCommerceCatalogEntryFixture } = await import('@/test/fixtures/commerce/commerce');
  const rated = catalogItemFromCatalogEntry(
    createCommerceCatalogEntryFixture({
      id: `${'s'.repeat(52)}:rangefinder_camera`,
      seller_id: 's'.repeat(52),
      listing_id: 'rangefinder_camera',
      title: '35mm rangefinder camera',
      description: 'Recently serviced mechanical rangefinder with bright optics.',
      category_id: 'electronics-cameras-film',
      condition: 'excellent',
      tags: ['film', 'camera'],
      sale_format: 'fixed_price',
      media_urls: [],
      price: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
      auction: null,
      reputation: { avg: 4.7, count: 12, verifiedCount: 9 },
      updated_at: Date.parse('2026-08-19T21:02:00.000Z'),
    }),
  );
  // A seller the index holds no reviews for: the card shows NO stars at all
  // (absence, never 0.0).
  const unrated = catalogItemFromCatalogEntry(
    createCommerceCatalogEntryFixture({
      id: `${'u'.repeat(52)}:silver_signet`,
      seller_id: 'u'.repeat(52),
      listing_id: 'silver_signet',
      title: 'Brutalist silver signet',
      description: 'Solid recycled silver ring cast and finished by hand.',
      category_id: 'fashion-jewelry-rings',
      condition: 'new',
      tags: ['silver', 'handmade'],
      sale_format: 'fixed_price',
      media_urls: [],
      price: { amountMinor: 12_000, currency: 'USD', exponent: 2 },
      auction: null,
      reputation: null,
      updated_at: Date.parse('2026-08-19T21:06:00.000Z'),
    }),
  );
  return { rated, unrated };
});

beforeEach(async () => {
  const { useMarketplaceDisplayStore } = await import('@/stores/marketplace-display/marketplace-display.store');
  useMarketplaceDisplayStore.setState({ showFxEstimate: true, measurementSystem: 'metric' });
  useAuthStore.setState({ currentUserPubky: null });
  controllerState.reputation = { status: 'unavailable' };
  controllerState.reviews = [];
  controllerState.ownResponse = null;
});

async function waitForText(fragment: string) {
  await vi.waitFor(() => {
    if (!document.body.textContent?.includes(fragment)) throw new Error(`"${fragment}" has not rendered yet.`);
  });
}

describe('Marketplace public reviews — visual regression', () => {
  it('renders a rated card with stars next to an unrated card without any at desktop viewport', async () => {
    const { rated, unrated } = await cardFixtures;
    const screen = await renderForVRT(
      <div className="grid grid-cols-4 gap-5 p-6">
        <MarketplaceListingCard listing={rated} shopName="Proof of Film" />
        <MarketplaceListingCard listing={unrated} shopName="Low Time Preference" />
      </div>,
      { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true },
    );
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('listing-cards-reputation-desktop');
  });

  it('renders the full rating header with its verified basis line at desktop viewport', async () => {
    controllerState.reputation = ratedSummary;
    const screen = await renderForVRT(
      <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-6 py-10">
        <MarketplaceReputationHeader sellerPubky={SELLER} variant="full" />
      </main>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await waitForText('verified by the marketplace attestor');
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('reputation-header-rated-full-desktop');
  });

  it('renders the explicit new-seller state at desktop viewport', async () => {
    controllerState.reputation = { status: 'new_seller' };
    const screen = await renderForVRT(
      <main className="mx-auto flex w-full max-w-xl flex-col gap-6 px-6 py-10">
        <MarketplaceReputationHeader sellerPubky={SELLER} variant="full" />
      </main>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await waitForText('New seller');
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('reputation-header-new-seller-desktop');
  });

  it('renders the D5 labeling spectrum with a threaded response at desktop viewport', async () => {
    controllerState.reviews = REVIEW_SPECTRUM;
    const screen = await renderForVRT(
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-10">
        <MarketplaceReviewsSection sellerPubky={SELLER} />
      </main>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await waitForText('Verified purchase');
    await waitForText('Attested (unrecognized attestor)');
    await waitForText('Unverified');
    await waitForText('switched to double-boxing');
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('reviews-section-spectrum-desktop');
  });

  it('links reviewers to their shop with a Profile on Pubky link under social link-out at desktop viewport', async () => {
    controllerState.reviews = REVIEW_SPECTRUM;
    setSocialHost('https://pubky.app');
    try {
      const screen = await renderForVRT(
        <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-10">
          <MarketplaceReviewsSection sellerPubky={SELLER} />
        </main>,
        { viewport: VRT_VIEWPORT_DESKTOP },
      );
      await waitForText('Verified purchase');
      await expect
        .element(screen.getByRole('link', { name: `${BUYER_A.slice(0, 8)}…` }))
        .toHaveAttribute('href', `/marketplace/shop/${BUYER_A}`);
      await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('reviews-section-social-linkout-desktop');
    } finally {
      setSocialHost(undefined);
    }
  });

  it('renders the review list at mobile viewport', async () => {
    controllerState.reviews = REVIEW_SPECTRUM;
    const screen = await renderForVRT(
      <main className="flex w-full flex-col gap-6 px-4 py-8">
        <MarketplaceReviewsSection sellerPubky={SELLER} />
      </main>,
      { viewport: VRT_VIEWPORT_MOBILE },
    );
    await waitForText('Verified purchase');
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('reviews-section-spectrum-mobile');
  });

  it('renders the empty review list honestly at desktop viewport', async () => {
    controllerState.reviews = [];
    const screen = await renderForVRT(
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-10">
        <MarketplaceReviewsSection sellerPubky={SELLER} />
      </main>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await waitForText('No reviews yet');
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('reviews-section-empty-desktop');
  });

  it('renders the subject respond affordance and open composer at desktop viewport', async () => {
    controllerState.reviews = [indexedReview()];
    useAuthStore.setState({ currentUserPubky: SELLER });
    const screen = await renderForVRT(
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 py-10">
        <MarketplaceReviewsSection sellerPubky={SELLER} />
      </main>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await waitForText('Respond');
    await screen.getByRole('button', { name: 'Respond' }).click();
    await vi.waitFor(() => {
      if (!document.querySelector('[data-cy="marketplace-review-response-composer"]')) {
        throw new Error('Composer has not opened yet.');
      }
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('reviews-section-composer-desktop');
  });
});
