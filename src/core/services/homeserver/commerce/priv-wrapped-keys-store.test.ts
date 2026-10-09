import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRIV_DEK_WRAP_ENC, type PrivWrappedKeyEnvelope } from '@/libs/commerce/priv-key-wrap';
import { AppError } from '@/libs/error/error';
import { HttpMethod } from '@/libs/http/http.types';
import { HomeserverService } from '@/services/homeserver/homeserver';
import { CommercePrivWrappedKeysStoreService } from './priv-wrapped-keys-store';

const OWNER = 'o'.repeat(52);
const KEY_A = '0123456789abcdef0123456789abcdef';
const KEY_B = 'fedcba9876543210fedcba9876543210';
const DIRECTORY = `pubky://${OWNER}/priv/pubky.app/marketplace/v2/keys/`;
const REDACTED_LOG_PATH = '/priv/pubky.app/marketplace/v2/keys/<key>.json';

const envelope = (kid: string): PrivWrappedKeyEnvelope => ({
  enc: PRIV_DEK_WRAP_ENC,
  kid,
  nonce: 'bm9uY2U',
  ct: 'Y3Q',
});

describe('CommercePrivWrappedKeysStoreService', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('listKeyIds', () => {
    it('lists the key directory under a redacted log path and keeps only wrapped-key files', async () => {
      const list = vi
        .spyOn(HomeserverService, 'list')
        .mockResolvedValue([`${DIRECTORY}${KEY_A}.json`, `${DIRECTORY}notes.txt`, `${DIRECTORY}${KEY_B}.json`]);

      expect(await CommercePrivWrappedKeysStoreService.listKeyIds(OWNER)).toEqual([KEY_A, KEY_B]);

      expect(list).toHaveBeenCalledOnce();
      expect(list).toHaveBeenCalledWith({
        baseDirectory: DIRECTORY,
        cursor: undefined,
        limit: 100,
        logUrl: REDACTED_LOG_PATH,
      });
    });

    it('follows the list cursor until a page comes back short', async () => {
      const fullPage = Array.from(
        { length: 100 },
        (_, index) => `${DIRECTORY}${index.toString(16).padStart(32, '0')}.json`,
      );
      const list = vi
        .spyOn(HomeserverService, 'list')
        .mockResolvedValueOnce(fullPage)
        .mockResolvedValueOnce([`${DIRECTORY}${KEY_A}.json`]);

      const keyIds = await CommercePrivWrappedKeysStoreService.listKeyIds(OWNER);

      expect(keyIds).toHaveLength(101);
      expect(keyIds[100]).toBe(KEY_A);
      expect(list).toHaveBeenCalledTimes(2);
      expect(list.mock.calls[1][0]).toMatchObject({ cursor: fullPage[99] });
    });

    it('finds nothing in an empty directory', async () => {
      vi.spyOn(HomeserverService, 'list').mockResolvedValue([]);
      expect(await CommercePrivWrappedKeysStoreService.listKeyIds(OWNER)).toEqual([]);
    });
  });

  describe('read', () => {
    it('returns the stored JSON, and null when there is no file or no JSON body', async () => {
      const get = vi
        .spyOn(HomeserverService, 'getJsonIfFound')
        .mockResolvedValueOnce({ found: true, json: envelope(KEY_A) })
        .mockResolvedValueOnce({ found: false })
        .mockResolvedValueOnce({ found: true, json: undefined });

      expect(await CommercePrivWrappedKeysStoreService.read(OWNER, KEY_A)).toEqual(envelope(KEY_A));
      expect(await CommercePrivWrappedKeysStoreService.read(OWNER, KEY_A)).toBeNull();
      expect(await CommercePrivWrappedKeysStoreService.read(OWNER, KEY_A)).toBeNull();
      expect(get).toHaveBeenCalledWith({ url: `${DIRECTORY}${KEY_A}.json`, logUrl: REDACTED_LOG_PATH });
    });

    it('refuses a key id that is not a key id before any request', async () => {
      const get = vi.spyOn(HomeserverService, 'getJsonIfFound');
      await expect(CommercePrivWrappedKeysStoreService.read(OWNER, '../x')).rejects.toThrow();
      expect(get).not.toHaveBeenCalled();
    });
  });

  describe('write', () => {
    it('puts the envelope at the key file and reads it back before it counts', async () => {
      const stored = envelope(KEY_A);
      const request = vi.spyOn(HomeserverService, 'request').mockResolvedValue(new Response(null, { status: 200 }));
      vi.spyOn(HomeserverService, 'getJsonIfFound').mockResolvedValue({ found: true, json: stored });

      await CommercePrivWrappedKeysStoreService.write(OWNER, stored);

      expect(request).toHaveBeenCalledWith({
        method: HttpMethod.PUT,
        url: `${DIRECTORY}${KEY_A}.json`,
        bodyJson: stored,
        logUrl: REDACTED_LOG_PATH,
      });
    });

    it('fails when the file reads back as something else, or not at all', async () => {
      vi.spyOn(HomeserverService, 'request').mockResolvedValue(new Response(null, { status: 200 }));
      const read = vi.spyOn(HomeserverService, 'getJsonIfFound');

      read.mockResolvedValueOnce({ found: true, json: { ...envelope(KEY_A), ct: 'b3RoZXI' } });
      const changed = await CommercePrivWrappedKeysStoreService.write(OWNER, envelope(KEY_A)).catch(
        (error: unknown) => error,
      );
      expect(changed).toBeInstanceOf(AppError);
      expect((changed as AppError).operation).toBe('writePrivWrappedKey');

      read.mockResolvedValueOnce({ found: false });
      await expect(CommercePrivWrappedKeysStoreService.write(OWNER, envelope(KEY_A))).rejects.toThrow();
    });

    it('does not read back when the write itself fails', async () => {
      vi.spyOn(HomeserverService, 'request').mockRejectedValue(new Error('homeserver down'));
      const read = vi.spyOn(HomeserverService, 'getJsonIfFound');

      await expect(CommercePrivWrappedKeysStoreService.write(OWNER, envelope(KEY_A))).rejects.toThrow(
        'homeserver down',
      );
      expect(read).not.toHaveBeenCalled();
    });
  });
});
