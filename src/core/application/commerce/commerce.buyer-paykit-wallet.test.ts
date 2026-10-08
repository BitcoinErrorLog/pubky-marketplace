import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import { PaykitMessagingService } from '@/services/paykit/paykit-messaging';
import { CommerceApplication } from './commerce';

const sdk = vi.hoisted(() => ({ publicStorageGet: vi.fn<(address: string) => Promise<Response>>() }));

// The real HomeserverService runs; only the SDK's public read is stubbed, so
// its 404, error and invalid-JSON handling decide the outcome.
vi.mock('@synonymdev/pubky', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@synonymdev/pubky')>();
  const instance = { publicStorage: { get: (address: string) => sdk.publicStorageGet(address) } };
  return {
    ...actual,
    Client: class {},
    Pubky: { withClient: () => instance, testnet: () => instance },
  };
});

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

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('CommerceApplication.fetchBuyerPaykitWallet', () => {
  let receiverMarker: MockInstance<typeof PaykitMessagingService.hasPaymentRequestReceiver>;

  beforeEach(() => {
    sdk.publicStorageGet.mockReset();
    receiverMarker = vi.spyOn(PaykitMessagingService, 'hasPaymentRequestReceiver');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('registry absent (404): the receiver markers decide', () => {
    it('reports a Bitkit 2.5 buyer as payable', async () => {
      sdk.publicStorageGet.mockResolvedValue(new Response('Not Found', { status: 404 }));
      receiverMarker.mockResolvedValue(true);
      await expect(CommerceApplication.fetchBuyerPaykitWallet(BUYER)).resolves.toBe('payable');
      expect(sdk.publicStorageGet).toHaveBeenCalledWith(REGISTRY_URL);
      expect(receiverMarker).toHaveBeenCalledWith(BUYER);
    });

    it('treats a 404 the client throws the same way', async () => {
      sdk.publicStorageGet.mockRejectedValue({ name: 'RequestError', message: 'Not Found', data: { statusCode: 404 } });
      receiverMarker.mockResolvedValue(true);
      await expect(CommerceApplication.fetchBuyerPaykitWallet(BUYER)).resolves.toBe('payable');
    });

    it('reports a buyer with no marker as not payable', async () => {
      sdk.publicStorageGet.mockResolvedValue(new Response('Not Found', { status: 404 }));
      receiverMarker.mockResolvedValue(false);
      await expect(CommerceApplication.fetchBuyerPaykitWallet(BUYER)).resolves.toBe('not_payable');
    });

    it('rejects when the marker read then fails', async () => {
      sdk.publicStorageGet.mockResolvedValue(new Response('Not Found', { status: 404 }));
      receiverMarker.mockRejectedValue(new Error('receiver list unreadable'));
      await expect(CommerceApplication.fetchBuyerPaykitWallet(BUYER)).rejects.toThrow('receiver list unreadable');
    });
  });

  describe('registry found', () => {
    it('reports a Bitkit 2.6 buyer as unsupported even when 2.5 receiver markers remain', async () => {
      sdk.publicStorageGet.mockResolvedValue(json(registry(true)));
      receiverMarker.mockResolvedValue(true);
      await expect(CommerceApplication.fetchBuyerPaykitWallet(BUYER)).resolves.toBe('unsupported');
      expect(receiverMarker).not.toHaveBeenCalled();
    });

    it('reports invalid JSON at the registry path as unsupported, never a marker verdict', async () => {
      sdk.publicStorageGet.mockResolvedValue(new Response('{"version":1,"kind":', { status: 200 }));
      receiverMarker.mockResolvedValue(true);
      await expect(CommerceApplication.fetchBuyerPaykitWallet(BUYER)).resolves.toBe('unsupported');
      expect(receiverMarker).not.toHaveBeenCalled();
    });

    it('reports a registry of a later version as unsupported', async () => {
      sdk.publicStorageGet.mockResolvedValue(json({ ...registry(false), version: 2 }));
      receiverMarker.mockResolvedValue(true);
      await expect(CommerceApplication.fetchBuyerPaykitWallet(BUYER)).resolves.toBe('unsupported');
    });

    it('lets the markers decide when a v1 registry lists no app that takes payment requests', async () => {
      sdk.publicStorageGet.mockResolvedValue(json(registry(false)));
      receiverMarker.mockResolvedValue(true);
      await expect(CommerceApplication.fetchBuyerPaykitWallet(BUYER)).resolves.toBe('payable');
    });
  });

  describe('registry read fails: unverified, whatever the markers say', () => {
    it('on a network error', async () => {
      sdk.publicStorageGet.mockRejectedValue(new TypeError('Failed to fetch'));
      receiverMarker.mockResolvedValue(true);
      await expect(CommerceApplication.fetchBuyerPaykitWallet(BUYER)).resolves.toBe('unverified');
      expect(receiverMarker).not.toHaveBeenCalled();
    });

    it('on a server error', async () => {
      sdk.publicStorageGet.mockResolvedValue(new Response('Unavailable', { status: 503 }));
      receiverMarker.mockResolvedValue(true);
      await expect(CommerceApplication.fetchBuyerPaykitWallet(BUYER)).resolves.toBe('unverified');
      expect(receiverMarker).not.toHaveBeenCalled();
    });

    it('and reads again on the next check', async () => {
      sdk.publicStorageGet
        .mockRejectedValueOnce(new TypeError('Failed to fetch'))
        .mockResolvedValueOnce(new Response('Not Found', { status: 404 }));
      receiverMarker.mockResolvedValue(true);
      await expect(CommerceApplication.fetchBuyerPaykitWallet(BUYER)).resolves.toBe('unverified');
      await expect(CommerceApplication.fetchBuyerPaykitWallet(BUYER)).resolves.toBe('payable');
    });
  });
});
