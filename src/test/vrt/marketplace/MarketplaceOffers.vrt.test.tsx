// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore } from '@/test/mocks/marketplace-vrt';
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceOffers } from '@/templates/Marketplace/MarketplaceOffers';

// Covers every offer state defined by the offer schema union, split into
// viewport-sized sweeps so each state is actually visible in a baseline, plus
// the sent (outgoing) rendering and the empty/error/loading states.
const fixtures = vi.hoisted(async () => {
  const { createOffersForEveryState, OFFER_FIXTURE_SELLER } = await import('@/test/fixtures/commerce/offers');
  const incoming = createOffersForEveryState();
  const sent = createOffersForEveryState(OFFER_FIXTURE_SELLER);
  return {
    seller: OFFER_FIXTURE_SELLER,
    incomingFirstHalf: incoming.slice(0, 3),
    incomingSecondHalf: incoming.slice(3),
    sentActionable: sent.slice(0, 2),
  };
});

const view = vi.hoisted(() => ({
  offers: [] as unknown[],
  isLoading: false,
  error: null as string | null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace/offers',
}));

vi.mock('@/controllers/commerce/commerce', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/controllers/commerce/commerce')>();
  return {
    ...actual,
    CommerceController: {
      ...actual.CommerceController,
      getMarketplaceOrder: vi.fn(async () => ({ state: 'cancelled' })),
      getManyListings: vi.fn(async () => new Map()),
    },
  };
});

vi.mock('@/stores/auth/auth.store', async () => ({
  useAuthStore: createMarketplaceVrtAuthStore({ currentUserPubky: (await fixtures).seller }),
}));

vi.mock('@/hooks/useMarketplaceOffers/useMarketplaceOffers', async () => {
  const { useForm } = await import('react-hook-form');
  const { marketplaceOfferDefaults } = await import('@/hooks/useMarketplaceOffer/useMarketplaceOffer.types');
  return {
    useMarketplaceOffers: () => ({
      offers: view.offers,
      isLoading: view.isLoading,
      error: view.error,
      form: useForm({ defaultValues: marketplaceOfferDefaults }),
      refresh: vi.fn(async () => {}),
      act: vi.fn(async () => false),
      counter: vi.fn(async () => false),
    }),
  };
});

vi.mock('@/hooks/useMarketplaceCart/useMarketplaceCart', () => ({
  useMarketplaceCart: () => ({
    addAward: vi.fn(async () => true),
  }),
}));

vi.mock('@/hooks/useMarketplaceCartCount/useMarketplaceCartCount', () => ({
  useMarketplaceCartCount: () => 3,
}));

vi.mock('@/hooks/useMarketplaceAddressBook/useMarketplaceAddressBook', () => ({
  useMarketplaceAddressBook: () => ({ addresses: [], isLoading: false, error: null }),
}));

vi.mock('@/hooks/useMarketplaceOfferCheckout/useMarketplaceOfferCheckout', () => ({
  useMarketplaceOfferCheckout: () => ({ submit: vi.fn(async () => false) }),
}));

vi.mock('@/hooks/useMarketplaceActivityUnread/useMarketplaceActivityUnread', () => ({
  useMarketplaceActivityUnread: () => 2,
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

describe('Marketplace offers — visual regression', () => {
  it('renders incoming pending, countered, and accepted offers at desktop viewport', async () => {
    const { incomingFirstHalf } = await fixtures;
    view.offers = incomingFirstHalf;
    view.isLoading = false;
    view.error = null;

    const screen = await renderForVRT(<MarketplaceOffers />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('offers-incoming-states-1-desktop');
  });

  it('renders incoming pending, countered, and accepted offers at mobile viewport', async () => {
    const { incomingFirstHalf } = await fixtures;
    view.offers = incomingFirstHalf;
    view.isLoading = false;
    view.error = null;

    const screen = await renderForVRT(<MarketplaceOffers />, { viewport: VRT_VIEWPORT_MOBILE });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('offers-incoming-states-1-mobile');
  });

  it('renders incoming rejected, withdrawn, and expired offers at desktop viewport', async () => {
    const { incomingSecondHalf } = await fixtures;
    view.offers = incomingSecondHalf;
    view.isLoading = false;
    view.error = null;

    const screen = await renderForVRT(<MarketplaceOffers />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('offers-incoming-states-2-desktop');
  });

  it('renders sent offers with the withdraw action at desktop viewport', async () => {
    const { sentActionable } = await fixtures;
    view.offers = sentActionable;
    view.isLoading = false;
    view.error = null;

    const screen = await renderForVRT(<MarketplaceOffers />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('offers-sent-desktop');
  });

  it('renders the empty state at desktop viewport', async () => {
    view.offers = [];
    view.isLoading = false;
    view.error = null;

    const screen = await renderForVRT(<MarketplaceOffers />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('offers-empty-desktop');
  });

  it('renders the error state at desktop viewport', async () => {
    view.offers = [];
    view.isLoading = false;
    view.error = 'Marketplace offers are unavailable.';

    const screen = await renderForVRT(<MarketplaceOffers />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('offers-error-desktop');
  });

  it('renders the loading state at desktop viewport', async () => {
    view.offers = [];
    view.isLoading = true;
    view.error = null;

    const screen = await renderForVRT(<MarketplaceOffers />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('offers-loading-desktop');
  });
});
