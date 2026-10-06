import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase, MESSAGING_WRAP_BASE_DB_VERSION } from '@/database/franky/franky';
import {
  migrateMessagingHistoryToWrappedStorage,
  migrateMessagingSecretsToWrappedStorage,
} from '@/database/franky/franky.migrations';
import {
  dropCachedWrappingKeyForTests,
  getOrCreateWrappingKey,
  resetMessagingKeyringForTests,
} from '@/libs/crypto/messaging-keyring';
import { buildWrapAad, unwrapPayload, WRAP_IV_BYTES, WRAP_VERSION_AES_GCM_256 } from '@/libs/crypto/secret-wrapping';
import { isAppError } from '@/libs/error/error';
import type {
  CommerceMessagingLinkModelSchema,
  CommerceMessagingMessageModelSchema,
  CommerceMessagingOutboxModelSchema,
  CommerceMessagingReceiverModelSchema,
} from '@/models/messaging/messaging.schema';

const OWNER = 'a'.repeat(52);
const COUNTERPARTY = 'z'.repeat(52);

/** A receiver row as version 4 wrote it: plaintext secret, no wrap_version. */
function legacyReceiverRow(): CommerceMessagingReceiverModelSchema {
  return {
    id: OWNER,
    noise_secret: new Uint8Array(32).fill(7),
    noise_public_key: 'n'.repeat(52),
    receiver_path: 'marketplace/wallet',
    marker_published: true,
    created_at: 1,
    updated_at: 1,
  };
}

/** A link row as version 4 wrote it: plaintext snapshot, no wrap_version. */
function legacyLinkRow(): CommerceMessagingLinkModelSchema {
  return {
    id: `${OWNER}:${COUNTERPARTY}`,
    owner_id: OWNER,
    counterparty_pubky: COUNTERPARTY,
    role: 'initiator',
    status: 'established',
    local_receiver_path: 'marketplace/wallet',
    remote_receiver_path: 'marketplace/wallet',
    remote_noise_public_key: 'p'.repeat(52),
    snapshot: new Uint8Array([9, 8, 7, 6]),
    created_at: 1,
    updated_at: 1,
  };
}

/** Creates a database exactly as the version-4 build did (full schema, plaintext rows). */
async function seedLegacyV4Database(name: string): Promise<{ receiver: Uint8Array; snapshot: Uint8Array }> {
  const legacy = new AppDatabase(name, MESSAGING_WRAP_BASE_DB_VERSION);
  const seeded = { receiver: legacyReceiverRow().noise_secret, snapshot: legacyLinkRow().snapshot };
  await legacy.initialize();
  await legacy.commerce_messaging_receivers.put(legacyReceiverRow());
  await legacy.commerce_messaging_links.put(legacyLinkRow());
  // A non-messaging row, to prove the upgrade does not wipe unrelated state.
  await legacy.user_counts.put({ id: OWNER, followers: 3 } as never);
  legacy.close();
  return seeded;
}

describe('migrateMessagingSecretsToWrappedStorage (DB 4 → 5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('upgrades a version-4 database in place: no wipe, plaintext rows wrapped, unwrap round-trips', async () => {
    const name = `franky-mig-${crypto.randomUUID()}`;
    const seeded = await seedLegacyV4Database(name);

    const upgraded = new AppDatabase(name, MESSAGING_WRAP_BASE_DB_VERSION + 1);
    const result = await upgraded.initialize();

    expect(result.wasDbReset).toBe(false);
    // Unrelated state survived — this was NOT the delete-and-recreate path.
    await expect(upgraded.user_counts.get(OWNER)).resolves.toMatchObject({ followers: 3 });

    const receiver = (await upgraded.commerce_messaging_receivers.get(OWNER))!;
    expect(receiver.wrap_version).toBe(WRAP_VERSION_AES_GCM_256);
    expect(receiver.noise_secret.byteLength).toBe(WRAP_IV_BYTES + 32 + 16);
    expect([...receiver.noise_secret]).not.toEqual([...seeded.receiver]);

    const link = (await upgraded.commerce_messaging_links.get(`${OWNER}:${COUNTERPARTY}`))!;
    expect(link.wrap_version).toBe(WRAP_VERSION_AES_GCM_256);
    expect([...link.snapshot]).not.toEqual([...seeded.snapshot]);

    // The wrapped rows unwrap back to the exact seeded plaintext under the
    // keyring key with the table+row-id AAD.
    const key = await getOrCreateWrappingKey();
    const unwrappedSecret = await unwrapPayload(
      key,
      buildWrapAad('commerce_messaging_receivers', OWNER),
      receiver.noise_secret,
    );
    expect([...unwrappedSecret]).toEqual([...seeded.receiver]);
    const unwrappedSnapshot = await unwrapPayload(
      key,
      buildWrapAad('commerce_messaging_links', `${OWNER}:${COUNTERPARTY}`),
      link.snapshot,
    );
    expect([...unwrappedSnapshot]).toEqual([...seeded.snapshot]);
    upgraded.close();
  });

  it('is idempotent: a second pass leaves the wrapped bytes untouched', async () => {
    const name = `franky-mig-${crypto.randomUUID()}`;
    await seedLegacyV4Database(name);
    const upgraded = new AppDatabase(name, MESSAGING_WRAP_BASE_DB_VERSION + 1);
    await upgraded.initialize();

    const before = (await upgraded.commerce_messaging_receivers.get(OWNER))!.noise_secret;
    await migrateMessagingSecretsToWrappedStorage(upgraded);
    await migrateMessagingSecretsToWrappedStorage(upgraded);
    const after = (await upgraded.commerce_messaging_receivers.get(OWNER))!.noise_secret;
    expect([...after]).toEqual([...before]);
    upgraded.close();
  });

  it('heals a crash-interrupted upgrade on the next initialize (versions-match sweep)', async () => {
    const name = `franky-mig-${crypto.randomUUID()}`;
    const seeded = await seedLegacyV4Database(name);
    const upgraded = new AppDatabase(name, MESSAGING_WRAP_BASE_DB_VERSION + 1);
    await upgraded.initialize();

    // Simulate a row that stayed plaintext because the first pass crashed:
    // the DB is already at the new version, so only the sweep can reach it.
    await upgraded.commerce_messaging_receivers.put(legacyReceiverRow());
    const result = await upgraded.initialize();

    expect(result.wasDbReset).toBe(false);
    const receiver = (await upgraded.commerce_messaging_receivers.get(OWNER))!;
    expect(receiver.wrap_version).toBe(WRAP_VERSION_AES_GCM_256);
    const key = await getOrCreateWrappingKey();
    const unwrapped = await unwrapPayload(
      key,
      buildWrapAad('commerce_messaging_receivers', OWNER),
      receiver.noise_secret,
    );
    expect([...unwrapped]).toEqual([...seeded.receiver]);
    upgraded.close();
  });

  it.each([
    ['a wrapped snapshot this build saved', { wrap_version: 1, write_id: 'other-tab' }],
    ['a plaintext snapshot an older build saved', {}],
  ])('never puts a legacy snapshot back over %s in another tab while it was being wrapped', async (_label, saved) => {
    const name = `franky-mig-${crypto.randomUUID()}`;
    await seedLegacyV4Database(name);
    const upgraded = new AppDatabase(name, MESSAGING_WRAP_BASE_DB_VERSION + 1);
    await upgraded.initialize();
    await upgraded.commerce_messaging_links.put(legacyLinkRow());
    const newer = { ...legacyLinkRow(), snapshot: new Uint8Array([1, 2, 3]), ...saved };
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
      await upgraded.commerce_messaging_links.put(newer);
      return await encrypt(...args);
    });

    await migrateMessagingSecretsToWrappedStorage(upgraded);

    const link = (await upgraded.commerce_messaging_links.get(`${OWNER}:${COUNTERPARTY}`))!;
    expect({ ...link, snapshot: [...link.snapshot] }).toEqual({ ...newer, snapshot: [1, 2, 3] });
    vi.restoreAllMocks();
    upgraded.close();
  });

  it.each([
    ['a wrapped key this build saved', { wrap_version: 1 }],
    ['a plaintext key an older build saved', {}],
  ])(
    'never puts a legacy receiver key back over %s in another tab while it was being wrapped',
    async (_label, saved) => {
      const name = `franky-mig-${crypto.randomUUID()}`;
      await seedLegacyV4Database(name);
      const upgraded = new AppDatabase(name, MESSAGING_WRAP_BASE_DB_VERSION + 1);
      await upgraded.initialize();
      await upgraded.commerce_messaging_receivers.put(legacyReceiverRow());
      const newer = {
        ...legacyReceiverRow(),
        noise_secret: new Uint8Array(32).fill(3),
        noise_public_key: 'q'.repeat(52),
        ...saved,
      };
      const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
      vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
        await upgraded.commerce_messaging_receivers.put(newer);
        return await encrypt(...args);
      });

      await migrateMessagingSecretsToWrappedStorage(upgraded);

      const receiver = (await upgraded.commerce_messaging_receivers.get(OWNER))!;
      expect({ ...receiver, noise_secret: [...receiver.noise_secret] }).toEqual({
        ...newer,
        noise_secret: [...newer.noise_secret],
      });
      vi.restoreAllMocks();
      upgraded.close();
    },
  );

  it('fails closed when WebCrypto is unavailable — never continues with plaintext', async () => {
    const name = `franky-mig-${crypto.randomUUID()}`;
    await seedLegacyV4Database(name);
    const upgraded = new AppDatabase(name, MESSAGING_WRAP_BASE_DB_VERSION + 1);

    dropCachedWrappingKeyForTests();
    const { subtle: _subtle, ...rest } = globalThis.crypto;
    vi.stubGlobal('crypto', rest);

    await expect(upgraded.initialize()).rejects.toSatisfy((error) => isAppError(error));
    // The plaintext row is still there, unread by this build — not wiped, not "migrated".
    vi.unstubAllGlobals();
    const receiver = (await upgraded.commerce_messaging_receivers.get(OWNER))!;
    expect(receiver.wrap_version).toBeUndefined();
    upgraded.close();
    await resetMessagingKeyringForTests();
  });
});

/** A history row as builds before sealed bodies wrote it: plaintext body, no wrap_version. */
function legacyMessageRow(suffix: string): CommerceMessagingMessageModelSchema {
  return {
    id: `${OWNER}:event-${suffix}`,
    owner_id: OWNER,
    conversation_id: `conversation:${COUNTERPARTY}_${OWNER}_L1`,
    listing_ref: `listing:${COUNTERPARTY}:L1`,
    counterparty_pubky: COUNTERPARTY,
    direction: 'received',
    body: `plaintext ${suffix}`,
    sent_at: 1,
    recorded_at: 1,
  };
}

/** A queued row as builds before sealed bodies wrote it. */
function legacyOutboxRow(suffix: string): CommerceMessagingOutboxModelSchema {
  return {
    id: `queued-${suffix}`,
    owner_pubky: OWNER,
    counterparty_pubky: COUNTERPARTY,
    kind: 'dm',
    conversation_id: null,
    listing_ref: null,
    body: `queued ${suffix}`,
    queued_at: 1,
    attempts: 0,
    last_attempt_at: null,
    last_error: null,
  };
}

async function openedBody(table: string, row: { id: string; sealed_body?: Uint8Array }): Promise<string> {
  const key = await getOrCreateWrappingKey();
  return new TextDecoder().decode(await unwrapPayload(key, buildWrapAad(table, row.id), row.sealed_body!));
}

/** A database at `version` holding plaintext history and a plaintext queued message, as shipped builds left it. */
async function seedPlaintextHistory(name: string, version: number): Promise<void> {
  const shipped = new AppDatabase(name, version);
  await shipped.initialize();
  await shipped.commerce_messaging_messages.bulkPut([legacyMessageRow('a'), legacyMessageRow('b')]);
  await shipped.commerce_messaging_outbox.put(legacyOutboxRow('a'));
  await shipped.user_counts.put({ id: OWNER, followers: 3 } as never);
  shipped.close();
}

describe('migrateMessagingHistoryToWrappedStorage (plaintext history sealed in place)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('seals plaintext history and queued bodies on the next boot of a current database, wiping nothing', async () => {
    const name = `franky-hist-${crypto.randomUUID()}`;
    await seedPlaintextHistory(name, 8);

    const booted = new AppDatabase(name, 8);
    const result = await booted.initialize();

    expect(result).toEqual({ wasDbReset: false, messagingAtRestDegraded: false });
    await expect(booted.user_counts.get(OWNER)).resolves.toMatchObject({ followers: 3 });
    for (const suffix of ['a', 'b']) {
      const row = (await booted.commerce_messaging_messages.get(`${OWNER}:event-${suffix}`))!;
      expect(row).toMatchObject({ body: '', wrap_version: WRAP_VERSION_AES_GCM_256, direction: 'received' });
      await expect(openedBody('commerce_messaging_messages', row)).resolves.toBe(`plaintext ${suffix}`);
    }
    const queued = (await booted.commerce_messaging_outbox.get('queued-a'))!;
    expect(queued).toMatchObject({ body: '', wrap_version: WRAP_VERSION_AES_GCM_256 });
    await expect(openedBody('commerce_messaging_outbox', queued)).resolves.toBe('queued a');
    booted.close();
  });

  it('seals them during an in-place version upgrade too', async () => {
    const name = `franky-hist-${crypto.randomUUID()}`;
    await seedPlaintextHistory(name, 7);

    const upgraded = new AppDatabase(name, 8);
    const result = await upgraded.initialize();

    expect(result).toEqual({ wasDbReset: false, messagingAtRestDegraded: false });
    const row = (await upgraded.commerce_messaging_messages.get(`${OWNER}:event-a`))!;
    expect(row.wrap_version).toBe(WRAP_VERSION_AES_GCM_256);
    await expect(openedBody('commerce_messaging_messages', row)).resolves.toBe('plaintext a');
    upgraded.close();
  });

  it('is idempotent and leaves sealed rows and rows of an unknown format untouched', async () => {
    const name = `franky-hist-${crypto.randomUUID()}`;
    await seedPlaintextHistory(name, 8);
    const booted = new AppDatabase(name, 8);
    await booted.initialize();
    const future = { ...legacyMessageRow('future'), body: 'not plaintext', wrap_version: 7 };
    await booted.commerce_messaging_messages.put(future);
    const sealedBefore = [...(await booted.commerce_messaging_messages.get(`${OWNER}:event-a`))!.sealed_body!];

    await migrateMessagingHistoryToWrappedStorage(booted);
    await migrateMessagingHistoryToWrappedStorage(booted);

    const sealedAfter = [...(await booted.commerce_messaging_messages.get(`${OWNER}:event-a`))!.sealed_body!];
    expect(sealedAfter).toEqual(sealedBefore);
    await expect(booted.commerce_messaging_messages.get(future.id)).resolves.toEqual(future);
    booted.close();
  });

  it('never seals an older body over one another tab rewrote while it was being wrapped', async () => {
    const name = `franky-hist-${crypto.randomUUID()}`;
    const database = new AppDatabase(name, 8);
    await database.initialize();
    await database.commerce_messaging_messages.put(legacyMessageRow('a'));
    const rewritten = { ...legacyMessageRow('a'), body: 'rewritten meanwhile' };
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
      await database.commerce_messaging_messages.put(rewritten);
      return await encrypt(...args);
    });

    await migrateMessagingHistoryToWrappedStorage(database);

    await expect(database.commerce_messaging_messages.get(rewritten.id)).resolves.toEqual(rewritten);
    vi.restoreAllMocks();
    // The next sweep seals what is there now.
    await migrateMessagingHistoryToWrappedStorage(database);
    const row = (await database.commerce_messaging_messages.get(rewritten.id))!;
    await expect(openedBody('commerce_messaging_messages', row)).resolves.toBe('rewritten meanwhile');
    database.close();
  });

  it('seals a history larger than one batch', async () => {
    const name = `franky-hist-${crypto.randomUUID()}`;
    const database = new AppDatabase(name, 8);
    await database.initialize();
    await database.commerce_messaging_messages.bulkPut(
      Array.from({ length: 450 }, (_, index) => legacyMessageRow(String(index))),
    );

    await migrateMessagingHistoryToWrappedStorage(database);

    const rows = await database.commerce_messaging_messages.toArray();
    expect(rows).toHaveLength(450);
    expect(rows.every((row) => row.wrap_version === WRAP_VERSION_AES_GCM_256 && row.body === '')).toBe(true);
    database.close();
  });

  it('reports messaging degraded, and keeps the plaintext readable, when sealing fails', async () => {
    const name = `franky-hist-${crypto.randomUUID()}`;
    await seedPlaintextHistory(name, 8);
    const booted = new AppDatabase(name, 8);
    vi.spyOn(crypto.subtle, 'encrypt').mockRejectedValue(new Error('encrypt unavailable'));

    const result = await booted.initialize();

    expect(result).toEqual({ wasDbReset: false, messagingAtRestDegraded: true });
    await expect(booted.commerce_messaging_messages.get(`${OWNER}:event-a`)).resolves.toEqual(legacyMessageRow('a'));
    vi.restoreAllMocks();
    // A later boot seals it.
    await expect(booted.initialize()).resolves.toEqual({ wasDbReset: false, messagingAtRestDegraded: false });
    expect((await booted.commerce_messaging_messages.get(`${OWNER}:event-a`))!.wrap_version).toBe(
      WRAP_VERSION_AES_GCM_256,
    );
    booted.close();
  });
});
