// @vitest-environment node
import { createHmac } from 'node:crypto';
import type { EncryptionKeys } from '@synonymdev/pubky';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrivKeyring } from '@/libs/commerce/priv-envelope';
import { type PrivWrappedKeyEnvelope, unwrapPrivDataKey, wrapPrivDataKey } from '@/libs/commerce/priv-key-wrap';
import type { MarketplacePrivKeysRead } from '@/libs/commerce/priv-keys';
import { CommercePrivWrappedKeysStoreService } from '@/services/homeserver/commerce/priv-wrapped-keys-store';
import { HomeserverService } from '@/services/homeserver/homeserver';
import { MarketplaceGatewayService } from '@/services/marketplace/marketplace';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import { MARKETPLACE_SESSION_GRANT } from '@/services/marketplace/marketplace-session-grant';
import { asOpaque } from '@/test-utils/type-assertions';
import { CommercePrivKeyringApplication } from './priv-keyring';

const OWNER = 'o'.repeat(52);
const KEY_A = '0123456789abcdef0123456789abcdef';
const KEY_B = 'fedcba9876543210fedcba9876543210';

const config = vi.hoisted(() => ({ mode: 'transaction-service' as string }));
vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => config.mode };
});

type ServiceState = {
  keys: { keyId: string; key: Uint8Array }[];
  released: boolean;
  read: 'normal' | 'needs_reauth' | 'unavailable';
  release: 'ok' | 'needs_reauth' | 'unavailable' | 'key_set_changed' | 'throws';
};

function serviceKeyring(state: ServiceState): PrivKeyring {
  return {
    ownerPubky: OWNER,
    currentKeyId: state.keys[state.keys.length - 1].keyId,
    keys: state.keys.map(({ keyId, key }) => ({ keyId, key: Uint8Array.from(key) })),
  };
}

/** A signer that derives one stable key per file under `/priv/pubky.app/marketplace/`, and records that it was freed. */
function signerKeys(root = 'signer-root', scopes = ['/priv/pubky.app/marketplace/']) {
  const free = vi.fn();
  const keys = {
    scopes,
    free,
    deriveForPath(path: string): Uint8Array {
      if (!scopes.some((scope) => path.startsWith(scope))) throw new Error('OutsideScope');
      return new Uint8Array(createHmac('sha256', root).update(path).digest());
    },
  };
  return { keys: asOpaque<EncryptionKeys>(keys), free, deriver: keys };
}

describe('CommercePrivKeyringApplication with scoped encryption keys (Phase 4)', () => {
  let homeserver: Map<string, unknown>;
  let service: ServiceState;
  let signer: ReturnType<typeof signerKeys> | null;
  let writes: string[];
  let releaseCalls: string[][];
  let serviceReads: number;

  const stored = (keyId: string) => homeserver.get(keyId) as PrivWrappedKeyEnvelope | undefined;

  beforeEach(() => {
    config.mode = 'transaction-service';
    homeserver = new Map();
    writes = [];
    releaseCalls = [];
    serviceReads = 0;
    service = {
      keys: [{ keyId: KEY_A, key: new Uint8Array(32).fill(5) }],
      released: false,
      read: 'normal',
      release: 'ok',
    };
    signer = signerKeys();

    vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue({
      token: 't',
      sessionId: 's',
      pubky: OWNER,
      capabilities: MARKETPLACE_SESSION_GRANT,
      expiresAt: '',
      expiresAtMs: 0,
      issuedAt: '',
    });
    vi.spyOn(HomeserverService, 'getCurrentSessionEncryptionKeys').mockImplementation(() => signer?.keys ?? null);

    vi.spyOn(MarketplaceGatewayService, 'getPrivKeys').mockImplementation(
      async (): Promise<MarketplacePrivKeysRead> => {
        serviceReads += 1;
        if (service.read === 'needs_reauth') return { kind: 'needs_reauth' };
        if (service.read === 'unavailable') return { kind: 'unavailable' };
        if (service.released) return { kind: 'released' };
        return { kind: 'keys', keyring: serviceKeyring(service) };
      },
    );
    vi.spyOn(MarketplaceGatewayService, 'releasePrivKeyCustody').mockImplementation(async (_actor, keyIds) => {
      releaseCalls.push([...keyIds]);
      if (service.release === 'throws') throw new Error('network');
      if (service.release !== 'ok') return service.release;
      service.released = true;
      service.keys = [];
      return 'released';
    });

    vi.spyOn(CommercePrivWrappedKeysStoreService, 'listKeyIds').mockImplementation(async () => [...homeserver.keys()]);
    vi.spyOn(CommercePrivWrappedKeysStoreService, 'read').mockImplementation(
      async (_owner, keyId) => homeserver.get(keyId) ?? null,
    );
    vi.spyOn(CommercePrivWrappedKeysStoreService, 'write').mockImplementation(async (_owner, envelope) => {
      writes.push(envelope.kid);
      homeserver.set(envelope.kid, envelope);
    });
    CommercePrivKeyringApplication.clear();
  });

  afterEach(() => {
    CommercePrivKeyringApplication.clear();
    vi.restoreAllMocks();
  });

  async function get() {
    return await CommercePrivKeyringApplication.get(OWNER);
  }

  function opened(keyId: string) {
    const envelope = stored(keyId);
    if (!signer) throw new Error('no signer');
    return unwrapPrivDataKey({ ownerPubky: OWNER, deriver: signer.deriver, keyId, envelope });
  }

  it('wraps the service key under the signer key, verifies it, then has the service drop its copy', async () => {
    const result = await get();

    expect(result.kind).toBe('keys');
    if (result.kind !== 'keys') return;
    expect(result.keyring.currentKeyId).toBe(KEY_A);
    expect(Array.from(result.keyring.keys[0].key)).toEqual(Array.from(new Uint8Array(32).fill(5)));
    expect(writes).toEqual([KEY_A]);
    expect(Array.from(opened(KEY_A).key)).toEqual(Array.from(new Uint8Array(32).fill(5)));
    expect(opened(KEY_A).generation).toBe(1);
    expect(releaseCalls).toEqual([[KEY_A]]);
    expect(service.released).toBe(true);
    expect(signer?.free).toHaveBeenCalled();
  });

  it('never asks the service to release before every wrapped file is written', async () => {
    service.keys.push({ keyId: KEY_B, key: new Uint8Array(32).fill(6) });
    const order: string[] = [];
    vi.mocked(CommercePrivWrappedKeysStoreService.write).mockImplementation(async (_owner, envelope) => {
      order.push(`write:${envelope.kid}`);
      homeserver.set(envelope.kid, envelope);
    });
    vi.mocked(MarketplaceGatewayService.releasePrivKeyCustody).mockImplementation(async (_actor, keyIds) => {
      order.push(`release:${keyIds.join(',')}`);
      return 'released';
    });

    const result = await get();

    expect(order).toEqual([`write:${KEY_A}`, `write:${KEY_B}`, `release:${KEY_A},${KEY_B}`]);
    expect(opened(KEY_B).generation).toBe(2);
    expect(result.kind === 'keys' && result.keyring.keys.map((key) => key.keyId)).toEqual([KEY_A, KEY_B]);
  });

  it('keeps the service copy when a wrapped file cannot be written, and surfaces the failure', async () => {
    vi.mocked(CommercePrivWrappedKeysStoreService.write).mockRejectedValue(new Error('homeserver down'));

    await expect(get()).rejects.toThrow('homeserver down');

    expect(releaseCalls).toEqual([]);
    expect(service.released).toBe(false);
    expect(service.keys).toHaveLength(1);
  });

  it('uses the wrapped copies alone once the service has released custody', async () => {
    await get();
    CommercePrivKeyringApplication.clear();
    writes.length = 0;
    releaseCalls.length = 0;

    const second = await get();

    expect(second.kind).toBe('keys');
    expect(second.kind === 'keys' && Array.from(second.keyring.keys[0].key)).toEqual(
      Array.from(new Uint8Array(32).fill(5)),
    );
    expect(writes).toEqual([]);
    expect(releaseCalls).toEqual([]);
  });

  it('opens the wrapped copies when the service is down or refuses the session', async () => {
    await get();
    for (const read of ['unavailable', 'needs_reauth'] as const) {
      CommercePrivKeyringApplication.clear();
      service.read = read;
      const result = await get();
      expect(result.kind).toBe('keys');
    }
  });

  it('keeps the verified keys in use when the service refuses the release, and finishes it on the next read', async () => {
    service.release = 'needs_reauth';

    const first = await get();
    expect(first.kind).toBe('keys');
    expect(service.released).toBe(false);
    expect(releaseCalls).toEqual([[KEY_A]]);

    CommercePrivKeyringApplication.clear();
    service.release = 'ok';
    writes.length = 0;
    const second = await get();

    expect(second.kind).toBe('keys');
    expect(writes).toEqual([]);
    expect(releaseCalls).toEqual([[KEY_A], [KEY_A]]);
    expect(service.released).toBe(true);
  });

  it('does not fail a read when the release request itself errors', async () => {
    service.release = 'throws';
    const result = await get();
    expect(result.kind).toBe('keys');
    expect(service.released).toBe(false);
  });

  it('reads the keys again when the service says its key set changed, then gives up after a few tries', async () => {
    service.release = 'key_set_changed';

    const result = await get();

    expect(result).toEqual({ kind: 'unavailable' });
    expect(releaseCalls).toHaveLength(3);
    expect(serviceReads).toBe(3);
  });

  it('wraps only the keys that have no matching wrapped file', async () => {
    await get();
    CommercePrivKeyringApplication.clear();
    service = {
      ...service,
      released: false,
      keys: [
        { keyId: KEY_A, key: new Uint8Array(32).fill(5) },
        { keyId: KEY_B, key: new Uint8Array(32).fill(6) },
      ],
    };
    writes.length = 0;
    releaseCalls.length = 0;

    const result = await get();

    expect(result.kind).toBe('keys');
    expect(writes).toEqual([KEY_B]);
    expect(releaseCalls).toEqual([[KEY_A, KEY_B]]);
  });

  it('rewrites a wrapped file that does not open to the key the service still holds', async () => {
    const other = signerKeys('some-other-root');
    homeserver.set(
      KEY_A,
      wrapPrivDataKey({
        ownerPubky: OWNER,
        deriver: other.deriver,
        key: { keyId: KEY_A, key: new Uint8Array(32).fill(9), generation: 1 },
      }),
    );

    const result = await get();

    expect(result.kind === 'keys' && Array.from(result.keyring.keys[0].key)).toEqual(
      Array.from(new Uint8Array(32).fill(5)),
    );
    expect(writes).toEqual([KEY_A]);
    expect(Array.from(opened(KEY_A).key)).toEqual(Array.from(new Uint8Array(32).fill(5)));
  });

  it('gives no keys, and writes nothing, when the service released custody and no wrapped file opens', async () => {
    service.released = true;
    homeserver.set(
      KEY_A,
      wrapPrivDataKey({
        ownerPubky: OWNER,
        deriver: signerKeys('some-other-root').deriver,
        key: { keyId: KEY_A, key: new Uint8Array(32).fill(9), generation: 1 },
      }),
    );

    expect(await get()).toEqual({ kind: 'unavailable' });
    expect(await CommercePrivKeyringApplication.exportRecoveryKey(OWNER)).toEqual({ kind: 'unavailable' });
    expect(writes).toEqual([]);
  });

  it('gives no keys when the service released custody and there is nothing wrapped, and never mints a new key', async () => {
    service.released = true;

    expect(await get()).toEqual({ kind: 'unavailable' });
    expect(writes).toEqual([]);
    expect(releaseCalls).toEqual([]);
  });

  it('refuses a wrapped set with a missing first key rather than deriving record paths from the wrong key', async () => {
    service.released = true;
    homeserver.set(
      KEY_B,
      wrapPrivDataKey({
        ownerPubky: OWNER,
        deriver: signer!.deriver,
        key: { keyId: KEY_B, key: new Uint8Array(32).fill(6), generation: 2 },
      }),
    );

    expect(await get()).toEqual({ kind: 'unavailable' });
  });

  describe('sessions that cannot deliver keys', () => {
    it('without scoped keys (cookie sign-in, bare grant, declined e) keeps using the service copy and touches no wrapped file', async () => {
      signer = null;

      const result = await get();

      expect(result.kind).toBe('keys');
      expect(writes).toEqual([]);
      expect(releaseCalls).toEqual([]);
      expect(service.released).toBe(false);
    });

    it('with keys that do not reach the key directory, treats the session as keyless', async () => {
      signer = signerKeys('signer-root', ['/priv/pubky.app/elsewhere/']);

      const result = await get();

      expect(result.kind).toBe('keys');
      expect(writes).toEqual([]);
      expect(releaseCalls).toEqual([]);
      expect(signer.free).toHaveBeenCalled();
    });

    it('after the service released custody has no keys, rather than a fresh one', async () => {
      signer = null;
      service.released = true;

      expect(await get()).toEqual({ kind: 'unavailable' });
    });

    it('passes the service refusals through unchanged', async () => {
      signer = null;
      service.read = 'needs_reauth';
      expect(await get()).toEqual({ kind: 'needs_reauth' });
      service.read = 'unavailable';
      expect(await get()).toEqual({ kind: 'unavailable' });
    });
  });

  it('zeroes the keys it holds on sign-out like any other keyring', async () => {
    const result = await get();
    if (result.kind !== 'keys') throw new Error('expected keys');
    const held = result.keyring;

    CommercePrivKeyringApplication.clear();

    expect(held.keys.every(({ key }) => key.every((byte) => byte === 0))).toBe(true);
  });

  it('serves the recovery export from the same keys', async () => {
    const exported = await CommercePrivKeyringApplication.exportRecoveryKey(OWNER);
    expect(exported.kind).toBe('file');
  });
});
