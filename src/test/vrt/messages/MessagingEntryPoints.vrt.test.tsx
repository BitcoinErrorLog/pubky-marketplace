// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { HeaderNavigationButtons } from '@/molecules/Header/Header';
import { MobileFooter } from '@/molecules/MobileFooter/MobileFooter';
import { ProfilePageHeader } from '@/organisms/ProfilePageHeader/ProfilePageHeader';

const COUNTERPARTY = 'z'.repeat(52);

const unread = vi.hoisted(() => ({ count: 0 }));
const auth = vi.hoisted(() => ({ currentUserPubky: 'o'.repeat(52) as string | null }));
const cart = vi.hoisted(() => ({ count: 0 }));
const commerce = vi.hoisted(() => ({ mode: 'unavailable' as 'unavailable' | 'sandbox' }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/home',
}));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => commerce.mode };
});

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      currentUserPubky: auth.currentUserPubky,
      setShowSignInDialog: vi.fn(),
    }),
}));

vi.mock('@/hooks/useMessagesUnread/useMessagesUnread', () => ({
  useMessagesUnread: () => unread.count,
}));

vi.mock('@/hooks/useMarketplaceCartCount/useMarketplaceCartCount', () => ({
  useMarketplaceCartCount: () => cart.count,
}));

vi.mock('@/hooks/useCollectionsNavDiscovery/useCollectionsNavDiscovery', () => ({
  useCollectionsNavDiscovery: () => ({ showCollectionsNew: false, markCollectionsNavSeen: vi.fn() }),
}));

vi.mock('@/hooks/useRequireAuth/useRequireAuth', () => ({
  useRequireAuth: () => ({ requireAuth: <T,>(action: () => T) => action() }),
}));

vi.mock('@/hooks/useTtlSubscription/useTtlSubscription', () => ({
  useTtlSubscription: () => ({ ref: () => {} }),
}));

vi.mock('@/hooks/useCurrentUserProfile/useCurrentUserProfile', () => ({
  useCurrentUserProfile: () => ({ userDetails: null, currentUserPubky: auth.currentUserPubky }),
}));

vi.mock('@/hooks/useKeyboardOffset/useKeyboardOffset', () => ({
  useKeyboardOffset: () => ({ isKeyboardVisible: false, keyboardOffset: 0 }),
}));

vi.mock('@/hooks/usePublicRoute/usePublicRoute', () => ({
  usePublicRoute: () => ({ isPublicExploreRoute: false, isCoreExploreRoute: false, isDynamicPublicRoute: false }),
}));

vi.mock('@/stores/notification/notification.store', () => ({
  useNotificationStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ selectTotalUnread: () => 0 }),
}));

vi.mock('@/stores/localFiles/localFiles.store', () => ({
  useLocalFilesStore: (selector: (state: Record<string, unknown>) => unknown) => selector({ profile: null }),
}));

function ProfileHeaderHarness() {
  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-10">
      <ProfilePageHeader
        profile={{
          name: 'Satoshi Nakamoto',
          publicKey: COUNTERPARTY,
          link: `https://pubky.app/profile/${COUNTERPARTY}`,
          status: '',
        }}
        actions={{
          onCopyLink: () => {},
          onCopyPublicKey: () => {},
          onFollowToggle: () => {},
          isFollowLoading: false,
          followLoadingAction: null,
          isFollowing: false,
        }}
        isOwnProfile={false}
        userId={COUNTERPARTY}
      />
    </main>
  );
}

describe('Messaging entry points — visual regression', () => {
  beforeEach(() => {
    unread.count = 0;
    cart.count = 0;
    commerce.mode = 'unavailable';
    auth.currentUserPubky = 'o'.repeat(52);
  });

  it('renders the header navigation with the Messages icon at desktop viewport', async () => {
    const screen = await renderForVRT(
      <main className="flex w-full justify-center py-10">
        <HeaderNavigationButtons avatarName="U" avatarSeed="vrt-user" />
      </main>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('header-messages-icon-desktop');
  });

  it('renders the header Messages icon with the honest unread badge at desktop viewport', async () => {
    unread.count = 3;

    const screen = await renderForVRT(
      <main className="flex w-full justify-center py-10">
        <HeaderNavigationButtons avatarName="U" avatarSeed="vrt-user" />
      </main>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('header-messages-unread-desktop');
  });

  it('renders the mobile footer with the Messages item and unread badge at mobile viewport', async () => {
    unread.count = 2;

    const screen = await renderForVRT(
      <main className="min-h-40 w-full">
        <MobileFooter />
      </main>,
      { viewport: VRT_VIEWPORT_MOBILE },
    );
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('footer-messages-unread-mobile');
  });

  it('renders the header Store item with a populated cart badge at desktop viewport', async () => {
    commerce.mode = 'sandbox';
    cart.count = 3;

    const screen = await renderForVRT(
      <main className="flex w-full justify-center py-10">
        <HeaderNavigationButtons avatarName="U" avatarSeed="vrt-user" />
      </main>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('header-store-cart-badge-desktop');
  });

  it('renders the mobile footer Store item with a capped cart badge at mobile viewport', async () => {
    commerce.mode = 'sandbox';
    cart.count = 25;

    const screen = await renderForVRT(
      <main className="min-h-40 w-full">
        <MobileFooter />
      </main>,
      { viewport: VRT_VIEWPORT_MOBILE },
    );
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('footer-store-cart-badge-mobile');
  });

  it('renders the profile Message button on another user profile at desktop viewport', async () => {
    const screen = await renderForVRT(<ProfileHeaderHarness />, { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('profile-message-button-desktop');
  });

  it('renders the profile Message button at mobile viewport', async () => {
    const screen = await renderForVRT(<ProfileHeaderHarness />, { viewport: VRT_VIEWPORT_MOBILE });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('profile-message-button-mobile');
  });
});
