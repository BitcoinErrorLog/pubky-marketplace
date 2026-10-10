// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore } from '@/test/mocks/marketplace-vrt';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { setEmbedded } from '@/test-utils/embedded';
import { Fab } from '@/molecules/Fab/Fab';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { Header } from '@/organisms/Header/Header';
import { MarketplaceSectionNav } from '@/organisms/Marketplace/MarketplaceSectionNav';

// The Shop shell as pubky.app's iframe shows it: the real root-layout chrome (Header, Fab) and
// the real ContentLayout (mobile header and footer) around the marketplace section bar. Embedded,
// the host app owns the page chrome, so only the Shop's own content may remain. Scenes exist for
// the embedded variant only; the standalone shell is covered by the existing scenes.

const USER = vi.hoisted(() => 'y'.repeat(52));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/marketplace/orders',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: createMarketplaceVrtAuthStore({ currentUserPubky: USER }),
}));

vi.mock('@/hooks/useRequireAuth/useRequireAuth', () => ({
  useRequireAuth: () => ({ requireAuth: (action: () => void) => action() }),
}));

vi.mock('@/hooks/useMarketplaceCartCount/useMarketplaceCartCount', () => ({
  useMarketplaceCartCount: () => 2,
}));
vi.mock('@/hooks/useMarketplaceActivityUnread/useMarketplaceActivityUnread', () => ({
  useMarketplaceActivityUnread: () => 0,
}));
vi.mock('@/hooks/useMarketplaceOrdersAttention/useMarketplaceOrdersAttention', () => ({
  useMarketplaceOrdersAttention: () => 1,
}));
vi.mock('@/hooks/useMarketplaceNavAttention/useMarketplaceNavAttention', () => ({
  useMarketplaceNavAttention: () => 0,
}));
vi.mock('@/hooks/useMessagesUnread/useMessagesUnread', () => ({
  useMessagesUnread: () => 0,
}));
vi.mock('@/hooks/useCurrentUserProfile/useCurrentUserProfile', () => ({
  useCurrentUserProfile: () => ({
    userDetails: { name: 'Satoshi', image: null, indexed_at: 0 },
    currentUserPubky: USER,
  }),
}));
vi.mock('@/hooks/useCollectionsNavDiscovery/useCollectionsNavDiscovery', () => ({
  useCollectionsNavDiscovery: () => ({ showCollectionsNew: false, markCollectionsNavSeen: vi.fn() }),
}));
vi.mock('@/hooks/useAuthStatus/useAuthStatus', () => ({
  useAuthStatus: () => ({
    isFullyAuthenticated: true,
    isLoading: false,
    status: 'AUTHENTICATED',
    hasKeypair: true,
    hasProfile: true,
  }),
}));
vi.mock('@/hooks/useFabAction/useFabAction', () => ({
  useFabAction: () => ({ kind: 'createPost', ariaLabel: 'New post' }),
}));
vi.mock('@/hooks/useHotTags/useHotTags', () => ({
  useHotTags: () => ({ tags: [], rawTags: [], isLoading: false, error: null, refetch: async () => {} }),
}));

function EmbeddedShopPage() {
  return (
    <>
      <Header />
      <ContentLayout showLeftSidebar={false} showRightSidebar={false}>
        <MarketplaceSectionNav />
        <h1 className="text-2xl font-semibold">Orders</h1>
        <p className="text-muted-foreground">Your purchases and sales appear here.</p>
      </ContentLayout>
      <Fab />
    </>
  );
}

function expectNoShopChrome(root: HTMLElement) {
  expect(root.querySelector('header'), 'the Shop header').toBeNull();
  expect(root.querySelector('[data-testid="new-post-cta"]'), 'the floating action button').toBeNull();
  expect(root.querySelector('button[aria-label="Account menu"]'), 'the mobile footer account menu').toBeNull();
  expect(root.querySelector('[data-testid="marketplace-section-nav"]'), 'the Shop section bar').not.toBeNull();
}

describe('Shop embedded in another app — visual regression', () => {
  afterEach(() => setEmbedded(false));

  it('shows only the Shop content at desktop viewport', async () => {
    setEmbedded(true);
    const screen = await renderForVRT(<EmbeddedShopPage />, { viewport: VRT_VIEWPORT_DESKTOP });

    expectNoShopChrome(screen.getByTestId(VRT_ROOT_TESTID).element() as HTMLElement);
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('embedded-shell-desktop');
  });

  it('shows only the Shop content at mobile viewport, without the mobile header and footer', async () => {
    setEmbedded(true);
    const screen = await renderForVRT(<EmbeddedShopPage />, { viewport: VRT_VIEWPORT_MOBILE });

    expectNoShopChrome(screen.getByTestId(VRT_ROOT_TESTID).element() as HTMLElement);
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('embedded-shell-mobile');
  });

  it('still renders the Shop chrome when not embedded (the scenes above are the embedded variant only)', async () => {
    const screen = await renderForVRT(<EmbeddedShopPage />, { viewport: VRT_VIEWPORT_DESKTOP });

    const root = screen.getByTestId(VRT_ROOT_TESTID).element() as HTMLElement;
    expect(root.querySelector('header')).not.toBeNull();
    expect(root.querySelector('[data-testid="new-post-cta"]')).not.toBeNull();
  });
});
