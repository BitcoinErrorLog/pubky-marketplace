// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore } from '@/test/mocks/marketplace-vrt';
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { Dialog, DialogContent } from '@/atoms/Dialog/Dialog';
import { Sheet, SheetContent, SheetTitle } from '@/atoms/Sheet/Sheet';
import { Toast, ToastProvider, ToastTitle, ToastViewport } from '@/atoms/Toast/Toast';
import { Header } from '@/organisms/Header/Header';
import { HeaderContainer } from '@/molecules/Header/Header';
import { HeaderSignIn } from '@/molecules/HeaderSignIn/HeaderSignIn';
import { Marketplace } from '@/templates/Marketplace/Marketplace';

// The header search dropdown opened over /marketplace. The header is a
// stacking context, so the dropdown only outranks page content when the
// page's sticky section tabs sit on a lower layer than the header itself.

// The marketplace project tolerates 2% of pixels at colour threshold 0.2, and
// the tab strip and the dropdown are both near-black: a strip covering the
// dropdown differs by less than that. These scenes exist to catch exactly
// that overlap, so they compare at a tolerance a hidden row cannot fit in.
const STRICT_DROPDOWN_SCREENSHOT = {
  comparatorOptions: { allowedMismatchedPixels: 200, allowedMismatchedPixelRatio: 0.0002, threshold: 0.05 },
} as const;

const VRT_USER_PUBKY = vi.hoisted(() => 'y'.repeat(52));

const fixtures = vi.hoisted(async () => {
  const { createCommerceSandboxCatalog } = await import('@/libs/commerce/sandbox-catalog');
  const { buildMarketplaceCatalogItems } = await import('@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils');
  const { toCommerceListingModel } = await import('@/test/fixtures/commerce/listing-models');

  const catalog = createCommerceSandboxCatalog();
  return {
    listings: buildMarketplaceCatalogItems(catalog.listings.map(toCommerceListingModel), []),
    shopsBySeller: new Map(catalog.shops.map((shop) => [shop.ownerPubky, shop])),
    users: [
      { id: 'a'.repeat(52), name: 'Alice Mercado', avatarUrl: undefined as string | undefined },
      { id: 'b'.repeat(52), name: 'Alicia Ortega', avatarUrl: undefined as string | undefined },
      { id: 'c'.repeat(52), name: 'Alina Croft', avatarUrl: undefined as string | undefined },
    ],
  };
});

vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: () => null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/marketplace',
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/hooks/useRequireAuth/useRequireAuth', () => ({
  useRequireAuth: () => ({ requireAuth: (action: () => void) => action() }),
}));

vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>();
  return { ...actual, getDeployEnv: () => 'staging' };
});

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: createMarketplaceVrtAuthStore({ currentUserPubky: VRT_USER_PUBKY }),
}));

vi.mock('@/hooks/useMarketplaceCatalog/useMarketplaceCatalog', async () => {
  const catalog = await fixtures;
  return {
    useMarketplaceCatalog: () => ({
      listings: catalog.listings,
      facetPool: catalog.listings,
      shopsBySeller: catalog.shopsBySeller,
      isLoading: false,
      adapterMode: 'sandbox',
    }),
  };
});

vi.mock('@/hooks/useCommerceFavorite/useCommerceFavorite', () => ({
  useCommerceFavorite: () => ({ isFavorite: false, isLoading: false, isMutating: false, toggle: vi.fn() }),
}));

vi.mock('@/hooks/useMarketplaceWatchDetection/useMarketplaceWatchDetection', () => ({
  useMarketplaceWatchDetection: () => {},
}));

vi.mock('@/hooks/useMarketplaceCartCount/useMarketplaceCartCount', () => ({
  useMarketplaceCartCount: () => 0,
}));
vi.mock('@/hooks/useMarketplaceActivityUnread/useMarketplaceActivityUnread', () => ({
  useMarketplaceActivityUnread: () => 0,
}));
vi.mock('@/hooks/useMarketplaceNavAttention/useMarketplaceNavAttention', () => ({
  useMarketplaceNavAttention: () => 0,
}));
vi.mock('@/hooks/useMessagesUnread/useMessagesUnread', () => ({
  useMessagesUnread: () => 0,
}));

vi.mock('@/hooks/useMarketplaceSavedSearches/useMarketplaceSavedSearches', () => ({
  useMarketplaceSavedSearches: () => ({
    searches: [],
    isSignedIn: true,
    saveCurrentSearch: vi.fn(async () => true),
    applySearch: vi.fn(async () => {}),
    deleteSearch: vi.fn(async () => {}),
  }),
}));

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  const { createMarketplaceMediaHooks } = await import('@/test/mocks/marketplace-media-hooks');
  return createMarketplaceMediaHooks(() => null);
});

vi.mock('@/hooks/useCurrentUserProfile/useCurrentUserProfile', () => ({
  useCurrentUserProfile: () => ({
    userDetails: { name: 'Satoshi', image: null, indexed_at: 0 },
    currentUserPubky: VRT_USER_PUBKY,
  }),
}));

vi.mock('@/hooks/useCollectionsNavDiscovery/useCollectionsNavDiscovery', () => ({
  useCollectionsNavDiscovery: () => ({ showCollectionsNew: false, markCollectionsNavSeen: vi.fn() }),
}));

vi.mock('@/hooks/useHotTags/useHotTags', () => ({
  useHotTags: () => ({ tags: [], rawTags: [], isLoading: false, error: null, refetch: async () => {} }),
}));

// A focused search field with a typed query keeps the dropdown open and
// deterministic without driving the real focus handlers.
vi.mock('@/hooks/useSearchInput/useSearchInput', async () => {
  const React = await import('react');
  return {
    useSearchInput: () => ({
      inputValue: 'ali',
      isFocused: true,
      containerRef: React.useRef<HTMLDivElement>(null),
      inputRef: React.useRef<HTMLInputElement>(null),
      handleInputChange: vi.fn(),
      handleKeyDown: vi.fn(),
      handleFocus: vi.fn(),
      clearInputValue: vi.fn(),
      setFocus: vi.fn(),
    }),
  };
});

vi.mock('@/hooks/useSearchAutocomplete/useSearchAutocomplete', async () => {
  const { users } = await fixtures;
  return {
    useSearchAutocomplete: () => ({
      tags: [{ name: 'alice' }, { name: 'alias' }, { name: 'alpine' }],
      users,
      isLoading: false,
    }),
  };
});

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

// `Header` hides itself below `lg` for signed-in users, so the mobile scene
// mounts the same container and signed-in content directly.
function MarketplaceWithHeader({ mobile }: { mobile: boolean }) {
  return (
    <>
      {mobile ? (
        <HeaderContainer>
          <HeaderSignIn />
        </HeaderContainer>
      ) : (
        <Header />
      )}
      <Marketplace />
    </>
  );
}

function requireElement(selector: string, root: ParentNode = document): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Expected ${selector} to be mounted`);
  return element;
}

function requireHeading(root: HTMLElement, text: string): HTMLElement {
  const heading = Array.from(root.querySelectorAll<HTMLElement>('*')).find(
    (node) => node.children.length === 0 && node.textContent === text,
  );
  if (!heading) throw new Error(`Expected a "${text}" heading in the search suggestions`);
  return heading;
}

function centerOf(rect: DOMRect) {
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function topElementAt(rect: DOMRect): Element | null {
  const { x, y } = centerOf(rect);
  return document.elementFromPoint(x, y);
}

function overlap(a: DOMRect, b: DOMRect): DOMRect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  if (right <= left || bottom <= top) return null;
  return new DOMRect(left, top, right - left, bottom - top);
}

function tabsWrapper(): HTMLElement {
  const wrapper = requireElement('[data-testid="marketplace-section-nav"]').parentElement;
  if (!wrapper) throw new Error('Section tabs have no sticky wrapper');
  return wrapper;
}

function zIndexOf(element: Element): number {
  return Number(getComputedStyle(element).zIndex);
}

async function renderOpenDropdown(mobile: boolean, disableHover: boolean) {
  const viewport = mobile ? VRT_VIEWPORT_MOBILE : VRT_VIEWPORT_DESKTOP;
  const screen = await renderForVRT(<MarketplaceWithHeader mobile={mobile} />, { viewport, disableHover });
  await vi.waitFor(() => {
    requireElement('[data-testid="search-suggestions"]');
    requireElement('[data-testid="marketplace-section-nav"]');
  });
  return screen;
}

describe('Marketplace header search dropdown — visual regression', () => {
  it('draws the open search dropdown above the section tabs at desktop viewport', async () => {
    const screen = await renderOpenDropdown(false, true);
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'marketplace-search-dropdown-desktop',
      STRICT_DROPDOWN_SCREENSHOT,
    );
  });

  it('draws the open search dropdown above the section tabs at mobile viewport', async () => {
    const screen = await renderOpenDropdown(true, true);
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(
      'marketplace-search-dropdown-mobile',
      STRICT_DROPDOWN_SCREENSHOT,
    );
  });
});

describe.each([
  { name: 'desktop', mobile: false },
  { name: 'mobile', mobile: true },
])('Marketplace header search dropdown stacking at $name viewport', ({ mobile }) => {
  it('hit-tests the dropdown, not the section tabs, wherever the two overlap', async () => {
    await renderOpenDropdown(mobile, false);
    const dropdown = requireElement('[data-testid="search-suggestions"]');
    const tabs = tabsWrapper();

    const shared = overlap(dropdown.getBoundingClientRect(), tabs.getBoundingClientRect());
    expect(shared, 'the dropdown must extend over the section tabs for this scene to prove anything').not.toBeNull();
    const hitInOverlap = topElementAt(shared!);
    expect(hitInOverlap && dropdown.contains(hitInOverlap)).toBe(true);
    expect(hitInOverlap && tabs.contains(hitInOverlap)).toBe(false);

    for (const label of ['Tags', 'Users']) {
      const hit = topElementAt(requireHeading(dropdown, label).getBoundingClientRect());
      expect(hit && dropdown.contains(hit), `${label} heading is covered`).toBe(true);
    }
  });

  it('keeps the section tabs above scrolled listing cards and below the header', async () => {
    await renderOpenDropdown(mobile, false);
    const header = requireElement('header');
    const tabs = tabsWrapper();

    expect(zIndexOf(tabs)).toBeLessThan(zIndexOf(header));
    expect(zIndexOf(tabs)).toBeGreaterThan(10);
  });
});

describe('Marketplace section tabs under the site overlays', () => {
  it('sits below an open dialog', async () => {
    await renderForVRT(
      <>
        <Marketplace />
        <Dialog open>
          <DialogContent hiddenTitle="Overlay probe" centered>
            <p>Dialog body</p>
          </DialogContent>
        </Dialog>
      </>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await vi.waitFor(() => requireElement('[data-slot="dialog-overlay"]'));
    const tabLink = requireElement('a', requireElement('[data-testid="marketplace-section-nav"]'));
    const hit = topElementAt(tabLink.getBoundingClientRect());
    expect(hit?.getAttribute('data-slot')).toBe('dialog-overlay');
  });

  it('sits below an open sheet', async () => {
    await renderForVRT(
      <>
        <Marketplace />
        <Sheet open>
          <SheetContent side="right">
            <SheetTitle>Overlay probe</SheetTitle>
          </SheetContent>
        </Sheet>
      </>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await vi.waitFor(() => requireElement('[role="dialog"]'));
    const tabLink = requireElement('a', requireElement('[data-testid="marketplace-section-nav"]'));
    const hit = topElementAt(tabLink.getBoundingClientRect());
    expect(hit && tabsWrapper().contains(hit)).toBe(false);
  });

  it('sits below the toast viewport', async () => {
    await renderForVRT(
      <>
        <Marketplace />
        <ToastProvider>
          <Toast open>
            <ToastTitle>Overlay probe</ToastTitle>
          </Toast>
          <ToastViewport data-testid="toast-viewport-probe" />
        </ToastProvider>
      </>,
      { viewport: VRT_VIEWPORT_DESKTOP },
    );
    await vi.waitFor(() => requireElement('[data-testid="toast-viewport-probe"]'));
    expect(zIndexOf(requireElement('[data-testid="toast-viewport-probe"]'))).toBeGreaterThan(zIndexOf(tabsWrapper()));
  });
});
