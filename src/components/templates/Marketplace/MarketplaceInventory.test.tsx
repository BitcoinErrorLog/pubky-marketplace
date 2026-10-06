import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { InventoryBoardLoad, InventoryBoardRow } from '@/application/commerce/inventory';
import { MarketplaceInventory } from './MarketplaceInventory';

const seller = 'y'.repeat(52);

function row(overrides: Partial<InventoryBoardRow> = {}): InventoryBoardRow {
  return {
    listingId: 'guide',
    sellerPubky: seller,
    aggregateId: `listing:${seller}_guide`,
    title: 'Printable field guide',
    thumbUrl: null,
    state: 'active',
    format: 'fixed_price',
    dropId: null,
    available: 999_999,
    reserved: 1,
    sold: 0,
    total: 1_000_000,
    serverRevision: 3,
    unlimited: true,
    sync: 'synced',
    ...overrides,
  };
}

const view = vi.hoisted(() => ({
  load: { status: 'ready', rows: [] } as InventoryBoardLoad,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/marketplace/inventory',
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));

vi.mock('@/hooks/useMarketplaceInventory/useMarketplaceInventory', () => ({
  useMarketplaceInventory: () => ({
    sellerPubky: seller,
    isLoading: false,
    load: view.load,
    conflictListingId: null,
    pendingListingId: null,
    refresh: vi.fn(),
    setAvailable: vi.fn(),
    retrySync: vi.fn(),
  }),
}));

vi.mock('@/hooks/useMarketplaceInventoryImport/useMarketplaceInventoryImport', () => ({
  useMarketplaceInventoryImport: () => ({ reset: vi.fn() }),
}));

describe('MarketplaceInventory', () => {
  it('reads Unlimited for an unlimited listing while a hold has lowered available', () => {
    view.load = { status: 'ready', rows: [row()] };
    render(<MarketplaceInventory />);
    const stock = screen.getByTestId('inventory-stock-guide');
    expect(stock).toHaveTextContent('Unlimited');
    expect(stock).toHaveTextContent('1 reserved');
    expect(stock).not.toHaveTextContent('999999');
    expect(stock).not.toHaveTextContent('1000000');
  });

  it('reads a number of copies for a finite listing', () => {
    view.load = {
      status: 'ready',
      rows: [
        row({ listingId: 'boots', title: 'Boots', available: 4, reserved: 1, sold: 2, total: 7, unlimited: undefined }),
      ],
    };
    render(<MarketplaceInventory />);
    const stock = screen.getByTestId('inventory-stock-boots');
    expect(stock).toHaveTextContent('4');
    expect(stock).toHaveTextContent('7 total');
    expect(stock).not.toHaveTextContent('Unlimited');
  });
});
