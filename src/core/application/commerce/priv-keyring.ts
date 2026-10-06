import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { type PrivKeyring, revokePrivKeyring } from '@/libs/commerce/priv-envelope';
import type { MarketplacePrivKeysResult } from '@/libs/commerce/priv-keys';
import { buildPrivRecoveryKeyFile, type PrivRecoveryKeyExport } from '@/libs/commerce/priv-recovery-key';
import { MarketplaceGatewayService } from '@/services/marketplace/marketplace';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';

/**
 * The signed-in owner's `/priv` data keys, held in memory only.
 *
 * Keys come from the marketplace service (`GET /v1/me/priv-keys`) on first
 * use and are never written to localStorage, IndexedDB or any cache. A
 * released keyring is kept for its owner until the marketplace session ends
 * or is replaced, or the user signs out, at which point every key byte is
 * zeroed.
 * `needs_reauth` and `unavailable` are not cached, so a re-approval or a
 * service recovery is picked up on the next call.
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
    const run = MarketplaceGatewayService.getPrivKeys(ownerPubky)
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

  private static subscribeToSessionEnd(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = [
      MarketplaceSessionService.onSessionEnded(() => this.clear()),
      MarketplaceSessionService.onSessionReplaced(() => this.clear()),
    ];
  }
}
