import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { MarketplaceFeedNotification } from '@/pipes/marketplaceNotification/marketplaceNotification.types';
import { useMarketplaceNotificationFeed } from './useMarketplaceNotificationFeed';

const OWNER = 'y'.repeat(52);

const config = vi.hoisted(() => ({
  mode: 'sandbox' as string,
}));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommercePollIntervalMs: () => 60_000, getCommerceAdapterMode: () => config.mode };
});

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) => selector({ currentUserPubky: OWNER }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getMarketplaceFeedNotifications: vi.fn(),
    markAllMarketplaceNotificationsRead: vi.fn(),
  },
}));

function feedItem(overrides: Partial<MarketplaceFeedNotification> = {}): MarketplaceFeedNotification {
  return {
    id: 'marketplace:018f47d2-6a27-7c23-a62f-000000000001',
    source: 'marketplace',
    type: 'offer_received',
    actorPubky: 'b'.repeat(52),
    aggregateId: 'offer:018f47d2-6a27-7c23-a62f-000000000002',
    timestamp: Date.parse('2026-08-19T12:00:00.000Z'),
    isUnread: true,
    href: '/marketplace/offers',
    ...overrides,
  } as MarketplaceFeedNotification;
}

describe('useMarketplaceNotificationFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.mode = 'sandbox';
    vi.mocked(CommerceController.getMarketplaceFeedNotifications).mockResolvedValue([feedItem()]);
    vi.mocked(CommerceController.markAllMarketplaceNotificationsRead).mockResolvedValue(undefined);
  });

  it('loads normalized feed items from the controller', async () => {
    const { result } = renderHook(() => useMarketplaceNotificationFeed());

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.items[0]).toMatchObject({ source: 'marketplace', type: 'offer_received' });
  });

  it('returns nothing and never fetches when no transactional backend is configured', async () => {
    config.mode = 'unavailable';

    const { result } = renderHook(() => useMarketplaceNotificationFeed());

    await waitFor(() => expect(result.current.items).toEqual([]));
    expect(CommerceController.getMarketplaceFeedNotifications).not.toHaveBeenCalled();
  });

  it('keeps a row highlighted for this mount even after a refresh reports it read', async () => {
    const { result } = renderHook(() => useMarketplaceNotificationFeed());
    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.items[0].isUnread).toBe(true);

    // Mark-all-read on page entry flips the backend row to read; the row the
    // user is looking at keeps its highlight, mirroring the social list's
    // frozen lastRead.
    vi.mocked(CommerceController.getMarketplaceFeedNotifications).mockResolvedValue([feedItem({ isUnread: false })]);
    await result.current.refresh();

    await waitFor(() => expect(result.current.items[0].isUnread).toBe(true));
  });

  it('does not highlight rows that were already read when first seen', async () => {
    vi.mocked(CommerceController.getMarketplaceFeedNotifications).mockResolvedValue([feedItem({ isUnread: false })]);

    const { result } = renderHook(() => useMarketplaceNotificationFeed());

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    expect(result.current.items[0].isUnread).toBe(false);
  });

  it('keeps the last loaded items when a refresh fails, so the shared surface never blanks on commerce errors', async () => {
    const { result } = renderHook(() => useMarketplaceNotificationFeed());
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    vi.mocked(CommerceController.getMarketplaceFeedNotifications).mockRejectedValue(new Error('backend down'));
    await result.current.refresh();

    expect(result.current.items).toHaveLength(1);
  });

  it('delegates mark-all-read to the controller, which no-ops outside the sandbox', async () => {
    const { result } = renderHook(() => useMarketplaceNotificationFeed());
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    await result.current.markAllRead();

    expect(CommerceController.markAllMarketplaceNotificationsRead).toHaveBeenCalledTimes(1);
  });
});
