import {
  decryptPrivRecord,
  encryptPrivRecord,
  isPrivEntryName,
  PRIV_V2_LOG_PATH,
  privEntryName,
  privEntryUrl,
  type PrivFamily,
  privFamilyUrl,
  type PrivKeyring,
  privListedEntryUrl,
} from '@/libs/commerce/priv-envelope';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { HttpMethod } from '@/libs/http/http.types';
import { HomeserverService } from '@/services/homeserver/homeserver';

const PRIV_LIST_PAGE = 500;

/**
 * Encrypted records under `/priv/pubky.app/marketplace/v2/s/`. Every read
 * decrypts, every write is read back and decrypted before it counts, and
 * logs and error context carry the redacted v2 prefix, never an entry path.
 */
export class CommercePrivStoreService {
  private constructor() {}

  /** The decrypted record, or null when the entry does not exist. */
  static async read(keyring: PrivKeyring, family: PrivFamily, id: string): Promise<unknown | null> {
    return await this.readAt(keyring, family, privEntryName(keyring, family, id), privEntryUrl(keyring, family, id));
  }

  /** {@link read} for an entry found by listing its family. */
  static async readListed(keyring: PrivKeyring, family: PrivFamily, name: string): Promise<unknown | null> {
    return await this.readAt(keyring, family, name, privListedEntryUrl(keyring, family, name));
  }

  /**
   * Seals and writes `record`, then reads it back. Resolves only when the
   * stored entry decrypts to the same JSON, so a caller may delete the
   * plaintext it replaces.
   */
  static async write(keyring: PrivKeyring, family: PrivFamily, id: string, record: unknown): Promise<void> {
    await this.writeAt(keyring, family, privEntryName(keyring, family, id), privEntryUrl(keyring, family, id), record);
  }

  /** {@link write} for an entry readers find by listing its family. */
  static async writeListed(keyring: PrivKeyring, family: PrivFamily, name: string, record: unknown): Promise<void> {
    await this.writeAt(keyring, family, name, privListedEntryUrl(keyring, family, name), record);
  }

  private static async readAt(keyring: PrivKeyring, family: PrivFamily, name: string, url: string): Promise<unknown> {
    const stored = await HomeserverService.getJsonIfFound<unknown>({ url, logUrl: PRIV_V2_LOG_PATH });
    if (!stored.found) return null;
    return decryptPrivRecord({ keyring, family, name, envelope: stored.json });
  }

  private static async writeAt(
    keyring: PrivKeyring,
    family: PrivFamily,
    name: string,
    url: string,
    record: unknown,
  ): Promise<void> {
    const envelope = encryptPrivRecord({ keyring, family, name, record });
    await HomeserverService.request({ method: HttpMethod.PUT, url, bodyJson: envelope, logUrl: PRIV_V2_LOG_PATH });
    const stored = await this.readAt(keyring, family, name, url);
    if (JSON.stringify(stored) !== JSON.stringify(record)) {
      throw Err.client(ClientErrorCode.CONFLICT, 'The encrypted private record did not read back as written.', {
        service: ErrorService.Homeserver,
        operation: 'writePrivRecord',
      });
    }
  }

  static async deleteListed(keyring: PrivKeyring, family: PrivFamily, name: string): Promise<void> {
    await HomeserverService.request({
      method: HttpMethod.DELETE,
      url: privListedEntryUrl(keyring, family, name),
      logUrl: PRIV_V2_LOG_PATH,
    });
  }

  /**
   * Every listed entry name in the family, following the list cursor until
   * a page comes back short. Anything else in the directory is skipped.
   */
  static async listAllNames(keyring: PrivKeyring, family: PrivFamily): Promise<string[]> {
    const names: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const urls = await HomeserverService.list({
        baseDirectory: privFamilyUrl(keyring, family),
        cursor,
        limit: PRIV_LIST_PAGE,
        logUrl: PRIV_V2_LOG_PATH,
      });
      for (const url of urls) {
        const name = url.slice(url.lastIndexOf('/') + 1);
        if (isPrivEntryName(name)) names.push(name);
      }
      if (urls.length < PRIV_LIST_PAGE) return names;
      cursor = urls[urls.length - 1];
    }
  }

  /** The names of the family's listed entries; anything else in the directory is skipped. */
  static async listNames(keyring: PrivKeyring, family: PrivFamily, limit: number): Promise<string[]> {
    const urls = await HomeserverService.list({
      baseDirectory: privFamilyUrl(keyring, family),
      limit,
      logUrl: PRIV_V2_LOG_PATH,
    });
    return urls.map((url) => url.slice(url.lastIndexOf('/') + 1)).filter(isPrivEntryName);
  }
}
