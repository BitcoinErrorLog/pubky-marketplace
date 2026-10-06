import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { db } from '@/database/franky/franky';
import { CommerceCartItemModel, CommerceListingModel } from '@/models/commerce/commerce.models';
import { LocalCommerceService } from '@/services/local/commerce/commerce';
import { createCommerceListingFixture } from '@/test/fixtures/commerce/commerce';
import { useMarketplaceCartCount } from './useMarketplaceCartCount';

const OWNER = 'y'.repeat(52);
const SELLER = 'b'.repeat(52);

const state = vi.hoisted(() => ({
  currentUserPubky: 'y'.repeat(52) as string | null,
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: Object.assign(
    (selector: (store: { currentUserPubky: string | null }) => unknown) =>
      selector({ currentUserPubky: state.currentUserPubky }),
    {
      getState: () => ({
        selectCurrentUserPubky: () => state.currentUserPubky,
      }),
    },
  ),
}));

function cartRow(listingId: string, quantity: number) {
  return {
    id: `${OWNER}|${SELLER}:${listingId}|v1`,
    owner_id: OWNER,
    listing_id: `${SELLER}:${listingId}`,
    variant_id: 'v1',
    quantity,
    added_at: 100,
    updated_at: 100,
  };
}

describe('useMarketplaceCartCount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.currentUserPubky = OWNER;
    return db.initialize().then(async () => {
      await CommerceCartItemModel.table.clear();
      await CommerceListingModel.table.clear();
    });
  });

  it('sums quantities across cart lines — the same number the cart page shows', async () => {
    await CommerceCartItemModel.table.bulkPut([cartRow('boots_01', 2), cartRow('cam_02', 3)]);
    await LocalCommerceService.upsertListing(
      createCommerceListingFixture({ ownerPubky: SELLER, listingId: 'boots_01' }),
      'synced',
    );
    await LocalCommerceService.upsertListing(
      createCommerceListingFixture({ ownerPubky: SELLER, listingId: 'cam_02' }),
      'synced',
    );
    expect(await CommerceController.getCartItems()).toHaveLength(2);
    expect((await CommerceController.getManyListings([`${SELLER}:boots_01`, `${SELLER}:cam_02`])).size).toBe(2);

    const { result } = renderHook(() => useMarketplaceCartCount());

    await waitFor(() => expect(result.current).toBe(5));
  });

  it('excludes lines whose listing no longer resolves, matching the cart page', async () => {
    await CommerceCartItemModel.table.bulkPut([cartRow('boots_01', 2), cartRow('gone_03', 4)]);
    await LocalCommerceService.upsertListing(
      createCommerceListingFixture({ ownerPubky: SELLER, listingId: 'boots_01' }),
      'synced',
    );

    const { result } = renderHook(() => useMarketplaceCartCount());

    await waitFor(() => expect(result.current).toBe(2));
  });

  it('returns zero for an empty cart — zero renders no badge', async () => {
    const { result } = renderHook(() => useMarketplaceCartCount());

    expect(result.current).toBe(0);
  });

  it('returns zero without reading the cart when signed out', async () => {
    state.currentUserPubky = null;

    const { result } = renderHook(() => useMarketplaceCartCount());

    await waitFor(() => expect(result.current).toBe(0));
  });
});
