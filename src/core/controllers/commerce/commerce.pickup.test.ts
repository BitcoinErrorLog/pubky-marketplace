import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceApplication } from '@/application/commerce/commerce';
import type { CommerceAdapterMode } from '@/config/commerce';
import { buildMarketplaceListingAggregateId } from '@/libs/commerce/transaction-commands';
import { useAuthStore } from '@/stores/auth/auth.store';
import { COMMERCE_FIXTURE_SELLER } from '@/test/fixtures/commerce/commerce';
import { CommerceController } from './commerce';

const commerceConfig = vi.hoisted(() => ({ mode: 'transaction-service' as string }));
vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => commerceConfig.mode as CommerceAdapterMode };
});

const SELLER = COMMERCE_FIXTURE_SELLER;
const LISTING_ID = 'boots_01';
const LISTING_AGGREGATE_ID = buildMarketplaceListingAggregateId(SELLER, LISTING_ID);
const ORDER_ID = '018f47d2-6a27-7c23-a62f-000000000741';

const spotDetails = {
  kind: 'spot' as const,
  spot: 'Central Station, north entrance',
  instructions: 'Ask for the blue backpack.',
  availability: {
    windows: [{ day: 'sat' as const, start: '10:00', end: '14:00' }],
    zone: 'Europe/Berlin',
  },
};

describe('CommerceController local pickup (Wave 7)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useAuthStore.setState({ currentUserPubky: SELLER });
  });

  it('delegates the capability read to the application', async () => {
    const available = vi.spyOn(CommerceApplication, 'fetchPickupAvailable').mockResolvedValue(false);

    await expect(CommerceController.fetchPickupAvailable()).resolves.toBe(false);
    expect(available).toHaveBeenCalledTimes(1);
  });

  it('fetches the buyer reveal for the current user, holding it in memory only', async () => {
    const reveal = vi.spyOn(CommerceApplication, 'fetchPickupReveal').mockResolvedValue({} as never);

    await CommerceController.fetchPickupReveal(ORDER_ID);

    expect(reveal).toHaveBeenCalledWith(SELLER, ORDER_ID);
    await expect(CommerceController.fetchPickupReveal('../private')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it('fetches the seller owner read keyed by the current user and listing', async () => {
    const ownerRead = vi.spyOn(CommerceApplication, 'fetchSellerPickupDetails').mockResolvedValue({} as never);

    await CommerceController.fetchSellerPickupDetails(LISTING_ID);

    expect(ownerRead).toHaveBeenCalledWith(SELLER, LISTING_AGGREGATE_ID);
  });

  it('commits pickup_details.set with validated ids, CAS version, and details', async () => {
    const setDetails = vi.spyOn(CommerceApplication, 'commitSetPickupDetails').mockResolvedValue({ ok: true } as never);

    await CommerceController.commitSetPickupDetails(LISTING_ID, { expectedVersion: 2, details: spotDetails });

    expect(setDetails).toHaveBeenCalledWith(SELLER, {
      sellerPubky: SELLER,
      listingId: LISTING_ID,
      expectedVersion: 2,
      details: spotDetails,
    });
  });

  it('rejects invalid set inputs at the boundary before calling the application', async () => {
    const setDetails = vi.spyOn(CommerceApplication, 'commitSetPickupDetails');

    await expect(
      CommerceController.commitSetPickupDetails(LISTING_ID, { expectedVersion: -1, details: spotDetails }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      CommerceController.commitSetPickupDetails(LISTING_ID, {
        expectedVersion: 0,
        details: { ...spotDetails, spot: undefined },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      CommerceController.commitSetPickupDetails('../nope', { expectedVersion: 0, details: spotDetails }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(setDetails).not.toHaveBeenCalled();
  });

  it('commits pickup_details.clear with the CAS version', async () => {
    const clearDetails = vi
      .spyOn(CommerceApplication, 'commitClearPickupDetails')
      .mockResolvedValue({ ok: true } as never);

    await CommerceController.commitClearPickupDetails(LISTING_ID, 4);

    expect(clearDetails).toHaveBeenCalledWith(SELLER, {
      sellerPubky: SELLER,
      listingId: LISTING_ID,
      expectedVersion: 4,
    });
    await expect(CommerceController.commitClearPickupDetails(LISTING_ID, 1.5)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(clearDetails).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['commitMarkReady', 'commitMarkReady'],
    ['commitConfirmPickup', 'commitConfirmPickup'],
  ] as const)('%s passes the order id and revision through', async (controllerMethod, applicationMethod) => {
    const spy = vi.spyOn(CommerceApplication, applicationMethod).mockResolvedValue({ ok: true } as never);

    await CommerceController[controllerMethod](ORDER_ID, 5);

    expect(spy).toHaveBeenCalledWith(SELLER, { orderId: ORDER_ID, expectedRevision: 5 });
    await expect(CommerceController[controllerMethod](ORDER_ID, 0)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('commits a checkout with fulfillment choices for the current user', async () => {
    const checkout = vi
      .spyOn(CommerceApplication, 'commitCreateMarketplaceCheckout')
      .mockResolvedValue({ ok: true } as never);
    const input = {
      lines: [
        {
          listingAggregateId: LISTING_AGGREGATE_ID,
          sellerPubky: SELLER,
          publishedFulfillmentMethods: ['shipping', 'pickup'] as ('shipping' | 'pickup')[],
          expectedRevision: 3,
          quantity: 1,
        },
      ],
      fulfillmentChoiceBySeller: { [SELLER]: 'pickup' as const },
    };

    await CommerceController.commitCreateMarketplaceCheckout(input);

    expect(checkout).toHaveBeenCalledWith(SELLER, input);
  });
});
