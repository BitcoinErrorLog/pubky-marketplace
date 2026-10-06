// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { describe, expect, it, vi } from 'vitest';
import { expectVrtSurface, renderForVRT } from '@/test-utils/vrt';
import { HOUR_MS, VRT_FROZEN_NOW_MS } from '@/test-utils/vrt.clock';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from '@/test-utils/vrt.viewports';
import { MarketplaceDrops } from '@/templates/Marketplace/MarketplaceDrops';

/**
 * The drops calendar page: populated estimate buckets (live / upcoming /
 * ended, every one labeled "estimated from index times"), the honest
 * not-indexed empty state a 404-answering Nexus produces, and the
 * durable-only unavailable state. Cards never carry claim affordances —
 * that absence is part of these baselines.
 */

const VRT_SELLER = vi.hoisted(() => 's'.repeat(52));

const view = vi.hoisted(() => ({
  drops: {} as Record<string, unknown>,
}));

vi.mock('@/hooks/useMarketplaceDrops/useMarketplaceDrops', () => ({
  useMarketplaceDrops: () => view.drops,
}));

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  const { createMarketplaceMediaHooks } = await import('@/test/mocks/marketplace-media-hooks');
  return createMarketplaceMediaHooks(() => null);
});

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

function makeEntry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    owner_id: VRT_SELLER,
    title: `Field Recordings ${id}`,
    description: '',
    media_urls: [],
    format: 'fcfs',
    starts_at: new Date(VRT_FROZEN_NOW_MS + 2 * HOUR_MS).toISOString(),
    ends_at: null,
    total_quantity: 100,
    ...overrides,
  };
}

function setDropsView(overrides: Record<string, unknown>) {
  view.drops = {
    buckets: { upcoming: [], live: [], ended: [] },
    isIndexed: true,
    isLoading: false,
    error: null,
    adapterMode: 'transaction-service',
    refresh: vi.fn(async () => {}),
    ...overrides,
  };
}

const POPULATED = {
  live: [makeEntry('vol-3', { starts_at: new Date(VRT_FROZEN_NOW_MS - HOUR_MS).toISOString() })],
  upcoming: [
    makeEntry('vol-4'),
    makeEntry('vol-5', { starts_at: new Date(VRT_FROZEN_NOW_MS + 50 * HOUR_MS).toISOString() }),
  ],
  ended: [
    makeEntry('vol-2', {
      starts_at: new Date(VRT_FROZEN_NOW_MS - 50 * HOUR_MS).toISOString(),
      ends_at: new Date(VRT_FROZEN_NOW_MS - 26 * HOUR_MS).toISOString(),
    }),
  ],
};

describe('Marketplace drops calendar — visual regression', () => {
  it('renders the populated estimate buckets at desktop viewport', async () => {
    setDropsView({ buckets: POPULATED });
    await renderForVRT(<MarketplaceDrops />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(expectVrtSurface('marketplace-drops')).toMatchScreenshot('drops-calendar-desktop');
  });

  it('renders the populated estimate buckets at mobile viewport', async () => {
    setDropsView({ buckets: POPULATED });
    await renderForVRT(<MarketplaceDrops />, { viewport: VRT_VIEWPORT_MOBILE, disableHover: true });
    await expect(expectVrtSurface('marketplace-drops')).toMatchScreenshot('drops-calendar-mobile');
  });

  it('renders the honest not-indexed empty state at desktop viewport', async () => {
    setDropsView({ isIndexed: false });
    const screen = await renderForVRT(<MarketplaceDrops />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect.element(screen.getByText(/isn't indexed on this deployment yet/)).toBeInTheDocument();
    await expect(expectVrtSurface('marketplace-drops')).toMatchScreenshot('drops-calendar-not-indexed-desktop');
  });

  it('renders the durable-only unavailable state in sandbox mode at desktop viewport', async () => {
    setDropsView({ adapterMode: 'sandbox' });
    await renderForVRT(<MarketplaceDrops />, { viewport: VRT_VIEWPORT_DESKTOP, disableHover: true });
    await expect(expectVrtSurface('marketplace-drops')).toMatchScreenshot('drops-calendar-unavailable-desktop');
  });
});
