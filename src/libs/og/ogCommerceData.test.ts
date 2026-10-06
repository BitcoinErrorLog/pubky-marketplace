import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommerceListingFixture } from '@/test/fixtures/commerce/commerce';
import { fetchListingForMetadata } from './ogCommerceData';

const { fetchMock, resolvePubkyMock } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  resolvePubkyMock: vi.fn((url: string) => `https://resolved.example/${url}`),
}));

vi.mock('@synonymdev/pubky', () => ({
  Client: class {
    fetch = fetchMock;
  },
  resolvePubky: resolvePubkyMock,
}));

const seller = '8mmmaouyode95qf7scbt4moytceiga4we5i3fwra71xapmwguwdy';

describe('fetchListingForMetadata', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    resolvePubkyMock.mockClear();
  });

  it.each(['aa540efdabb144c0babc304c5d19f1d3', '0035KEX9KTD20'])(
    'resolves production listing id shape %s through the seller homeserver',
    async (listingId) => {
      const fixture = createCommerceListingFixture({ ownerPubky: seller, listingId });
      fixture.media = fixture.media.map((media) => ({
        ...media,
        url: media.url.replace('y'.repeat(52), seller),
      }));
      fetchMock.mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));

      await expect(fetchListingForMetadata(seller, listingId)).resolves.toMatchObject({
        kind: 'found',
        record: { listingId },
      });
      expect(resolvePubkyMock).toHaveBeenCalledWith(
        `pubky://${seller}/pub/pubky.app/marketplace/v1/listings/${listingId}`,
      );
    },
  );

  it('returns unavailable on a record validation failure instead of not-found', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ recordType: 'listing', listingId: 'broken' }), { status: 200 }),
    );

    await expect(fetchListingForMetadata(seller, 'broken')).resolves.toEqual({
      kind: 'unavailable',
      reason: 'validation',
    });
  });

  it('uses the generic card cue only for a genuine not-found response', async () => {
    fetchMock.mockResolvedValue(new Response('Not Found', { status: 404 }));

    await expect(fetchListingForMetadata(seller, 'missing')).resolves.toEqual({ kind: 'not_found' });
  });

  it('returns unavailable for a seller homeserver 5xx response', async () => {
    fetchMock.mockResolvedValue(new Response('upstream failure', { status: 503 }));

    await expect(fetchListingForMetadata(seller, 'server-error')).resolves.toEqual({
      kind: 'unavailable',
      reason: 'http_503',
    });
  });

  it('returns unavailable when a successful response is not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));

    await expect(fetchListingForMetadata(seller, 'not-json')).resolves.toMatchObject({
      kind: 'unavailable',
      reason: expect.any(String),
    });
  });

  it('returns unavailable on a transient timeout instead of not-found', async () => {
    fetchMock.mockRejectedValue(new DOMException('The operation timed out', 'TimeoutError'));

    await expect(fetchListingForMetadata(seller, 'slow')).resolves.toEqual({
      kind: 'unavailable',
      reason: 'timeout',
    });
  });

  it('returns not-found for a removed listing', async () => {
    const fixture = createCommerceListingFixture({ ownerPubky: seller, state: 'removed' });
    fixture.media = fixture.media.map((media) => ({
      ...media,
      url: media.url.replace('y'.repeat(52), seller),
    }));
    fetchMock.mockResolvedValue(new Response(JSON.stringify(fixture), { status: 200 }));

    await expect(fetchListingForMetadata(seller, fixture.listingId)).resolves.toEqual({ kind: 'not_found' });
  });
});
