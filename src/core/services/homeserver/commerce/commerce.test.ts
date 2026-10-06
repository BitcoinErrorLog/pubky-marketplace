import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpMethod } from '@/libs/http/http.types';
import { HomeserverService } from '@/services/homeserver/homeserver';
import { CommerceHomeserverService } from './commerce';

const URL = `pubky://${'y'.repeat(52)}/pub/pubky.app/marketplace/v1/listings/boots_01`;

describe('CommerceHomeserverService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches public JSON through the shared Pubky homeserver service', async () => {
    const response = { recordType: 'listing' };
    const request = vi.spyOn(HomeserverService, 'request').mockResolvedValue(response);

    await expect(CommerceHomeserverService.fetchJson(URL)).resolves.toEqual(response);
    expect(request).toHaveBeenCalledWith({ method: HttpMethod.GET, url: URL });
  });

  it('writes public JSON through the authenticated owner path', async () => {
    const request = vi.spyOn(HomeserverService, 'request').mockResolvedValue(undefined);
    const bodyJson = { recordType: 'listing' };

    await CommerceHomeserverService.putJson(URL, bodyJson);

    expect(request).toHaveBeenCalledWith({ method: HttpMethod.PUT, url: URL, bodyJson });
  });

  it('writes media bytes through the shared binary upload boundary', async () => {
    const putBlob = vi.spyOn(HomeserverService, 'putBlob').mockResolvedValue(undefined);
    const bytes = new Uint8Array([1, 2, 3]);

    await CommerceHomeserverService.putMedia(URL, bytes);

    expect(putBlob).toHaveBeenCalledWith({ url: URL, blob: bytes });
  });

  it('writes and deletes digital deliverables with the redacted log path', async () => {
    const deliverable = `pubky://${'y'.repeat(52)}/pub/pubky.app/marketplace/v1/deliverables/${'a'.repeat(32)}/2`;
    const putBlob = vi.spyOn(HomeserverService, 'putBlob').mockResolvedValue(undefined);
    const request = vi.spyOn(HomeserverService, 'request').mockResolvedValue(undefined);
    const bytes = new Uint8Array([1, 2, 3]);

    await CommerceHomeserverService.putDeliverable(deliverable, bytes);
    await CommerceHomeserverService.deleteDeliverable(deliverable);

    const logUrl = '/pub/pubky.app/marketplace/v1/deliverables/<deliverable>';
    expect(putBlob).toHaveBeenCalledWith({ url: deliverable, blob: bytes, logUrl });
    expect(request).toHaveBeenCalledWith({ method: HttpMethod.DELETE, url: deliverable, logUrl });
  });

  it('reads a digital deliverable with the redacted log path', async () => {
    const deliverable = `pubky://${'y'.repeat(52)}/pub/pubky.app/marketplace/v1/deliverables/${'a'.repeat(32)}/2`;
    const bytes = new Uint8Array([4, 5, 6]);
    const getBlob = vi.spyOn(HomeserverService, 'getBlob').mockResolvedValue(bytes);

    await expect(CommerceHomeserverService.getDeliverable(deliverable, 19)).resolves.toBe(bytes);
    expect(getBlob).toHaveBeenCalledWith({
      url: deliverable,
      logUrl: '/pub/pubky.app/marketplace/v1/deliverables/<deliverable>',
      maxBytes: 19,
    });
  });

  it('deletes only through the authenticated homeserver request boundary', async () => {
    const request = vi.spyOn(HomeserverService, 'request').mockResolvedValue(undefined);

    await CommerceHomeserverService.delete(URL);

    expect(request).toHaveBeenCalledWith({ method: HttpMethod.DELETE, url: URL });
  });
});
