import {
  PRIV_WRAPPED_KEYS_LOG_PATH,
  type PrivWrappedKeyEnvelope,
  privWrappedKeyIdFromEntryUrl,
  privWrappedKeysDirectoryUrl,
  privWrappedKeyUrl,
} from '@/libs/commerce/priv-key-wrap';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { HttpMethod } from '@/libs/http/http.types';
import { HomeserverService } from '@/services/homeserver/homeserver';

const LIST_PAGE = 100;

/**
 * The wrapped data-key files under `/priv/pubky.app/marketplace/v2/keys/`.
 * Files are opaque envelopes here; opening them is `priv-key-wrap`. Logs and
 * error context carry the redacted directory form, never a key id.
 */
export class CommercePrivWrappedKeysStoreService {
  private constructor() {}

  /** Every key id that has a wrapped-key file, following the list cursor until a page comes back short. */
  static async listKeyIds(ownerPubky: string): Promise<string[]> {
    const keyIds: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const urls = await HomeserverService.list({
        baseDirectory: privWrappedKeysDirectoryUrl(ownerPubky),
        cursor,
        limit: LIST_PAGE,
        logUrl: PRIV_WRAPPED_KEYS_LOG_PATH,
      });
      for (const url of urls) {
        const keyId = privWrappedKeyIdFromEntryUrl(url);
        if (keyId !== null) keyIds.push(keyId);
      }
      if (urls.length < LIST_PAGE) return keyIds;
      cursor = urls[urls.length - 1];
    }
  }

  /** The stored envelope JSON for `keyId`, or null when no file exists. */
  static async read(ownerPubky: string, keyId: string): Promise<unknown | null> {
    const stored = await HomeserverService.getJsonIfFound<unknown>({
      url: privWrappedKeyUrl(ownerPubky, keyId),
      logUrl: PRIV_WRAPPED_KEYS_LOG_PATH,
    });
    return stored.found ? (stored.json ?? null) : null;
  }

  /**
   * Writes the envelope, then reads it back. Resolves only when the stored
   * file is the envelope that was written, so a caller may ask the service to
   * drop its copy of the key the file wraps.
   */
  static async write(ownerPubky: string, envelope: PrivWrappedKeyEnvelope): Promise<void> {
    const url = privWrappedKeyUrl(ownerPubky, envelope.kid);
    await HomeserverService.request({
      method: HttpMethod.PUT,
      url,
      bodyJson: envelope,
      logUrl: PRIV_WRAPPED_KEYS_LOG_PATH,
    });
    const stored = await this.read(ownerPubky, envelope.kid);
    if (JSON.stringify(stored) !== JSON.stringify(envelope)) {
      throw Err.client(ClientErrorCode.CONFLICT, 'The wrapped private data key did not read back as written.', {
        service: ErrorService.Homeserver,
        operation: 'writePrivWrappedKey',
      });
    }
  }
}
