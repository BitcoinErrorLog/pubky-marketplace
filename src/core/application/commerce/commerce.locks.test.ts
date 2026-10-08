import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as commerceConfig from '@/config/commerce';
import type { CommerceDigitalLock } from '@/libs/commerce/marketplace-records';
import type { CommerceLocksCorrelationModelSchema } from '@/models/commerce/commerce.schema';
import { LocalCommerceService } from '@/services/local/commerce/commerce';
import { LocksGatewayService, type LocksVerificationLifecycle } from '@/services/locks/locks';
import { MarketplaceGatewayService } from '@/services/marketplace/marketplace';
import { createOrderFixture, ORDER_FIXTURE_BUYER, ORDER_FIXTURE_SELLER } from '@/test/fixtures/commerce/orders';
import { asOpaque } from '@/test-utils/type-assertions';
import { CommerceApplication } from './commerce';

/**
 * pubky/locks#72: a payment submit is durable on the Lock Server before any
 * Paykit I/O, and the buyer polls that task instead of resubmitting. The Shop
 * therefore stores the bundle id before it submits, and an unregistered retry
 * looks the task up: a found task is never submitted again, and a missing one
 * is submitted with the same bundle id, never a fresh one.
 */

const BUNDLE_ID = '000G40R40M30E209185GR38E1W';
const SECOND_BUNDLE_ID = '000G40R40M30E209185GR38E1X';
const POLICY_URI = `pubky://${ORDER_FIXTURE_SELLER}/pub/locks.app/${'0'.repeat(52)}.json`;
const digitalLock = asOpaque<CommerceDigitalLock>({
  policyUri: POLICY_URI,
  criterionId: 'paykit',
  contentPath: 'pub/locks.app/content/file.bin',
  resourceHash: 'a'.repeat(64),
});

function pendingLifecycle(statusMessage: string | null = null): LocksVerificationLifecycle {
  return {
    creator: `pubky${ORDER_FIXTURE_SELLER}`,
    bundle_id: BUNDLE_ID,
    status: 'pending',
    submitted_at: '2026-10-06T18:00:00.000Z',
    started_at: null,
    completed_at: null,
    failure_message: null,
    status_message: statusMessage,
  };
}

describe('CommerceApplication Locks payment start (pubky/locks#72 no-resubmit rule)', () => {
  const store = new Map<string, CommerceLocksCorrelationModelSchema>();
  const order = createOrderFixture('pending_payment');
  const payment = asOpaque<Parameters<typeof CommerceApplication.beginMarketplaceLocksPayment>[0]['payment']>({
    id: 'payment-1',
    revision: 3,
  });
  const begin = () =>
    CommerceApplication.beginMarketplaceLocksPayment({ buyerPubky: ORDER_FIXTURE_BUYER, order, payment, digitalLock });

  beforeEach(() => {
    store.clear();
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('locks-paykit');
    vi.spyOn(LocalCommerceService, 'getLocksCorrelation').mockImplementation(async (_owner, paymentId) =>
      asOpaque(store.get(paymentId) ?? null),
    );
    vi.spyOn(LocalCommerceService, 'upsertLocksCorrelation').mockImplementation(async (correlation) => {
      store.set(correlation.payment_id, { ...correlation, id: correlation.payment_id });
    });
    vi.spyOn(LocalCommerceService, 'markLocksCorrelationRegistered').mockImplementation(
      async (_owner, paymentId, windowExpiresAt) => {
        const current = store.get(paymentId)!;
        store.set(paymentId, { ...current, registered: true, window_expires_at: windowExpiresAt });
      },
    );
    vi.spyOn(LocksGatewayService, 'generateBundleId')
      .mockResolvedValueOnce(BUNDLE_ID)
      .mockResolvedValueOnce(SECOND_BUNDLE_ID);
    vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue(
      asOpaque({ ok: true, result: { verification: { windowExpiresAt: '2026-10-06T19:00:00.000Z' } } }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stores the bundle id before the submit, submits once and registers it', async () => {
    const order_: string[] = [];
    vi.mocked(LocalCommerceService.upsertLocksCorrelation).mockImplementation(async (correlation) => {
      order_.push('store');
      store.set(correlation.payment_id, { ...correlation, id: correlation.payment_id });
    });
    const submit = vi.spyOn(LocksGatewayService, 'submitPaykitProof').mockImplementation(async () => {
      order_.push('submit');
      return pendingLifecycle();
    });
    const find = vi.spyOn(LocksGatewayService, 'findVerification');

    await expect(begin()).resolves.toMatchObject({ ok: true });

    expect(order_).toEqual(['store', 'submit']);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ bundleId: BUNDLE_ID }));
    expect(find).not.toHaveBeenCalled();
    expect(store.get('payment-1')).toMatchObject({ bundle_id: BUNDLE_ID, registered: true });
    expect(MarketplaceGatewayService.execute).toHaveBeenCalledWith(
      ORDER_FIXTURE_BUYER,
      expect.objectContaining({
        kind: 'payment.register_locks',
        payload: expect.objectContaining({ bundleId: BUNDLE_ID }),
      }),
    );
  });

  it('after a submit whose answer was lost, a retry finds the durable task and never submits it again', async () => {
    const submit = vi
      .spyOn(LocksGatewayService, 'submitPaykitProof')
      .mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const find = vi.spyOn(LocksGatewayService, 'findVerification').mockResolvedValue(pendingLifecycle());

    await expect(begin()).rejects.toThrow('Failed to fetch');
    expect(store.get('payment-1')).toMatchObject({ bundle_id: BUNDLE_ID, registered: false });

    await expect(begin()).resolves.toMatchObject({ ok: true });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith(ORDER_FIXTURE_SELLER, BUNDLE_ID);
    expect(LocksGatewayService.generateBundleId).toHaveBeenCalledTimes(1);
    expect(MarketplaceGatewayService.execute).toHaveBeenCalledWith(
      ORDER_FIXTURE_BUYER,
      expect.objectContaining({ payload: expect.objectContaining({ bundleId: BUNDLE_ID }) }),
    );
  });

  it('a retry for a submit the Lock Server refused submits the same bundle id, never a fresh one', async () => {
    const submit = vi
      .spyOn(LocksGatewayService, 'submitPaykitProof')
      .mockRejectedValueOnce(new Error('422 reader_pubky_unresolvable'))
      .mockResolvedValueOnce(pendingLifecycle());
    vi.spyOn(LocksGatewayService, 'findVerification').mockResolvedValue(null);

    await expect(begin()).rejects.toThrow('422');
    await expect(begin()).resolves.toMatchObject({ ok: true });

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls.map(([params]) => params.bundleId)).toEqual([BUNDLE_ID, BUNDLE_ID]);
    expect(LocksGatewayService.generateBundleId).toHaveBeenCalledTimes(1);
  });

  it('a registered correlation is neither looked up nor submitted again', async () => {
    const submit = vi.spyOn(LocksGatewayService, 'submitPaykitProof').mockResolvedValue(pendingLifecycle());
    const find = vi.spyOn(LocksGatewayService, 'findVerification');

    await begin();
    await begin();

    expect(submit).toHaveBeenCalledTimes(1);
    expect(find).not.toHaveBeenCalled();
  });

  it('reads the admission state of the stored task for the buyer', async () => {
    vi.spyOn(LocksGatewayService, 'submitPaykitProof').mockResolvedValue(pendingLifecycle());
    const find = vi
      .spyOn(LocksGatewayService, 'findVerification')
      .mockResolvedValueOnce(pendingLifecycle('Reader wallet setup needed'))
      .mockResolvedValueOnce({
        ...pendingLifecycle(),
        status: 'failed',
        started_at: '2026-10-06T18:10:00.000Z',
        completed_at: '2026-10-06T18:10:00.000Z',
        failure_message: 'invoice admission deadline exceeded',
      })
      .mockResolvedValueOnce(null);
    await expect(
      CommerceApplication.fetchMarketplaceLocksAdmission(ORDER_FIXTURE_BUYER, 'payment-1'),
    ).resolves.toBeNull();
    await begin();

    await expect(CommerceApplication.fetchMarketplaceLocksAdmission(ORDER_FIXTURE_BUYER, 'payment-1')).resolves.toEqual(
      {
        kind: 'in_flight',
        readerWalletSetupNeeded: true,
      },
    );
    await expect(CommerceApplication.fetchMarketplaceLocksAdmission(ORDER_FIXTURE_BUYER, 'payment-1')).resolves.toEqual(
      {
        kind: 'failed',
        failure: 'admission_deadline_exceeded',
      },
    );
    await expect(
      CommerceApplication.fetchMarketplaceLocksAdmission(ORDER_FIXTURE_BUYER, 'payment-1'),
    ).resolves.toBeNull();
    expect(find).toHaveBeenCalledTimes(3);
    expect(LocksGatewayService.submitPaykitProof).toHaveBeenCalledTimes(1);
  });
});
