import type { Table } from 'dexie';
import { withCurrentWrappingKey } from '@/libs/crypto/messaging-keyring';
import { buildWrapAad, WRAP_VERSION_AES_GCM_256, wrapPayload } from '@/libs/crypto/secret-wrapping';
import { isAppError } from '@/libs/error/error';
import { DatabaseErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { Logger } from '@/libs/logger/logger';
import type { AppDatabase } from './franky';

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * Data migration for DB version 4 → 5: wraps the two messaging key-material
 * columns (`commerce_messaging_receivers.noise_secret`,
 * `commerce_messaging_links.snapshot`) in place with AES-GCM-256 under the
 * non-extractable keyring key, AAD-bound to table + row id. The Dexie schema
 * itself is unchanged between those versions (the wrap format rides in the
 * existing `Uint8Array` columns plus the non-indexed `wrap_version` field),
 * so the bump only marks this data pass.
 *
 * IDEMPOTENT by construction: rows already at `wrap_version: 1` are skipped,
 * so a crash mid-pass simply resumes on the next run (see the versions-match
 * sweep in `runInitialize`). Runs BEFORE any messaging read can hand out a
 * legacy row in the upgraded build.
 *
 * FAIL CLOSED: any failure (WebCrypto/IDB unavailable, write error) throws —
 * an upgrade that cannot wrap must not continue with known-plaintext secrets.
 */
export async function migrateMessagingSecretsToWrappedStorage(database: AppDatabase): Promise<void> {
  const receivers = await database.commerce_messaging_receivers.toArray();
  const links = await database.commerce_messaging_links.toArray();
  const legacyReceivers = receivers.filter((row) => row.wrap_version !== WRAP_VERSION_AES_GCM_256);
  const legacyLinks = links.filter((row) => row.wrap_version !== WRAP_VERSION_AES_GCM_256);
  if (legacyReceivers.length === 0 && legacyLinks.length === 0) return;

  try {
    // Each row is wrapped and written under the key fence, like every other
    // write of wrapped state, so a sign-out in another tab cannot delete the
    // key between the two. Without Web Locks it runs anyway: no messaging
    // reader or writer runs anywhere then, and the upgrade must finish.
    for (const receiver of legacyReceivers) {
      await withCurrentWrappingKey(
        async (key) => {
          const wrapped = await wrapPayload(
            key,
            buildWrapAad('commerce_messaging_receivers', receiver.id),
            receiver.noise_secret,
          );
          // As for links below: another tab may have replaced this receiver
          // since it was read, and putting the older key back would leave the
          // published marker advertising a key the device no longer holds.
          await database.transaction('rw', database.commerce_messaging_receivers, async () => {
            const current = await database.commerce_messaging_receivers.get(receiver.id);
            if (!current || current.wrap_version === WRAP_VERSION_AES_GCM_256) return;
            if (!sameBytes(current.noise_secret, receiver.noise_secret)) return;
            await database.commerce_messaging_receivers.put({
              ...current,
              noise_secret: wrapped,
              wrap_version: WRAP_VERSION_AES_GCM_256,
            });
          });
        },
        { whenUnavailable: 'run' },
      );
    }
    for (const link of legacyLinks) {
      await withCurrentWrappingKey(
        async (key) => {
          const wrapped = await wrapPayload(key, buildWrapAad('commerce_messaging_links', link.id), link.snapshot);
          // Another tab may have saved a newer snapshot of this link since it
          // was read; putting the older one back would rewind its send counter.
          // The row is replaced only if it is still the one that was wrapped.
          await database.transaction('rw', database.commerce_messaging_links, async () => {
            const current = await database.commerce_messaging_links.get(link.id);
            if (!current || current.wrap_version === WRAP_VERSION_AES_GCM_256) return;
            if (!sameBytes(current.snapshot, link.snapshot)) return;
            await database.commerce_messaging_links.put({
              ...current,
              snapshot: wrapped,
              wrap_version: WRAP_VERSION_AES_GCM_256,
            });
          });
        },
        { whenUnavailable: 'run' },
      );
    }
    Logger.info('Wrapped legacy plaintext messaging secrets at rest (DB 4 → 5)', {
      receivers: legacyReceivers.length,
      links: legacyLinks.length,
    });
  } catch (error) {
    if (isAppError(error)) throw error;
    throw Err.database(
      DatabaseErrorCode.INIT_FAILED,
      'Failed to wrap legacy plaintext messaging secrets at rest; refusing to continue with them unencrypted.',
      { service: ErrorService.Local, operation: 'migrateMessagingSecretsToWrappedStorage', cause: error },
    );
  }
}

/** Rows wrapped per key-fence hold, so a large history never holds the fence for long. */
const HISTORY_WRAP_BATCH = 200;

type BodyRow = { id: string; body: string; sealed_body?: Uint8Array; wrap_version?: number };

/**
 * Wraps message bodies left in plaintext by builds that stored history and
 * the queued outbox unencrypted: each legacy row of
 * `commerce_messaging_messages` and `commerce_messaging_outbox` gets its
 * body sealed into `sealed_body` (AES-GCM-256 under the keyring key,
 * AAD-bound to table + row id), its stored `body` emptied and `wrap_version`
 * 1, in place. No Dexie schema change is involved: the new fields are not
 * indexed.
 *
 * IDEMPOTENT: only rows with no wrap format (absent or 0) are touched, and a
 * row is replaced only if it still holds the exact plaintext that was
 * wrapped, so a row another tab rewrote meanwhile is left to that write. A
 * row with an unknown wrap format is never treated as plaintext.
 *
 * FAIL CLOSED: any failure throws, and the caller reports messaging at rest
 * as degraded until a later boot's sweep succeeds.
 */
export async function migrateMessagingHistoryToWrappedStorage(database: AppDatabase): Promise<void> {
  try {
    const messages = await wrapLegacyBodies(database, database.commerce_messaging_messages);
    const outbox = await wrapLegacyBodies(database, database.commerce_messaging_outbox);
    if (messages + outbox > 0) {
      Logger.info('Wrapped legacy plaintext message bodies at rest', { messages, outbox });
    }
  } catch (error) {
    if (isAppError(error)) throw error;
    throw Err.database(
      DatabaseErrorCode.INIT_FAILED,
      'Failed to wrap legacy plaintext message history at rest; it stays unencrypted until a later attempt succeeds.',
      { service: ErrorService.Local, operation: 'migrateMessagingHistoryToWrappedStorage', cause: error },
    );
  }
}

async function wrapLegacyBodies<T extends BodyRow>(database: AppDatabase, table: Table<T, string>): Promise<number> {
  const legacy = (await table.toArray()).filter((row) => row.wrap_version === undefined || row.wrap_version === 0);
  let wrapped = 0;
  for (let start = 0; start < legacy.length; start += HISTORY_WRAP_BATCH) {
    const batch = legacy.slice(start, start + HISTORY_WRAP_BATCH);
    wrapped += await withCurrentWrappingKey(
      async (key) => {
        const sealed = await Promise.all(
          batch.map(async (row) => ({
            id: row.id,
            body: row.body,
            sealed: await wrapPayload(key, buildWrapAad(table.name, row.id), new TextEncoder().encode(row.body)),
          })),
        );
        return await database.transaction('rw', table, async () => {
          let written = 0;
          for (const { id, body, sealed: sealedBody } of sealed) {
            const current = await table.get(id);
            if (!current || (current.wrap_version !== undefined && current.wrap_version !== 0)) continue;
            if (current.body !== body) continue;
            await table.put({ ...current, body: '', sealed_body: sealedBody, wrap_version: WRAP_VERSION_AES_GCM_256 });
            written += 1;
          }
          return written;
        });
      },
      { whenUnavailable: 'run' },
    );
  }
  return wrapped;
}
