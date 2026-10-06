// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore } from '@/test/mocks/marketplace-vrt';
import { describe, expect, it, vi } from 'vitest';
import { expectVrtSurface, renderForVRT, VRT_DENSE_CHROME_SCREENSHOT } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceInventoryAutomations } from '@/templates/Marketplace/MarketplaceInventoryAutomations';
import { MarketplaceInventoryOnceSecretDialog } from '@/organisms/Marketplace/MarketplaceInventoryOnceSecretDialog';
import type { InventoryAutomationsLoad } from '@/application/commerce/inventory-automations';

const { SELLER } = vi.hoisted(() => ({
  SELLER: 'y'.repeat(52),
}));

const view = vi.hoisted(() => ({
  isLoading: false,
  load: { status: 'empty', sessions: [], webhooks: [] } as InventoryAutomationsLoad,
  pendingId: null as string | null,
  secret: null as { status: 'secret'; id: string; url: string; secret: string; message: string } | null,
  message: null as string | null,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace/dashboard/inventory/automations',
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: createMarketplaceVrtAuthStore({ currentUserPubky: SELLER }),
}));

vi.mock('@/hooks/useMarketplaceInventoryAutomations/useMarketplaceInventoryAutomations', () => ({
  useMarketplaceInventoryAutomations: () => ({
    sellerPubky: SELLER,
    load: view.load,
    isLoading: view.isLoading,
    pendingId: view.pendingId,
    secret: view.secret,
    message: view.message,
    refresh: async () => undefined,
    revoke: async () => undefined,
    addWebhook: async () => undefined,
    rotateWebhook: async () => undefined,
    deleteWebhook: async () => undefined,
    dismissSecret: () => {
      view.secret = null;
    },
  }),
}));

vi.mock('@/hooks/useMarketplaceInventoryGrantConnect/useMarketplaceInventoryGrantConnect', () => ({
  useMarketplaceInventoryGrantConnect: () => ({
    status: 'idle',
    authorizationUrl: '',
    errorMessage: null,
    isOpeningSigner: false,
    start: () => {},
    cancel: () => {},
    copyAuthUrl: async () => {},
    openInSigner: () => {},
  }),
}));

vi.mock('@/hooks/useMarketplaceCartCount/useMarketplaceCartCount', () => ({
  useMarketplaceCartCount: () => 0,
}));

vi.mock('@/hooks/useMarketplaceActivityUnread/useMarketplaceActivityUnread', () => ({
  useMarketplaceActivityUnread: () => 0,
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

describe('MarketplaceInventoryAutomations VRT', () => {
  it('renders the automations list with sessions and webhooks at desktop viewport', async () => {
    view.isLoading = false;
    view.secret = null;
    view.load = {
      status: 'ready',
      sessions: [
        {
          id: '22222222-2222-4222-8222-222222222222',
          kind: 'purchase',
          kindLabel: 'Purchase',
          label: 'Shop',
          grant: '—',
          createdAt: '2026-09-21T00:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
          lastUsedAt: '2026-09-21T01:00:00.000Z',
        },
        {
          id: '33333333-3333-4333-8333-333333333333',
          kind: 'inventory',
          kindLabel: 'Inventory',
          label: 'Studio',
          grant: '—',
          createdAt: '2026-09-21T00:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
          lastUsedAt: null,
        },
        {
          id: '44444444-4444-4444-8444-444444444444',
          kind: 'cli',
          kindLabel: 'CLI',
          label: 'CLI',
          grant: '—',
          createdAt: '2026-09-21T00:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
          lastUsedAt: null,
        },
      ],
      webhooks: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          url: 'https://example.com/hooks/shop',
          createdAt: Date.parse('2026-09-21T00:00:00.000Z'),
        },
      ],
    };
    await renderForVRT(<MarketplaceInventoryAutomations />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await expect(expectVrtSurface('inventory-studio')).toMatchScreenshot(
      'inventory-automations-list-desktop',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  it('renders the automations list at mobile viewport', async () => {
    view.isLoading = false;
    view.secret = null;
    view.load = {
      status: 'ready',
      sessions: [
        {
          id: '33333333-3333-4333-8333-333333333333',
          kind: 'inventory',
          kindLabel: 'Inventory',
          label: 'Studio',
          grant: '—',
          createdAt: '2026-09-21T00:00:00.000Z',
          expiresAt: '2099-01-01T00:00:00.000Z',
          lastUsedAt: null,
        },
      ],
      webhooks: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          url: 'https://example.com/hooks/shop',
          createdAt: Date.parse('2026-09-21T00:00:00.000Z'),
        },
      ],
    };
    await renderForVRT(<MarketplaceInventoryAutomations />, {
      viewport: VRT_VIEWPORT_MOBILE,
      disableHover: true,
    });
    await expect(expectVrtSurface('inventory-studio')).toMatchScreenshot(
      'inventory-automations-list-mobile',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  it('renders the once-secret dialog with the secret masked', async () => {
    const screen = await renderForVRT(
      <main className="w-full py-6">
        <MarketplaceInventoryOnceSecretDialog
          open
          secret="this-secret-must-not-appear-in-pixels"
          onClose={() => undefined}
        />
      </main>,
      { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true },
    );
    expect(screen.getByTestId('inventory-once-secret')).toBeTruthy();
    await expect(expectVrtSurface('inventory-studio')).toMatchScreenshot(
      'inventory-once-secret-masked-desktop',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  it('renders the empty automations board at desktop viewport', async () => {
    view.isLoading = false;
    view.secret = null;
    view.load = { status: 'empty', sessions: [], webhooks: [] };
    await renderForVRT(<MarketplaceInventoryAutomations />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await expect(expectVrtSurface('inventory-studio')).toMatchScreenshot(
      'inventory-automations-empty-desktop',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  it('renders the grant-needed banner at desktop viewport', async () => {
    view.isLoading = false;
    view.secret = null;
    view.load = { status: 'grant-needed' };
    await renderForVRT(<MarketplaceInventoryAutomations />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await expect(expectVrtSurface('inventory-studio')).toMatchScreenshot(
      'inventory-automations-grant-needed-desktop',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  it('renders the automations error at desktop viewport', async () => {
    view.isLoading = false;
    view.secret = null;
    view.load = { status: 'error', message: 'The service request failed.' };
    await renderForVRT(<MarketplaceInventoryAutomations />, {
      viewport: VRT_VIEWPORT_DESKTOP,
      disableHover: true,
    });
    await expect(expectVrtSurface('inventory-studio')).toMatchScreenshot(
      'inventory-automations-error-desktop',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });

  it('renders the once-secret dialog masked at mobile viewport', async () => {
    const screen = await renderForVRT(
      <main className="w-full py-6">
        <MarketplaceInventoryOnceSecretDialog
          open
          secret="this-secret-must-not-appear-in-pixels"
          onClose={() => undefined}
        />
      </main>,
      { viewport: VRT_VIEWPORT_MOBILE, disableHover: true },
    );
    expect(screen.getByTestId('inventory-once-secret')).toBeTruthy();
    await expect(expectVrtSurface('inventory-studio')).toMatchScreenshot(
      'inventory-once-secret-masked-mobile',
      VRT_DENSE_CHROME_SCREENSHOT,
    );
  });
});
