import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceMediaService } from '@/core/services/commerce/marketplace-media';
import {
  clearMarketplaceMediaCache,
  resolveMarketplaceMediaUrlAsync,
  useMarketplaceMediaUrl,
} from './useMarketplaceMediaUrl';

vi.mock('@/core/services/commerce/marketplace-media', () => ({
  MarketplaceMediaService: {
    getOwnerHomeserver: vi.fn(),
    fetchMedia: vi.fn(),
  },
}));

vi.mock('@/config/network', () => ({
  getHomeserver: vi.fn(() => 'configured-homeserver'),
  getHomeserverUrl: vi.fn(() => 'https://configured.example'),
}));

const owner = 'y'.repeat(52);
const otherOwner = 'b'.repeat(52);
const mediaUri = `pubky://${owner}/pub/pubky.app/marketplace/v1/media/image`;
const otherMediaUri = `pubky://${otherOwner}/pub/pubky.app/marketplace/v1/media/image`;

describe('marketplace media resolution', () => {
  beforeEach(() => {
    clearMarketplaceMediaCache();
    vi.clearAllMocks();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:marketplace-media');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it('uses the direct URL for an owner on the configured homeserver', async () => {
    vi.mocked(MarketplaceMediaService.getOwnerHomeserver).mockResolvedValue('configured-homeserver');

    await expect(resolveMarketplaceMediaUrlAsync(mediaUri)).resolves.toContain(`pubky-host=${owner}`);
    expect(MarketplaceMediaService.fetchMedia).not.toHaveBeenCalled();
  });

  it('fetches another owner through the SDK and returns an object URL', async () => {
    vi.mocked(MarketplaceMediaService.getOwnerHomeserver).mockResolvedValue('other-homeserver');
    vi.mocked(MarketplaceMediaService.fetchMedia).mockResolvedValue(new Blob(['media']));

    await expect(resolveMarketplaceMediaUrlAsync(otherMediaUri)).resolves.toBe('blob:marketplace-media');
    expect(MarketplaceMediaService.fetchMedia).toHaveBeenCalledTimes(1);
  });

  it('returns null when the owner has no homeserver record', async () => {
    vi.mocked(MarketplaceMediaService.getOwnerHomeserver).mockResolvedValue(null);

    await expect(resolveMarketplaceMediaUrlAsync(otherMediaUri)).resolves.toBeNull();
  });

  it('re-resolves a missing owner after the negative owner-cache TTL but keeps positive entries', async () => {
    vi.useFakeTimers();
    vi.mocked(MarketplaceMediaService.getOwnerHomeserver)
      .mockResolvedValueOnce(null)
      .mockResolvedValue('configured-homeserver');

    await expect(resolveMarketplaceMediaUrlAsync(otherMediaUri)).resolves.toBeNull();
    vi.advanceTimersByTime(30 * 1000 + 1);
    await expect(resolveMarketplaceMediaUrlAsync(otherMediaUri)).resolves.toContain(`pubky-host=${otherOwner}`);
    expect(MarketplaceMediaService.getOwnerHomeserver).toHaveBeenCalledTimes(2);

    clearMarketplaceMediaCache();
    vi.mocked(MarketplaceMediaService.getOwnerHomeserver).mockResolvedValue('configured-homeserver');
    await resolveMarketplaceMediaUrlAsync(otherMediaUri);
    vi.advanceTimersByTime(30 * 1000 + 1);
    await resolveMarketplaceMediaUrlAsync(otherMediaUri);
    expect(MarketplaceMediaService.getOwnerHomeserver).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('deduplicates concurrent SDK requests', async () => {
    vi.mocked(MarketplaceMediaService.getOwnerHomeserver).mockResolvedValue('other-homeserver');
    vi.mocked(MarketplaceMediaService.fetchMedia).mockResolvedValue(new Blob(['media']));

    await Promise.all([resolveMarketplaceMediaUrlAsync(otherMediaUri), resolveMarketplaceMediaUrlAsync(otherMediaUri)]);
    expect(MarketplaceMediaService.getOwnerHomeserver).toHaveBeenCalledTimes(1);
    expect(MarketplaceMediaService.fetchMedia).toHaveBeenCalledTimes(1);
  });

  it('does not retry failed media fetches during the negative-cache TTL', async () => {
    vi.mocked(MarketplaceMediaService.getOwnerHomeserver).mockResolvedValue('other-homeserver');
    vi.mocked(MarketplaceMediaService.fetchMedia).mockRejectedValue(new Error('fetch failed'));

    await expect(resolveMarketplaceMediaUrlAsync(otherMediaUri)).rejects.toThrow('fetch failed');
    await expect(resolveMarketplaceMediaUrlAsync(otherMediaUri)).resolves.toBeNull();
    expect(MarketplaceMediaService.fetchMedia).toHaveBeenCalledTimes(1);
  });

  it('evicts the oldest owner cache entry at the size limit', async () => {
    vi.mocked(MarketplaceMediaService.getOwnerHomeserver).mockResolvedValue('configured-homeserver');
    const alphabet = 'ybndrfg8ejkmcpqxot1uwisza345h769';

    for (let index = 0; index < 101; index += 1) {
      const currentOwner = `${alphabet[Math.floor(index / alphabet.length)]}${alphabet[index % alphabet.length]}${'y'.repeat(50)}`;
      await resolveMarketplaceMediaUrlAsync(`pubky://${currentOwner}/pub/pubky.app/marketplace/v1/media/image`);
    }

    await resolveMarketplaceMediaUrlAsync(`pubky://${'yy' + 'y'.repeat(50)}/pub/pubky.app/marketplace/v1/media/image`);
    expect(MarketplaceMediaService.getOwnerHomeserver).toHaveBeenCalledTimes(102);
  });

  it('expires cached owner media after the TTL', async () => {
    vi.useFakeTimers();
    vi.mocked(MarketplaceMediaService.getOwnerHomeserver).mockResolvedValue('other-homeserver');
    vi.mocked(MarketplaceMediaService.fetchMedia).mockResolvedValue(new Blob(['media']));

    await resolveMarketplaceMediaUrlAsync(otherMediaUri);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await resolveMarketplaceMediaUrlAsync(otherMediaUri);

    expect(MarketplaceMediaService.fetchMedia).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:marketplace-media');
    vi.useRealTimers();
  });

  it('does not revoke a blob URL while a hook still renders it after the cache TTL', async () => {
    vi.mocked(MarketplaceMediaService.getOwnerHomeserver).mockResolvedValue('other-homeserver');
    vi.mocked(MarketplaceMediaService.fetchMedia).mockResolvedValue(new Blob(['media']));

    const { result, unmount } = renderHook(() => useMarketplaceMediaUrl(otherMediaUri));
    await waitFor(() => expect(result.current).toBe('blob:marketplace-media'));

    vi.useFakeTimers();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(result.current).toBe('blob:marketplace-media');

    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:marketplace-media');
    vi.useRealTimers();
  });

  it('revokes the previous blob URL only after the hook replaces or unmounts it and the cache no longer holds it', async () => {
    let blobSeq = 0;
    vi.mocked(URL.createObjectURL).mockImplementation(() => `blob:marketplace-media-${++blobSeq}`);
    vi.mocked(MarketplaceMediaService.getOwnerHomeserver).mockResolvedValue('other-homeserver');
    vi.mocked(MarketplaceMediaService.fetchMedia).mockResolvedValue(new Blob(['media']));

    const replacementUri = `pubky://${otherOwner}/pub/pubky.app/marketplace/v1/media/other`;
    const { result, rerender, unmount } = renderHook(({ uri }: { uri: string }) => useMarketplaceMediaUrl(uri), {
      initialProps: { uri: otherMediaUri },
    });
    await waitFor(() => expect(result.current).toBe('blob:marketplace-media-1'));

    rerender({ uri: replacementUri });
    await waitFor(() => expect(result.current).toBe('blob:marketplace-media-2'));
    // The previous URL remains cached until TTL, so replacing the rendered URI
    // must not revoke it while another resolve could still reuse the cache.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    vi.useFakeTimers();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    await resolveMarketplaceMediaUrlAsync(otherMediaUri);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:marketplace-media-1');
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith('blob:marketplace-media-2');

    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:marketplace-media-2');
    vi.useRealTimers();
  });
});
