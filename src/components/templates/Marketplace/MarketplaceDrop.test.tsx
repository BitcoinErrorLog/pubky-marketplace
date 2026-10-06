import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { APP_ROUTES, getMarketplaceShopRoute } from '@/app/routes';
import { MarketplaceDrop } from './MarketplaceDrop';

const SELLER = 's'.repeat(52);
const toggleShopFollow = vi.hoisted(() => vi.fn());

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getOrFetchShop: vi.fn(async () => ({ name: 'Analog Sound Co.' })),
  },
}));

vi.mock('@/hooks/useMarketplaceDrop/useMarketplaceDrop', () => ({
  useMarketplaceDrop: () => ({
    record: {
      ownerPubky: SELLER,
      dropId: 'vol1',
      title: 'Field Recordings Vol. 1',
      description: 'One hundred numbered copies, first come first served.',
      media: [],
      startsAt: '2026-08-19T20:00:00.000Z',
      endsAt: '2026-08-29T20:00:00.000Z',
      perBuyerLimit: 2,
      revision: 1,
    },
    recordError: null,
    projection: {
      totalQuantity: 100,
      perBuyerLimit: 2,
      startsAt: '2026-08-19T20:00:00.000Z',
      endsAt: '2026-08-29T20:00:00.000Z',
    },
    displayState: 'ended_sold_out',
    isLoading: false,
    clockOffsetMs: 0,
    adapterMode: 'transaction-service',
    readyCheck: null,
    refresh: vi.fn(async () => {}),
  }),
}));

vi.mock('@/hooks/useMarketplaceDropClaim/useMarketplaceDropClaim', () => ({
  useMarketplaceDropClaim: () => ({}),
}));

vi.mock('@/hooks/useCommerceShopFollow/useCommerceShopFollow', () => ({
  useCommerceShopFollow: () => ({
    isFollowing: false,
    isLoading: false,
    isMutating: false,
    toggle: toggleShopFollow,
  }),
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) =>
    selector({ currentUserPubky: 'b'.repeat(52) }),
}));

vi.mock('@/stores/commerce/commerce.store', () => ({
  useCommerceStore: (selector: (state: { marketplaceSession: object }) => unknown) =>
    selector({ marketplaceSession: {} }),
}));

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  const { createMarketplaceMediaHooks } = await import('@/test/mocks/marketplace-media-hooks');
  return createMarketplaceMediaHooks(() => null);
});

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

describe('MarketplaceDrop', () => {
  it('offers seller watch and catalog follow-ups on a sold-out archive', async () => {
    const user = userEvent.setup();

    render(<MarketplaceDrop sellerPubky={SELLER} dropId="vol1" />);

    await user.click(screen.getByRole('button', { name: 'Watch this seller' }));

    expect(toggleShopFollow).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'Browse similar' })).toHaveAttribute('href', APP_ROUTES.MARKETPLACE);
    expect(screen.getByRole('link', { name: /View shop/i })).toHaveAttribute('href', getMarketplaceShopRoute(SELLER));
  });
});
