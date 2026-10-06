// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore } from '@/test/mocks/marketplace-vrt';
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { formatStableRelative } from '@/test-utils/vrt.clock';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { NotificationsContainer } from '@/organisms/NotificationsContainer/NotificationsContainer';

// Marketplace notifications inside the app's GENERAL notification surface
// (the /profile list): interleaved with social rows by timestamp, unread dots
// only where read state actually exists (sandbox), and never any payload
// beyond actor + action + deep link.
const fixtures = vi.hoisted(async () => {
  const { NOTIFICATION_FIXTURE_ACTOR: SELLER_ACTOR, NOTIFICATION_FIXTURE_RECIPIENT: BUYER_ACTOR } =
    await import('@/test/fixtures/commerce/notifications');
  const { NotificationType } = await import('@/models/notification/notification.types');
  const { VRT_FROZEN_NOW_MS: NOW, HOUR_MS: HOUR } = await import('@/test-utils/vrt.clock');

  const socialFollow = {
    id: `follow:${NOW - 2 * HOUR}:social-actor`,
    type: NotificationType.Follow,
    timestamp: NOW - 2 * HOUR,
    followed_by: 'social-actor',
  };
  const socialReply = {
    id: `reply:${NOW - 5 * HOUR}:social-actor`,
    type: NotificationType.Reply,
    timestamp: NOW - 5 * HOUR,
    replied_by: 'social-actor',
    parent_post_uri: 'pubky://viewer/pub/pubky.app/posts/parent-1',
    reply_uri: 'pubky://social-actor/pub/pubky.app/posts/reply-1',
  };

  const marketplaceItem = (
    type: string,
    hoursAgo: number,
    isUnread: boolean,
    href: string,
    actorPubky: string,
    aggregateId = 'order:018f47d2-6a27-7c23-a62f-000000000002',
  ) => ({
    id: `marketplace:018f47d2-6a27-7c23-a62f-${String(hoursAgo).padStart(12, '0')}`,
    source: 'marketplace' as const,
    type,
    actorPubky,
    aggregateId,
    timestamp: NOW - hoursAgo * HOUR,
    isUnread,
    href,
  });

  return {
    social: [socialFollow, socialReply],
    sandboxItems: [
      marketplaceItem('offer_received', 1, true, '/marketplace/offers', SELLER_ACTOR),
      marketplaceItem('order_shipped', 3, false, '/marketplace/orders', SELLER_ACTOR),
      marketplaceItem('outbid', 4, true, `/marketplace/listing/${'s'.repeat(52)}/boots_01`, SELLER_ACTOR),
    ],
    durableItems: [
      marketplaceItem('payment_confirmed', 1, false, '/marketplace/orders', BUYER_ACTOR),
      marketplaceItem('review_received', 3, false, '/marketplace/orders', SELLER_ACTOR),
    ],
    // `order_delivered` on digital orders, as the normalizer marks them.
    digitalDeliveredItems: [
      {
        ...marketplaceItem('order_delivered', 1, false, '/marketplace/orders', 'paypal-ipn'),
        digitalDelivery: 'automatic',
      },
      {
        ...marketplaceItem('order_delivered', 3, false, '/marketplace/orders', SELLER_ACTOR),
        digitalDelivery: 'manual',
      },
    ],
  };
});

const view = vi.hoisted(() => ({
  social: [] as unknown[],
  unreadSocial: [] as unknown[],
  marketplaceItems: [] as unknown[],
  hasMore: false,
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
    unreadNotifications: view.unreadSocial,
    count: view.social.length,
    unreadCount: view.unreadSocial.length,
    isLoading: false,
    isLoadingMore: false,
    hasMore: view.hasMore,
    error: null,
    loadMore: vi.fn(),
    refresh: vi.fn(),
    markAllAsRead: vi.fn(),
    isNotificationUnread: vi.fn(() => false),
  }),
}));

vi.mock('@/hooks/useMarketplaceNotificationFeed/useMarketplaceNotificationFeed', () => ({
  useMarketplaceNotificationFeed: () => ({
    items: view.marketplaceItems,
    refresh: vi.fn(async () => {}),
    markAllRead: vi.fn(async () => {}),
  }),
}));

// Device-local watch alerts are captured in GeneralNotificationsWatchAlerts.vrt;
// this suite pins the service-notification interleaving without them.
vi.mock('@/hooks/useMarketplaceWatchAlertFeed/useMarketplaceWatchAlertFeed', () => ({
  useMarketplaceWatchAlertFeed: () => ({ items: [], markAllSeen: vi.fn(async () => {}) }),
}));

vi.mock('@/hooks/useUserProfile/useUserProfile', () => ({
  useUserProfile: (userId: string) => ({
    profile: {
      name:
        userId === 'social-actor'
          ? 'Satoshi Follower'
          : userId === 'b'.repeat(52)
            ? 'Marketplace Buyer'
            : 'Marketplace Seller',
      bio: '',
      publicKey: `pk:${userId}`,
      link: `/profile/${userId}`,
    },
    isLoading: false,
  }),
}));

vi.mock('@/hooks/useNotificationPostContent/useNotificationPostContent', () => ({
  useNotificationPostContent: () => ({ content: 'A reply to your post', isLoading: false }),
}));

vi.mock('@/hooks/useRelativeTime/useRelativeTime', () => {
  const result = { formatRelativeTime: (date: Date) => formatStableRelative(date.getTime()) };
  return { useRelativeTime: () => result };
});

async function setView(overrides: Partial<typeof view>) {
  window.localStorage.clear();
  view.social = [];
  view.unreadSocial = [];
  view.marketplaceItems = [];
  view.hasMore = false;
  Object.assign(view, overrides);
}

describe('General notifications with marketplace rows — visual regression', () => {
  it('interleaves sandbox marketplace rows with unread dots among social rows at desktop viewport', async () => {
    const { social, sandboxItems } = await fixtures;
    await setView({ social, unreadSocial: [social[0]], marketplaceItems: sandboxItems });

    const screen = await renderForVRT(<NotificationsContainer />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('general-notifications-marketplace-desktop');
  });

  it('interleaves sandbox marketplace rows with unread dots among social rows at mobile viewport', async () => {
    const { social, sandboxItems } = await fixtures;
    await setView({ social, unreadSocial: [social[0]], marketplaceItems: sandboxItems });

    const screen = await renderForVRT(<NotificationsContainer />, { viewport: VRT_VIEWPORT_MOBILE });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('general-notifications-marketplace-mobile');
  });

  it('shows durable-mode marketplace rows without unread dots — the service stores no read state', async () => {
    const { social, durableItems } = await fixtures;
    await setView({ social, marketplaceItems: durableItems });

    const screen = await renderForVRT(<NotificationsContainer />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'general-notifications-marketplace-durable-desktop',
    );
  });

  it('words digital deliveries as a purchase to download at desktop viewport', async () => {
    const { digitalDeliveredItems } = await fixtures;
    await setView({ marketplaceItems: digitalDeliveredItems });

    const screen = await renderForVRT(<NotificationsContainer />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'general-notifications-digital-delivered-desktop',
    );
  });

  it('renders marketplace rows alone when there is no social activity, instead of the empty state', async () => {
    const { sandboxItems } = await fixtures;
    await setView({ marketplaceItems: sandboxItems });

    const screen = await renderForVRT(<NotificationsContainer />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'general-notifications-marketplace-only-desktop',
    );
  });
});
