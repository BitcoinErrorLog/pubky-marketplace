import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import {
  PRIV_DATA_KEY_BYTES,
  privErrorSummary,
  type PrivKeyring,
  revokePrivKeyring,
} from '@/libs/commerce/priv-envelope';
import {
  type PrivFileKeyDeriver,
  privKeyringFromWrappedKeys,
  privKeyScopesCoverWrappedKeys,
  type PrivWrappedKey,
  unwrapPrivDataKey,
  wrapPrivDataKey,
} from '@/libs/commerce/priv-key-wrap';
import type { MarketplacePrivKeysResult } from '@/libs/commerce/priv-keys';
import { buildPrivRecoveryKeyFile, type PrivRecoveryKeyExport } from '@/libs/commerce/priv-recovery-key';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { Logger } from '@/libs/logger/logger';
import { CommercePrivWrappedKeysStoreService } from '@/services/homeserver/commerce/priv-wrapped-keys-store';
import { HomeserverService } from '@/services/homeserver/homeserver';
import { MarketplaceGatewayService } from '@/services/marketplace/marketplace';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';

const MAX_KEY_SET_RETRIES = 2;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left[index] ^ right[index];
  return difference === 0;
}

function zero(keys: PrivWrappedKey[]): void {
  for (const { key } of keys) key.fill(0);
}

/**
 * The signed-in owner's `/priv` data keys, held in memory only.
 *
 * Keys come from the marketplace service (`GET /v1/me/priv-keys`) on first
 * use, or, once the owner's signer delivered scoped encryption keys, from the
 * wrapped copies on the owner's homeserver. They are never written to
 * localStorage, IndexedDB or any cache. A released keyring is kept for its
 * owner until the marketplace session ends or is replaced, or the user signs
 * out, at which point every key byte is zeroed.
 * `needs_reauth` and `unavailable` are not cached, so a re-approval or a
 * service recovery is picked up on the next call.
 *
 * Phase 4 (priv-encryption-plan.md). With scoped encryption keys, each data
 * key is stored on the owner's homeserver wrapped under a key only the
 * owner's signer can derive (`priv-key-wrap`). The service holds the keys
 * until a wrapped copy of every one has been written, read back and opened
 * here; only then is it asked to drop its copies, and from then on it can no
 * longer decrypt. The data keys never change, so no record is re-encrypted and
 * no record path moves.
 * - Wrapped files exist and the service still holds keys (a release that did
 *   not finish): any key without a matching wrapped file is wrapped, then the
 *   release is retried.
 * - Wrapped files exist and the service has released custody, is down or
 *   refuses the session: the wrapped files are the keys.
 * - No wrapped files and the service has released custody: the keys cannot be
 *   recovered, so there is no keyring and nothing is written.
 */
export class CommercePrivKeyringApplication {
  private constructor() {}

  /** Every keyring `get` hands out is the one held here, so clear() revokes all of them. */
  private static ready = new Map<string, PrivKeyring>();
  private static inFlight = new Map<string, Promise<MarketplacePrivKeysResult>>();
  private static generation = 0;
  private static unsubscribe: (() => void)[] | null = null;

  /**
   * The owner's keyring, or why there is none. Only the owner of the active
   * marketplace session can hold one.
   */
  static async get(ownerPubky: string): Promise<MarketplacePrivKeysResult> {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) return { kind: 'unavailable' };
    this.subscribeToSessionEnd();
    const session = MarketplaceSessionService.getActiveSession();
    if (!session || session.pubky !== ownerPubky) {
      this.clear();
      return { kind: 'needs_reauth' };
    }
    const cached = this.ready.get(ownerPubky);
    if (cached) return { kind: 'keys', keyring: cached };

    const pending = this.inFlight.get(ownerPubky);
    if (pending) return await pending;

    const generation = this.generation;
    const run = this.load(ownerPubky)
      .then((result) => {
        if (result.kind !== 'keys') return result;
        // Signed out, or another account took over, while the read was in flight.
        const stillOwner = MarketplaceSessionService.getActiveSession()?.pubky === ownerPubky;
        if (generation !== this.generation || !stillOwner) {
          revokePrivKeyring(result.keyring);
          return { kind: 'needs_reauth' } as const;
        }
        this.ready.set(ownerPubky, result.keyring);
        return result;
      })
      .finally(() => {
        // A fetch that went stale must not drop the slot of the fetch that
        // replaced it: a second fetch would then overwrite that keyring in
        // `ready` while callers still hold it, and clear() would miss it.
        if (this.inFlight.get(ownerPubky) === run) this.inFlight.delete(ownerPubky);
      });
    this.inFlight.set(ownerPubky, run);
    return await run;
  }

  /**
   * The owner's keys: from the wrapped copies when the signed-in session holds
   * scoped encryption keys that reach them, else from the service. A session
   * without such keys (a cookie sign-in, a signer that declined `e`) can only
   * use the service's copy, so an owner whose service copy was dropped has no
   * keys there ("unavailable") rather than a fresh one.
   */
  private static async load(ownerPubky: string): Promise<MarketplacePrivKeysResult> {
    const encryptionKeys = HomeserverService.getCurrentSessionEncryptionKeys(ownerPubky);
    if (encryptionKeys && privKeyScopesCoverWrappedKeys(encryptionKeys.scopes)) {
      try {
        return await this.resolveWithOwnerKeys(ownerPubky, encryptionKeys);
      } finally {
        encryptionKeys.free();
      }
    }
    encryptionKeys?.free();
    const read = await MarketplaceGatewayService.getPrivKeys(ownerPubky);
    return read.kind === 'released' ? { kind: 'unavailable' } : read;
  }

  /**
   * The owner's recovery key file ("Export recovery key"), built from the
   * same released keys the encrypted records use. Nothing is kept once the
   * caller has the file contents.
   */
  static async exportRecoveryKey(ownerPubky: string): Promise<PrivRecoveryKeyExport> {
    const result = await this.get(ownerPubky);
    if (result.kind !== 'keys') return result;
    return { kind: 'file', file: buildPrivRecoveryKeyFile(result.keyring) };
  }

  /** Drops and zeroes every held key. Part of sign-out and session teardown. */
  static clear(): void {
    this.generation += 1;
    for (const keyring of this.ready.values()) revokePrivKeyring(keyring);
    this.ready.clear();
    this.inFlight.clear();
  }

  /** The keyring, or why there is none. Never writes a record. */
  private static async resolveWithOwnerKeys(
    ownerPubky: string,
    deriver: PrivFileKeyDeriver,
  ): Promise<MarketplacePrivKeysResult> {
    for (let attempt = 0; ; attempt += 1) {
      const outcome = await this.resolveWithOwnerKeysOnce(ownerPubky, deriver);
      if (outcome !== 'key_set_changed') return outcome;
      if (attempt >= MAX_KEY_SET_RETRIES) return { kind: 'unavailable' };
    }
  }

  private static async resolveWithOwnerKeysOnce(
    ownerPubky: string,
    deriver: PrivFileKeyDeriver,
  ): Promise<MarketplacePrivKeysResult | 'key_set_changed'> {
    const wrapped = await this.readWrappedKeys(ownerPubky, deriver);
    const read = await MarketplaceGatewayService.getPrivKeys(ownerPubky);

    if (read.kind === 'keys') {
      const held = read.keyring;
      try {
        return await this.wrapAndRelease(ownerPubky, deriver, held, wrapped);
      } finally {
        revokePrivKeyring(held);
      }
    }

    if (read.kind === 'released' || wrapped.length > 0) {
      const keyring = wrapped.length > 0 ? privKeyringFromWrappedKeys(ownerPubky, wrapped) : null;
      if (keyring) return { kind: 'keys', keyring };
      zero(wrapped);
      return { kind: 'unavailable' };
    }
    return read;
  }

  /** Every wrapped key that opens; a file that does not open is left out and logged by its failure kind only. */
  private static async readWrappedKeys(ownerPubky: string, deriver: PrivFileKeyDeriver): Promise<PrivWrappedKey[]> {
    const keyIds = await CommercePrivWrappedKeysStoreService.listKeyIds(ownerPubky);
    const opened: PrivWrappedKey[] = [];
    for (const keyId of keyIds) {
      const envelope = await CommercePrivWrappedKeysStoreService.read(ownerPubky, keyId);
      if (envelope === null) continue;
      try {
        opened.push(unwrapPrivDataKey({ ownerPubky, deriver, keyId, envelope }));
      } catch (error) {
        Logger.warn('A wrapped private data key did not open', privErrorSummary(error));
      }
    }
    return opened;
  }

  /**
   * The service still holds `held`: make sure each key has a wrapped file that
   * opens to the same bytes, then drop the service's copies. A failed or
   * refused release keeps the verified wrapped keys in use and leaves custody
   * with the service, to be retried on the next read.
   */
  private static async wrapAndRelease(
    ownerPubky: string,
    deriver: PrivFileKeyDeriver,
    held: PrivKeyring,
    wrapped: PrivWrappedKey[],
  ): Promise<MarketplacePrivKeysResult | 'key_set_changed'> {
    const verified: PrivWrappedKey[] = [];
    try {
      for (const [index, key] of held.keys.entries()) {
        const existing = wrapped.find((entry) => entry.keyId === key.keyId);
        if (
          existing &&
          existing.generation === index + 1 &&
          existing.key.length === PRIV_DATA_KEY_BYTES &&
          sameBytes(existing.key, key.key)
        ) {
          verified.push({ keyId: key.keyId, key: Uint8Array.from(existing.key), generation: existing.generation });
          continue;
        }
        verified.push(
          await this.wrapAndStore(ownerPubky, deriver, { keyId: key.keyId, key: key.key, generation: index + 1 }),
        );
      }
      const keyring = privKeyringFromWrappedKeys(ownerPubky, verified);
      if (!keyring || keyring.currentKeyId !== held.currentKeyId) {
        zero(verified);
        return { kind: 'unavailable' };
      }
      try {
        const released = await MarketplaceGatewayService.releasePrivKeyCustody(
          ownerPubky,
          held.keys.map((key) => key.keyId),
        );
        if (released === 'key_set_changed') {
          revokePrivKeyring(keyring);
          return 'key_set_changed';
        }
        if (released !== 'released') {
          Logger.warn('The marketplace did not drop its private data keys; they stay with it for now', {
            outcome: released,
          });
        }
      } catch (error) {
        Logger.warn('The marketplace could not be asked to drop its private data keys', privErrorSummary(error));
      }
      return { kind: 'keys', keyring };
    } catch (error) {
      zero(verified);
      throw error;
    } finally {
      zero(wrapped);
    }
  }

  /** Writes the wrapped file, reads it back, and opens it again so the key proven to round-trip is the one kept. */
  private static async wrapAndStore(
    ownerPubky: string,
    deriver: PrivFileKeyDeriver,
    key: PrivWrappedKey,
  ): Promise<PrivWrappedKey> {
    const envelope = wrapPrivDataKey({ ownerPubky, deriver, key });
    await CommercePrivWrappedKeysStoreService.write(ownerPubky, envelope);
    const reopened = unwrapPrivDataKey({ ownerPubky, deriver, keyId: key.keyId, envelope });
    if (reopened.generation !== key.generation || !sameBytes(reopened.key, key.key)) {
      reopened.key.fill(0);
      throw Err.client(
        ClientErrorCode.CONFLICT,
        'A wrapped private data key did not open to the key that was wrapped.',
        {
          service: ErrorService.Local,
          operation: 'wrapPrivDataKey',
        },
      );
    }
    return reopened;
  }

  private static subscribeToSessionEnd(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = [
      MarketplaceSessionService.onSessionEnded(() => this.clear()),
      MarketplaceSessionService.onSessionReplaced(() => this.clear()),
    ];
  }
}
