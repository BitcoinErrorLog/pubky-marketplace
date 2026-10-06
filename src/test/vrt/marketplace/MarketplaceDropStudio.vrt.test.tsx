// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore } from '@/test/mocks/marketplace-vrt';
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { DropStudioHome } from '@/organisms/Marketplace/DropStudioHome';

const view = vi.hoisted(() => ({
  filled: false,
  catalog: 'loaded' as 'loaded' | 'unavailable',
  projection: 'loaded' as 'loaded' | 'session-unavailable' | 'unavailable',
  publishStatus: { record: 'idle', sync: 'idle' } as { record: string; sync: string },
  publishErrors: [] as string[],
  publishedDropId: null as string | null,
}));

function installStableDatetimePlaceholderStyle() {
  const styleId = 'marketplace-drop-studio-vrt-datetime';
  document.getElementById(styleId)?.remove();
  const style = document.createElement('style');
  style.id = styleId;
  style.textContent =
    'input[type="datetime-local"][value=""]:not(:focus)::-webkit-datetime-edit { visibility: hidden; }';
  document.head.appendChild(style);
}

// Media-less fixtures keep every capture network-free: the preview card and
// listing rows render their gradient/text fallbacks byte-identically.
const listingsFixture = vi.hoisted(() => [
  {
    id: `${'y'.repeat(52)}:item1`,
    seller_id: 'y'.repeat(52),
    listing_id: 'item1',
    record: {
      title: 'Numbered print — Genesis',
      media: [],
      sale: { format: 'fixed_price', unitPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 } },
    },
    revision: 1,
    state: 'active',
    category_id: 'art',
    format: 'fixed_price',
    currency: 'USD',
    price_minor: 4_500,
    sync_status: 'synced',
    updated_at: 0,
  },
  {
    id: `${'y'.repeat(52)}:item2`,
    seller_id: 'y'.repeat(52),
    listing_id: 'item2',
    record: {
      title: 'Signed zine',
      media: [],
      sale: { format: 'fixed_price', unitPrice: { amountMinor: 1_200, currency: 'USD', exponent: 2 } },
    },
    revision: 1,
    state: 'active',
    category_id: 'art',
    format: 'fixed_price',
    currency: 'USD',
    price_minor: 1_200,
    sync_status: 'synced',
    updated_at: 0,
  },
]);

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace/sell/drops',
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: createMarketplaceVrtAuthStore({ currentUserPubky: 'y'.repeat(52), selectSession: () => null }),
}));

vi.mock('@/hooks/useMarketplaceSessionConnect/useMarketplaceSessionConnect', () => ({
  useMarketplaceSessionConnect: () => ({
    status: 'idle',
    authorizationUrl: '',
    errorMessage: null,
    requestsFullGrant: false,
    requestsGrantReconnect: false,
    start: vi.fn(),
    cancel: vi.fn(),
    copyAuthUrl: vi.fn(async () => {}),
    openInRing: vi.fn(),
    isOpeningRing: false,
  }),
}));

vi.mock('@/hooks/useOwnDrops/useOwnDrops', () => ({
  useOwnDrops: () => ({
    isLoading: false,
    isDurable: true,
    refresh: async () => undefined,
    rows: [
      {
        dropId: 'drop-live',
        record: {
          dropId: 'drop-live',
          title: 'Winter capsule',
          startsAt: '2026-01-01T10:00:00.000Z',
          endsAt: '2026-01-02T10:00:00.000Z',
        },
        projection:
          view.projection === 'loaded'
            ? { status: 'loaded', drop: { dropId: 'drop-live', state: 'live', revision: 3 } }
            : view.projection === 'session-unavailable'
              ? { status: 'session-unavailable' }
              : { status: 'unavailable' },
      },
      {
        dropId: 'drop-unregistered',
        record: {
          dropId: 'drop-unregistered',
          title: 'Spring preview',
          startsAt: '2025-12-20T10:00:00.000Z',
        },
        projection: { status: 'unregistered' },
      },
    ],
  }),
}));

vi.mock('@/hooks/useDropStudio/useDropStudio', async () => {
  const { useForm } = await import('react-hook-form');
  const { dropStudioDefaults: defaults } = await import('@/hooks/useDropStudio/useDropStudio.types');
  return {
    useDropStudio: () => ({
      form: useForm({
        defaultValues: view.filled
          ? {
              ...defaults,
              title: 'Winter capsule — 100 numbered pieces',
              description: 'One hundred numbered pieces, first come first served.',
              listingIds: ['item1', 'item2'],
              startsAtLocal: '2026-01-15T18:00',
              endsAtLocal: '2026-01-16T18:00',
              totalQuantity: '100',
              perBuyerLimit: '2',
              stockDisplay: 'bands',
            }
          : defaults,
      }),
      listings: listingsFixture,
      catalog: view.catalog,
      retryCatalog: () => undefined,
      isDurable: true,
      registration: { item1: 'registered', item2: 'unregistered' },
      registerListing: async () => undefined,
      publishStatus: view.publishStatus,
      publishErrors: view.publishErrors,
      publishedDropId: view.publishedDropId,
      publish: async () => undefined,
      retrySync: async () => undefined,
    }),
  };
});

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

describe('Marketplace Drop Studio — visual regression', () => {
  it('renders the drops home with the composer blank at desktop viewport', async () => {
    view.filled = false;
    view.catalog = 'loaded';
    view.projection = 'loaded';
    view.publishStatus = { record: 'idle', sync: 'idle' };
    view.publishedDropId = null;

    installStableDatetimePlaceholderStyle();
    const screen = await renderForVRT(<DropStudioHome />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    expect(screen.container.querySelectorAll('input[type="datetime-local"][value=""]')).toHaveLength(2);
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-studio-blank-desktop');
  });

  it('renders the drops home at mobile viewport', async () => {
    view.filled = false;
    view.catalog = 'loaded';
    view.projection = 'loaded';
    view.publishStatus = { record: 'idle', sync: 'idle' };
    view.publishedDropId = null;

    installStableDatetimePlaceholderStyle();
    const screen = await renderForVRT(<DropStudioHome />, { viewport: VRT_VIEWPORT_MOBILE, disableHover: true });
    expect(screen.container.querySelectorAll('input[type="datetime-local"][value=""]')).toHaveLength(2);
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-studio-blank-mobile');
  });

  it('renders the filled composer with mixed listing registration states at desktop viewport', async () => {
    view.filled = true;
    view.catalog = 'loaded';
    view.projection = 'loaded';
    view.publishStatus = { record: 'idle', sync: 'idle' };
    view.publishedDropId = null;

    installStableDatetimePlaceholderStyle();
    const screen = await renderForVRT(<DropStudioHome />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-studio-filled-desktop');
  });

  it('renders the record-ok / sync-failed two-truth panel with its retry affordance', async () => {
    view.filled = true;
    view.catalog = 'loaded';
    view.projection = 'loaded';
    view.publishStatus = { record: 'ok', sync: 'failed' };
    view.publishedDropId = 'drop123';

    installStableDatetimePlaceholderStyle();
    // Keep pointer events on: this scene must open the native <details> so the
    // two-truth rows and retry control are in frame. disableHover would set
    // pointer-events:none on the VRT root and make the trigger click time out.
    const screen = await renderForVRT(<DropStudioHome />, { viewport: VRT_VIEWPORT_DESKTOP });
    // Overflow is clipped to the VRT viewport; the native <summary> lives below
    // the fold. Native <summary> is not exposed as role=button in Playwright's
    // a11y tree (chromium/webkit/firefox), so query by its accessible name.
    screen.container.querySelector('[role="status"]')?.scrollIntoView({ block: 'center' });
    const detailsTrigger = screen.getByText('Technical details');
    await expect.element(detailsTrigger).toBeVisible();
    await detailsTrigger.click();
    await expect.element(screen.getByText('Retry registration')).toBeVisible();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-studio-two-truth-sync-failed-desktop');
  });

  it('renders a failed publish with the required-fields summary at desktop viewport', async () => {
    view.filled = false;
    view.catalog = 'loaded';
    view.projection = 'loaded';
    view.publishStatus = { record: 'idle', sync: 'idle' };
    view.publishErrors = ['title:Enter a title.', 'listingIds:Select at least one listing.'];
    view.publishedDropId = null;

    installStableDatetimePlaceholderStyle();
    const screen = await renderForVRT(<DropStudioHome />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect.element(screen.getByText('Required to publish')).toBeVisible();
    await expect.element(screen.getByRole('link', { name: 'Drop title' })).toBeVisible();
    await expect.element(screen.getByRole('link', { name: 'Listings' })).toBeVisible();
    screen.container.querySelector('[role="alert"]')?.scrollIntoView({ block: 'center' });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-studio-publish-invalid-desktop');
    view.publishErrors = [];
  });

  it('renders the hydrated picker at desktop viewport', async () => {
    view.filled = false;
    view.catalog = 'loaded';
    view.projection = 'loaded';

    installStableDatetimePlaceholderStyle();
    const screen = await renderForVRT(<DropStudioHome />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(screen.getByText('Numbered print — Genesis')).toBeVisible();
    Array.from(screen.container.querySelectorAll('span'))
      .find((element) => element.textContent === 'Numbered print — Genesis')
      ?.scrollIntoView({ block: 'start' });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-studio-hydrated-picker-desktop');
  });

  it('renders catalog unavailable without advising the seller to create a listing', async () => {
    view.filled = false;
    view.catalog = 'unavailable';
    view.projection = 'loaded';

    installStableDatetimePlaceholderStyle();
    const screen = await renderForVRT(<DropStudioHome />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(screen.getByText('Your catalog could not be loaded — retry.')).toBeVisible();
    Array.from(screen.container.querySelectorAll('p'))
      .find((element) => element.textContent === 'Your catalog could not be loaded — retry.')
      ?.scrollIntoView({ block: 'start' });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-studio-catalog-unavailable-desktop');
  });

  it('renders session-unavailable without calling a protected drop Draft', async () => {
    view.filled = false;
    view.catalog = 'loaded';
    view.projection = 'session-unavailable';
    view.publishStatus = { record: 'idle', sync: 'idle' };
    view.publishErrors = [];
    view.publishedDropId = null;

    installStableDatetimePlaceholderStyle();
    const screen = await renderForVRT(<DropStudioHome />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect.element(screen.getByText('Connect a marketplace session to read drop status.')).toBeVisible();
    await expect.element(screen.getByRole('link', { name: 'New drop' })).toBeVisible();
    expect(screen.container.textContent).not.toContain('Status unavailable');
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-studio-session-unavailable-desktop');
  });

  it('keeps New drop above the fold when a marketplace session is required at mobile viewport', async () => {
    view.filled = false;
    view.catalog = 'loaded';
    view.projection = 'session-unavailable';
    view.publishStatus = { record: 'idle', sync: 'idle' };
    view.publishErrors = [];
    view.publishedDropId = null;

    installStableDatetimePlaceholderStyle();
    const screen = await renderForVRT(<DropStudioHome />, { viewport: VRT_VIEWPORT_MOBILE, disableHover: true });
    await expect.element(screen.getByRole('link', { name: 'New drop' })).toBeVisible();
    await expect.element(screen.getByText('Connect a marketplace session to read drop status.')).toBeVisible();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-studio-session-unavailable-mobile');
  });

  it('renders a single transient-status row with Retry and New drop above the fold', async () => {
    view.filled = false;
    view.catalog = 'loaded';
    view.projection = 'unavailable';
    view.publishStatus = { record: 'idle', sync: 'idle' };
    view.publishErrors = [];
    view.publishedDropId = null;

    installStableDatetimePlaceholderStyle();
    const screen = await renderForVRT(<DropStudioHome />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect.element(screen.getByText("Could not read this drop's status.")).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect.element(screen.getByRole('link', { name: 'New drop' })).toBeVisible();
    expect(screen.container.textContent).not.toContain('Status unavailable');
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-studio-status-unavailable-desktop');
  });

  it('keeps New drop above the fold when drop status is unavailable at mobile viewport', async () => {
    view.filled = false;
    view.catalog = 'loaded';
    view.projection = 'unavailable';
    view.publishStatus = { record: 'idle', sync: 'idle' };
    view.publishErrors = [];
    view.publishedDropId = null;

    installStableDatetimePlaceholderStyle();
    const screen = await renderForVRT(<DropStudioHome />, { viewport: VRT_VIEWPORT_MOBILE, disableHover: true });
    await expect.element(screen.getByRole('link', { name: 'New drop' })).toBeVisible();
    await expect.element(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-studio-status-unavailable-mobile');
  });
});
