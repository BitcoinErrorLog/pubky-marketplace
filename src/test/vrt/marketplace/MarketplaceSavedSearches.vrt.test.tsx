// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { VRT_VIEWPORT_DESKTOP } from '@/test-utils/vrt.viewports';
import { MarketplaceSavedSearches } from '@/organisms/Marketplace/MarketplaceSavedSearches';

// Saved searches live in a compact popover off the filter row; this suite
// pins the trigger (with and without the aggregate NEW badge), the open
// popover's empty state, the naming flow, and a populated list.
const view = vi.hoisted(() => ({
  searches: [] as unknown[],
  isSignedIn: true,
}));

vi.mock('@/hooks/useMarketplaceSavedSearches/useMarketplaceSavedSearches', () => ({
  useMarketplaceSavedSearches: () => ({
    searches: view.searches,
    isSignedIn: view.isSignedIn,
    saveCurrentSearch: vi.fn(async () => true),
    applySearch: vi.fn(async () => {}),
    deleteSearch: vi.fn(async () => {}),
  }),
}));

const SAVED_FIXTURES = [
  { id: 'search-1', name: 'Y2K denim', new_count: 3 },
  { id: 'search-2', name: 'Film cameras under ₿200,000', new_count: 0 },
];

function harness() {
  return (
    <div className="mx-auto flex h-96 max-w-5xl justify-end p-6">
      <MarketplaceSavedSearches />
    </div>
  );
}

describe('Marketplace saved searches — visual regression', () => {
  it('renders the trigger with an aggregate NEW badge at desktop viewport', async () => {
    view.searches = SAVED_FIXTURES;

    const screen = await renderForVRT(harness(), { viewport: VRT_VIEWPORT_DESKTOP });
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('saved-searches-trigger-desktop');
  });

  it('renders the open popover with saved searches at desktop viewport', async () => {
    view.searches = SAVED_FIXTURES;

    const screen = await renderForVRT(harness(), { viewport: VRT_VIEWPORT_DESKTOP });
    await screen.getByRole('button', { name: /Saved searches/ }).click();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('saved-searches-open-desktop');
  });

  it('renders the open popover empty state at desktop viewport', async () => {
    view.searches = [];

    const screen = await renderForVRT(harness(), { viewport: VRT_VIEWPORT_DESKTOP });
    await screen.getByRole('button', { name: /Saved searches/ }).click();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('saved-searches-empty-desktop');
  });

  it('renders the naming form after choosing to save at desktop viewport', async () => {
    view.searches = [];

    const screen = await renderForVRT(harness(), { viewport: VRT_VIEWPORT_DESKTOP });
    await screen.getByRole('button', { name: /Saved searches/ }).click();
    await screen.getByRole('button', { name: 'Save current' }).click();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('saved-searches-naming-desktop');
  });
});
