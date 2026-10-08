import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { HttpMethod } from '@/libs/http/http.types';
import { PaykitMessagingService } from '@/services/paykit/paykit-messaging';
import { type FakeHomeserver, installFakeHomeserver } from '@/test-utils/fake-homeserver';
import { CommerceApplication } from './commerce';

const BUYER = 'b'.repeat(52);
const REGISTRY_URL = `pubky://${BUYER}/pub/paykit/v0/app-registry.json`;

function registry(paymentRequests: boolean) {
  return {
    version: 1,
    kind: 'paykit.app_registry',
    key_generation: 1,
    noise_public_key: 'n'.repeat(52),
    apps: {
      'to.bitkit': {
        display_name: 'Bitkit',
        capabilities: {
          private_payments: true,
          payment_requests: paymentRequests,
          receipts: true,
          outgoing_payments: true,
        },
      },
    },
    default_app_id: 'to.bitkit',
    default_apps_by_endpoint: {},
  };
}

describe('CommerceApplication.fetchBuyerPaykitWallet', () => {
  let homeserver: FakeHomeserver;
  let receiverMarker: MockInstance<typeof PaykitMessagingService.hasPaymentRequestReceiver>;

  beforeEach(() => {
    homeserver = installFakeHomeserver();
    receiverMarker = vi.spyOn(PaykitMessagingService, 'hasPaymentRequestReceiver');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reports a Bitkit 2.5 buyer (receiver marker, no registry) as payable', async () => {
    receiverMarker.mockResolvedValue(true);
    await expect(CommerceApplication.fetchBuyerPaykitWallet(BUYER)).resolves.toBe('payable');
    expect(homeserver.log).toEqual([`${HttpMethod.GET} ${REGISTRY_URL}`]);
    expect(receiverMarker).toHaveBeenCalledWith(BUYER);
  });

  it('reports a buyer with neither as not payable', async () => {
    receiverMarker.mockResolvedValue(false);
    await expect(CommerceApplication.fetchBuyerPaykitWallet(BUYER)).resolves.toBe('not_payable');
  });

  it('reports a Bitkit 2.6 buyer as unsupported even when 2.5 receiver markers remain', async () => {
    homeserver.files.set(REGISTRY_URL, registry(true));
    receiverMarker.mockResolvedValue(true);
    await expect(CommerceApplication.fetchBuyerPaykitWallet(BUYER)).resolves.toBe('unsupported');
    expect(receiverMarker).not.toHaveBeenCalled();
  });

  it('falls back to receiver markers when the registry lists no app that takes payment requests', async () => {
    homeserver.files.set(REGISTRY_URL, registry(false));
    receiverMarker.mockResolvedValue(true);
    await expect(CommerceApplication.fetchBuyerPaykitWallet(BUYER)).resolves.toBe('payable');
  });

  it('falls back to receiver markers when the registry is not a v1 Paykit App Registry', async () => {
    homeserver.files.set(REGISTRY_URL, { ...registry(true), kind: 'something.else' });
    receiverMarker.mockResolvedValue(false);
    await expect(CommerceApplication.fetchBuyerPaykitWallet(BUYER)).resolves.toBe('not_payable');
  });

  it('rejects when the registry cannot be read, never reporting a wallet state', async () => {
    homeserver.failNext(HttpMethod.GET, REGISTRY_URL, 503);
    receiverMarker.mockResolvedValue(true);
    await expect(CommerceApplication.fetchBuyerPaykitWallet(BUYER)).rejects.toThrow();
    expect(receiverMarker).not.toHaveBeenCalled();
  });

  it('rejects when the receiver markers cannot be read', async () => {
    receiverMarker.mockRejectedValue(new Error('receiver list unreadable'));
    await expect(CommerceApplication.fetchBuyerPaykitWallet(BUYER)).rejects.toThrow('receiver list unreadable');
  });
});
