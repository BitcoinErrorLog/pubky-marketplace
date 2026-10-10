import { usePathname } from 'next/navigation';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as commerceConfig from '@/config/commerce';
import { FORCE_FEED_SCROLL_TOP_KEY } from '@/config/feed';
import { FileController } from '@/controllers/file/file';
import { useCurrentUserProfile } from '@/hooks/useCurrentUserProfile/useCurrentUserProfile';
import { useKeyboardOffset } from '@/hooks/useKeyboardOffset/useKeyboardOffset';
import { useMarketplaceCartCount } from '@/hooks/useMarketplaceCartCount/useMarketplaceCartCount';
import { useMarketplaceNavAttention } from '@/hooks/useMarketplaceNavAttention/useMarketplaceNavAttention';
import { useMessagesUnread } from '@/hooks/useMessagesUnread/useMessagesUnread';
import { setEmbedded } from '@/test-utils/embedded';
import { setSocialHost } from '@/test-utils/social-host';
import { MobileFooter } from './MobileFooter';

const collectionsDiscoveryMock = vi.hoisted(() => ({
  markCollectionsNavSeen: vi.fn(),
  setShowSignInDialog: vi.fn(),
  showCollectionsNew: false,
}));

let mockCurrentUserPubky: string | null = 'pk:test-user-pubky';
let mockIsPublicRoute = false;
let mockIsCoreExploreRoute = false;

const createSessionStorageMock = () => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  key: vi.fn(),
  length: 0,
});

// Mock Next.js router
vi.mock('next/navigation', () => ({
  usePathname: vi.fn(),
}));

// Mock the organisms
vi.mock('@/organisms/AvatarWithFallback/AvatarWithFallback', () => {
  return {
    AvatarWithFallback: ({
      avatarUrl,
      name,
      size,
      className,
      alt,
    }: {
      avatarUrl?: string;
      name: string;
      size?: string;
      className?: string;
      alt?: string;
    }) => (
      <div data-testid="avatar-with-fallback" className={className} data-size={size}>
        {avatarUrl ? (
          <img data-testid="avatar-image" src={avatarUrl} alt={alt || name} />
        ) : (
          <span data-testid="avatar-fallback">
            {name
              .trim()
              .split(/\s+/)
              .filter(Boolean)
              .slice(0, 2)
              .map((part) => part[0]?.toUpperCase())
              .join('') || 'U'}
          </span>
        )}
        <span data-testid="avatar-name">{name}</span>
      </div>
    ),
  };
});

// Mock the libs - use actual implementations

// Mock the app routes
vi.mock('@/app/routes', async () => {
  const actual = await vi.importActual('@/app/routes');
  return {
    ...actual,
    APP_ROUTES: {
      HOME: '/home',
      SEARCH: '/search',
      HOT: '/hot',
      MARKETPLACE: '/marketplace',
      COLLECTIONS: '/collections',
      MESSAGES: '/messages',
      SETTINGS: '/settings',
      PROFILE: '/profile',
    },
    SETTINGS_ROUTES: {
      ACCOUNT: '/settings/account',
    },
    UNAUTHENTICATED_ROUTES: [],
    AUTHENTICATED_ROUTES: [],
  };
});

// Mock Hooks
vi.mock('@/hooks/useCurrentUserProfile/useCurrentUserProfile', () => ({
  useCurrentUserProfile: vi.fn(() => ({
    userDetails: { name: 'Test User', image: null, indexed_at: 123 },
    currentUserPubky: 'pk:test-user-pubky',
  })),
}));

vi.mock('@/hooks/usePublicRoute/usePublicRoute', () => ({
  usePublicRoute: vi.fn(() => ({
    isPublicRoute: mockIsPublicRoute,
    isDynamicPublicRoute: mockIsPublicRoute,
    isCoreExploreRoute: mockIsCoreExploreRoute,
    isPublicExploreRoute: mockIsPublicRoute || mockIsCoreExploreRoute,
  })),
}));

vi.mock('@/hooks/useKeyboardOffset/useKeyboardOffset', () => ({
  useKeyboardOffset: vi.fn(() => ({ isKeyboardVisible: false, keyboardOffset: 0 })),
}));
vi.mock('@/hooks/useMessagesUnread/useMessagesUnread', () => ({
  useMessagesUnread: vi.fn(() => 0),
}));
vi.mock('@/hooks/useMarketplaceCartCount/useMarketplaceCartCount', () => ({
  useMarketplaceCartCount: vi.fn(() => 0),
}));
vi.mock('@/hooks/useMarketplaceNavAttention/useMarketplaceNavAttention', () => ({
  useMarketplaceNavAttention: vi.fn(() => 0),
}));

vi.mock('@/hooks/useCollectionsNavDiscovery/useCollectionsNavDiscovery', () => ({
  useCollectionsNavDiscovery: () => ({
    showCollectionsNew: Boolean(mockCurrentUserPubky) && collectionsDiscoveryMock.showCollectionsNew,
    markCollectionsNavSeen: collectionsDiscoveryMock.markCollectionsNavSeen,
  }),
}));

// Track notification store mock for per-test overrides
const mockSelectUnread = vi.fn(() => 0);
vi.mock('@/controllers/file/file', () => ({
  FileController: {
    getAvatarUrl: vi.fn((pubky: string, version?: string | number) =>
      version ? `https://example.com/avatar/${pubky}?v=${version}` : `https://example.com/avatar/${pubky}`,
    ),
  },
}));
vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: vi.fn(
    (selector: (state: { currentUserPubky: string | null; setShowSignInDialog: (open: boolean) => void }) => unknown) =>
      selector({
        currentUserPubky: mockCurrentUserPubky,
        setShowSignInDialog: collectionsDiscoveryMock.setShowSignInDialog,
      }),
  ),
}));
vi.mock('@/stores/localFiles/localFiles.store', () => ({
  useLocalFilesStore: vi.fn((selector: (state: { profile: string | null }) => unknown) => selector({ profile: null })),
}));
vi.mock('@/stores/notification/notification.store', () => ({
  useNotificationStore: vi.fn(
    (selector: (state: { selectUnread: () => number; selectTotalUnread: () => number }) => unknown) =>
      selector({ selectUnread: mockSelectUnread, selectTotalUnread: mockSelectUnread }),
  ),
}));

describe('MobileFooter', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(usePathname).mockReturnValue('/home');
    mockSelectUnread.mockReturnValue(0);
    vi.mocked(useMarketplaceCartCount).mockReturnValue(0);
    vi.mocked(useMarketplaceNavAttention).mockReturnValue(0);
    mockCurrentUserPubky = 'pk:test-user-pubky';
    collectionsDiscoveryMock.showCollectionsNew = false;
    mockIsPublicRoute = false;
    mockIsCoreExploreRoute = false;
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: createSessionStorageMock(),
    });
    HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
    HTMLElement.prototype.setPointerCapture = vi.fn();
    HTMLElement.prototype.releasePointerCapture = vi.fn();
    HTMLElement.prototype.scrollIntoView = vi.fn();

    // Reset keyboard offset mock
    vi.mocked(useKeyboardOffset).mockReturnValue({ isKeyboardVisible: false, keyboardOffset: 0 });
  });

  describe('embedded in another app', () => {
    afterEach(() => setEmbedded(false));

    it('renders no footer navigation so the host app owns the page navigation', () => {
      setEmbedded(true);
      const { container } = render(<MobileFooter />);
      expect(container).toBeEmptyDOMElement();
    });
  });

  it('renders with default props', () => {
    render(<MobileFooter />);

    expect(document.querySelector('.lucide-house')).toBeInTheDocument();
    expect(document.querySelector('.lucide-search')).toBeInTheDocument();
    expect(document.querySelector('.lucide-flame')).toBeInTheDocument();
    expect(document.querySelector('.lucide-library')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();
    expect(screen.getByTestId('avatar-with-fallback')).toBeInTheDocument();
  });

  it('renders with custom className', () => {
    render(<MobileFooter className="custom-footer" />);

    expect(document.querySelector('.lucide-house')).toBeInTheDocument();
  });

  it('renders all navigation items', () => {
    render(<MobileFooter />);

    const navItems = [
      { href: '/home', iconClass: '.lucide-house', label: 'Home' },
      { href: '/search', iconClass: '.lucide-search', label: 'Search' },
      { href: '/hot', iconClass: '.lucide-flame', label: 'Hot' },
      { href: '/collections', iconClass: '.lucide-library', label: 'Collections' },
    ];

    const links = screen.getAllByRole('link');
    navItems.forEach((item) => {
      const link = links.find((link) => link.getAttribute('href') === item.href);
      expect(link).toHaveAttribute('href', item.href);
      expect(link).toHaveAttribute('aria-label', item.label);
    });
  });

  it('hides Marketplace from navigation by default', () => {
    render(<MobileFooter />);
    expect(screen.queryByRole('link', { name: 'Marketplace' })).not.toBeInTheDocument();
  });

  it('shows Marketplace in navigation when the commerce adapter is enabled', () => {
    const adapterMode = vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    try {
      render(<MobileFooter />);
      expect(screen.getByRole('link', { name: 'Marketplace' })).toHaveAttribute('href', '/marketplace');
    } finally {
      adapterMode.mockRestore();
    }
  });

  it('shows the cart badge with honest accessibility copy', () => {
    const adapterMode = vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    vi.mocked(useMarketplaceCartCount).mockReturnValue(3);
    try {
      render(<MobileFooter />);

      expect(screen.getByRole('link', { name: 'Marketplace, 3 items in cart' })).toBeInTheDocument();
      expect(document.querySelector('[data-cy="mobile-marketplace-counter"]')).toHaveTextContent('3');
    } finally {
      adapterMode.mockRestore();
    }
  });

  it('uses singular cart accessibility copy for one item', () => {
    const adapterMode = vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    vi.mocked(useMarketplaceCartCount).mockReturnValue(1);
    try {
      render(<MobileFooter />);

      expect(screen.getByRole('link', { name: 'Marketplace, 1 item in cart' })).toBeInTheDocument();
    } finally {
      adapterMode.mockRestore();
    }
  });

  it('hides the cart badge at zero and caps it above 21', () => {
    const adapterMode = vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    try {
      vi.mocked(useMarketplaceCartCount).mockReturnValue(0);
      const { unmount } = render(<MobileFooter />);
      expect(document.querySelector('[data-cy="mobile-marketplace-counter"]')).toBeNull();
      unmount();

      vi.mocked(useMarketplaceCartCount).mockReturnValue(22);
      render(<MobileFooter />);
      expect(document.querySelector('[data-cy="mobile-marketplace-counter"]')).toHaveTextContent('21+');
      expect(screen.getByRole('link', { name: 'Marketplace, 22 items in cart' })).toBeInTheDocument();
    } finally {
      adapterMode.mockRestore();
    }
  });

  it('adds orders and activity that need attention to the marketplace badge', () => {
    const adapterMode = vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    vi.mocked(useMarketplaceCartCount).mockReturnValue(1);
    vi.mocked(useMarketplaceNavAttention).mockReturnValue(2);
    try {
      render(<MobileFooter />);

      expect(screen.getByRole('link', { name: 'Marketplace, 1 item in cart, 2 need attention' })).toBeInTheDocument();
      expect(document.querySelector('[data-cy="mobile-marketplace-counter"]')).toHaveTextContent('3');
    } finally {
      adapterMode.mockRestore();
    }
  });

  it('renders the profile avatar inside the designer account menu trigger', () => {
    render(<MobileFooter />);

    const accountMenu = screen.getByTestId('avatar-with-fallback').closest('button');
    expect(accountMenu).toHaveAttribute('aria-label', 'Account menu');
  });

  it('preserves messages, settings, notifications, profile, and posts routes in the account menu', () => {
    render(<MobileFooter />);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Account menu' }), { button: 0, ctrlKey: false });

    expect(screen.getByRole('menuitem', { name: 'Messages' })).toHaveAttribute('href', '/messages');
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute('href', '/settings/account');
    expect(screen.getByRole('menuitem', { name: 'Notifications' })).toHaveAttribute('href', '/profile');
    expect(screen.getByRole('menuitem', { name: 'Profile' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'My posts' })).toBeInTheDocument();
  });

  it('contains correct icons', () => {
    render(<MobileFooter />);

    expect(document.querySelector('.lucide-search')).toBeInTheDocument();
    expect(document.querySelector('.lucide-house')).toBeInTheDocument();
    expect(document.querySelector('.lucide-library')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  });

  it('renders avatar with user name', () => {
    render(<MobileFooter />);

    const avatarName = screen.getByTestId('avatar-name');
    expect(avatarName).toBeInTheDocument();
    expect(avatarName).toHaveTextContent('Test User');
  });

  it('does not request avatar URL when user has no avatar set', async () => {
    render(<MobileFooter />);

    expect(vi.mocked(FileController.getAvatarUrl)).not.toHaveBeenCalled();
    expect(screen.queryByTestId('avatar-image')).not.toBeInTheDocument();
    expect(screen.getByTestId('avatar-fallback')).toHaveTextContent('TU');
  });

  it('requests avatar URL when user has an avatar set', async () => {
    vi.mocked(useCurrentUserProfile).mockReturnValueOnce({
      userDetails: {
        id: 'pk:test-user-pubky',
        name: 'Test User',
        bio: '',
        image: 'has-avatar',
        indexed_at: 456,
        links: [],
        status: '',
      },
      currentUserPubky: 'pk:test-user-pubky',
    });

    render(<MobileFooter />);

    expect(vi.mocked(FileController.getAvatarUrl)).toHaveBeenCalledWith('pk:test-user-pubky', 456);
    expect(screen.getByTestId('avatar-image').getAttribute('src')).toBe(
      'https://example.com/avatar/pk:test-user-pubky?v=456',
    );
  });

  it('applies correct icon classes', () => {
    render(<MobileFooter />);

    const iconClasses = ['.lucide-house', '.lucide-search', '.lucide-flame', '.lucide-library'];
    iconClasses.forEach((selector) => {
      const iconElement = document.querySelector(selector) as HTMLElement | null;
      expect(iconElement).toHaveClass('h-6', 'w-6');
    });
  });

  it('handles active state correctly', () => {
    vi.mocked(usePathname).mockReturnValue('/home');
    render(<MobileFooter />);

    const homeLink = document.querySelector('.lucide-house')?.closest('a');
    expect(homeLink).toHaveClass('bg-secondary');
    expect(homeLink).not.toHaveClass('border');
  });

  it('handles inactive state correctly', () => {
    vi.mocked(usePathname).mockReturnValue('/search');
    render(<MobileFooter />);

    const homeLink = document.querySelector('.lucide-house')?.closest('a');
    expect(homeLink).toHaveClass('border', 'border-border', 'bg-white/5');
    expect(homeLink).not.toHaveClass('bg-secondary');
  });

  it('keeps settings reachable from the account menu on settings routes', () => {
    vi.mocked(usePathname).mockReturnValue('/settings/account');
    render(<MobileFooter />);

    expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  });

  it('highlights Collections on the Collections landing page', () => {
    vi.mocked(usePathname).mockReturnValue('/collections');
    render(<MobileFooter />);

    const collectionsLink = document.querySelector('.lucide-library')?.closest('a');
    expect(collectionsLink).toHaveClass('bg-secondary');
    expect(collectionsLink).not.toHaveClass('border');
  });

  it('highlights Collections when on a nested collection route', () => {
    vi.mocked(usePathname).mockReturnValue('/collections/bookmarks');
    render(<MobileFooter />);

    const collectionsLink = document.querySelector('.lucide-library')?.closest('a');
    expect(collectionsLink).toHaveClass('bg-secondary');
    expect(collectionsLink).not.toHaveClass('border');
  });

  it('keeps the designer Collections treatment when discovery is new', () => {
    collectionsDiscoveryMock.showCollectionsNew = true;

    render(<MobileFooter />);

    const collectionsLink = document.querySelector('.lucide-library')?.closest('a');
    expect(collectionsLink).toHaveClass('border', 'border-border', 'bg-white/5');
    expect(screen.queryByText('New')).not.toBeInTheDocument();
  });

  it('keeps the active designer background when Collections is active and new', () => {
    vi.mocked(usePathname).mockReturnValue('/collections');
    collectionsDiscoveryMock.showCollectionsNew = true;

    render(<MobileFooter />);

    const collectionsLink = document.querySelector('.lucide-library')?.closest('a');
    expect(collectionsLink).toHaveClass('bg-secondary');
  });

  it('marks Collections discovery seen when clicking the authenticated Collections nav link', () => {
    collectionsDiscoveryMock.showCollectionsNew = true;
    render(<MobileFooter />);

    const collectionsLink = document.querySelector('.lucide-library')?.closest('a');
    expect(collectionsLink).toBeTruthy();
    fireEvent.click(collectionsLink!);

    expect(collectionsDiscoveryMock.markCollectionsNavSeen).toHaveBeenCalledTimes(1);
  });

  it('does not show or dismiss Collections discovery for guests', () => {
    mockCurrentUserPubky = null;
    mockIsCoreExploreRoute = true;
    collectionsDiscoveryMock.showCollectionsNew = true;

    render(<MobileFooter />);

    expect(screen.queryByText('New')).not.toBeInTheDocument();
    const collectionsLink = document.querySelector('.lucide-library')?.closest('a');
    expect(collectionsLink).toBeTruthy();
    expect(collectionsLink).toHaveAttribute('href', '/collections');
    fireEvent.click(collectionsLink!);
    expect(collectionsDiscoveryMock.markCollectionsNavSeen).not.toHaveBeenCalled();
    expect(collectionsDiscoveryMock.setShowSignInDialog).not.toHaveBeenCalled();
  });

  it('keeps the account menu visible on sibling settings pages', () => {
    vi.mocked(usePathname).mockReturnValue('/settings/notifications');
    render(<MobileFooter />);

    expect(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();
  });

  it('does not add a route ring to the account menu on a profile route', () => {
    vi.mocked(usePathname).mockReturnValue('/profile/posts');
    render(<MobileFooter />);

    const accountMenu = screen.getByTestId('avatar-with-fallback').closest('button');
    expect(accountMenu).not.toHaveClass('ring-2', 'ring-primary');
  });

  it('does not add a route ring to the account menu on a non-profile route', () => {
    vi.mocked(usePathname).mockReturnValue('/home');
    render(<MobileFooter />);

    const accountMenu = screen.getByTestId('avatar-with-fallback').closest('button');
    expect(accountMenu).not.toHaveClass('ring-2', 'ring-primary');
  });

  it('displays notification counter badge when unread notifications > 0', () => {
    mockSelectUnread.mockReturnValue(5);
    render(<MobileFooter />);

    const badge = screen.getByTestId('mobile-notification-counter');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent('5');
  });

  it('does not display notification counter badge when unread notifications is 0', () => {
    mockSelectUnread.mockReturnValue(0);
    render(<MobileFooter />);

    expect(screen.queryByTestId('mobile-notification-counter')).not.toBeInTheDocument();
  });

  it('displays 21+ when unread notifications exceed 21', () => {
    mockSelectUnread.mockReturnValue(25);
    render(<MobileFooter />);

    const badge = screen.getByTestId('mobile-notification-counter');
    expect(badge).toHaveTextContent('21+');
  });

  it('renders with correct responsive behavior', () => {
    render(<MobileFooter />);

    expect(document.querySelector('.lucide-house')).toBeInTheDocument();
  });

  it('applies correct hover states', () => {
    render(<MobileFooter />);

    expect(document.querySelector('.lucide-house')).toBeInTheDocument();
  });

  it('scrolls to top when clicking Home while already on /home', () => {
    vi.mocked(usePathname).mockReturnValue('/home');
    Object.defineProperty(window, 'scrollTo', { value: vi.fn(), writable: true });
    const setItemSpy = vi.spyOn(window.sessionStorage, 'setItem');

    render(<MobileFooter />);
    const homeLink = document.querySelector('.lucide-house')?.closest('a');
    expect(homeLink).toBeTruthy();

    fireEvent.click(homeLink!);
    expect(window.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    expect(setItemSpy).not.toHaveBeenCalled();
  });

  it('does not scroll to top when clicking Home from another page', () => {
    vi.mocked(usePathname).mockReturnValue('/search');
    Object.defineProperty(window, 'scrollTo', { value: vi.fn(), writable: true });
    const setItemSpy = vi.spyOn(window.sessionStorage, 'setItem');

    render(<MobileFooter />);
    const homeLink = document.querySelector('.lucide-house')?.closest('a');
    expect(homeLink).toBeTruthy();

    fireEvent.click(homeLink!);
    expect(window.scrollTo).not.toHaveBeenCalled();
    expect(setItemSpy).toHaveBeenCalledWith(FORCE_FEED_SCROLL_TOP_KEY, '1');
  });

  it('applies transform when keyboard is visible', async () => {
    vi.mocked(useKeyboardOffset).mockReturnValue({ isKeyboardVisible: true, keyboardOffset: 300 });

    const { container } = render(<MobileFooter />);
    const footerContainer = container.querySelector('.fixed');

    expect(footerContainer).toBeInTheDocument();
    expect(footerContainer?.getAttribute('style')).toContain('translateY(-300px)');
  });

  it('does not apply transform when keyboard is not visible', async () => {
    vi.mocked(useKeyboardOffset).mockReturnValue({ isKeyboardVisible: false, keyboardOffset: 0 });

    const { container } = render(<MobileFooter />);
    const footerContainer = container.querySelector('.fixed');

    expect(footerContainer).toBeInTheDocument();
    expect(footerContainer?.getAttribute('style')).toBeFalsy();
  });

  it('always applies transition classes for smooth keyboard animation', async () => {
    // transition-transform and duration-75 are always present regardless of keyboard state
    vi.mocked(useKeyboardOffset).mockReturnValue({ isKeyboardVisible: false, keyboardOffset: 0 });
    const { container, rerender } = render(<MobileFooter />);
    let footerContainer = container.querySelector('.fixed');
    expect(footerContainer).toHaveClass('transition-transform', 'duration-75');

    // Still present when keyboard is visible
    vi.mocked(useKeyboardOffset).mockReturnValue({ isKeyboardVisible: true, keyboardOffset: 300 });
    rerender(<MobileFooter />);
    footerContainer = container.querySelector('.fixed');
    expect(footerContainer).toHaveClass('transition-transform', 'duration-75');
  });

  it('renders the designer public navigation and join action for guests', () => {
    mockCurrentUserPubky = null;
    mockIsCoreExploreRoute = true;

    render(<MobileFooter />);

    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['/home', '/search', '/hot', '/collections']);
    expect(document.querySelector('.lucide-library')).toBeInTheDocument();
    expect(document.querySelector('.lucide-settings')).not.toBeInTheDocument();
    expect(screen.queryByTestId('avatar-with-fallback')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join Pubky' })).toBeInTheDocument();
  });

  it('renders explore footer for guests on dynamic public routes', () => {
    mockCurrentUserPubky = null;
    mockIsPublicRoute = true;
    mockIsCoreExploreRoute = false;

    render(<MobileFooter />);

    expect(screen.getByRole('button', { name: 'Join Pubky' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Home' })).toBeInTheDocument();
  });

  it('does not render for guests on non-explore routes', () => {
    mockCurrentUserPubky = null;
    mockIsPublicRoute = false;
    mockIsCoreExploreRoute = false;

    const { container } = render(<MobileFooter />);

    expect(container.firstChild).toBeNull();
  });

  describe('social link-out', () => {
    afterEach(() => {
      setSocialHost(undefined);
    });

    it('renders no social-host link while off', () => {
      render(<MobileFooter />);

      expect(screen.queryByRole('link', { name: 'Pubky' })).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', '/home');
      expect(useMessagesUnread).toHaveBeenCalledWith({ enabled: true });
    });

    it('shows global App links and local Shop, with the App profile in the same tab', () => {
      setSocialHost('https://pubky.app');
      const adapterMode = vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
      try {
        vi.mocked(usePathname).mockReturnValue('/marketplace/listing/example');
        render(<MobileFooter />);
        expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
          'https://pubky.app/home',
          'https://pubky.app/search',
          'https://pubky.app/hot',
          '/marketplace',
          'https://pubky.app/collections',
          'https://pubky.app/settings/account',
          'https://pubky.app/profile',
        ]);
        expect(screen.getByRole('link', { name: 'Shop' })).toHaveClass('bg-secondary');
        expect(screen.getByRole('link', { name: 'Search' })).not.toHaveAttribute('target');
        expect(screen.getByRole('link', { name: 'Profile' })).not.toHaveAttribute('target');
        expect(screen.queryByRole('button', { name: 'Account menu' })).not.toBeInTheDocument();
        expect(useMessagesUnread).toHaveBeenCalledWith({ enabled: false });
      } finally {
        adapterMode.mockRestore();
      }
    });

    it('lets guests navigate to App Search and Settings without signing into Shop', () => {
      setSocialHost('https://staging.pubky.app');
      mockCurrentUserPubky = null;
      mockIsCoreExploreRoute = true;
      render(<MobileFooter />);
      expect(screen.getByRole('link', { name: 'Search' })).toHaveAttribute('href', 'https://staging.pubky.app/search');
      fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
      expect(collectionsDiscoveryMock.setShowSignInDialog).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Join Pubky' })).toBeInTheDocument();
    });
  });
});

describe('MobileFooter - Snapshots', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(usePathname).mockReturnValue('/home');
    mockSelectUnread.mockReturnValue(0);
    mockCurrentUserPubky = 'pk:test-user-pubky';
    collectionsDiscoveryMock.showCollectionsNew = false;
    mockIsPublicRoute = false;
    mockIsCoreExploreRoute = false;
    vi.mocked(useKeyboardOffset).mockReturnValue({ isKeyboardVisible: false, keyboardOffset: 0 });
  });

  it('matches snapshot with default props', () => {
    const { container } = render(<MobileFooter />);
    expect(container.firstChild).toMatchSnapshot();
  });

  it('matches snapshot with custom className', () => {
    const { container } = render(<MobileFooter className="custom-footer" />);
    expect(container.firstChild).toMatchSnapshot();
  });

  it('matches snapshot with different active path', () => {
    vi.mocked(usePathname).mockReturnValue('/search');
    const { container } = render(<MobileFooter />);
    expect(container.firstChild).toMatchSnapshot();
  });

  it('matches snapshot for navigation links', () => {
    render(<MobileFooter />);

    const homeLink = document.querySelector('.lucide-house')?.closest('a');
    expect(homeLink).toMatchSnapshot();
  });

  it('matches snapshot for account menu trigger', () => {
    render(<MobileFooter />);

    const accountMenu = screen.getByTestId('avatar-with-fallback').closest('button');
    expect(accountMenu).toMatchSnapshot();
  });
});
