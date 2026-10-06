// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore } from '@/test/mocks/marketplace-vrt';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderForVRT } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { setSocialHost } from '@/test-utils/social-host';
import { HeaderExploreNavigationButtons } from '@/molecules/Header/Header';
import { HeaderSignIn } from '@/molecules/HeaderSignIn/HeaderSignIn';
import { MobileFooter } from '@/molecules/MobileFooter/MobileFooter';
import { useNotificationStore } from '@/stores/notification/notification.store';

// The Shop nav with social link-out on (NEXT_PUBLIC_SOCIAL_HOST set): Marketplace,
// Messages and one Pubky link, no social search, account entries pointing at
// the Shop. The link-out-off header is pinned by NotificationBadge.vrt.

const VRT_USER_PUBKY = vi.hoisted(() => 'v'.repeat(52));
const viewer = vi.hoisted(() => ({ pubky: 'v'.repeat(52) as string | null }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: createMarketplaceVrtAuthStore({ getCurrentUserPubky: () => viewer.pubky }),
}));

vi.mock('@/hooks/useCurrentUserProfile/useCurrentUserProfile', () => ({
  useCurrentUserProfile: () => ({
    userDetails: { name: 'Satoshi', image: null, indexed_at: 0 },
    currentUserPubky: viewer.pubky,
  }),
}));

vi.mock('@/hooks/useCollectionsNavDiscovery/useCollectionsNavDiscovery', () => ({
  useCollectionsNavDiscovery: () => ({ showCollectionsNew: false, markCollectionsNavSeen: vi.fn() }),
}));

vi.mock('@/hooks/useRequireAuth/useRequireAuth', () => ({
  useRequireAuth: () => ({ requireAuth: (action: () => void) => action() }),
}));

vi.mock('@/config/commerce', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/commerce')>();
  return { ...actual, getCommerceAdapterMode: () => 'sandbox' as const };
});

// Badge hooks are covered by their own tests; fixed values keep the pills deterministic.
vi.mock('@/hooks/useMarketplaceCartCount/useMarketplaceCartCount', () => ({
  useMarketplaceCartCount: () => 2,
}));
vi.mock('@/hooks/useMarketplaceNavAttention/useMarketplaceNavAttention', () => ({
  useMarketplaceNavAttention: () => 0,
}));
vi.mock('@/hooks/useMessagesUnread/useMessagesUnread', () => ({
  useMessagesUnread: () => 1,
}));

const NAV_FRAME_TESTID = 'social-linkout-nav-frame';

/**
 * Captures only the nav, not the whole viewport: the marketplace project's 2%
 * mismatch allowance would otherwise absorb a swapped pill or avatar.
 */
function HeaderFrame({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid={NAV_FRAME_TESTID} className="inline-flex p-3">
      {children}
    </div>
  );
}

/** MobileFooter is `position: fixed`; a transformed frame becomes its containing block. */
function FooterFrame({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid={NAV_FRAME_TESTID} className="relative h-20 w-full" style={{ transform: 'translateZ(0)' }}>
      {children}
    </div>
  );
}

describe('Social link-out nav — visual regression', () => {
  beforeEach(() => {
    setSocialHost('https://pubky.app');
    viewer.pubky = VRT_USER_PUBKY;
  });

  afterEach(() => {
    setSocialHost(undefined);
    useNotificationStore.getState().reset();
  });

  it('renders the signed-in header with Marketplace, Messages and Pubky at desktop viewport', async () => {
    useNotificationStore.getState().setMarketplaceUnread(3);

    const screen = await renderForVRT(
      <HeaderFrame>
        <HeaderSignIn />
      </HeaderFrame>,
      { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true },
    );
    await expect.element(screen.getByRole('link', { name: 'Pubky' })).toHaveAttribute('href', 'https://pubky.app/');
    expect(document.querySelector('[data-cy="header-nav-profile-btn"]')).toHaveAttribute(
      'href',
      '/marketplace/notifications',
    );
    await expect(screen.getByTestId(NAV_FRAME_TESTID)).toMatchScreenshot('social-linkout-header-signed-in-desktop');
  });

  it('renders the guest header with Marketplace, Messages and Pubky at desktop viewport', async () => {
    viewer.pubky = null;

    const screen = await renderForVRT(
      <HeaderFrame>
        <HeaderExploreNavigationButtons />
      </HeaderFrame>,
      { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true },
    );
    await expect.element(screen.getByRole('link', { name: 'Pubky' })).toHaveAttribute('href', 'https://pubky.app/');
    await expect(screen.getByTestId(NAV_FRAME_TESTID)).toMatchScreenshot('social-linkout-header-guest-desktop');
  });

  it('renders the signed-in mobile footer with Marketplace and Pubky at mobile viewport', async () => {
    const screen = await renderForVRT(
      <FooterFrame>
        <MobileFooter />
      </FooterFrame>,
      { viewport: VRT_VIEWPORT_MOBILE, disableHover: true },
    );
    await expect.element(screen.getByRole('link', { name: 'Pubky' })).toHaveAttribute('href', 'https://pubky.app/');
    await expect.element(screen.getByRole('button', { name: 'Account menu' })).toBeInTheDocument();
    await expect(screen.getByTestId(NAV_FRAME_TESTID)).toMatchScreenshot('social-linkout-footer-signed-in-mobile');
  });

  it('renders the guest mobile footer with Marketplace, Pubky and Join at mobile viewport', async () => {
    viewer.pubky = null;

    const screen = await renderForVRT(
      <FooterFrame>
        <MobileFooter />
      </FooterFrame>,
      { viewport: VRT_VIEWPORT_MOBILE, disableHover: true },
    );
    await expect.element(screen.getByRole('button', { name: 'Join Pubky' })).toBeInTheDocument();
    await expect(screen.getByTestId(NAV_FRAME_TESTID)).toMatchScreenshot('social-linkout-footer-guest-mobile');
  });
});
