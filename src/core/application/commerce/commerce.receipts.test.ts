import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as commerceConfig from '@/config/commerce';
import { marketplaceReceiptAttestationSchema } from '@/libs/commerce/attestation';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  decryptPrivRecord,
  encryptPrivRecord,
  privEntryName,
  privEntryUrl,
  type PrivKeyring,
  revokePrivKeyring,
} from '@/libs/commerce/priv-envelope';
import { toCamelCaseWire } from '@/libs/commerce/wire-casing';
import { HttpMethod } from '@/libs/http/http.types';
import { Logger } from '@/libs/logger/logger';
import { CommerceHomeserverService } from '@/services/homeserver/commerce/commerce';
import { CommercePrivStoreService } from '@/services/homeserver/commerce/priv-store';
import { HomeserverService } from '@/services/homeserver/homeserver';
import { MarketplaceGatewayService } from '@/services/marketplace/marketplace';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import receiptAttestationV1 from '@/test/fixtures/commerce/receipt-attestation-v1.json';
import receiptAttestationV2Bitcoin from '@/test/fixtures/commerce/receipt-attestation-v2-bitcoin.json';
import receiptAttestationV2SameCurrency from '@/test/fixtures/commerce/receipt-attestation-v2-same-currency.json';
import { type FakeHomeserver, installFakeHomeserver } from '@/test-utils/fake-homeserver';
import {
  establishMarketplaceSession,
  expectSafeAtEverySessionReplacement,
  releasedKeyring,
} from '@/test-utils/priv-session-replacement';
import { CommerceApplication } from './commerce';
import { CommercePrivKeyringApplication } from './priv-keyring';

// A REAL receipt attestation issued by the transaction service's Rust
// attestor (test keypair) and cross-verified against the specs fork's
// verifier — the same artifact the wire delivers. Tampering with any claim
// or the signature must fail the offline recipe.
const BUYER = 'operrr8wsbpr3ue9d4qj41ge1kcc6r7fdiy6o3ugjrrhi4y77rdo';
const SELLER = 'pxnu33x7jtpx9ar1ytsi4yxbp6a5o36gwhffs8zoxmbuptici1jy';
const ORDER_ID = '018f47d2-6a27-7c23-a49d-6b21bb770200';
const RECEIPT_ID = '018f47d2-6a27-7c23-a49d-6b21bb770201';
const OTHER_RECEIPT = '018f47d2-6a27-7c23-a49d-6b21bb770299';
const JWS =
  'eyJhbGciOiJFZERTQSIsInR5cCI6InB1Ymt5LW9yZGVyLXJlY2VpcHQrdjEifQ.eyJ2IjoxLCJpc3MiOiI3amZnYWE5bnV0anlpeHppa2I3dGdtc2Y5Z2t3cTdpcXo0OTh6cjFuZDVpZzFmbmc0ZXN5IiwiYnV5ZXIiOiJvcGVycnI4d3NicHIzdWU5ZDRxajQxZ2Uxa2NjNnI3ZmRpeTZvM3VnanJyaGk0eTc3cmRvIiwic2VsbGVyIjoicHhudTMzeDdqdHB4OWFyMXl0c2k0eXhicDZhNW8zNmd3aGZmczh6b3htYnVwdGljaTFqeSIsIm9yZGVyIjoiMDE4ZjQ3ZDItNmEyNy03YzIzLWE0OWQtNmIyMWJiNzcwMjAwIiwicmVjZWlwdCI6IjAxOGY0N2QyLTZhMjctN2MyMy1hNDlkLTZiMjFiYjc3MDIwMSIsInRvdGFsX21pbm9yIjoxNDc5NiwiY3VycmVuY3kiOiJVU0QiLCJleHBvbmVudCI6MiwicGFpZF9hdCI6IjIwMjYtMDgtMTlUMjI6MDA6MDAuMDAwWiIsImlhdCI6MTc4NzE3NjgwMH0.2zDQZwDYjVsxfppJMZanH9WR04bW8IkqbwHvVY49a72SFqpLDnZN_YYeYHYex5mujtXMp6fLwqhzG8vMZRMFAA';

type LiveReceiptFixture = {
  receipt_attestation: {
    jws: string;
    claims: Record<string, unknown>;
  };
};

const parseLiveReceiptFixture = (fixture: LiveReceiptFixture) =>
  marketplaceReceiptAttestationSchema.parse(toCamelCaseWire(fixture.receipt_attestation));

const attestation = () => ({
  jws: JWS,
  claims: {
    v: 1 as const,
    iss: '7jfgaa9nutjyixzikb7tgmsf9gkwq7iqz498zr1nd5ig1fng4esy',
    buyer: BUYER,
    seller: SELLER,
    order: ORDER_ID,
    receipt: RECEIPT_ID,
    totalMinor: 14796,
    currency: 'USD',
    exponent: 2,
    paidAt: '2026-08-19T22:00:00.000Z',
    iat: 1787176800,
  },
});

// A REAL pubky-drop-edition+v1 JWS from the same attestor, bound to the
// receipt above ("edition 7 of 100" of drop_summer_01) and cross-verified
// against the specs verifier.
const EDITION_JWS =
  'eyJhbGciOiJFZERTQSIsInR5cCI6InB1Ymt5LWRyb3AtZWRpdGlvbit2MSJ9.eyJ2IjoxLCJpc3MiOiI3amZnYWE5bnV0anlpeHppa2I3dGdtc2Y5Z2t3cTdpcXo0OTh6cjFuZDVpZzFmbmc0ZXN5IiwiYnV5ZXIiOiJvcGVycnI4d3NicHIzdWU5ZDRxajQxZ2Uxa2NjNnI3ZmRpeTZvM3VnanJyaGk0eTc3cmRvIiwic2VsbGVyIjoicHhudTMzeDdqdHB4OWFyMXl0c2k0eXhicDZhNW8zNmd3aGZmczh6b3htYnVwdGljaTFqeSIsImRyb3AiOiJkcm9wX3N1bW1lcl8wMSIsImVkaXRpb24iOjcsIm9mIjoxMDAsInJlY2VpcHQiOiIwMThmNDdkMi02YTI3LTdjMjMtYTQ5ZC02YjIxYmI3NzAyMDEiLCJpYXQiOjE3ODcxNzY4MDB9.HUaDMmkkFaAmGR_MdXB7O_kewj5ruU7sYOh8JKHqTWFWhdpHeLxxk9I8s3IDhGkI-FxAecU0e704UPYuS8brAQ';

const editionAttestation = () => ({
  jws: EDITION_JWS,
  claims: {
    v: 1 as const,
    iss: '7jfgaa9nutjyixzikb7tgmsf9gkwq7iqz498zr1nd5ig1fng4esy',
    buyer: BUYER,
    seller: SELLER,
    drop: 'drop_summer_01',
    edition: 7,
    of: 100,
    receipt: RECEIPT_ID,
    iat: 1787176800,
  },
});

const paidOrder = (receiptId: string = RECEIPT_ID) => ({ receiptId, buyerPubky: BUYER, sellerPubky: SELLER }) as never;

const paidDropOrder = (receiptId: string = RECEIPT_ID) =>
  ({
    receiptId,
    buyerPubky: BUYER,
    sellerPubky: SELLER,
    dropAggregateId: `drop:${SELLER}_drop_summer_01`,
    edition: 7,
  }) as never;

const grantCapableSession = () => {
  vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
  vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(true);
  vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(true);
};

const keyringFor = (owner: string): PrivKeyring => ({
  ownerPubky: owner,
  currentKeyId: 'c'.repeat(32),
  keys: [{ keyId: 'c'.repeat(32), key: new Uint8Array(32).fill(owner.charCodeAt(0)) }],
});
const sealedUrl = (owner: string, receiptId: string) => privEntryUrl(keyringFor(owner), 'order_receipt', receiptId);
const legacyUrl = (owner: string, receiptId: string) =>
  `pubky://${owner}/priv/pubky.app/marketplace/v1/receipts/${receiptId}`;

let homeserver: FakeHomeserver;

function storedReceipt(owner: string, receiptId: string): Record<string, unknown> {
  return decryptPrivRecord({
    keyring: keyringFor(owner),
    family: 'order_receipt',
    name: privEntryName(keyringFor(owner), 'order_receipt', receiptId),
    envelope: homeserver.files.get(sealedUrl(owner, receiptId)),
  }) as Record<string, unknown>;
}

function sealReceipt(owner: string, receiptId: string, record: Record<string, unknown>) {
  homeserver.files.set(
    sealedUrl(owner, receiptId),
    encryptPrivRecord({
      keyring: keyringFor(owner),
      family: 'order_receipt',
      name: privEntryName(keyringFor(owner), 'order_receipt', receiptId),
      record,
    }),
  );
}

const writes = () => homeserver.log.filter((entry) => entry.startsWith('PUT ') || entry.startsWith('DELETE '));

async function publishedRecord(): Promise<Record<string, unknown>> {
  grantCapableSession();
  vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation').mockResolvedValue(attestation());
  await CommerceApplication.publishOrderReceipts(BUYER, [paidOrder()]);
  return storedReceipt(BUYER, RECEIPT_ID);
}

beforeEach(() => {
  homeserver = installFakeHomeserver();
  vi.spyOn(CommercePrivKeyringApplication, 'get').mockImplementation(async (owner: string) => ({
    kind: 'keys',
    keyring: keyringFor(owner),
  }));
});

describe('CommerceApplication.publishOrderReceipts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    CommerceApplication.resetReceiptPublicationMemo();
  });

  it('publishes a verified portable receipt built from the attestation claims, sealed at its opaque entry', async () => {
    const record = await publishedRecord();

    expect(record.recordType).toBe('order_receipt');
    expect(record.role).toBe('buyer');
    expect(record.ownerPubky).toBe(BUYER);
    expect(record.receiptId).toBe(RECEIPT_ID);
    expect(record.orderId).toBe(ORDER_ID);
    expect(record.total).toEqual({ amountMinor: 14796, currency: 'USD', exponent: 2 });
    expect(record.paidAt).toBe('2026-08-19T22:00:00.000Z');
    expect(record.receiptAttestation).toBe(JWS);
    const stored = JSON.stringify(homeserver.files.get(sealedUrl(BUYER, RECEIPT_ID)));
    for (const plaintext of [RECEIPT_ID, ORDER_ID, SELLER, 'order_receipt', JWS.slice(0, 40)]) {
      expect(stored).not.toContain(plaintext);
    }
    expect(sealedUrl(BUYER, RECEIPT_ID)).not.toContain(RECEIPT_ID);
    expect(homeserver.files.has(legacyUrl(BUYER, RECEIPT_ID))).toBe(false);
  });

  it('publishes a drop order receipt carrying the verified edition attestation', async () => {
    grantCapableSession();
    vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation').mockResolvedValue(attestation());
    const editions = vi
      .spyOn(MarketplaceGatewayService, 'getEditionAttestation')
      .mockResolvedValue(editionAttestation());

    await CommerceApplication.publishOrderReceipts(BUYER, [paidDropOrder()]);

    expect(editions).toHaveBeenCalledWith(BUYER, RECEIPT_ID);
    const record = storedReceipt(BUYER, RECEIPT_ID);
    expect(record.editionAttestation).toBe(EDITION_JWS);
    expect(record.drop).toEqual({ dropId: 'drop_summer_01', edition: 7, of: 100 });
  });

  it.each([
    ['v1', receiptAttestationV1],
    ['v2 bitcoin settlement', receiptAttestationV2Bitcoin],
    ['v2 same-currency settlement', receiptAttestationV2SameCurrency],
  ])('parses the live %s receipt attestation through the wire boundary', (_name, fixture) => {
    const parsed = parseLiveReceiptFixture(fixture as LiveReceiptFixture);
    expect(parsed.jws).toBe((fixture as LiveReceiptFixture).receipt_attestation.jws);
  });

  it('rejects a deliberately wrong v2 claim version and mismatched money shape', () => {
    const wrongVersion = structuredClone(receiptAttestationV2Bitcoin.receipt_attestation);
    wrongVersion.claims.v = 1;
    expect(marketplaceReceiptAttestationSchema.safeParse(toCamelCaseWire(wrongVersion)).success).toBe(false);

    const wrongMoneyShape = structuredClone(receiptAttestationV2Bitcoin.receipt_attestation);
    wrongMoneyShape.claims.merchandise_total = {
      amount_minor: -1,
      currency: 'USD',
      exponent: 2,
    };
    expect(marketplaceReceiptAttestationSchema.safeParse(toCamelCaseWire(wrongMoneyShape)).success).toBe(false);
  });

  it('publishes a v2 receipt with merchandise value as the portable record total', async () => {
    grantCapableSession();
    const fixture = parseLiveReceiptFixture(receiptAttestationV2Bitcoin as LiveReceiptFixture);
    vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation').mockResolvedValue(fixture);

    await CommerceApplication.publishOrderReceipts(fixture.claims.buyer, [
      {
        receiptId: fixture.claims.receipt,
        buyerPubky: fixture.claims.buyer,
        sellerPubky: fixture.claims.seller,
      } as never,
    ]);

    const record = storedReceipt(fixture.claims.buyer, fixture.claims.receipt);
    expect(record.total).toEqual({ amountMinor: 13700, currency: 'USD', exponent: 2 });
    expect(record.settlementTotal).toEqual({ amountMinor: 51637, currency: 'SAT', exponent: 0 });
    expect(record.receiptAttestation).toBe(fixture.jws);
  });

  it('refuses a v2 receipt when wire claims disagree with the signed payload', async () => {
    grantCapableSession();
    const tamperedWire = structuredClone(receiptAttestationV2Bitcoin) as LiveReceiptFixture;
    (
      tamperedWire.receipt_attestation.claims as { settlement_total: { amount_minor: number } }
    ).settlement_total.amount_minor += 1;
    const fixture = parseLiveReceiptFixture(tamperedWire);
    vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation').mockResolvedValue(fixture);

    await CommerceApplication.publishOrderReceipts(fixture.claims.buyer, [
      {
        receiptId: fixture.claims.receipt,
        buyerPubky: fixture.claims.buyer,
        sellerPubky: fixture.claims.seller,
      } as never,
    ]);

    expect(writes()).toEqual([]);
  });

  it('refuses to publish a drop receipt whose edition attestation does not verify', async () => {
    grantCapableSession();
    vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation').mockResolvedValue(attestation());
    const tampered = editionAttestation();
    tampered.jws = `${EDITION_JWS.slice(0, -8)}AAAAAAAA`;
    vi.spyOn(MarketplaceGatewayService, 'getEditionAttestation').mockResolvedValue(tampered);

    await CommerceApplication.publishOrderReceipts(BUYER, [paidDropOrder()]);

    expect(writes()).toEqual([]);
  });

  it('does not fetch edition attestations for non-drop orders', async () => {
    grantCapableSession();
    vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation').mockResolvedValue(attestation());
    const editions = vi.spyOn(MarketplaceGatewayService, 'getEditionAttestation');

    await CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770206')]);

    expect(editions).not.toHaveBeenCalled();
  });

  it('refuses to publish when the attestation does not verify against the record', async () => {
    grantCapableSession();
    // Tamper: signature bytes flipped — structural shape survives, crypto fails.
    const tampered = attestation();
    tampered.jws = `${JWS.slice(0, -8)}AAAAAAAA`;
    vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation').mockResolvedValue(tampered);

    await CommerceApplication.publishOrderReceipts(BUYER, [paidOrder()]);

    expect(writes()).toEqual([]);
  });

  it('skips publication when a verified sealed receipt already exists on the homeserver', async () => {
    await publishedRecord();
    CommerceApplication.resetReceiptPublicationMemo();
    homeserver.log.length = 0;
    const fetchAttestation = vi.mocked(MarketplaceGatewayService.getReceiptAttestation);
    fetchAttestation.mockClear();

    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder()])).resolves.toBe('published');

    expect(fetchAttestation).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });

  it.each([
    ['is not an order receipt', () => ({})],
    ['names another receipt', (record: Record<string, unknown>) => ({ ...record, receiptId: OTHER_RECEIPT })],
    ['belongs to another owner', (record: Record<string, unknown>) => ({ ...record, ownerPubky: SELLER })],
    [
      'carries an attestation that does not verify',
      (record: Record<string, unknown>) => ({ ...record, total: { amountMinor: 1, currency: 'USD', exponent: 2 } }),
    ],
  ])('does not count a sealed receipt that opens but %s as published, and never overwrites it', async (_name, make) => {
    const record = await publishedRecord();
    CommerceApplication.resetReceiptPublicationMemo();
    sealReceipt(BUYER, RECEIPT_ID, make(record));
    const sealedBefore = homeserver.files.get(sealedUrl(BUYER, RECEIPT_ID));
    homeserver.log.length = 0;
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder()])).resolves.toBe('unavailable');

    expect(homeserver.files.get(sealedUrl(BUYER, RECEIPT_ID))).toEqual(sealedBefore);
    expect(writes()).toEqual([]);
  });

  it('does nothing without a durable mode, a session, or the /priv write grant', async () => {
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    await CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770203')]);

    vi.mocked(commerceConfig.getCommerceAdapterMode).mockReturnValue('transaction-service');
    vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(false);
    await CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770203')]);

    vi.mocked(HomeserverService.hasActiveSession).mockReturnValue(true);
    vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(false);
    await CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770203')]);

    expect(homeserver.log).toEqual([]);
    expect(CommercePrivKeyringApplication.get).not.toHaveBeenCalled();
  });

  it('stops honestly when the deployment issues no attestations', async () => {
    grantCapableSession();
    vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation').mockResolvedValue(null);

    await CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770204')]);

    expect(writes()).toEqual([]);
  });

  it('ignores orders the current user is not a party to and orders without receipts', async () => {
    grantCapableSession();
    const fetchAttestation = vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation');

    const stranger = 'y'.repeat(52);
    await CommerceApplication.publishOrderReceipts(stranger, [
      paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770205'),
      { receiptId: null, buyerPubky: stranger, sellerPubky: SELLER } as never,
    ]);

    expect(fetchAttestation).not.toHaveBeenCalled();
    expect(writes()).toEqual([]);
  });
});

describe('CommerceApplication.publishOrderReceipts without a released key', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    CommerceApplication.resetReceiptPublicationMemo();
  });

  it('writes nothing and reports needs_marketplace_approval or unavailable, leaving plaintext receipts in place', async () => {
    grantCapableSession();
    const fetchAttestation = vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation');
    homeserver.files.set(legacyUrl(BUYER, RECEIPT_ID), { recordType: 'order_receipt' });

    vi.mocked(CommercePrivKeyringApplication.get).mockResolvedValueOnce({ kind: 'needs_reauth' });
    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder()])).resolves.toBe(
      'needs_marketplace_approval',
    );
    vi.mocked(CommercePrivKeyringApplication.get).mockResolvedValueOnce({ kind: 'unavailable' });
    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder()])).resolves.toBe('unavailable');
    vi.mocked(CommercePrivKeyringApplication.get).mockRejectedValueOnce(new TypeError('network unavailable'));
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder()])).resolves.toBe('unavailable');

    expect(homeserver.log).toEqual([]);
    expect(fetchAttestation).not.toHaveBeenCalled();
    expect(homeserver.files.has(legacyUrl(BUYER, RECEIPT_ID))).toBe(true);
  });
});

describe('CommerceApplication.publishOrderReceipts moving plaintext receipts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    CommerceApplication.resetReceiptPublicationMemo();
  });

  it('seals every plaintext receipt, reads it back, then deletes the plaintext', async () => {
    const record = await publishedRecord();
    CommerceApplication.resetReceiptPublicationMemo();
    homeserver.files.clear();
    const otherReceipt = '018f47d2-6a27-7c23-a49d-6b21bb770230';
    homeserver.files.set(legacyUrl(BUYER, RECEIPT_ID), record);
    homeserver.files.set(legacyUrl(BUYER, otherReceipt), { ...record, receiptId: otherReceipt });
    homeserver.log.length = 0;
    const fetchAttestation = vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation');
    fetchAttestation.mockClear();

    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder()])).resolves.toBe('published');

    expect(storedReceipt(BUYER, RECEIPT_ID)).toEqual(record);
    expect(storedReceipt(BUYER, otherReceipt)).toEqual({ ...record, receiptId: otherReceipt });
    expect(homeserver.files.has(legacyUrl(BUYER, RECEIPT_ID))).toBe(false);
    expect(homeserver.files.has(legacyUrl(BUYER, otherReceipt))).toBe(false);
    const put = homeserver.log.indexOf(`PUT ${sealedUrl(BUYER, RECEIPT_ID)}`);
    const verify = homeserver.log.lastIndexOf(`GET ${sealedUrl(BUYER, RECEIPT_ID)}`);
    const remove = homeserver.log.indexOf(`DELETE ${legacyUrl(BUYER, RECEIPT_ID)}`);
    expect(put).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(put);
    expect(remove).toBeGreaterThan(verify);
    // The moved receipt is published: no attestation fetch, no second write.
    expect(fetchAttestation).not.toHaveBeenCalled();
    expect(homeserver.log.filter((entry) => entry === `PUT ${sealedUrl(BUYER, RECEIPT_ID)}`)).toHaveLength(1);
  });

  it('deletes a plaintext receipt whose sealed entry already exists without rewriting it', async () => {
    const record = await publishedRecord();
    CommerceApplication.resetReceiptPublicationMemo();
    homeserver.files.set(legacyUrl(BUYER, RECEIPT_ID), record);
    const sealedBefore = homeserver.files.get(sealedUrl(BUYER, RECEIPT_ID));
    homeserver.log.length = 0;

    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder()])).resolves.toBe('published');

    expect(homeserver.files.get(sealedUrl(BUYER, RECEIPT_ID))).toEqual(sealedBefore);
    expect(writes()).toEqual([`DELETE ${legacyUrl(BUYER, RECEIPT_ID)}`]);
  });

  it('keeps a plaintext file that does not parse or names another receipt, and reports unavailable', async () => {
    grantCapableSession();
    const record = await publishedRecord();
    CommerceApplication.resetReceiptPublicationMemo();
    const misnamed = '018f47d2-6a27-7c23-a49d-6b21bb770231';
    homeserver.files.set(legacyUrl(BUYER, misnamed), record);
    homeserver.files.set(legacyUrl(BUYER, '018f47d2-6a27-7c23-a49d-6b21bb770232'), { garbage: true });
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder()])).resolves.toBe('unavailable');

    expect(homeserver.files.has(legacyUrl(BUYER, misnamed))).toBe(true);
    expect(homeserver.files.has(legacyUrl(BUYER, '018f47d2-6a27-7c23-a49d-6b21bb770232'))).toBe(true);
  });

  it('keeps the plaintext and the sealed entry when the sealed entry opens to an invalid receipt', async () => {
    const record = await publishedRecord();
    CommerceApplication.resetReceiptPublicationMemo();
    sealReceipt(BUYER, RECEIPT_ID, {});
    const sealedBefore = homeserver.files.get(sealedUrl(BUYER, RECEIPT_ID));
    homeserver.files.set(legacyUrl(BUYER, RECEIPT_ID), record);
    homeserver.log.length = 0;
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder()])).resolves.toBe('unavailable');

    expect(homeserver.files.get(legacyUrl(BUYER, RECEIPT_ID))).toEqual(record);
    expect(homeserver.files.get(sealedUrl(BUYER, RECEIPT_ID))).toEqual(sealedBefore);
    expect(writes()).toEqual([]);
  });

  it('keeps both copies when the sealed receipt differs from the plaintext one', async () => {
    const record = await publishedRecord();
    CommerceApplication.resetReceiptPublicationMemo();
    const plaintext = { ...record, revision: 2, updatedAt: '2026-08-20T00:00:00.000Z' };
    homeserver.files.set(legacyUrl(BUYER, RECEIPT_ID), plaintext);
    const sealedBefore = homeserver.files.get(sealedUrl(BUYER, RECEIPT_ID));
    homeserver.log.length = 0;
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder()])).resolves.toBe('unavailable');

    expect(homeserver.files.get(legacyUrl(BUYER, RECEIPT_ID))).toEqual(plaintext);
    expect(homeserver.files.get(sealedUrl(BUYER, RECEIPT_ID))).toEqual(sealedBefore);
    expect(writes()).toEqual([]);
  });

  it('keeps a plaintext receipt of another owner', async () => {
    const record = await publishedRecord();
    CommerceApplication.resetReceiptPublicationMemo();
    homeserver.files.clear();
    homeserver.files.set(legacyUrl(BUYER, RECEIPT_ID), { ...record, ownerPubky: SELLER, role: 'seller' });
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    await expect(CommerceApplication.publishOrderReceipts(BUYER, [])).resolves.toBe('unavailable');

    expect(homeserver.files.has(legacyUrl(BUYER, RECEIPT_ID))).toBe(true);
    expect(homeserver.files.has(sealedUrl(BUYER, RECEIPT_ID))).toBe(false);
  });

  it('logs no receipt id, private path or record content when a move or publication fails', async () => {
    const record = await publishedRecord();
    CommerceApplication.resetReceiptPublicationMemo();
    homeserver.files.clear();
    const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    homeserver.files.set(legacyUrl(BUYER, RECEIPT_ID), record);

    homeserver.failNext(HttpMethod.GET, /\/v1\/receipts\/$/, 500);
    await CommerceApplication.publishOrderReceipts(BUYER, []);
    homeserver.failNext(HttpMethod.GET, legacyUrl(BUYER, RECEIPT_ID), 500);
    await CommerceApplication.publishOrderReceipts(BUYER, []);
    homeserver.failNext(HttpMethod.GET, sealedUrl(BUYER, RECEIPT_ID), 500);
    await CommerceApplication.publishOrderReceipts(BUYER, []);
    homeserver.failNext(HttpMethod.PUT, sealedUrl(BUYER, RECEIPT_ID), 500);
    await CommerceApplication.publishOrderReceipts(BUYER, []);
    homeserver.failNext(HttpMethod.DELETE, legacyUrl(BUYER, RECEIPT_ID), 500);
    await CommerceApplication.publishOrderReceipts(BUYER, []);
    homeserver.files.clear();
    homeserver.failNext(HttpMethod.PUT, sealedUrl(BUYER, RECEIPT_ID), 500);
    await CommerceApplication.publishOrderReceipts(BUYER, [paidOrder()]);

    expect(warn).toHaveBeenCalledTimes(6);
    const logged = JSON.stringify(warn.mock.calls);
    const entry = sealedUrl(BUYER, RECEIPT_ID).split('/');
    for (const secret of [
      RECEIPT_ID,
      ORDER_ID,
      SELLER,
      '/v1/receipts',
      '/v2/s/',
      entry.at(-1),
      entry.at(-2),
      JWS.slice(0, 40),
    ]) {
      expect(logged).not.toContain(secret);
    }
    expect(homeserver.unredacted).toEqual([]);
  });

  it('keeps the plaintext when the sealed write does not read back', async () => {
    const record = await publishedRecord();
    CommerceApplication.resetReceiptPublicationMemo();
    homeserver.files.clear();
    homeserver.files.set(legacyUrl(BUYER, RECEIPT_ID), record);
    homeserver.corruptNextPut(sealedUrl(BUYER, RECEIPT_ID), () => ({ enc: 'pubky-priv-aead/v1' }));
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    await expect(CommerceApplication.publishOrderReceipts(BUYER, [])).resolves.toBe('unavailable');

    expect(homeserver.files.has(legacyUrl(BUYER, RECEIPT_ID))).toBe(true);
  });

  it('reports needs_reauth when listing plaintext receipts is refused', async () => {
    grantCapableSession();
    homeserver.failNext(HttpMethod.GET, /\/v1\/receipts\/$/, 403);

    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder()])).resolves.toBe('needs_reauth');
    expect(writes()).toEqual([]);
  });

  it('never overwrites a sealed receipt it cannot open', async () => {
    const record = await publishedRecord();
    CommerceApplication.resetReceiptPublicationMemo();
    const envelope = homeserver.files.get(sealedUrl(BUYER, RECEIPT_ID)) as { ct: string };
    const ct = base64UrlToBytes(envelope.ct);
    ct[0] ^= 1;
    const tampered = { ...envelope, ct: bytesToBase64Url(ct) };
    homeserver.files.set(sealedUrl(BUYER, RECEIPT_ID), tampered);
    homeserver.files.set(legacyUrl(BUYER, RECEIPT_ID), record);
    homeserver.log.length = 0;
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder()])).resolves.toBe('unavailable');

    expect(homeserver.files.get(sealedUrl(BUYER, RECEIPT_ID))).toEqual(tampered);
    expect(homeserver.files.has(legacyUrl(BUYER, RECEIPT_ID))).toBe(true);
    expect(homeserver.log.filter((entry) => entry.startsWith('PUT '))).toEqual([]);
  });

  it('never writes the plaintext v1 receipt path', async () => {
    const putJson = vi.spyOn(CommerceHomeserverService, 'putJson');
    await publishedRecord();

    expect(putJson).not.toHaveBeenCalled();
    expect(homeserver.log.some((entry) => entry.startsWith('PUT ') && entry.includes('/v1/receipts/'))).toBe(false);
  });
});

describe('CommerceApplication.publishOrderReceipts publication status (step-up Option C)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    CommerceApplication.resetReceiptPublicationMemo();
  });

  it('reports needs_reauth from session facts alone under the narrow bridged grant — no probing, no silent return', async () => {
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(true);
    vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(false);

    await expect(
      CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770210')]),
    ).resolves.toBe('needs_reauth');
    expect(homeserver.log).toEqual([]);
  });

  it('reports skipped for non-durable modes and signed-out sessions', async () => {
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    await expect(
      CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770211')]),
    ).resolves.toBe('skipped');

    vi.mocked(commerceConfig.getCommerceAdapterMode).mockReturnValue('transaction-service');
    vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(false);
    await expect(
      CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770211')]),
    ).resolves.toBe('skipped');
  });

  it('transitions needs_reauth → published when the session is widened by re-approval', async () => {
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
    vi.spyOn(HomeserverService, 'hasActiveSession').mockReturnValue(true);
    const canWrite = vi.spyOn(HomeserverService, 'canCurrentSessionWrite').mockReturnValue(false);
    const receiptId = '018f47d2-6a27-7c23-a49d-6b21bb770212';

    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder(receiptId)])).resolves.toBe('needs_reauth');

    // The step-up re-approval replaced the cookie with the superset grant.
    canWrite.mockReturnValue(true);
    vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation').mockResolvedValue(attestation());

    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder(receiptId)])).resolves.toBe('published');
    expect(homeserver.files.has(sealedUrl(BUYER, receiptId))).toBe(true);
  });

  it("does not count another receipt's valid record, sealed at this receipt's entry, as published", async () => {
    const record = await publishedRecord();
    CommerceApplication.resetReceiptPublicationMemo();
    sealReceipt(BUYER, OTHER_RECEIPT, record);
    const sealedBefore = homeserver.files.get(sealedUrl(BUYER, OTHER_RECEIPT));
    homeserver.log.length = 0;
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder(OTHER_RECEIPT)])).resolves.toBe(
      'unavailable',
    );

    expect(homeserver.files.get(sealedUrl(BUYER, OTHER_RECEIPT))).toEqual(sealedBefore);
    expect(writes()).toEqual([]);
  });

  it('reports published when every eligible receipt is already sealed on the homeserver', async () => {
    await publishedRecord();
    CommerceApplication.resetReceiptPublicationMemo();

    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder()])).resolves.toBe('published');
  });

  it('re-reads a published receipt after clearMarketplaceSession instead of trusting the memo', async () => {
    grantCapableSession();
    vi.spyOn(MarketplaceSessionService, 'clearSession').mockImplementation(() => {});
    const receiptId = RECEIPT_ID;
    sealReceipt(BUYER, receiptId, await publishedRecord());
    CommerceApplication.resetReceiptPublicationMemo();
    homeserver.log.length = 0;
    const reads = () => homeserver.log.filter((entry) => entry === `GET ${sealedUrl(BUYER, receiptId)}`).length;

    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder(receiptId)])).resolves.toBe('published');
    expect(reads()).toBe(1);

    // Memo hit: a second pass in the same session does not re-read.
    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder(receiptId)])).resolves.toBe('published');
    expect(reads()).toBe(1);

    // Sign-out / account-switch teardown drops the memo alongside the bearer,
    // so the next session confirms publication from the homeserver itself.
    CommerceApplication.clearMarketplaceSession();
    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder(receiptId)])).resolves.toBe('published');
    expect(reads()).toBe(2);
  });

  it('a grant session refused with 403 reports unavailable, not a step-up', async () => {
    grantCapableSession();
    vi.spyOn(HomeserverService, 'isCurrentSessionGrant').mockReturnValue(true);
    const receiptId = '018f47d2-6a27-7c23-a49d-6b21bb770219';
    homeserver.failNext(HttpMethod.GET, sealedUrl(BUYER, receiptId), 403);
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder(receiptId)])).resolves.toBe('unavailable');
  });

  it('reports needs_reauth when the private read is refused with 403 mid-pass', async () => {
    grantCapableSession();
    const receiptId = '018f47d2-6a27-7c23-a49d-6b21bb770214';
    homeserver.failNext(HttpMethod.GET, sealedUrl(BUYER, receiptId), 403);

    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder(receiptId)])).resolves.toBe('needs_reauth');
  });

  it('reports unavailable when the deployment issues no attestations', async () => {
    grantCapableSession();
    vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation').mockResolvedValue(null);

    await expect(
      CommerceApplication.publishOrderReceipts(BUYER, [paidOrder('018f47d2-6a27-7c23-a49d-6b21bb770215')]),
    ).resolves.toBe('unavailable');
  });

  it('reports unavailable when a receipt write fails transiently (it retries on the next load)', async () => {
    grantCapableSession();
    const receiptId = '018f47d2-6a27-7c23-a49d-6b21bb770216';
    vi.spyOn(MarketplaceGatewayService, 'getReceiptAttestation').mockResolvedValue(attestation());
    homeserver.failNext(HttpMethod.PUT, sealedUrl(BUYER, receiptId), 500);
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    await expect(CommerceApplication.publishOrderReceipts(BUYER, [paidOrder(receiptId)])).resolves.toBe('unavailable');
  });
});

describe('CommerceApplication.publishOrderReceipts when the marketplace session is replaced mid-pass', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    CommerceApplication.resetReceiptPublicationMemo();
  });

  const realSealed = (receiptId: string) => {
    const real = releasedKeyring(BUYER);
    const url = privEntryUrl(real, 'order_receipt', receiptId);
    if (!homeserver.files.has(url)) return null;
    return decryptPrivRecord({
      keyring: real,
      family: 'order_receipt',
      name: privEntryName(real, 'order_receipt', receiptId),
      envelope: homeserver.files.get(url),
    });
  };

  it('never seals, places or deletes anything under revoked keys while moving or publishing', async () => {
    const record = await publishedRecord();
    vi.mocked(CommercePrivKeyringApplication.get).mockRestore();
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const flow = async (orders: never[]) => {
      CommerceApplication.resetReceiptPublicationMemo();
      return await CommerceApplication.publishOrderReceipts(BUYER, orders);
    };

    const moving = await expectSafeAtEverySessionReplacement({
      homeserver,
      ownerPubky: BUYER,
      otherPubky: SELLER,
      plant: () => {
        homeserver.files.set(legacyUrl(BUYER, RECEIPT_ID), record);
      },
      flow: () => flow([]),
      check: () => {
        if (!homeserver.files.has(legacyUrl(BUYER, RECEIPT_ID))) expect(realSealed(RECEIPT_ID)).toEqual(record);
      },
    });
    const publishing = await expectSafeAtEverySessionReplacement({
      homeserver,
      ownerPubky: BUYER,
      otherPubky: SELLER,
      plant: () => {},
      flow: () => flow([paidOrder()]),
      check: () => {
        const sealed = realSealed(RECEIPT_ID);
        if (sealed !== null) expect(sealed).toEqual(record);
      },
    });
    expect(moving).toBeGreaterThanOrEqual(5);
    expect(publishing).toBeGreaterThanOrEqual(3);
  });

  it.each(['write', 'read'] as const)(
    'keeps the plaintext receipt when the session is replaced after the sealed %s resolves and before it is deleted',
    async (step) => {
      const record = await publishedRecord();
      vi.mocked(CommercePrivKeyringApplication.get).mockRestore();
      vi.spyOn(MarketplaceGatewayService, 'getPrivKeys').mockImplementation(async (owner: string) => ({
        kind: 'keys',
        keyring: releasedKeyring(owner),
      }));
      vi.spyOn(Logger, 'warn').mockImplementation(() => {});
      CommerceApplication.resetReceiptPublicationMemo();
      homeserver.files.clear();
      CommercePrivKeyringApplication.clear();
      establishMarketplaceSession(BUYER);
      homeserver.files.set(legacyUrl(BUYER, RECEIPT_ID), record);
      if (step === 'read') {
        const real = releasedKeyring(BUYER);
        homeserver.files.set(
          privEntryUrl(real, 'order_receipt', RECEIPT_ID),
          encryptPrivRecord({
            keyring: real,
            family: 'order_receipt',
            name: privEntryName(real, 'order_receipt', RECEIPT_ID),
            record,
          }),
        );
      }
      const original = CommercePrivStoreService[step].bind(CommercePrivStoreService) as (
        ...args: unknown[]
      ) => Promise<unknown>;
      vi.spyOn(CommercePrivStoreService, step).mockImplementation((async (...args: unknown[]) => {
        const result = await original(...args);
        establishMarketplaceSession(BUYER);
        return result;
      }) as never);
      homeserver.log.length = 0;

      await expect(CommerceApplication.publishOrderReceipts(BUYER, [])).resolves.toBe('unavailable');

      expect(homeserver.files.get(legacyUrl(BUYER, RECEIPT_ID))).toEqual(record);
      expect(homeserver.log.some((entry) => entry.startsWith('DELETE '))).toBe(false);
      MarketplaceSessionService.clearSession();
      CommercePrivKeyringApplication.clear();
    },
  );

  it.each(['moving', 'publishing'] as const)(
    'stops the whole pass, without trying the next receipt, once the keyring is revoked while %s',
    async (pass) => {
      const record = await publishedRecord();
      CommerceApplication.resetReceiptPublicationMemo();
      homeserver.files.clear();
      const held = keyringFor(BUYER);
      vi.mocked(CommercePrivKeyringApplication.get).mockResolvedValue({ kind: 'keys', keyring: held });
      const fetchAttestation = vi.mocked(MarketplaceGatewayService.getReceiptAttestation);
      fetchAttestation.mockClear();
      const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
      if (pass === 'moving') {
        homeserver.files.set(legacyUrl(BUYER, RECEIPT_ID), record);
        homeserver.files.set(legacyUrl(BUYER, OTHER_RECEIPT), { ...record, receiptId: OTHER_RECEIPT });
      } else {
        sealReceipt(BUYER, RECEIPT_ID, record);
      }
      const firstRead =
        pass === 'moving' ? `GET ${legacyUrl(BUYER, RECEIPT_ID)}` : `GET ${sealedUrl(BUYER, RECEIPT_ID)}`;
      homeserver.onRequest = ({ entry, phase }) => {
        if (phase === 'after' && entry === firstRead) revokePrivKeyring(held);
      };
      homeserver.log.length = 0;

      const orders = pass === 'moving' ? [] : [paidOrder(RECEIPT_ID), paidOrder(OTHER_RECEIPT)];
      await expect(CommerceApplication.publishOrderReceipts(BUYER, orders)).resolves.toBe('unavailable');

      homeserver.onRequest = null;
      expect(homeserver.log).toEqual([expect.stringMatching(/^LIST /), firstRead]);
      expect(fetchAttestation).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      if (pass === 'moving') {
        expect(homeserver.files.get(legacyUrl(BUYER, RECEIPT_ID))).toEqual(record);
        expect(homeserver.files.has(legacyUrl(BUYER, OTHER_RECEIPT))).toBe(true);
      }
    },
  );
});
