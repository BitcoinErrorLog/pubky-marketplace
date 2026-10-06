import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as commerceConfig from '@/config/commerce';
import { encryptDigitalDeliverable, openDigitalDeliverable } from '@/libs/commerce/digital-file';
import { buildMarketplaceListingAggregateId } from '@/libs/commerce/transaction-commands';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { Logger } from '@/libs/logger/logger';
import { CommerceHomeserverService } from '@/services/homeserver/commerce/commerce';
import { LocalCommerceService } from '@/services/local/commerce/commerce';
import { MarketplaceGatewayService } from '@/services/marketplace/marketplace';
import { COMMERCE_FIXTURE_SELLER } from '@/test/fixtures/commerce/commerce';
import { asOpaque } from '@/test-utils/type-assertions';
import { CommerceApplication } from './commerce';

const SELLER = COMMERCE_FIXTURE_SELLER;
const LISTING_ID = 'guide_01';
const LISTING_AGGREGATE_ID = buildMarketplaceListingAggregateId(SELLER, LISTING_ID);
const PLAINTEXT = new TextEncoder().encode('%PDF-1.7 printable field guide');
const DELIVERABLE_URL = new RegExp(`^pubky://${SELLER}/pub/pubky\\.app/marketplace/v1/deliverables/[0-9a-f]{32}/3$`);

const okResponse = {
  ok: true as const,
  version: 1 as const,
  commandId: '018f47d2-6a27-7c23-a62f-000000000761',
  aggregateId: LISTING_AGGREGATE_ID,
  revision: 1,
  eventIds: [],
  result: { kind: 'digital_delivery', listingAggregateId: LISTING_AGGREGATE_ID, version: 3, updatedAt: '' },
};
const refusal = {
  ok: false as const,
  error: { code: 'INVALID_STATE', message: 'x', reason: 'deliverable_unverifiable' },
};

type ExecutedCommand = { kind: string; aggregateId: string; expectedRevision: number; payload: Record<string, never> };

function executedCommand(execute: ReturnType<typeof vi.spyOn>): ExecutedCommand {
  return execute.mock.calls[0][1] as ExecutedCommand;
}

describe('CommerceApplication digital delivery seller setup (digital delivery design §2)', () => {
  beforeEach(() => {
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(LocalCommerceService, 'getShop').mockResolvedValue({ record: {} } as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('encrypts a file, writes only the ciphertext, then sets it as the next version with the sealed facts', async () => {
    const put = vi.spyOn(CommerceHomeserverService, 'putDeliverable').mockResolvedValue(undefined);
    const remove = vi.spyOn(CommerceHomeserverService, 'deleteDeliverable').mockResolvedValue(undefined);
    const execute = vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue(okResponse as never);

    const response = await CommerceApplication.commitSetDigitalDelivery(SELLER, {
      sellerPubky: SELLER,
      listingId: LISTING_ID,
      expectedVersion: 2,
      delivery: {
        kind: 'file',
        bytes: PLAINTEXT,
        fileName: 'C:\\drafts\\Field Guide.pdf',
        contentType: 'application/pdf',
      },
    });

    expect(response.ok).toBe(true);
    const [url, ciphertext] = put.mock.calls[0];
    expect(url).toMatch(DELIVERABLE_URL);
    expect(new TextDecoder().decode(ciphertext)).not.toContain('field guide');
    expect(put.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]);

    const command = executedCommand(execute);
    expect(command).toMatchObject({
      kind: 'digital_delivery.set',
      aggregateId: LISTING_AGGREGATE_ID,
      expectedRevision: 0,
    });
    const payload = asOpaque<{
      expectedVersion: number;
      delivery: {
        kind: 'file';
        deliverableId: string;
        version: number;
        key: string;
        iv: string;
        ciphertextBlake3: string;
        plaintextBlake3: string;
        sizeBytes: number;
        contentType: string;
        fileName: string;
      };
    }>(command.payload);
    expect(payload.expectedVersion).toBe(2);
    expect(payload.delivery).toMatchObject({
      kind: 'file',
      version: 3,
      sizeBytes: PLAINTEXT.byteLength,
      contentType: 'application/pdf',
      fileName: 'Field Guide.pdf',
      ciphertextBlake3: bytesToHex(blake3(ciphertext)),
      plaintextBlake3: bytesToHex(blake3(PLAINTEXT)),
    });
    expect(url).toContain(`/deliverables/${payload.delivery.deliverableId}/3`);
    // The buyer's side can open what was uploaded with what was sent to the service.
    const opened = await openDigitalDeliverable({
      ciphertext: new Uint8Array(ciphertext),
      sellerPubky: SELLER,
      ...payload.delivery,
    });
    expect(opened.ok && new TextDecoder().decode(opened.plaintext)).toBe('%PDF-1.7 printable field guide');
    expect(remove).not.toHaveBeenCalled();
  });

  it('deletes the new ciphertext when the service refuses the set', async () => {
    vi.spyOn(CommerceHomeserverService, 'putDeliverable').mockResolvedValue(undefined);
    const remove = vi.spyOn(CommerceHomeserverService, 'deleteDeliverable').mockResolvedValue(undefined);
    vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue(refusal as never);

    const response = await CommerceApplication.commitSetDigitalDelivery(SELLER, {
      sellerPubky: SELLER,
      listingId: LISTING_ID,
      expectedVersion: 2,
      delivery: { kind: 'file', bytes: PLAINTEXT, fileName: 'guide.pdf', contentType: 'application/pdf' },
    });

    expect(response.ok).toBe(false);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][0]).toMatch(DELIVERABLE_URL);
  });

  it('still returns the refusal when the cleanup delete fails, logging no path', async () => {
    vi.spyOn(CommerceHomeserverService, 'putDeliverable').mockResolvedValue(undefined);
    vi.spyOn(CommerceHomeserverService, 'deleteDeliverable').mockRejectedValue(new TypeError('offline'));
    vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue(refusal as never);
    const warn = vi.spyOn(Logger, 'warn');

    const response = await CommerceApplication.commitSetDigitalDelivery(SELLER, {
      sellerPubky: SELLER,
      listingId: LISTING_ID,
      expectedVersion: 2,
      delivery: { kind: 'file', bytes: PLAINTEXT, fileName: 'guide.pdf', contentType: 'application/pdf' },
    });

    expect(response.ok).toBe(false);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/deliverables/');
  });

  const fileSet = () =>
    CommerceApplication.commitSetDigitalDelivery(SELLER, {
      sellerPubky: SELLER,
      listingId: LISTING_ID,
      expectedVersion: 2,
      delivery: { kind: 'file', bytes: PLAINTEXT, fileName: 'guide.pdf', contentType: 'application/pdf' },
    });

  it('replays a set that threw after the upload, and deletes the upload when the service had refused it', async () => {
    vi.spyOn(CommerceHomeserverService, 'putDeliverable').mockResolvedValue(undefined);
    const remove = vi.spyOn(CommerceHomeserverService, 'deleteDeliverable').mockResolvedValue(undefined);
    const execute = vi
      .spyOn(MarketplaceGatewayService, 'execute')
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(refusal as never);

    const response = await fileSet();

    expect(response.ok).toBe(false);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute.mock.calls[1][1]).toBe(execute.mock.calls[0][1]);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][0]).toMatch(DELIVERABLE_URL);
  });

  it('keeps the upload when the replay shows the service had set it', async () => {
    vi.spyOn(CommerceHomeserverService, 'putDeliverable').mockResolvedValue(undefined);
    const remove = vi.spyOn(CommerceHomeserverService, 'deleteDeliverable').mockResolvedValue(undefined);
    vi.spyOn(MarketplaceGatewayService, 'execute')
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(okResponse as never);

    const response = await fileSet();

    expect(response.ok).toBe(true);
    expect(remove).not.toHaveBeenCalled();
  });

  it('keeps the upload and rethrows when the set gets no answer twice, logging no path', async () => {
    vi.spyOn(CommerceHomeserverService, 'putDeliverable').mockResolvedValue(undefined);
    const remove = vi.spyOn(CommerceHomeserverService, 'deleteDeliverable').mockResolvedValue(undefined);
    vi.spyOn(MarketplaceGatewayService, 'execute')
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockRejectedValueOnce(new TypeError('still offline'));
    const warn = vi.spyOn(Logger, 'warn');

    await expect(fileSet()).rejects.toThrow('connection reset');
    expect(remove).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('/deliverables/');
  });

  it('uploads and sends nothing when the file cannot be encrypted, and says it was the encryption', async () => {
    vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValueOnce(new DOMException('encrypt failed', 'OperationError'));
    const put = vi.spyOn(CommerceHomeserverService, 'putDeliverable');
    const execute = vi.spyOn(MarketplaceGatewayService, 'execute');

    const error = await fileSet().catch((caught: unknown) => caught);

    expect(error).toMatchObject({ context: { refusal: 'encrypt_failed' } });
    expect(put).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('sends no command when the homeserver refuses the upload', async () => {
    vi.spyOn(CommerceHomeserverService, 'putDeliverable').mockRejectedValue(new TypeError('quota'));
    const execute = vi.spyOn(MarketplaceGatewayService, 'execute');

    await expect(
      CommerceApplication.commitSetDigitalDelivery(SELLER, {
        sellerPubky: SELLER,
        listingId: LISTING_ID,
        expectedVersion: 0,
        delivery: { kind: 'file', bytes: PLAINTEXT, fileName: 'guide.pdf', contentType: 'application/pdf' },
      }),
    ).rejects.toThrow('quota');
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'link' as const, url: 'https://example.com/course' }],
    [{ kind: 'text' as const, text: 'LICENCE-1234' }],
    [{ kind: 'email' as const }],
    [{ kind: 'message' as const }],
  ])('sets %j without touching the homeserver', async (delivery) => {
    const put = vi.spyOn(CommerceHomeserverService, 'putDeliverable');
    const execute = vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue(okResponse as never);

    await CommerceApplication.commitSetDigitalDelivery(SELLER, {
      sellerPubky: SELLER,
      listingId: LISTING_ID,
      expectedVersion: 0,
      delivery,
    });

    expect(put).not.toHaveBeenCalled();
    expect(executedCommand(execute).payload).toEqual({ expectedVersion: 0, delivery });
  });

  it('clears on the listing aggregate with the payload CAS', async () => {
    const execute = vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue(okResponse as never);

    await CommerceApplication.commitClearDigitalDelivery(SELLER, {
      sellerPubky: SELLER,
      listingId: LISTING_ID,
      expectedVersion: 4,
    });

    expect(executedCommand(execute)).toMatchObject({
      kind: 'digital_delivery.clear',
      aggregateId: LISTING_AGGREGATE_ID,
      expectedRevision: 0,
      payload: { expectedVersion: 4 },
    });
  });

  it('refuses both commands before any bytes leave on a non-durable deployment', async () => {
    vi.mocked(commerceConfig.getCommerceAdapterMode).mockReturnValue('sandbox');
    const put = vi.spyOn(CommerceHomeserverService, 'putDeliverable');
    const execute = vi.spyOn(MarketplaceGatewayService, 'execute');

    await expect(
      CommerceApplication.commitSetDigitalDelivery(SELLER, {
        sellerPubky: SELLER,
        listingId: LISTING_ID,
        expectedVersion: 0,
        delivery: { kind: 'file', bytes: PLAINTEXT, fileName: 'guide.pdf', contentType: 'application/pdf' },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT', context: { refusal: 'digital_delivery_unavailable' } });
    await expect(
      CommerceApplication.commitClearDigitalDelivery(SELLER, {
        sellerPubky: SELLER,
        listingId: LISTING_ID,
        expectedVersion: 0,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(put).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('delegates the owner read to the gateway', async () => {
    const read = vi.spyOn(MarketplaceGatewayService, 'getListingDigitalDelivery').mockResolvedValue({} as never);
    await CommerceApplication.fetchSellerDigitalDelivery(SELLER, LISTING_AGGREGATE_ID);
    expect(read).toHaveBeenCalledWith(SELLER, LISTING_AGGREGATE_ID);
  });
});

describe('CommerceApplication buyer digital delivery (digital delivery design §3.4, §4.2, §6 F11)', () => {
  const ORDER_ID = '018f47d2-6a27-7c23-a62f-000000000901';
  const DELIVERABLE_ID = 'b'.repeat(32);

  async function pinnedFileLine() {
    const encrypted = await encryptDigitalDeliverable({
      plaintext: new Uint8Array(PLAINTEXT),
      sellerPubky: SELLER,
      deliverableId: DELIVERABLE_ID,
      version: 3,
    });
    const line = {
      lineIndex: 0,
      listingAggregateId: LISTING_AGGREGATE_ID,
      kind: 'file' as const,
      sellerPubky: SELLER,
      deliverableId: DELIVERABLE_ID,
      version: 3,
      key: encrypted.key,
      iv: encrypted.iv,
      ciphertextBlake3: encrypted.ciphertextBlake3,
      plaintextBlake3: encrypted.plaintextBlake3,
      sizeBytes: encrypted.sizeBytes,
      contentType: 'application/pdf',
      fileName: 'Field Guide.pdf',
    };
    return { line, ciphertext: encrypted.ciphertext };
  }

  beforeEach(() => {
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reads the ciphertext at the pinned path, verifies it and returns the plaintext', async () => {
    const { line, ciphertext } = await pinnedFileLine();
    const get = vi.spyOn(CommerceHomeserverService, 'getDeliverable').mockResolvedValue(ciphertext);

    const opened = await CommerceApplication.openOrderDigitalFile(line);

    expect(get).toHaveBeenCalledWith(
      `pubky://${SELLER}/pub/pubky.app/marketplace/v1/deliverables/${DELIVERABLE_ID}/3`,
      line.sizeBytes + 16,
    );
    expect(opened).toMatchObject({ ok: true, fileName: 'Field Guide.pdf', contentType: 'application/pdf' });
    expect(opened.ok && new TextDecoder().decode(opened.bytes)).toBe(new TextDecoder().decode(PLAINTEXT));
  });

  // Review P2: a body larger than the pinned ciphertext is refused while it is read.
  it('reads at most the pinned ciphertext length, and names an oversized body as not the paid file', async () => {
    const { line } = await pinnedFileLine();
    vi.spyOn(CommerceHomeserverService, 'getDeliverable').mockRejectedValue(
      Err.client(ClientErrorCode.PAYLOAD_TOO_LARGE, 'The homeserver returned more bytes than expected.', {
        service: ErrorService.Homeserver,
        operation: 'readResponseBytes',
      }),
    );

    await expect(CommerceApplication.openOrderDigitalFile(line)).resolves.toEqual({
      ok: false,
      reason: 'ciphertext_mismatch',
    });
  });

  it('refuses a ciphertext that is not the pinned one', async () => {
    const { line, ciphertext } = await pinnedFileLine();
    const tampered = new Uint8Array(ciphertext);
    tampered[0] ^= 0xff;
    vi.spyOn(CommerceHomeserverService, 'getDeliverable').mockResolvedValue(tampered);

    await expect(CommerceApplication.openOrderDigitalFile(line)).resolves.toEqual({
      ok: false,
      reason: 'ciphertext_mismatch',
    });
  });

  it('refuses a pinned key that does not open the file', async () => {
    const { line, ciphertext } = await pinnedFileLine();
    vi.spyOn(CommerceHomeserverService, 'getDeliverable').mockResolvedValue(ciphertext);

    await expect(CommerceApplication.openOrderDigitalFile({ ...line, key: 'a'.repeat(64) })).resolves.toEqual({
      ok: false,
      reason: 'decrypt_failed',
    });
  });

  it('reports a homeserver that does not return the file', async () => {
    const { line } = await pinnedFileLine();
    vi.spyOn(CommerceHomeserverService, 'getDeliverable').mockRejectedValue(new Error('404'));

    await expect(CommerceApplication.openOrderDigitalFile(line)).resolves.toEqual({
      ok: false,
      reason: 'fetch_failed',
    });
  });

  it('sets the delivery email on the order aggregate with the order revision', async () => {
    const execute = vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue(okResponse as never);

    await CommerceApplication.commitSetDeliveryEmail(SELLER, {
      orderId: ORDER_ID,
      expectedRevision: 4,
      deliveryEmail: 'buyer@example.com',
    });

    expect(executedCommand(execute)).toMatchObject({
      kind: 'order.set_delivery_email',
      aggregateId: `order:${ORDER_ID}`,
      expectedRevision: 4,
      payload: { orderId: ORDER_ID, deliveryEmail: 'buyer@example.com' },
    });
  });

  it('marks a digital order delivered on the order aggregate with the order revision', async () => {
    const execute = vi.spyOn(MarketplaceGatewayService, 'execute').mockResolvedValue(okResponse as never);

    await CommerceApplication.commitDeliverDigital(SELLER, {
      orderId: ORDER_ID,
      expectedRevision: 5,
      channel: 'email',
    });

    expect(executedCommand(execute)).toMatchObject({
      kind: 'fulfillment.deliver_digital',
      aggregateId: `order:${ORDER_ID}`,
      expectedRevision: 5,
      payload: { orderId: ORDER_ID, channel: 'email' },
    });
  });

  it('reads no evidence on a non-durable deployment', async () => {
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    const read = vi.spyOn(MarketplaceGatewayService, 'getOrderDigitalEvidence');

    await expect(CommerceApplication.fetchOrderDigitalEvidence(SELLER, ORDER_ID)).rejects.toMatchObject({
      context: { refusal: 'digital_delivery_unavailable' },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses to mark delivered on a non-durable deployment', async () => {
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    const execute = vi.spyOn(MarketplaceGatewayService, 'execute');

    await expect(
      CommerceApplication.commitDeliverDigital(SELLER, { orderId: ORDER_ID, expectedRevision: 5, channel: 'message' }),
    ).rejects.toMatchObject({ context: { refusal: 'digital_delivery_unavailable' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it('reads nothing and sends nothing on a non-durable deployment', async () => {
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    const read = vi.spyOn(MarketplaceGatewayService, 'getOrderDigitalDelivery');
    const execute = vi.spyOn(MarketplaceGatewayService, 'execute');

    await expect(CommerceApplication.fetchOrderDigitalDelivery(SELLER, ORDER_ID, 0)).rejects.toMatchObject({
      context: { refusal: 'digital_delivery_unavailable' },
    });
    await expect(
      CommerceApplication.commitSetDeliveryEmail(SELLER, {
        orderId: ORDER_ID,
        expectedRevision: 1,
        deliveryEmail: 'a@b',
      }),
    ).rejects.toMatchObject({ context: { refusal: 'digital_delivery_unavailable' } });
    expect(read).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
