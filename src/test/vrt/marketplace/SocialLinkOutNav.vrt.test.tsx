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

// Shared primary navigation with social link-out enabled. Social destinations and
// Search open the App; Shop stays local. Link-out-off is pinned by NotificationBadge.vrt.

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
  useMessagesUnread: ({ enabled = true } = {}) => (enabled ? 1 : 0),
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

  it('renders the signed-in header with global App items and Shop at desktop viewport', async () => {
    useNotificationStore.getState().setMarketplaceUnread(3);

    const screen = await renderForVRT(
      <HeaderFrame>
        <HeaderSignIn />
      </HeaderFrame>,
      { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true },
    );
    await expect.element(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', 'https://pubky.app/home');
    expect(document.querySelector('[data-cy="header-nav-profile-btn"]')).toHaveAttribute(
      'href',
      'https://pubky.app/profile',
    );
    await expect(screen.getByTestId(NAV_FRAME_TESTID)).toMatchScreenshot('social-linkout-header-signed-in-desktop');
  });

  it('renders the guest header with global App items and Shop at desktop viewport', async () => {
    viewer.pubky = null;

    const screen = await renderForVRT(
      <HeaderFrame>
        <HeaderExploreNavigationButtons />
      </HeaderFrame>,
      { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true },
    );
    await expect.element(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', 'https://pubky.app/home');
    await expect(screen.getByTestId(NAV_FRAME_TESTID)).toMatchScreenshot('social-linkout-header-guest-desktop');
  });

  it('renders the signed-in mobile footer with global App items and Shop at mobile viewport', async () => {
    const screen = await renderForVRT(
      <FooterFrame>
        <MobileFooter />
      </FooterFrame>,
      { viewport: VRT_VIEWPORT_MOBILE, disableHover: true },
    );
    await expect.element(screen.getByRole('link', { name: 'Home' })).toHaveAttribute('href', 'https://pubky.app/home');
    await expect.element(screen.getByRole('link', { name: 'Profile' })).toBeInTheDocument();
    await expect(screen.getByTestId(NAV_FRAME_TESTID)).toMatchScreenshot('social-linkout-footer-signed-in-mobile');
  });

  it('renders the guest mobile footer with global App items, Shop and Join at mobile viewport', async () => {
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

  it.each([
    { width: 320, signedIn: true },
    { width: 320, signedIn: false },
    { width: 375, signedIn: true },
    { width: 375, signedIn: false },
    { width: 390, signedIn: true },
    { width: 390, signedIn: false },
  ])('fits 44px footer targets at $width px (signed in: $signedIn)', async ({ width, signedIn }) => {
    viewer.pubky = signedIn ? VRT_USER_PUBKY : null;
    const screen = await renderForVRT(
      <FooterFrame>
        <MobileFooter />
      </FooterFrame>,
      { viewport: { width, height: VRT_VIEWPORT_MOBILE.height }, disableHover: true },
    );
    const frame = screen.getByTestId(NAV_FRAME_TESTID).element();
    const targets = Array.from(frame.querySelectorAll('a, button'));
    expect(targets).toHaveLength(7);
    for (const target of targets) {
      const rect = target.getBoundingClientRect();
      expect(rect.width).toBeGreaterThanOrEqual(44);
      expect(rect.height).toBeGreaterThanOrEqual(44);
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(width);
    }
  });
});
