// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_DENSE_CHROME_SCREENSHOT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceNotifications } from '@/templates/Marketplace/MarketplaceNotifications';

// Covers every notification kind defined by the notification schema union,
// split into viewport-sized sweeps so each kind is actually visible in a
// baseline, plus the preferences card, empty, error, and loading states.
const fixtures = vi.hoisted(async () => {
  const { createNotificationFixture, createNotificationsForEveryType, createNotificationPreferencesFixture } =
    await import('@/test/fixtures/commerce/notifications');
  const everyType = createNotificationsForEveryType();
  return {
    kindsFirstThird: everyType.slice(0, 6),
    kindsSecondThird: everyType.slice(6, 12),
    kindsLastThird: everyType.slice(12),
    preferences: createNotificationPreferencesFixture(),
    mutedPreferences: createNotificationPreferencesFixture({ offers: false, auctions: false }),
    readPair: [
      createNotificationFixture('offer_received', { readAt: '2026-08-19T18:00:00.000Z' }),
      createNotificationFixture('order_shipped', { readAt: '2026-08-19T18:30:00.000Z' }),
    ],
    // `order_delivered` on a digital order: released at payment, then marked
    // by the seller; beside it, the same type on a shipped order.
    deliveredKinds: [
      createNotificationFixture('order_delivered', {
        id: '00000000-0000-4000-8000-000000000951',
        actorPubky: 'system',
        orderFulfillment: 'digital',
        createdAt: '2026-08-19T12:03:00.000Z',
      }),
      createNotificationFixture('order_delivered', {
        id: '00000000-0000-4000-8000-000000000952',
        orderFulfillment: 'digital',
        createdAt: '2026-08-19T12:02:00.000Z',
      }),
      createNotificationFixture('order_delivered', {
        id: '00000000-0000-4000-8000-000000000953',
        orderFulfillment: 'shipping',
        createdAt: '2026-08-19T12:01:00.000Z',
      }),
    ],
  };
});

interface NotificationLike {
  readAt: string | null;
}

const view = vi.hoisted(() => ({
  notifications: [] as unknown[],
  preferences: null as unknown,
  isLoading: false,
  error: null as string | null,
  canMarkRead: true,
  watchAlerts: [] as unknown[],
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace/notifications',
}));

vi.mock('@/hooks/useMarketplaceOrders/useMarketplaceOrders', () => ({
  useMarketplaceOrders: () => ({
    orders: [],
    isLoading: false,
    error: null,
    needsSession: false,
  }),
}));

vi.mock('@/hooks/useMarketplaceNotifications/useMarketplaceNotifications', () => ({
  useMarketplaceNotifications: () => ({
    notifications: view.notifications,
    preferences: view.preferences,
    unreadCount: (view.notifications as NotificationLike[]).filter(({ readAt }) => !readAt).length,
    isLoading: view.isLoading,
    error: view.error,
    canMarkRead: view.canMarkRead,
    markAllRead: vi.fn(async () => {}),
    updatePreferences: vi.fn(async () => false),
  }),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

// Device-local watch alerts, view-driven per scenario; detection itself is a
// visit-triggered Dexie/network pass and stays a no-op in screenshots.
vi.mock('@/hooks/useMarketplaceWatchAlertFeed/useMarketplaceWatchAlertFeed', () => ({
  useMarketplaceWatchAlertFeed: () => ({ items: view.watchAlerts, markAllSeen: vi.fn(async () => {}) }),
}));

vi.mock('@/hooks/useMarketplaceWatchDetection/useMarketplaceWatchDetection', () => ({
  useMarketplaceWatchDetection: () => {},
}));

vi.mock('@/hooks/useRelativeTime/useRelativeTime', async () => {
  const { formatStableRelative } = await import('@/test-utils/vrt.clock');
  const result = { formatRelativeTime: (date: Date) => formatStableRelative(date.getTime()) };
  return { useRelativeTime: () => result };
});

async function setView(overrides: Partial<typeof view>) {
  view.notifications = [];
  view.preferences = null;
  view.isLoading = false;
  view.error = null;
  view.canMarkRead = true;
  view.watchAlerts = [];
  Object.assign(view, overrides);
}

describe('Marketplace notifications — visual regression', () => {
  it('renders the first third of every notification kind at desktop viewport', async () => {
    const { kindsFirstThird } = await fixtures;
    await setView({ notifications: kindsFirstThird });

    const screen = await renderForVRT(<MarketplaceNotifications />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'notifications-kinds-1-desktop',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  it('renders the first third of every notification kind at mobile viewport', async () => {
    const { kindsFirstThird } = await fixtures;
    await setView({ notifications: kindsFirstThird });

    const screen = await renderForVRT(<MarketplaceNotifications />, { viewport: VRT_VIEWPORT_MOBILE });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'notifications-kinds-1-mobile',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  it('renders the second third of every notification kind at desktop viewport', async () => {
    const { kindsSecondThird } = await fixtures;
    await setView({ notifications: kindsSecondThird });

    const screen = await renderForVRT(<MarketplaceNotifications />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'notifications-kinds-2-desktop',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  it('renders the last third of every notification kind at desktop viewport', async () => {
    const { kindsLastThird } = await fixtures;
    await setView({ notifications: kindsLastThird });

    const screen = await renderForVRT(<MarketplaceNotifications />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'notifications-kinds-3-desktop',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  it('renders the preferences card with muted channels and read items at desktop viewport', async () => {
    const { mutedPreferences, readPair } = await fixtures;
    await setView({ notifications: readPair, preferences: mutedPreferences });

    const screen = await renderForVRT(<MarketplaceNotifications />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'notifications-preferences-desktop',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  it('renders the empty state at desktop viewport', async () => {
    const { preferences } = await fixtures;
    await setView({ preferences });

    const screen = await renderForVRT(<MarketplaceNotifications />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'notifications-empty-desktop',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  it('renders the error state at desktop viewport', async () => {
    await setView({ error: 'Commerce notifications are unavailable.' });

    const screen = await renderForVRT(<MarketplaceNotifications />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'notifications-error-desktop',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  it('renders the loading state at desktop viewport', async () => {
    await setView({ isLoading: true });

    const screen = await renderForVRT(<MarketplaceNotifications />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'notifications-loading-desktop',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  it('renders the device-local watchlist alerts section above the service list at desktop viewport', async () => {
    const { kindsFirstThird } = await fixtures;
    const { createWatchAlertFeedItemFixture } = await import('@/test/fixtures/commerce/watch-alerts');
    await setView({
      notifications: kindsFirstThird.slice(0, 2),
      watchAlerts: [
        createWatchAlertFeedItemFixture('outbid', { isUnseen: true }),
        createWatchAlertFeedItemFixture('ending_soon'),
        createWatchAlertFeedItemFixture('price_change'),
      ],
    });

    const screen = await renderForVRT(<MarketplaceNotifications />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'notifications-watch-alerts-desktop',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  it('renders digital and shipped delivery notifications at desktop viewport', async () => {
    const { deliveredKinds } = await fixtures;
    await setView({ notifications: deliveredKinds, canMarkRead: false });

    const screen = await renderForVRT(<MarketplaceNotifications />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'notifications-digital-delivered-desktop',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  // Durable transaction-service mode: real delivered notifications, but no
  // mark-all-read button and no preferences card — the service stores neither.
  it('renders the durable-mode read-state notice at desktop viewport', async () => {
    const { kindsFirstThird } = await fixtures;
    await setView({ notifications: kindsFirstThird, canMarkRead: false });

    const screen = await renderForVRT(<MarketplaceNotifications />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'notifications-durable-desktop',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });
});
