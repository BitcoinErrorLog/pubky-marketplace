// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hoverAndWaitForScale, renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { MarketplaceListingCard } from '@/organisms/Marketplace/MarketplaceListingCard';
import { DropCard } from '@/organisms/Marketplace/DropCard';
import { buildMarketplaceCatalogItems } from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import type { NexusDropStreamEntry } from '@/hooks/useMarketplaceDrops/drops-stream';
import { createCommerceSandboxCatalog } from '@/libs/commerce/sandbox-catalog';
import { toCommerceListingModel } from '@/test/fixtures/commerce/listing-models';
import { useMarketplaceDisplayStore } from '@/stores/marketplace-display/marketplace-display.store';

vi.mock('@/hooks/useMarketplaceLiveBid/useMarketplaceLiveBid', () => ({
  useMarketplaceLiveBid: () => ({ ref: () => {}, bid: null }),
}));

vi.mock('@/hooks/useCommerceFavorite/useCommerceFavorite', () => ({
  useCommerceFavorite: () => ({ isFavorite: false, isLoading: false, isMutating: false, toggle: vi.fn() }),
}));

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  const { createMarketplaceMediaHooks } = await import('@/test/mocks/marketplace-media-hooks');
  return createMarketplaceMediaHooks(() => null);
});

vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: () => null,
}));

const catalog = createCommerceSandboxCatalog();
const listings = buildMarketplaceCatalogItems(catalog.listings.map(toCommerceListingModel), []);
const drop: NexusDropStreamEntry = {
  id: 'fidelity-drop',
  owner_id: 'owner-pubky',
  title: 'After Hours — limited vinyl',
  description: 'A limited drop.',
  media_urls: [],
  format: 'fixed_price',
  starts_at: '2026-09-20T08:00:00.000Z',
  ends_at: '2026-09-21T08:00:00.000Z',
  total_quantity: 50,
  per_buyer_limit: 1,
};

function FidelityCards() {
  return (
    <div className="grid grid-cols-2 gap-6 p-7 sm:grid-cols-4">
      <MarketplaceListingCard listing={listings[0]} shopName="Shutter Priority" index={0} />
      <MarketplaceListingCard listing={listings[2]} shopName="Low Time Preference" index={1} />
      <DropCard entry={drop} bucket="live" index={2} />
      <MarketplaceListingCard listing={listings[1]} shopName="Ninetieth Percentile" index={3} />
    </div>
  );
}

describe('Marketplace fidelity cards — visual regression', () => {
  beforeEach(() => {
    useMarketplaceDisplayStore.setState({ displayCurrency: 'USD' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['desktop', { width: 1280, height: 900 }],
    ['mobile', { width: 390, height: 844 }],
  ] as const)('captures the second listing at rest and mid-hover on %s', async (name, viewport) => {
    const screen = await renderForVRT(<FidelityCards />, { viewport });
    // Browser instances retain the pointer position between tests. Park it in
    // the root's empty top-left padding so the "rest" capture cannot inherit a
    // hover transform from whichever card occupied the prior pointer position.
    await screen.getByTestId(VRT_ROOT_TESTID).hover({ position: { x: 1, y: 1 } });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(`fidelity-${name}-rest`);
    vi.spyOn(Math, 'random').mockReturnValue(0.75);
    const listing = screen.getByRole('link', { name: `View ${listings[2].title}` });
    await hoverAndWaitForScale(listing);
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(`fidelity-${name}-listing-hover`);
  });

  it.each([
    ['desktop', { width: 1280, height: 900 }],
    ['mobile', { width: 390, height: 844 }],
  ] as const)('captures the drop card mid-hover on %s', async (name, viewport) => {
    const screen = await renderForVRT(<FidelityCards />, { viewport });
    await screen.getByTestId(VRT_ROOT_TESTID).hover({ position: { x: 1, y: 1 } });
    vi.spyOn(Math, 'random').mockReturnValue(0.75);
    const dropCard = screen.getByRole('link', { name: 'View After Hours — limited vinyl' });
    await hoverAndWaitForScale(dropCard);
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot(`fidelity-${name}-drop-hover`);
  });
});
