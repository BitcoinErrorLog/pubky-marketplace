import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchOgMediaAsDataUri } from './ogCommerceData';

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
const sellerMediaUri = `pubky://${seller}/pub/pubky.app/marketplace/v1/media/b313eeca407a42408e81d3e12d267fe5`;
const resolvedUrl = `https://_pubky.${seller}/pub/pubky.app/marketplace/v1/media/b313eeca407a42408e81d3e12d267fe5`;

describe('fetchOgMediaAsDataUri', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    resolvePubkyMock.mockClear();
  });

  it('fetches pubky media from the PKARR-resolved seller homeserver', async () => {
    const png = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 0, b: 0 } },
    })
      .png()
      .toBuffer();
    resolvePubkyMock.mockReturnValue(resolvedUrl);
    fetchMock.mockResolvedValue(
      new Response(new Uint8Array(png), { status: 200, headers: { 'Content-Type': 'image/png' } }),
    );

    await expect(fetchOgMediaAsDataUri(sellerMediaUri)).resolves.toMatch(/^data:image\/png;base64,/);
    expect(resolvePubkyMock).toHaveBeenCalledWith(sellerMediaUri);
    expect(fetchMock).toHaveBeenCalledWith(
      resolvedUrl,
      expect.objectContaining({ credentials: 'include', signal: expect.any(AbortSignal) }),
    );
  });

  it('returns null when the PKARR-resolved media fetch is not found', async () => {
    resolvePubkyMock.mockReturnValue(resolvedUrl);
    fetchMock.mockResolvedValue(new Response('Not Found', { status: 404 }));

    await expect(fetchOgMediaAsDataUri(sellerMediaUri)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(resolvedUrl, expect.any(Object));
  });

  it.each([
    'ftp://example.com/image.png',
    'not-a-media-uri',
    'pubky://not-z32/pub/pubky.app/marketplace/v1/media/image',
  ])('rejects malformed media URI %s without fetching', async (uri) => {
    await expect(fetchOgMediaAsDataUri(uri)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(resolvePubkyMock).not.toHaveBeenCalled();
  });
});
