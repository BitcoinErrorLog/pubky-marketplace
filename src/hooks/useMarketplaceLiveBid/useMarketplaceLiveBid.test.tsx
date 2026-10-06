import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { MarketplaceListingProjection } from '@/services/marketplace/marketplace';
import { useMarketplaceLiveBid } from './useMarketplaceLiveBid';

const config = vi.hoisted(() => ({ mode: 'transaction-service' }));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => config.mode };
});

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getMarketplaceListingProjection: vi.fn(),
  },
}));

let intersectionCallback: ((entries: IntersectionObserverEntry[]) => void) | null = null;
const mockObserve = vi.fn();
const mockDisconnect = vi.fn();

class MockIntersectionObserver {
  constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
    intersectionCallback = callback;
  }

  observe = mockObserve;
  unobserve = vi.fn();
  disconnect = mockDisconnect;
}

Object.defineProperty(window, 'IntersectionObserver', {
  writable: true,
  configurable: true,
  value: MockIntersectionObserver,
});

Object.defineProperty(global, 'IntersectionObserver', {
  writable: true,
  configurable: true,
  value: MockIntersectionObserver,
});

const SELLER = 'y'.repeat(52);

function auctionProjection(overrides: Partial<NonNullable<MarketplaceListingProjection['auction']>> = {}) {
  return {
    aggregateId: `listing:${SELLER}_camera`,
    sellerPubky: SELLER,
    listingId: 'camera',
    serverRevision: 3,
    state: 'available',
    availableQuantity: 1,
    reservedQuantity: 0,
    unitPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
    saleFormat: 'auction',
    auction: {
      startsAt: '2026-08-19T20:00:00.000Z',
      endsAt: '2026-08-29T20:00:00.000Z',
      minimumIncrement: { amountMinor: 500, currency: 'USD', exponent: 2 },
      currentPrice: { amountMinor: 7_500, currency: 'USD', exponent: 2 },
      leaderPubky: null,
      bidCount: 4,
      ...overrides,
    },
  } as MarketplaceListingProjection;
}

function attachAndShow(ref: (node: HTMLElement | null) => void) {
  act(() => {
    ref(document.createElement('div'));
  });
  act(() => {
    intersectionCallback?.([{ isIntersecting: true } as IntersectionObserverEntry]);
  });
}

describe('useMarketplaceLiveBid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    intersectionCallback = null;
    config.mode = 'transaction-service';
    vi.mocked(CommerceController.getMarketplaceListingProjection).mockResolvedValue(auctionProjection());
  });

  it('fetches live bid state once the card becomes visible in transaction-service mode', async () => {
    const { result } = renderHook(() => useMarketplaceLiveBid(SELLER, 'camera', true));

    expect(result.current.bid).toBeNull();
    expect(CommerceController.getMarketplaceListingProjection).not.toHaveBeenCalled();

    attachAndShow(result.current.ref);

    await waitFor(() =>
      expect(result.current.bid).toEqual({
        currentPrice: { amountMinor: 7_500, currency: 'USD', exponent: 2 },
        bidCount: 4,
      }),
    );
    expect(CommerceController.getMarketplaceListingProjection).toHaveBeenCalledExactlyOnceWith(SELLER, 'camera');
  });

  it('fetches only once per card even across repeated visibility changes', async () => {
    const { result } = renderHook(() => useMarketplaceLiveBid(SELLER, 'camera', true));

    attachAndShow(result.current.ref);
    await waitFor(() => expect(result.current.bid).not.toBeNull());

    act(() => {
      intersectionCallback?.([{ isIntersecting: false } as IntersectionObserverEntry]);
    });
    act(() => {
      intersectionCallback?.([{ isIntersecting: true } as IntersectionObserverEntry]);
    });

    expect(CommerceController.getMarketplaceListingProjection).toHaveBeenCalledTimes(1);
  });

  it('never fetches for off-screen cards', () => {
    const { result } = renderHook(() => useMarketplaceLiveBid(SELLER, 'camera', true));

    act(() => {
      result.current.ref(document.createElement('div'));
    });

    expect(CommerceController.getMarketplaceListingProjection).not.toHaveBeenCalled();
    expect(result.current.bid).toBeNull();
  });

  it.each(['sandbox', 'unavailable', 'locks-paykit'] as const)('stays inert in %s mode', (mode) => {
    config.mode = mode;
    const { result } = renderHook(() => useMarketplaceLiveBid(SELLER, 'camera', true));

    attachAndShow(result.current.ref);

    expect(mockObserve).not.toHaveBeenCalled();
    expect(CommerceController.getMarketplaceListingProjection).not.toHaveBeenCalled();
    expect(result.current.bid).toBeNull();
  });

  it('stays inert when disabled (non-auction cards)', () => {
    const { result } = renderHook(() => useMarketplaceLiveBid(SELLER, 'camera', false));

    attachAndShow(result.current.ref);

    expect(mockObserve).not.toHaveBeenCalled();
    expect(CommerceController.getMarketplaceListingProjection).not.toHaveBeenCalled();
  });

  it('degrades to a null bid when the transaction service is unreachable', async () => {
    vi.mocked(CommerceController.getMarketplaceListingProjection).mockRejectedValue(new Error('fetch failed'));
    const { result } = renderHook(() => useMarketplaceLiveBid(SELLER, 'camera', true));

    attachAndShow(result.current.ref);

    await waitFor(() => expect(CommerceController.getMarketplaceListingProjection).toHaveBeenCalled());
    expect(result.current.bid).toBeNull();
  });

  it('keeps a null bid when the projection is not registered or carries no auction', async () => {
    vi.mocked(CommerceController.getMarketplaceListingProjection).mockResolvedValue(null);
    const { result } = renderHook(() => useMarketplaceLiveBid(SELLER, 'camera', true));

    attachAndShow(result.current.ref);

    await waitFor(() => expect(CommerceController.getMarketplaceListingProjection).toHaveBeenCalled());
    expect(result.current.bid).toBeNull();
    expect(result.current.listingState).toBeNull();
  });

  it('records reserved listing state for a visible fixed-price card', async () => {
    vi.mocked(CommerceController.getMarketplaceListingProjection).mockResolvedValue({
      ...auctionProjection(),
      saleFormat: 'fixed_price',
      state: 'reserved',
      auction: null,
    });
    const { result } = renderHook(() => useMarketplaceLiveBid(SELLER, 'boots', true));

    attachAndShow(result.current.ref);

    await waitFor(() => expect(result.current.listingState).toBe('reserved'));
    expect(result.current.bid).toBeNull();
  });
});
