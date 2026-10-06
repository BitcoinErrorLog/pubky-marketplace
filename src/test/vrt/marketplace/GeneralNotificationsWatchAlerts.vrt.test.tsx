// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore } from '@/test/mocks/marketplace-vrt';
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { formatStableRelative } from '@/test-utils/vrt.clock';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { NotificationsContainer } from '@/organisms/NotificationsContainer/NotificationsContainer';

// Device-local watchlist alerts inside the app's GENERAL notification surface:
// interleaved with social rows by timestamp, visibly labeled as local device
// checks ("Watchlist · checked on this device"), with honest local unseen dots.
const fixtures = vi.hoisted(async () => {
  const { NotificationType } = await import('@/models/notification/notification.types');
  const { createWatchAlertFeedItemFixture } = await import('@/test/fixtures/commerce/watch-alerts');
  const { VRT_FROZEN_NOW_MS: NOW, HOUR_MS: HOUR } = await import('@/test-utils/vrt.clock');

  const socialFollow = {
    id: `follow:${NOW - 3 * HOUR}:social-actor`,
    type: NotificationType.Follow,
    timestamp: NOW - 3 * HOUR,
    followed_by: 'social-actor',
  };

  return {
    social: [socialFollow],
    watchAlerts: [
      createWatchAlertFeedItemFixture('outbid', { isUnseen: true, timestamp: NOW - HOUR }),
      createWatchAlertFeedItemFixture('ending_soon', { isUnseen: true, timestamp: NOW - 2 * HOUR }),
      createWatchAlertFeedItemFixture('price_change', { timestamp: NOW - 4 * HOUR }),
      createWatchAlertFeedItemFixture('new_bid', { timestamp: NOW - 5 * HOUR }),
      createWatchAlertFeedItemFixture('state_change', { timestamp: NOW - 6 * HOUR }),
    ],
  };
});

const view = vi.hoisted(() => ({
  social: [] as unknown[],
  watchAlerts: [] as unknown[],
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/profile',
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: createMarketplaceVrtAuthStore({ currentUserPubky: 'v'.repeat(52), session: {} }),
}));

vi.mock('@/hooks/useNotifications/useNotifications', () => ({
  useNotifications: () => ({
    notifications: view.social,
    unreadNotifications: [],
    count: view.social.length,
    unreadCount: 0,
    isLoading: false,
    isLoadingMore: false,
    hasMore: false,
    error: null,
    loadMore: vi.fn(),
    refresh: vi.fn(),
    markAllAsRead: vi.fn(),
    isNotificationUnread: vi.fn(() => false),
  }),
}));

vi.mock('@/hooks/useMarketplaceNotificationFeed/useMarketplaceNotificationFeed', () => ({
  useMarketplaceNotificationFeed: () => ({
    items: [],
    refresh: vi.fn(async () => {}),
    markAllRead: vi.fn(async () => {}),
  }),
}));

vi.mock('@/hooks/useMarketplaceWatchAlertFeed/useMarketplaceWatchAlertFeed', () => ({
  useMarketplaceWatchAlertFeed: () => ({
    items: view.watchAlerts,
    markAllSeen: vi.fn(async () => {}),
  }),
}));

vi.mock('@/hooks/useUserProfile/useUserProfile', () => ({
  useUserProfile: (userId: string) => ({
    profile: { name: 'Satoshi Follower', bio: '', publicKey: `pk:${userId}`, link: `/profile/${userId}` },
    isLoading: false,
  }),
}));

vi.mock('@/hooks/useRelativeTime/useRelativeTime', () => {
  const result = { formatRelativeTime: (date: Date) => formatStableRelative(date.getTime()) };
  return { useRelativeTime: () => result };
});

async function setView(overrides: Partial<typeof view>) {
  window.localStorage.clear();
  view.social = [];
  view.watchAlerts = [];
  Object.assign(view, overrides);
}

describe('General notifications with watchlist alert rows — visual regression', () => {
  it('interleaves every watch alert kind among social rows at desktop viewport', async () => {
    const { social, watchAlerts } = await fixtures;
    await setView({ social, watchAlerts });

    const screen = await renderForVRT(<NotificationsContainer />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('general-notifications-watch-alerts-desktop');
  });

  it('interleaves every watch alert kind among social rows at mobile viewport', async () => {
    const { social, watchAlerts } = await fixtures;
    await setView({ social, watchAlerts });

    const screen = await renderForVRT(<NotificationsContainer />, { viewport: VRT_VIEWPORT_MOBILE });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('general-notifications-watch-alerts-mobile');
  });

  it('renders watch alerts alone when there is no social activity, instead of the empty state', async () => {
    const { watchAlerts } = await fixtures;
    await setView({ watchAlerts: watchAlerts.slice(0, 3) });

    const screen = await renderForVRT(<NotificationsContainer />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'general-notifications-watch-alerts-only-desktop',
    );
  });
});
