import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFeatureDiscoveryStorageKey } from '@/config/featureDiscovery';
import { useNotifications } from '@/hooks/useNotifications/useNotifications';
import { type FlatNotification, NotificationType, PostChangedSource } from '@/models/notification/notification.types';
import { marketplaceNotificationSchema } from '@/services/marketplace/marketplace-projections';
import {
  classifyGeneralNotificationTab,
  isMarketplaceNotificationType,
  NotificationsContainer,
} from './NotificationsContainer';

const authStoreState = vi.hoisted(() => ({
  session: {} as unknown,
  currentUserPubky: 'viewer'.repeat(9).slice(0, 52),
}));
const marketplaceFeedState = vi.hoisted(() => ({
  items: [] as unknown[],
  markAllRead: vi.fn(async () => {}),
}));
const watchAlertFeedState = vi.hoisted(() => ({
  items: [] as unknown[],
  markAllSeen: vi.fn(async () => {}),
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector?: (state: { session: unknown | null; currentUserPubky: string }) => unknown) =>
    selector ? selector(authStoreState) : authStoreState,
}));

// Device-local watch alerts come from a Dexie live query; mocking it keeps
// these tests free of the async re-render the real hook schedules (several
// scenarios use mockReturnValueOnce and must not re-render past it).
vi.mock('@/hooks/useMarketplaceWatchAlertFeed/useMarketplaceWatchAlertFeed', () => ({
  useMarketplaceWatchAlertFeed: () => ({
    items: watchAlertFeedState.items,
    markAllSeen: watchAlertFeedState.markAllSeen,
  }),
}));

vi.mock('@/hooks/useMarketplaceNotificationFeed/useMarketplaceNotificationFeed', () => ({
  useMarketplaceNotificationFeed: () => ({
    items: marketplaceFeedState.items,
    refresh: vi.fn(async () => {}),
    markAllRead: marketplaceFeedState.markAllRead,
  }),
}));

// The entry effect advances the device-local activity read checkpoint; the
// real controller would reach for the (mocked-away) auth store internals.
// The feed hook's controller reads are stubbed for the same reason.
const mockMarkActivityRead = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    markActivityRead: mockMarkActivityRead,
    getMarketplaceFeedNotifications: vi.fn(async () => []),
    markAllMarketplaceNotificationsRead: vi.fn(async () => {}),
  },
}));

// Mock useNotifications hook
vi.mock('@/hooks/useNotifications/useNotifications', () => ({
  useNotifications: vi.fn(() => ({
    notifications: [
      {
        id: 'follow:123:user1',
        type: NotificationType.Follow,
        timestamp: Date.now() - 1000 * 60 * 30,
        followed_by: 'user1',
      },
    ],
    unreadNotifications: [],
    count: 27,
    unreadCount: 0,
    isLoading: false,
    isLoadingMore: false,
    hasMore: false,
    error: null,
    loadMore: vi.fn(),
    refresh: vi.fn(),
    markAllAsRead: vi.fn(),
    isNotificationUnread: vi.fn(() => false),
  })),
}));

// Captures the options the container hands the scroll sentinel, so tests can inspect
// the wiring; the budget behaviour itself lives in (and is tested with) the hook.
const infiniteScrollOptions = vi.hoisted(() => ({
  current: null as {
    onLoadMore: () => void;
    hasMore: boolean;
    isLoading: boolean;
    itemCount?: number;
    maxUnproductiveLoads?: number;
  } | null,
}));
const infiniteScrollState = vi.hoisted(() => ({ isStalled: false }));
const mockResumeAutoLoad = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useInfiniteScroll/useInfiniteScroll', () => ({
  useInfiniteScroll: vi.fn((options: { onLoadMore: () => void; hasMore: boolean; isLoading: boolean }) => {
    infiniteScrollOptions.current = options;
    return { sentinelRef: vi.fn(), isStalled: infiniteScrollState.isStalled, resumeAutoLoad: mockResumeAutoLoad };
  }),
}));

// Mock atoms
vi.mock('@/atoms/Container/Container', () => {
  return {
    Container: ({
      children,
      className,
    }: {
      children: React.ReactNode;
      className?: string;
      overrideDefaults?: boolean;
    }) => <div className={className}>{children}</div>,
  };
});

vi.mock('@/atoms/Heading/Heading', () => {
  return {
    Heading: ({ children, level, className }: { children: React.ReactNode; level?: number; className?: string }) => {
      const Tag = `h${level || 1}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      return (
        <Tag data-testid={`heading-${level || 1}`} className={className}>
          {children}
        </Tag>
      );
    },
  };
});

vi.mock('@/atoms/Skeleton/Skeleton', () => {
  return {
    Skeleton: ({ className }: { className?: string }) => <div data-testid="skeleton" className={className} />,
  };
});

vi.mock('@/atoms/Spinner/Spinner', () => {
  return {
    Spinner: ({ size }: { size?: string }) => <div data-testid="spinner" data-size={size} />,
  };
});

// Mock molecules
vi.mock('@/molecules/NotificationsEmpty/NotificationsEmpty', () => {
  return {
    NotificationsEmpty: () => <div data-testid="notifications-empty">No notifications yet</div>,
  };
});

// Mock organisms (NotificationsList is now in organisms)
vi.mock('@/organisms/NotificationsList/NotificationsList', () => ({
  NotificationsList: ({ entries }: { entries: unknown[] }) => (
    <div data-testid="notifications-list">{entries.length} notifications</div>
  ),
}));

function resetFeedMocks() {
  marketplaceFeedState.items = [];
  watchAlertFeedState.items = [];
  marketplaceFeedState.markAllRead.mockClear();
  watchAlertFeedState.markAllSeen.mockClear();
  window.localStorage.clear();
}

describe('NotificationsContainer', () => {
  beforeEach(() => {
    authStoreState.session = {};
    authStoreState.currentUserPubky = 'viewer'.repeat(9).slice(0, 52);
    resetFeedMocks();
    mockMarkActivityRead.mockClear();
  });

  it('renders without errors', () => {
    render(<NotificationsContainer />);
    expect(screen.getByTestId('heading-5')).toBeInTheDocument();
  });

  it('displays the correct heading', () => {
    render(<NotificationsContainer />);
    const heading = screen.getByTestId('heading-5');
    expect(heading).toBeInTheDocument();
    expect(heading).toHaveTextContent(/Notifications/);
  });

  it('displays notifications list when notifications exist', () => {
    render(<NotificationsContainer />);
    expect(screen.getByTestId('notifications-list')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    vi.mocked(useNotifications).mockReturnValueOnce({
      notifications: [],
      unreadNotifications: [],
      count: 0,
      unreadCount: 0,
      isLoading: true,
      isLoadingMore: false,
      hasMore: false,
      error: null,
      loadMore: vi.fn(),
      refresh: vi.fn(),
      markAllAsRead: vi.fn(),
      isNotificationUnread: vi.fn(() => false),
    });
    render(<NotificationsContainer />);
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);
  });

  it('shows empty state when no notifications', () => {
    vi.mocked(useNotifications).mockReturnValueOnce({
      notifications: [],
      unreadNotifications: [],
      count: 0,
      unreadCount: 0,
      isLoading: false,
      isLoadingMore: false,
      hasMore: false,
      error: null,
      loadMore: vi.fn(),
      refresh: vi.fn(),
      markAllAsRead: vi.fn(),
      isNotificationUnread: vi.fn(() => false),
    });
    render(<NotificationsContainer />);
    expect(screen.getByText(/No notifications yet/i)).toBeInTheDocument();
  });

  it('owns the page with a retry when a failure leaves nothing loaded', async () => {
    const refresh = vi.fn();
    vi.mocked(useNotifications).mockReturnValueOnce({
      notifications: [],
      unreadNotifications: [],
      count: 0,
      unreadCount: 0,
      isLoading: false,
      isLoadingMore: false,
      hasMore: false,
      error: 'Failed to load notifications',
      loadMore: vi.fn(),
      refresh,
      markAllAsRead: vi.fn(),
      isNotificationUnread: vi.fn(() => false),
    });
    render(<NotificationsContainer />);

    expect(screen.getByText(/Failed to load notifications/i)).toBeInTheDocument();
    expect(screen.queryByTestId('notifications-list')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps the loaded rows and renders the failure inline with a retry', async () => {
    const refresh = vi.fn();
    vi.mocked(useNotifications).mockReturnValueOnce({
      notifications: [
        {
          id: 'follow:123:user1',
          type: NotificationType.Follow,
          timestamp: Date.now() - 1000 * 60 * 30,
          followed_by: 'user1',
        } as FlatNotification,
      ],
      unreadNotifications: [],
      count: 1,
      unreadCount: 0,
      isLoading: false,
      isLoadingMore: false,
      hasMore: true,
      error: 'Failed to load more notifications',
      loadMore: vi.fn(),
      refresh,
      markAllAsRead: vi.fn(),
      isNotificationUnread: vi.fn(() => false),
    });
    const { container } = render(<NotificationsContainer />);

    // The accumulated list survives the failure; the error renders below it instead.
    expect(screen.getByTestId('notifications-list')).toBeInTheDocument();
    expect(screen.getByText(/Failed to load more notifications/i)).toBeInTheDocument();
    // The sentinel unmounts so the observer cannot loop retries against a failing
    // network — recovery goes through the button.
    expect(container.querySelector('[data-cy="notifications-sentinel"]')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('shows loading more indicator when paginating', () => {
    vi.mocked(useNotifications).mockReturnValueOnce({
      notifications: [
        {
          id: 'follow:123:user1',
          type: NotificationType.Follow,
          timestamp: Date.now() - 1000 * 60 * 30,
          followed_by: 'user1',
        },
      ],
      unreadNotifications: [],
      count: 1,
      unreadCount: 0,
      isLoading: false,
      isLoadingMore: true,
      hasMore: true,
      error: null,
      loadMore: vi.fn(),
      refresh: vi.fn(),
      markAllAsRead: vi.fn(),
      isNotificationUnread: vi.fn(() => false),
    });
    render(<NotificationsContainer />);
    expect(screen.getAllByTestId('skeleton').length).toBeGreaterThan(0);
  });

  it('calls markAllAsRead on mount and not on unmount', () => {
    const markAllAsRead = vi.fn();
    vi.mocked(useNotifications).mockReturnValue({
      notifications: [
        {
          id: 'follow:123:user1',
          type: NotificationType.Follow,
          timestamp: Date.now() - 1000 * 60 * 30,
          followed_by: 'user1',
        },
      ],
      unreadNotifications: [],
      count: 1,
      unreadCount: 0,
      isLoading: false,
      isLoadingMore: false,
      hasMore: false,
      error: null,
      loadMore: vi.fn(),
      refresh: vi.fn(),
      markAllAsRead,
      isNotificationUnread: vi.fn(() => false),
    });
    const { unmount } = render(<NotificationsContainer />);
    expect(markAllAsRead).toHaveBeenCalledTimes(1);
    // Seeing the interleaved commerce rows here also advances the
    // device-local activity read checkpoint behind the marketplace badge.
    expect(mockMarkActivityRead).toHaveBeenCalledTimes(1);
    unmount();
    expect(markAllAsRead).toHaveBeenCalledTimes(1);
  });

  it('does not call markAllAsRead until authenticated', () => {
    authStoreState.session = null;
    const markAllAsRead = vi.fn();
    vi.mocked(useNotifications).mockReturnValueOnce({
      notifications: [
        {
          id: 'follow:123:user1',
          type: NotificationType.Follow,
          timestamp: Date.now() - 1000 * 60 * 30,
          followed_by: 'user1',
        },
      ],
      unreadNotifications: [],
      count: 1,
      unreadCount: 0,
      isLoading: false,
      isLoadingMore: false,
      hasMore: false,
      error: null,
      loadMore: vi.fn(),
      refresh: vi.fn(),
      markAllAsRead,
      isNotificationUnread: vi.fn(() => false),
    });

    render(<NotificationsContainer />);

    expect(markAllAsRead).not.toHaveBeenCalled();
    expect(mockMarkActivityRead).not.toHaveBeenCalled();
  });

  it('matches snapshot', () => {
    const { container } = render(<NotificationsContainer />);
    expect(container).toMatchSnapshot();
  });

  it('filters tabs and persists the last selected tab for the account', async () => {
    marketplaceFeedState.items = [
      {
        id: 'marketplace:offer1',
        source: 'marketplace',
        type: 'offer_received',
        actorPubky: 'seller'.repeat(9).slice(0, 52),
        aggregateId: 'offer:1',
        timestamp: Date.now(),
        isUnread: true,
        href: '/marketplace/offers',
      },
    ];
    watchAlertFeedState.items = [
      {
        id: 'watch:1',
        source: 'watch-alert',
        kind: 'outbid',
        title: 'Vintage boots',
        href: '/marketplace/listing/seller/boots',
        timestamp: Date.now() - 1,
        isUnseen: true,
        endsAt: null,
        previousAmount: null,
        currentAmount: null,
        bidCount: 4,
        previousState: null,
        nextState: null,
      },
    ];

    render(<NotificationsContainer />);

    expect(screen.getByRole('tab', { name: 'All (3)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Marketplace (2)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Social (1)' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Marketplace (2)' }));

    expect(screen.getByTestId('notifications-list')).toHaveTextContent('2 notifications');
    expect(
      window.localStorage.getItem(
        buildFeatureDiscoveryStorageKey(authStoreState.currentUserPubky, 'general-notifications-tab-v1'),
      ),
    ).toBe('marketplace');
  });

  it('places review_received and message_received in Marketplace, not Social', async () => {
    marketplaceFeedState.items = [
      marketplaceItem('review_received', 'order:1', '/marketplace/orders'),
      marketplaceItem('message_received', 'conversation:1', '/marketplace/messages'),
    ];

    render(<NotificationsContainer />);

    expect(screen.getByRole('tab', { name: 'All (3)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Marketplace (2)' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Social (1)' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Marketplace (2)' }));
    expect(screen.getByTestId('notifications-list')).toHaveTextContent('2 notifications');

    await userEvent.click(screen.getByRole('tab', { name: 'Social (1)' }));
    expect(screen.getByTestId('notifications-list')).toHaveTextContent('1 notifications');
  });

  it('classifies every marketplace and social notification type explicitly', () => {
    const unclassified: string[] = [];
    for (const type of marketplaceNotificationSchema.shape.type.options) {
      const kind = classifyGeneralNotificationTab(type);
      if (kind === 'unclassified') unclassified.push(type);
      expect(kind).toBe('marketplace');
      expect(isMarketplaceNotificationType(type)).toBe(true);
    }
    for (const type of Object.values(NotificationType)) {
      const kind = classifyGeneralNotificationTab(type);
      if (kind === 'unclassified') unclassified.push(type);
      expect(kind).toBe('social');
      expect(isMarketplaceNotificationType(type)).toBe(false);
    }
    expect(unclassified).toEqual([]);
    expect(classifyGeneralNotificationTab('not_a_real_type')).toBe('unclassified');
  });
});

function marketplaceItem(type: string, aggregateId: string, href: string) {
  return {
    id: `marketplace:${aggregateId}`,
    source: 'marketplace',
    type,
    actorPubky: 'seller'.repeat(9).slice(0, 52),
    aggregateId,
    timestamp: Date.now(),
    isUnread: true,
    href,
  };
}

function buildNotificationsResult({
  notifications,
  loadMore = vi.fn(),
  hasMore = true,
}: {
  notifications: FlatNotification[];
  loadMore?: () => Promise<void>;
  hasMore?: boolean;
}): ReturnType<typeof useNotifications> {
  return {
    notifications,
    unreadNotifications: [],
    count: notifications.length,
    unreadCount: 0,
    isLoading: false,
    isLoadingMore: false,
    hasMore,
    error: null,
    loadMore,
    refresh: vi.fn(),
    markAllAsRead: vi.fn(),
    isNotificationUnread: vi.fn(() => false),
  };
}

describe('NotificationsContainer - grouping', () => {
  beforeEach(() => {
    authStoreState.session = {};
    resetFeedMocks();
  });

  it('collapses consecutive deletions by the same actor into one row', () => {
    const deletion = (timestamp: number): FlatNotification => ({
      id: `post_deleted:${timestamp}:alice`,
      type: NotificationType.PostDeleted,
      timestamp,
      delete_source: PostChangedSource.Reply,
      deleted_by: 'alice',
      deleted_uri: `pubky://alice/pub/pubky.app/posts/deleted-${timestamp}`,
      linked_uri: `pubky://viewer/pub/pubky.app/posts/linked-${timestamp}`,
    });

    vi.mocked(useNotifications).mockReturnValue(
      buildNotificationsResult({ notifications: [deletion(3000), deletion(2000), deletion(1000)] }),
    );

    render(<NotificationsContainer />);

    // The mocked list renders its entry count, so three notifications becoming one row
    // proves the container grouped them before handing them over.
    expect(screen.getByTestId('notifications-list')).toHaveTextContent('1 notifications');
  });
});

describe('NotificationsContainer - auto-load guard', () => {
  // Grouping can collapse a page into a handful of rows, leaving the sentinel on screen
  // and re-triggering loads. The budget lives in useInfiniteScroll (tested there); these
  // tests pin the container's wiring: the options it passes and the stall button.
  const loadMore = vi.fn();

  const followNotification = (actor: string): FlatNotification => ({
    id: `follow:${actor}`,
    type: NotificationType.Follow,
    timestamp: Date.now(),
    followed_by: actor,
  });

  /** The button carries a Cypress hook, not a testing-library one. */
  const loadMoreButton = () => document.querySelector<HTMLButtonElement>('[data-cy="notifications-load-more"]');

  const mockShortList = (hasMore = true) =>
    vi
      .mocked(useNotifications)
      .mockReturnValue(buildNotificationsResult({ notifications: [followNotification('user1')], loadMore, hasMore }));

  beforeEach(() => {
    authStoreState.session = {};
    resetFeedMocks();
    loadMore.mockClear();
    mockResumeAutoLoad.mockClear();
    infiniteScrollState.isStalled = false;
    infiniteScrollOptions.current = null;
    mockShortList();
  });

  it('hands the sentinel the rendered row count and the unproductive-load budget', () => {
    render(<NotificationsContainer />);

    expect(infiniteScrollOptions.current).toMatchObject({
      hasMore: true,
      isLoading: false,
      itemCount: 1,
      maxUnproductiveLoads: 3,
    });
    // loadMore goes through unwrapped — the hook owns the budget accounting.
    expect(infiniteScrollOptions.current?.onLoadMore).toBe(loadMore);
  });

  it('reports rendered rows, not raw notifications, as the productivity signal', () => {
    const deletion = (timestamp: number): FlatNotification => ({
      id: `post_deleted:${timestamp}:alice`,
      type: NotificationType.PostDeleted,
      timestamp,
      delete_source: PostChangedSource.Reply,
      deleted_by: 'alice',
      deleted_uri: `pubky://alice/pub/pubky.app/posts/deleted-${timestamp}`,
      linked_uri: `pubky://viewer/pub/pubky.app/posts/linked-${timestamp}`,
    });
    vi.mocked(useNotifications).mockReturnValue(
      buildNotificationsResult({ notifications: [deletion(3000), deletion(2000), deletion(1000)], loadMore }),
    );

    render(<NotificationsContainer />);

    // Three notifications grouped into one row must count as one item.
    expect(infiniteScrollOptions.current?.itemCount).toBe(1);
  });

  it('offers the manual button while auto-loading is stalled', () => {
    infiniteScrollState.isStalled = true;

    render(<NotificationsContainer />);

    expect(loadMoreButton()).toBeInTheDocument();
  });

  it('hides the manual button while auto-loading is running normally', () => {
    render(<NotificationsContainer />);

    expect(loadMoreButton()).toBeNull();
  });

  it('resumes auto-loading when the user asks for more', async () => {
    infiniteScrollState.isStalled = true;

    render(<NotificationsContainer />);
    await userEvent.click(loadMoreButton()!);

    expect(mockResumeAutoLoad).toHaveBeenCalledTimes(1);
  });

  it('never offers the manual button once there is nothing left to load', () => {
    infiniteScrollState.isStalled = true;
    mockShortList(false);

    render(<NotificationsContainer />);

    expect(loadMoreButton()).toBeNull();
  });
});
