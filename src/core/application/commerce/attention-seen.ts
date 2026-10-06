import { CommercePrivKeyringApplication } from '@/application/commerce/priv-keyring';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { raiseLocalOrdersSeenAt, readLocalOrdersSeenAt } from '@/libs/commerce/marketplace-attention';
import {
  assertPrivKeyringLive,
  newPrivEntryName,
  PRIV_V1_LOG_PATH,
  privEnvelopeRejection,
  privErrorSummary,
  type PrivFamily,
  type PrivKeyring,
} from '@/libs/commerce/priv-envelope';
import { hasHttpStatus } from '@/libs/error/error.utils';
import { HttpStatusCode } from '@/libs/http/http.types';
import { Logger } from '@/libs/logger/logger';
import { CommerceRecordNormalizer } from '@/pipes/commerce/commerce.normalizer';
import { CommerceHomeserverService } from '@/services/homeserver/commerce/commerce';
import { CommercePrivStoreService } from '@/services/homeserver/commerce/priv-store';
import { HomeserverService, PRIVATE_APP_DATA_PATH } from '@/services/homeserver/homeserver';
import { LocalCommerceService } from '@/services/local/commerce/commerce';
import { useAuthStore } from '@/stores/auth/auth.store';

export type MarketplaceAttentionSide = 'activity' | 'orders';

/** Quiet period before a burst of "seen" moments becomes one homeserver write. */
export const ATTENTION_SEEN_WRITE_DEBOUNCE_MS = 2_000;

/** Plaintext v1 entry names are ms epochs zero-padded to this width. */
const LEGACY_ENTRY_NAME = /^\d{13}$/;
/** Pruning keeps each directory to a handful of entries; this bounds one read. */
const ENTRY_LIST_LIMIT = 100;

const FAMILY: Record<MarketplaceAttentionSide, PrivFamily> = {
  activity: 'attention_seen/activity',
  orders: 'attention_seen/orders',
};

type SealedEntry = { name: string; at: number };
type LegacyEntry = { url: string; at: number };
type Listing = { kind: 'entries'; sealed: SealedEntry[]; legacy: LegacyEntry[] } | { kind: 'unavailable' };
type PendingWrite = { timer: ReturnType<typeof setTimeout>; done: Promise<void>; resolve: () => void };

/**
 * The account's badge checkpoints: when this account last opened Activity
 * and Orders, on any browser.
 *
 * The durable marketplace service stores no read state, so the checkpoints
 * live on the owner's homeserver, encrypted, in one hidden family directory
 * per side under `/priv/pubky.app/marketplace/v2/s/`. Each entry has a
 * random name and seals `{ version: 1, seenAt }`, so the homeserver sees
 * neither which side an entry belongs to nor when it was seen. Each write
 * adds a new entry and never rewrites an existing one; the checkpoint is
 * the largest `seenAt`. The homeserver has no conditional write, and a
 * read-modify-write of one document lets a slower writer put back an older
 * value. A set of immutable entries whose maximum is the value cannot move
 * backward under any interleaving of tabs or browsers. After a write,
 * entries below the one just written are deleted; an entry is only deleted
 * when a larger one exists, so the maximum survives concurrent pruning too.
 * An entry that does not decrypt is ignored and never deleted.
 *
 * Plaintext v1 entries (`/priv/pubky.app/marketplace/v1/attention_seen/
 * {side}/{ms}`, named by the timestamp) are read, carried into an encrypted
 * entry when they hold the newest value, and deleted once an encrypted
 * entry at least as new exists.
 *
 * Each browser keeps a local copy (Dexie for Activity, local storage for
 * Orders) that the badge hooks read live. `markSeen` raises the local copy
 * at once and schedules one debounced write, which is skipped when the
 * homeserver already holds a checkpoint at least as new. `pull` raises the
 * local copies to the homeserver's, capped at this device's now so a clock
 * running ahead cannot hide future activity. Without a session that can
 * write `/priv/pubky.app/`, without a released data key, or in the sandbox,
 * the local copy is all there is, and the badge behaves per browser.
 */
export class CommerceAttentionSeenApplication {
  private constructor() {}

  private static pullsInFlight = new Map<string, Promise<void>>();
  private static pendingWrites = new Map<string, PendingWrite>();

  /**
   * Records that this account saw `side` at `now`. Resolves once the
   * debounced homeserver write for this burst has settled.
   */
  static async markSeen(ownerPubky: string, side: MarketplaceAttentionSide, now = Date.now()): Promise<void> {
    await this.raiseLocal(ownerPubky, side, now);
    if (!this.canUseRemote(ownerPubky)) return;
    await this.scheduleWrite(ownerPubky, side);
  }

  /** Raises this browser's checkpoints to the account's. One read per owner at a time. */
  static async pull(ownerPubky: string): Promise<void> {
    if (!this.canUseRemote(ownerPubky)) return;
    const inFlight = this.pullsInFlight.get(ownerPubky);
    if (inFlight) return await inFlight;
    const run = this.runPull(ownerPubky).finally(() => {
      this.pullsInFlight.delete(ownerPubky);
    });
    this.pullsInFlight.set(ownerPubky, run);
    return await run;
  }

  /** Test support: drops scheduled writes without running them. */
  static resetPendingWrites(): void {
    for (const pending of this.pendingWrites.values()) {
      clearTimeout(pending.timer);
      pending.resolve();
    }
    this.pendingWrites.clear();
  }

  private static scheduleWrite(ownerPubky: string, side: MarketplaceAttentionSide): Promise<void> {
    const key = `${ownerPubky}|${side}`;
    const existing = this.pendingWrites.get(key);
    if (existing) clearTimeout(existing.timer);
    let resolve: () => void = () => {};
    const done = existing?.done ?? new Promise<void>((settle) => (resolve = settle));
    const pending: PendingWrite = {
      done,
      resolve: existing?.resolve ?? resolve,
      timer: setTimeout(() => {
        this.pendingWrites.delete(key);
        void this.writeCheckpoint(ownerPubky, side).finally(pending.resolve);
      }, ATTENTION_SEEN_WRITE_DEBOUNCE_MS),
    };
    this.pendingWrites.set(key, pending);
    return done;
  }

  private static async writeCheckpoint(ownerPubky: string, side: MarketplaceAttentionSide): Promise<void> {
    // The account may have changed or lost its grant during the quiet period.
    if (!this.canUseRemote(ownerPubky)) return;
    try {
      const keyring = await this.keyring(ownerPubky);
      if (!keyring) return;
      const local =
        side === 'activity'
          ? await LocalCommerceService.getActivityReadCheckpoint(ownerPubky)
          : readLocalOrdersSeenAt(ownerPubky);
      const value = Math.min(local, Date.now());
      if (!(value > 0)) return;
      const listing = await this.listEntries(ownerPubky, keyring, side);
      if (listing.kind === 'unavailable') return;
      await this.store(keyring, side, listing, value);
    } catch (error) {
      Logger.warn('Failed to save the marketplace badge checkpoint', privErrorSummary(error));
    }
  }

  /**
   * Makes the encrypted entries hold at least `value`, then prunes: sealed
   * entries below the newest, and every plaintext entry an encrypted entry
   * now covers.
   */
  private static async store(
    keyring: PrivKeyring,
    side: MarketplaceAttentionSide,
    listing: Extract<Listing, { kind: 'entries' }>,
    value: number,
  ): Promise<void> {
    let newest = latestSealed(listing);
    const stale: SealedEntry[] = [];
    if (newest < value) {
      const name = newPrivEntryName();
      await CommercePrivStoreService.writeListed(keyring, FAMILY[side], name, { version: 1, seenAt: value });
      stale.push(...listing.sealed);
      newest = value;
    }
    const covered = listing.legacy.filter(({ at }) => at <= newest);
    // A session replacement may have revoked the keyring while the write
    // above was in flight; plaintext is deleted only under a live keyring.
    await Promise.allSettled([
      ...stale.map(({ name }) => CommercePrivStoreService.deleteListed(keyring, FAMILY[side], name)),
      ...covered.map(async ({ url }) => {
        assertPrivKeyringLive(keyring);
        await CommerceHomeserverService.delete(url, PRIV_V1_LOG_PATH);
      }),
    ]);
  }

  private static async runPull(ownerPubky: string): Promise<void> {
    try {
      const keyring = await this.keyring(ownerPubky);
      if (!keyring) return;
      const now = Date.now();
      for (const side of ['activity', 'orders'] as const) {
        const listing = await this.listEntries(ownerPubky, keyring, side);
        if (listing.kind === 'unavailable') continue;
        const newest = Math.max(latestSealed(listing), latestLegacy(listing));
        await this.raiseLocal(ownerPubky, side, Math.min(newest, now));
        if (listing.legacy.length > 0) await this.store(keyring, side, listing, newest);
      }
    } catch (error) {
      Logger.warn('Failed to load the marketplace badge checkpoint', privErrorSummary(error));
    }
  }

  private static async listEntries(
    ownerPubky: string,
    keyring: PrivKeyring,
    side: MarketplaceAttentionSide,
  ): Promise<Listing> {
    let names: string[];
    let legacyUrls: string[];
    try {
      [names, legacyUrls] = await Promise.all([
        CommercePrivStoreService.listNames(keyring, FAMILY[side], ENTRY_LIST_LIMIT),
        CommerceHomeserverService.list(
          CommerceRecordNormalizer.attentionSeenDirectoryUri(ownerPubky, side),
          ENTRY_LIST_LIMIT,
          PRIV_V1_LOG_PATH,
        ),
      ]);
    } catch (error) {
      if (isAccessDenied(error)) return { kind: 'unavailable' };
      throw error;
    }
    const sealed: SealedEntry[] = [];
    for (const name of names) {
      let at: number | null;
      try {
        at = await this.readSealed(keyring, side, name);
      } catch (error) {
        if (isAccessDenied(error)) return { kind: 'unavailable' };
        throw error;
      }
      if (at !== null) sealed.push({ name, at });
    }
    const legacy: LegacyEntry[] = [];
    for (const url of legacyUrls) {
      const name = url.slice(url.lastIndexOf('/') + 1);
      if (LEGACY_ENTRY_NAME.test(name)) legacy.push({ url, at: Number(name) });
    }
    return { kind: 'entries', sealed, legacy };
  }

  /** The entry's `seenAt`, or null when it does not open or is not `{ version: 1, seenAt: <positive integer> }`. Other failures throw. */
  private static async readSealed(
    keyring: PrivKeyring,
    side: MarketplaceAttentionSide,
    name: string,
  ): Promise<number | null> {
    let record: unknown;
    try {
      record = await CommercePrivStoreService.readListed(keyring, FAMILY[side], name);
    } catch (error) {
      if (privEnvelopeRejection(error) === null) throw error;
      Logger.warn('Ignoring a marketplace badge checkpoint that does not decrypt', privErrorSummary(error));
      return null;
    }
    const checkpoint = record as { version?: unknown; seenAt?: unknown } | null;
    const seenAt = checkpoint?.seenAt;
    return checkpoint?.version === 1 && Number.isSafeInteger(seenAt) && (seenAt as number) > 0
      ? (seenAt as number)
      : null;
  }

  private static async keyring(ownerPubky: string): Promise<PrivKeyring | null> {
    const result = await CommercePrivKeyringApplication.get(ownerPubky);
    return result.kind === 'keys' ? result.keyring : null;
  }

  private static async raiseLocal(ownerPubky: string, side: MarketplaceAttentionSide, at: number): Promise<void> {
    if (!(at > 0)) return;
    if (side === 'activity') {
      await LocalCommerceService.markActivityRead(ownerPubky, at);
      return;
    }
    raiseLocalOrdersSeenAt(ownerPubky, at);
  }

  private static canUseRemote(ownerPubky: string): boolean {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) return false;
    if (useAuthStore.getState().currentUserPubky !== ownerPubky) return false;
    return HomeserverService.hasActiveSession() && HomeserverService.canCurrentSessionWrite(PRIVATE_APP_DATA_PATH);
  }
}

function isAccessDenied(error: unknown): boolean {
  return hasHttpStatus(error, HttpStatusCode.FORBIDDEN) || hasHttpStatus(error, HttpStatusCode.UNAUTHORIZED);
}

function latestSealed(listing: Extract<Listing, { kind: 'entries' }>): number {
  return listing.sealed.reduce((max, { at }) => Math.max(max, at), 0);
}

function latestLegacy(listing: Extract<Listing, { kind: 'entries' }>): number {
  return listing.legacy.reduce((max, { at }) => Math.max(max, at), 0);
}
