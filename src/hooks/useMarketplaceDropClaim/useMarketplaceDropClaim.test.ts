import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { useMarketplaceDropClaim } from './useMarketplaceDropClaim';

const SELLER = 's'.repeat(52);
const BUYER = 'b'.repeat(52);

const config = vi.hoisted(() => ({ mode: 'transaction-service' as string }));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => config.mode };
});

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getMarketplaceListingProjection: vi.fn(),
    getMarketplaceOrders: vi.fn(async () => []),
    syncListingRegistration: vi.fn(),
    executeMarketplaceCommand: vi.fn(),
    getDeliveryAddresses: vi.fn(async () => []),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({
  toast: vi.fn(),
}));

vi.mock('@/libs/logger/logger', () => ({
  Logger: { error: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string | null }) => unknown) =>
    selector({ currentUserPubky: 'b'.repeat(52) }),
}));

const savedAddress = {
  id: `${BUYER}:addr1`,
  owner_id: BUYER,
  label: 'Home',
  name: 'Alice Buyer',
  line1: '1 Market Street',
  line2: '',
  city: 'New York',
  region: 'NY',
  postal_code: '10001',
  country_code: 'us',
  is_default: true,
  last_used_at: null,
  created_at: 100,
  updated_at: 100,
};

describe('useMarketplaceDropClaim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    config.mode = 'transaction-service';
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000002200');
    vi.mocked(CommerceController.getDeliveryAddresses).mockResolvedValue([savedAddress] as never);
    vi.mocked(CommerceController.getMarketplaceListingProjection).mockResolvedValue({
      aggregateId: `listing:${SELLER}_listing1`,
      sellerPubky: SELLER,
      listingId: 'listing1',
      serverRevision: 4,
      state: 'available',
      availableQuantity: 3,
      reservedQuantity: 0,
      unitPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
      saleFormat: 'fixed_price',
      auction: null,
    } as never);
    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValue({
      ok: true,
      version: 1,
      commandId: '00000000-0000-4000-8000-000000002200',
      aggregateId: 'checkout:00000000-0000-4000-8000-000000002200',
      revision: 1,
      eventIds: [],
      result: { kind: 'checkout' },
    } as never);
  });

  it('claims exactly one unit of one listing through the existing checkout path', async () => {
    const onClaimed = vi.fn();
    const { result } = renderHook(() => useMarketplaceDropClaim(onClaimed));
    await waitFor(() => expect(result.current.claimAddress).not.toBeNull());

    let ok = false;
    await act(async () => {
      ok = await result.current.claim(SELLER, 'listing1', 1);
    });

    expect(ok).toBe(true);
    expect(CommerceController.executeMarketplaceCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'checkout.create',
        payload: expect.objectContaining({
          lines: [{ listingAggregateId: `listing:${SELLER}_listing1`, expectedRevision: 4, quantity: 1 }],
          deliveryAddress: expect.objectContaining({ name: 'Alice Buyer', countryCode: 'US' }),
          guaranteePolicyVersion: 1,
        }),
      }),
    );
    expect(onClaimed).toHaveBeenCalledTimes(1);
    expect(result.current.claimedListingIds.has(`${SELLER}:listing1`)).toBe(true);
    expect(result.current.failure).toBeNull();
  });

  it('keeps the payment deadline from the claimed order for the confirmation surface', async () => {
    vi.mocked(CommerceController.getMarketplaceOrders).mockResolvedValue([
      {
        state: 'pending_payment',
        holdExpiresAt: '2026-09-15T13:00:00.000Z',
        lines: [{ listingAggregateId: `listing:${SELLER}_listing1` }],
      } as never,
    ]);
    const { result } = renderHook(() => useMarketplaceDropClaim());
    await waitFor(() => expect(result.current.claimAddress).not.toBeNull());

    await act(async () => {
      await result.current.claim(SELLER, 'listing1', 1);
    });

    expect(result.current.claimDeadlines?.get(`${SELLER}:listing1`)).toBe('2026-09-15T13:00:00.000Z');
  });

  it('maps service refusal messages to static client copy', async () => {
    for (const [code, message, expected] of [
      ['INVALID_STATE', 'The drop has not started.', "This drop hasn't started yet."],
      ['INVALID_STATE', 'The drop has ended.', 'This drop has ended.'],
      ['INSUFFICIENT_INVENTORY', 'The drop is sold out.', 'This drop is sold out.'],
      [
        'INVALID_STATE',
        "You have reached this drop's per-buyer limit.",
        "You have reached this drop's per-buyer limit.",
      ],
    ]) {
      vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValueOnce({
        ok: false,
        error: { code, message },
      } as never);
      const { result } = renderHook(() => useMarketplaceDropClaim());
      await waitFor(() => expect(result.current.claimAddress).not.toBeNull());

      await act(async () => {
        await result.current.claim(SELLER, 'listing1', 1);
      });
      expect(result.current.failure).toBe(expected);
    }
  });

  it('uses refusal fallback for an unknown service refusal', async () => {
    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValueOnce({
      ok: false,
      error: { code: 'UNKNOWN_CODE', message: 'SENTINEL_SERVER_TEXT_drop' },
    } as never);
    const { result } = renderHook(() => useMarketplaceDropClaim());
    await waitFor(() => expect(result.current.claimAddress).not.toBeNull());

    await act(async () => {
      await result.current.claim(SELLER, 'listing1', 1);
    });
    expect(result.current.failure).toBe('The claim could not be completed.');
    expect(result.current.failure).not.toContain('SENTINEL_SERVER_TEXT_drop');
  });

  it('refreshes the public drop and ready check after a refusal', async () => {
    const refresh = vi.fn(async () => {});
    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValueOnce({
      ok: false,
      error: { code: 'INVALID_STATE', message: 'The drop has ended.' },
    } as never);
    const { result } = renderHook(() => useMarketplaceDropClaim(refresh));
    await waitFor(() => expect(result.current.claimAddress).not.toBeNull());

    await act(async () => {
      await result.current.claim(SELLER, 'listing1', 1);
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('maps thrown sentinel failures to static copy', async () => {
    const sentinel = 'SENTINEL_SERVER_TEXT_drop_claim';
    vi.mocked(CommerceController.executeMarketplaceCommand).mockRejectedValueOnce(
      new AppError({
        category: ErrorCategory.Client,
        code: ClientErrorCode.CONFLICT,
        message: sentinel,
        service: ErrorService.Marketplace,
        operation: 'claim',
      }),
    );
    const { result } = renderHook(() => useMarketplaceDropClaim());
    await waitFor(() => expect(result.current.claimAddress).not.toBeNull());

    await act(async () => {
      await result.current.claim(SELLER, 'listing1', 1);
    });
    expect(result.current.failure).toBeTypeOf('string');
    expect(result.current.failure).not.toContain(sentinel);
  });

  it('refreshes the public drop and ready check after a thrown claim error', async () => {
    const refresh = vi.fn(async () => {});
    vi.mocked(CommerceController.executeMarketplaceCommand).mockRejectedValueOnce(new Error('service failure'));
    const { result } = renderHook(() => useMarketplaceDropClaim(refresh));
    await waitFor(() => expect(result.current.claimAddress).not.toBeNull());

    await act(async () => {
      await result.current.claim(SELLER, 'listing1', 1);
    });

    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps a successful claim when the success refresh callback throws', async () => {
    const refresh = vi.fn(async () => {
      throw new Error('refresh failure');
    });
    const { result } = renderHook(() => useMarketplaceDropClaim(refresh));
    await waitFor(() => expect(result.current.claimAddress).not.toBeNull());

    let ok = false;
    await act(async () => {
      ok = await result.current.claim(SELLER, 'listing1', 1);
    });

    expect(ok).toBe(true);
    expect(result.current.failure).toBeNull();
    expect(result.current.claimedListingIds.has(`${SELLER}:listing1`)).toBe(true);
  });

  it('heals an unregistered listing with one sync before giving up', async () => {
    vi.mocked(CommerceController.getMarketplaceListingProjection)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        aggregateId: `listing:${SELLER}_listing1`,
        serverRevision: 1,
      } as never);
    vi.mocked(CommerceController.syncListingRegistration).mockResolvedValue({ ok: true } as never);

    const { result } = renderHook(() => useMarketplaceDropClaim());
    await waitFor(() => expect(result.current.claimAddress).not.toBeNull());

    let ok = false;
    await act(async () => {
      ok = await result.current.claim(SELLER, 'listing1', 1);
    });
    expect(ok).toBe(true);
    expect(CommerceController.syncListingRegistration).toHaveBeenCalledTimes(1);
  });

  it('says the listing was removed when the sync reports the seller deleted it', async () => {
    const aggregateId = `listing:${SELLER}_listing1`;
    vi.mocked(CommerceController.getMarketplaceListingProjection).mockResolvedValue(null);
    vi.mocked(CommerceController.syncListingRegistration).mockResolvedValue({
      ok: true,
      version: 1,
      commandId: '018f47d2-6a27-7c23-a62f-000000000752',
      aggregateId,
      revision: 2,
      eventIds: [],
      result: { kind: 'listing_deleted', listing: { aggregateId, serverRevision: 2 } },
    } as never);

    const { result } = renderHook(() => useMarketplaceDropClaim());
    await waitFor(() => expect(result.current.claimAddress).not.toBeNull());

    let ok = true;
    await act(async () => {
      ok = await result.current.claim(SELLER, 'listing1', 1);
    });

    expect(ok).toBe(false);
    expect(result.current.failure).toBe('This listing was removed.');
    expect(CommerceController.getMarketplaceListingProjection).toHaveBeenCalledTimes(1);
    expect(CommerceController.executeMarketplaceCommand).not.toHaveBeenCalled();
  });

  it('refuses to claim without a saved delivery address, with honest guidance', async () => {
    vi.mocked(CommerceController.getDeliveryAddresses).mockResolvedValue([] as never);
    const { result } = renderHook(() => useMarketplaceDropClaim());
    await waitFor(() => expect(result.current.addresses).toHaveLength(0));

    let ok = true;
    await act(async () => {
      ok = await result.current.claim(SELLER, 'listing1', 1);
    });
    expect(ok).toBe(false);
    expect(result.current.failure).toContain('delivery address');
    expect(CommerceController.executeMarketplaceCommand).not.toHaveBeenCalled();
  });

  it('fails closed at zero allowance before reading a projection or issuing a command', async () => {
    const { result } = renderHook(() => useMarketplaceDropClaim());
    await waitFor(() => expect(result.current.claimAddress).not.toBeNull());

    let ok = true;
    await act(async () => {
      ok = await result.current.claim(SELLER, 'listing1', 0);
    });

    expect(ok).toBe(false);
    expect(CommerceController.getMarketplaceListingProjection).not.toHaveBeenCalled();
    expect(CommerceController.executeMarketplaceCommand).not.toHaveBeenCalled();
  });

  it('refuses the seller from claiming their own drop before reading a projection', async () => {
    const { result } = renderHook(() => useMarketplaceDropClaim());
    await waitFor(() => expect(result.current.claimAddress).not.toBeNull());

    await act(async () => {
      await expect(result.current.claim(BUYER, 'listing1', 1)).resolves.toBe(false);
    });
    expect(result.current.failure).toBe('You cannot claim from your own drop');
    expect(CommerceController.getMarketplaceListingProjection).not.toHaveBeenCalled();
    expect(CommerceController.executeMarketplaceCommand).not.toHaveBeenCalled();
  });
});
