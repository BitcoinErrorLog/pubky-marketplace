import crypto from 'node:crypto';
import { listingUriBuilder } from 'pubky-app-specs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import type { CommerceReviewModelSchema } from '@/models/commerce/commerce.schema';
import { CommerceHomeserverService } from '@/services/homeserver/commerce/commerce';
import { LocalCommerceService } from '@/services/local/commerce/commerce';
import { MarketplaceGatewayService } from '@/services/marketplace/marketplace';
import { useAuthStore } from '@/stores/auth/auth.store';
import { createOrderFixture, ORDER_FIXTURE_BUYER, ORDER_FIXTURE_SELLER } from '@/test/fixtures/commerce/orders';
import { CommerceApplication } from './commerce';

const FOREIGN_PUBKY = 'z'.repeat(52);

const Z_ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769';
function zbase32(bytes: Uint8Array): string {
  let bits = 0;
  let accumulator = 0;
  let out = '';
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += Z_ALPHABET[(accumulator >> bits) & 31];
    }
  }
  if (bits > 0) out += Z_ALPHABET[(accumulator << (5 - bits)) & 31];
  return out;
}
const b64u = (input: Uint8Array | string): string => Buffer.from(input).toString('base64url');

/** A real EdDSA attestation, camelCased the way the wire boundary delivers it. */
function issuedAttestation(listingId: string) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const iss = zbase32(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32));
  const jwsClaims = {
    v: 1,
    iss,
    sub: ORDER_FIXTURE_BUYER,
    cpk: ORDER_FIXTURE_SELLER,
    role: 'buyer_reviewing_seller',
    listing: listingUriBuilder(ORDER_FIXTURE_SELLER, listingId),
    order_ref: 'cd'.repeat(32),
    completed_on: '2026-08-21',
    iat: 1_787_654_321,
  };
  const header = { alg: 'EdDSA', typ: 'pubky-purchase-attestation+v1' };
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(jwsClaims))}`;
  const jws = `${signingInput}.${b64u(crypto.sign(null, Buffer.from(signingInput), privateKey))}`;
  return {
    iss,
    jws,
    wire: {
      jws,
      claims: {
        v: 1,
        iss,
        sub: ORDER_FIXTURE_BUYER,
        cpk: ORDER_FIXTURE_SELLER,
        role: 'buyer_reviewing_seller',
        listing: jwsClaims.listing,
        orderRef: jwsClaims.order_ref,
        completedOn: jwsClaims.completed_on,
        iat: jwsClaims.iat,
      },
    },
  };
}

function reviewResult(attestation: unknown) {
  return {
    kind: 'review',
    review: {
      reviewerPubky: ORDER_FIXTURE_BUYER,
      reviewerRole: 'buyer',
      subjectPubky: ORDER_FIXTURE_SELLER,
      rating: 5,
      text: 'Accurate and fast.',
      createdAt: '2026-08-21T10:00:00.000Z',
      updatedAt: '2026-08-21T10:00:00.000Z',
    },
    ...(attestation === null ? {} : { attestation }),
  };
}

describe('CommerceApplication own-review publication', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes the reviewer-owned record with the attestation embedded verbatim', async () => {
    const { iss, jws, wire } = issuedAttestation('boots');
    const order = createOrderFixture('completed');
    vi.spyOn(LocalCommerceService, 'getOwnReviewById').mockResolvedValue(undefined);
    const stage = vi.spyOn(LocalCommerceService, 'stageOwnReviewSync').mockResolvedValue(undefined);
    const upsert = vi.spyOn(LocalCommerceService, 'upsertOwnReview').mockResolvedValue(undefined);
    const complete = vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);
    const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);

    const published = await CommerceApplication.commitPublishOwnReview({
      actorPubky: ORDER_FIXTURE_BUYER,
      order,
      result: reviewResult(wire),
    });

    expect(published).not.toBeNull();
    const record = published!.record;
    expect(record.eligibilityAttestation).toBe(jws);
    expect(record.ownerPubky).toBe(ORDER_FIXTURE_BUYER);
    expect(record.subjectPubky).toBe(ORDER_FIXTURE_SELLER);
    expect(record.listingOwnerPubky).toBe(ORDER_FIXTURE_SELLER);
    expect(record.listingId).toBe('boots');
    expect(record.role).toBe('buyer_reviewing_seller');
    expect(record.revision).toBe(1);
    // The offline verification recipe ran and pinned the issuer.
    expect(published!.attestation_verified).toBe(true);
    expect(published!.attestation_iss).toBe(iss);
    expect(published!.sync_status).toBe('synced');

    // The record went to the reviewer's homeserver at the canonical path.
    expect(put).toHaveBeenCalledWith(
      `pubky://${ORDER_FIXTURE_BUYER}/pub/pubky.app/marketplace/v1/reviews/${published!.review_id}`,
      expect.objectContaining({ eligibilityAttestation: jws }),
    );
    expect(stage).toHaveBeenCalledOnce();
    expect(upsert).toHaveBeenCalledOnce();
    expect(complete).toHaveBeenCalledOnce();
  });

  it('publishes nothing when the deployment issued no attestation (honest absence)', async () => {
    const order = createOrderFixture('completed');
    const put = vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);

    const published = await CommerceApplication.commitPublishOwnReview({
      actorPubky: ORDER_FIXTURE_BUYER,
      order,
      result: reviewResult(null),
    });

    expect(published).toBeNull();
    expect(put).not.toHaveBeenCalled();
  });

  it('revises the living record on republication instead of forking it', async () => {
    const { wire } = issuedAttestation('boots');
    const order = createOrderFixture('completed');
    vi.spyOn(LocalCommerceService, 'stageOwnReviewSync').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'upsertOwnReview').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);
    vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);

    // First publication resolves the deterministic id; the second finds the
    // prior row and must bump the revision while keeping createdAt.
    vi.spyOn(LocalCommerceService, 'getOwnReviewById').mockResolvedValueOnce(undefined);
    const first = await CommerceApplication.commitPublishOwnReview({
      actorPubky: ORDER_FIXTURE_BUYER,
      order,
      result: reviewResult(wire),
    });
    vi.spyOn(LocalCommerceService, 'getOwnReviewById').mockResolvedValue(first!);

    const second = await CommerceApplication.commitPublishOwnReview({
      actorPubky: ORDER_FIXTURE_BUYER,
      order,
      result: reviewResult(wire),
    });
    expect(second!.review_id).toBe(first!.review_id);
    expect(second!.record.revision).toBe(2);
    expect(second!.record.createdAt).toBe(first!.record.createdAt);
  });

  it('leaves the staged row pending when the homeserver PUT fails, and the resume retries it', async () => {
    const { wire } = issuedAttestation('boots');
    const order = createOrderFixture('completed');
    vi.spyOn(LocalCommerceService, 'getOwnReviewById').mockResolvedValue(undefined);
    const stage = vi.spyOn(LocalCommerceService, 'stageOwnReviewSync').mockResolvedValue(undefined);
    const upsert = vi.spyOn(LocalCommerceService, 'upsertOwnReview').mockResolvedValue(undefined);
    vi.spyOn(CommerceHomeserverService, 'putJson').mockRejectedValue(new TypeError('network unavailable'));

    await expect(
      CommerceApplication.commitPublishOwnReview({
        actorPubky: ORDER_FIXTURE_BUYER,
        order,
        result: reviewResult(wire),
      }),
    ).rejects.toThrow();
    expect(stage).toHaveBeenCalledOnce();
    expect(upsert).not.toHaveBeenCalled();
    const staged = stage.mock.calls[0][0] as CommerceReviewModelSchema;
    expect(staged.sync_status).toBe('pending');

    // The retry path re-puts the staged record verbatim and marks it synced.
    vi.spyOn(LocalCommerceService, 'getPendingOwnReviews').mockResolvedValue([staged]);
    const retryPut = vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
    const retried = await CommerceApplication.resumeOwnReviewPublications(ORDER_FIXTURE_BUYER);
    expect(retried).toBe(1);
    expect(retryPut).toHaveBeenCalledWith(
      `pubky://${ORDER_FIXTURE_BUYER}/pub/pubky.app/marketplace/v1/reviews/${staged.review_id}`,
      expect.objectContaining({ eligibilityAttestation: staged.record.eligibilityAttestation }),
    );
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ sync_status: 'synced' }));
  });

  it('reads the seller band consent through the gateway', async () => {
    const gateway = vi.spyOn(MarketplaceGatewayService, 'getBandConsent').mockResolvedValue(true);
    await expect(
      CommerceApplication.getMarketplaceBandConsent(ORDER_FIXTURE_BUYER, ORDER_FIXTURE_SELLER),
    ).resolves.toBe(true);
    expect(gateway).toHaveBeenCalledWith(ORDER_FIXTURE_BUYER, ORDER_FIXTURE_SELLER);
  });
});

describe('CommerceApplication own-review hydrate after local miss', () => {
  beforeEach(() => {
    useAuthStore.getState().setCurrentUserPubky(ORDER_FIXTURE_BUYER);
    CommerceApplication.resetOwnReviewHydrateMemo();
  });

  afterEach(() => {
    CommerceApplication.resetOwnReviewHydrateMemo();
    useAuthStore.getState().setCurrentUserPubky(null);
    vi.restoreAllMocks();
  });

  async function publishedOwnReview() {
    const { iss, wire } = issuedAttestation('boots');
    const order = createOrderFixture('completed');
    vi.spyOn(LocalCommerceService, 'getOwnReviewById').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'stageOwnReviewSync').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'upsertOwnReview').mockResolvedValue(undefined);
    vi.spyOn(LocalCommerceService, 'completeSyncJob').mockResolvedValue(undefined);
    vi.spyOn(CommerceHomeserverService, 'putJson').mockResolvedValue(undefined);
    const published = await CommerceApplication.commitPublishOwnReview({
      actorPubky: ORDER_FIXTURE_BUYER,
      order,
      result: reviewResult(wire),
    });
    return { iss, order, published: published! };
  }

  it('hydrates the homeserver record when the local row is gone', async () => {
    const { iss, order, published } = await publishedOwnReview();
    vi.spyOn(LocalCommerceService, 'getOwnReviewByOrder').mockResolvedValue(undefined);
    const fetch = vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue(published.record);
    const upsert = vi.spyOn(LocalCommerceService, 'upsertOwnReview').mockResolvedValue(undefined);
    upsert.mockClear();

    const hydrated = await CommerceApplication.getOwnMarketplaceReview(ORDER_FIXTURE_BUYER, order);

    expect(hydrated).not.toBeNull();
    expect(hydrated!.review_id).toBe(published.review_id);
    expect(hydrated!.order_id).toBe(order.id);
    expect(hydrated!.sync_status).toBe('synced');
    expect(hydrated!.attestation_verified).toBe(true);
    expect(hydrated!.attestation_iss).toBe(iss);
    expect(fetch).toHaveBeenCalledWith(
      `pubky://${ORDER_FIXTURE_BUYER}/pub/pubky.app/marketplace/v1/reviews/${published.review_id}`,
    );
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({ review_id: published.review_id, sync_status: 'synced' }),
    );
  });

  it('does not fetch the homeserver when the local row is present', async () => {
    const { order, published } = await publishedOwnReview();
    vi.spyOn(LocalCommerceService, 'getOwnReviewByOrder').mockResolvedValue(published);
    const fetch = vi.spyOn(CommerceHomeserverService, 'fetchJson');

    await expect(CommerceApplication.getOwnMarketplaceReview(ORDER_FIXTURE_BUYER, order)).resolves.toBe(published);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('stays unresolved on a homeserver 404 instead of claiming unpublished', async () => {
    const { order } = await publishedOwnReview();
    vi.spyOn(LocalCommerceService, 'getOwnReviewByOrder').mockResolvedValue(undefined);
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockRejectedValue(
      new AppError({
        category: ErrorCategory.Client,
        code: ClientErrorCode.NOT_FOUND,
        message: 'HTTP 404',
        service: ErrorService.Homeserver,
        operation: 'fetchJson',
        context: { statusCode: 404 },
      }),
    );
    const upsert = vi.spyOn(LocalCommerceService, 'upsertOwnReview');
    upsert.mockClear();

    await expect(CommerceApplication.getOwnMarketplaceReview(ORDER_FIXTURE_BUYER, order)).resolves.toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it('does not re-GET a 404 on remount in the same session', async () => {
    const { order } = await publishedOwnReview();
    vi.spyOn(LocalCommerceService, 'getOwnReviewByOrder').mockResolvedValue(undefined);
    const fetch = vi.spyOn(CommerceHomeserverService, 'fetchJson').mockRejectedValue(
      new AppError({
        category: ErrorCategory.Client,
        code: ClientErrorCode.NOT_FOUND,
        message: 'HTTP 404',
        service: ErrorService.Homeserver,
        operation: 'fetchJson',
        context: { statusCode: 404 },
      }),
    );

    await expect(CommerceApplication.getOwnMarketplaceReview(ORDER_FIXTURE_BUYER, order)).resolves.toBeNull();
    await expect(CommerceApplication.getOwnMarketplaceReview(ORDER_FIXTURE_BUYER, order)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not upsert when the live identity differs from the hydrate actor', async () => {
    const { order, published } = await publishedOwnReview();
    vi.spyOn(LocalCommerceService, 'getOwnReviewByOrder').mockResolvedValue(undefined);
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockImplementation(async () => {
      useAuthStore.getState().setCurrentUserPubky(FOREIGN_PUBKY);
      return published.record;
    });
    const upsert = vi.spyOn(LocalCommerceService, 'upsertOwnReview');
    upsert.mockClear();

    await expect(CommerceApplication.getOwnMarketplaceReview(ORDER_FIXTURE_BUYER, order)).resolves.toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['owner', { ownerPubky: FOREIGN_PUBKY }],
    ['listing', { listingId: 'hats' }],
    ['role', { role: 'seller_reviewing_buyer' as const }],
    ['subject', { subjectPubky: FOREIGN_PUBKY }],
    ['reviewId', { reviewId: 'not-the-path-id' }],
  ])('stays waiting when the homeserver record %s does not match', async (_field, patch) => {
    const { order, published } = await publishedOwnReview();
    vi.spyOn(LocalCommerceService, 'getOwnReviewByOrder').mockResolvedValue(undefined);
    vi.spyOn(CommerceHomeserverService, 'fetchJson').mockResolvedValue({ ...published.record, ...patch });
    const upsert = vi.spyOn(LocalCommerceService, 'upsertOwnReview');
    upsert.mockClear();

    await expect(CommerceApplication.getOwnMarketplaceReview(ORDER_FIXTURE_BUYER, order)).resolves.toBeNull();
    expect(upsert).not.toHaveBeenCalled();
  });
});
