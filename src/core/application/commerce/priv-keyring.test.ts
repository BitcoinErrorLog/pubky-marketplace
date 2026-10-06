import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { privFamilyPath, type PrivKeyring, privKeyringRefusal } from '@/libs/commerce/priv-envelope';
import type { MarketplacePrivKeysResult } from '@/libs/commerce/priv-keys';
import { MarketplaceGatewayService } from '@/services/marketplace/marketplace';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import { MARKETPLACE_SESSION_GRANT } from '@/services/marketplace/marketplace-session-grant';
import { CommerceApplication } from './commerce';
import { CommercePrivKeyringApplication } from './priv-keyring';

const OWNER = 'o'.repeat(52);
const OTHER = 'p'.repeat(52);

const config = vi.hoisted(() => ({ mode: 'transaction-service' as string }));
vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => config.mode };
});

const session = vi.hoisted(() => ({ pubky: null as string | null }));

/** What deriving a path from `held` throws, or undefined when it is still live. */
function refusalOf(held: PrivKeyring): unknown {
  try {
    privFamilyPath(held, 'watchlist');
    return undefined;
  } catch (error) {
    return error;
  }
}

function keyring(owner = OWNER): PrivKeyring {
  return {
    ownerPubky: owner,
    currentKeyId: 'a'.repeat(32),
    keys: [{ keyId: 'a'.repeat(32), key: new Uint8Array(32).fill(5) }],
  };
}

describe('CommercePrivKeyringApplication', () => {
  beforeEach(() => {
    config.mode = 'transaction-service';
    session.pubky = OWNER;
    vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockImplementation(() =>
      session.pubky
        ? {
            token: 't',
            sessionId: 's',
            pubky: session.pubky,
            capabilities: MARKETPLACE_SESSION_GRANT,
            expiresAt: '',
            expiresAtMs: 0,
            issuedAt: '',
          }
        : null,
    );
    CommercePrivKeyringApplication.clear();
  });

  afterEach(() => {
    CommercePrivKeyringApplication.clear();
    vi.restoreAllMocks();
  });

  it('reads the keys once and serves them from memory for the same owner', async () => {
    const read = vi
      .spyOn(MarketplaceGatewayService, 'getPrivKeys')
      .mockResolvedValue({ kind: 'keys', keyring: keyring() });
    const [first, second] = await Promise.all([
      CommercePrivKeyringApplication.get(OWNER),
      CommercePrivKeyringApplication.get(OWNER),
    ]);
    const third = await CommercePrivKeyringApplication.get(OWNER);
    expect(first.kind).toBe('keys');
    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(read).toHaveBeenCalledOnce();
  });

  it('zeroes and drops the keys on sign-out teardown', async () => {
    const held = keyring();
    const read = vi.spyOn(MarketplaceGatewayService, 'getPrivKeys').mockResolvedValue({ kind: 'keys', keyring: held });
    await CommercePrivKeyringApplication.get(OWNER);

    CommerceApplication.clearMarketplaceSession();

    expect(Array.from(held.keys[0].key).every((byte) => byte === 0)).toBe(true);
    // Revoked, not merely wiped: an operation still holding the object is refused as revoked.
    let refusal: unknown;
    try {
      privFamilyPath(held, 'watchlist');
    } catch (error) {
      refusal = error;
    }
    expect(privKeyringRefusal(refusal)).toBe('revoked');
    session.pubky = OWNER;
    read.mockResolvedValue({ kind: 'keys', keyring: keyring() });
    await CommercePrivKeyringApplication.get(OWNER);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('drops the keys when the marketplace session ends on its own', async () => {
    const held = keyring();
    vi.spyOn(MarketplaceGatewayService, 'getPrivKeys').mockResolvedValue({ kind: 'keys', keyring: held });
    vi.mocked(MarketplaceSessionService.getActiveSession).mockRestore();
    MarketplaceSessionService.establishClaimedGrantSession(
      {
        token: 'A'.repeat(43),
        pubky: OWNER,
        capabilities: MARKETPLACE_SESSION_GRANT,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
      OWNER,
    );
    await CommercePrivKeyringApplication.get(OWNER);
    expect(Array.from(held.keys[0].key).every((byte) => byte === 5)).toBe(true);

    MarketplaceSessionService.clearSession('rejected');
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

    expect(Array.from(held.keys[0].key).every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    ['another account', OTHER],
    ['the same account', OWNER],
  ])('zeroes the keys before a new session for %s replaces the live one', async (_name, next) => {
    const held = keyring();
    const read = vi.spyOn(MarketplaceGatewayService, 'getPrivKeys').mockResolvedValue({ kind: 'keys', keyring: held });
    vi.mocked(MarketplaceSessionService.getActiveSession).mockRestore();
    const establish = (pubky: string) =>
      MarketplaceSessionService.establishClaimedGrantSession(
        {
          token: 'A'.repeat(43),
          pubky,
          capabilities: MARKETPLACE_SESSION_GRANT,
          expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        },
        pubky,
      );
    establish(OWNER);
    await CommercePrivKeyringApplication.get(OWNER);
    expect(Array.from(held.keys[0].key).every((byte) => byte === 5)).toBe(true);

    establish(next);

    expect(Array.from(held.keys[0].key).every((byte) => byte === 0)).toBe(true);
    read.mockResolvedValue({ kind: 'keys', keyring: keyring(next) });
    await CommercePrivKeyringApplication.get(next);
    expect(read).toHaveBeenCalledTimes(2);
    MarketplaceSessionService.clearSession();
  });

  it('holds no keys for anyone but the marketplace session owner', async () => {
    const held = keyring();
    const read = vi.spyOn(MarketplaceGatewayService, 'getPrivKeys').mockResolvedValue({ kind: 'keys', keyring: held });
    await CommercePrivKeyringApplication.get(OWNER);

    session.pubky = OTHER;
    expect(await CommercePrivKeyringApplication.get(OWNER)).toEqual({ kind: 'needs_reauth' });
    expect(Array.from(held.keys[0].key).every((byte) => byte === 0)).toBe(true);
    session.pubky = null;
    expect(await CommercePrivKeyringApplication.get(OWNER)).toEqual({ kind: 'needs_reauth' });
    expect(read).toHaveBeenCalledOnce();
  });

  it('does not cache a refusal, so a re-approval is picked up on the next call', async () => {
    const read = vi
      .spyOn(MarketplaceGatewayService, 'getPrivKeys')
      .mockResolvedValueOnce({ kind: 'needs_reauth' })
      .mockResolvedValueOnce({ kind: 'unavailable' })
      .mockResolvedValueOnce({ kind: 'keys', keyring: keyring() });
    expect((await CommercePrivKeyringApplication.get(OWNER)).kind).toBe('needs_reauth');
    expect((await CommercePrivKeyringApplication.get(OWNER)).kind).toBe('unavailable');
    expect((await CommercePrivKeyringApplication.get(OWNER)).kind).toBe('keys');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('discards keys that arrive after a sign-out started', async () => {
    const held = keyring();
    let release: (value: MarketplacePrivKeysResult) => void = () => {};
    vi.spyOn(MarketplaceGatewayService, 'getPrivKeys').mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const pending = CommercePrivKeyringApplication.get(OWNER);
    CommercePrivKeyringApplication.clear();
    release({ kind: 'keys', keyring: held });

    expect(await pending).toEqual({ kind: 'needs_reauth' });
    expect(Array.from(held.keys[0].key).every((byte) => byte === 0)).toBe(true);
  });

  describe.each([
    ['releases keys', 'keys'],
    ['is refused', 'refused'],
    ['fails', 'fails'],
  ] as const)('when a fetch that went stale %s after a session replacement', (_name, staleOutcome) => {
    it.each([
      ['the same account', OWNER],
      ['another account', OTHER],
    ])('the next replacement, by %s, still revokes the keys the new session handed out', async (_who, next) => {
      const fetches: { resolve: (value: MarketplacePrivKeysResult) => void; reject: (error: unknown) => void }[] = [];
      const read = vi.spyOn(MarketplaceGatewayService, 'getPrivKeys').mockImplementation(
        () =>
          new Promise((resolve, reject) => {
            fetches.push({ resolve, reject });
          }),
      );
      vi.mocked(MarketplaceSessionService.getActiveSession).mockRestore();
      const establish = (pubky: string) =>
        MarketplaceSessionService.establishClaimedGrantSession(
          {
            token: 'A'.repeat(43),
            pubky,
            capabilities: MARKETPLACE_SESSION_GRANT,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          },
          pubky,
        );
      const stale = keyring();
      const handedOut = keyring();

      establish(OWNER);
      const fetchA = CommercePrivKeyringApplication.get(OWNER);
      establish(OWNER);
      const fetchB = CommercePrivKeyringApplication.get(OWNER);
      if (staleOutcome === 'keys') fetches[0].resolve({ kind: 'keys', keyring: stale });
      if (staleOutcome === 'refused') fetches[0].resolve({ kind: 'needs_reauth' });
      if (staleOutcome === 'fails') fetches[0].reject(new Error('network'));
      await fetchA.catch(() => undefined);
      const fetchC = CommercePrivKeyringApplication.get(OWNER);
      fetches[1].resolve({ kind: 'keys', keyring: handedOut });
      expect(await fetchB).toEqual({ kind: 'keys', keyring: handedOut });
      for (const extra of fetches.slice(2)) extra.resolve({ kind: 'keys', keyring: keyring() });
      await fetchC;

      establish(next);

      if (staleOutcome === 'keys') expect(privKeyringRefusal(refusalOf(stale))).toBe('revoked');
      expect(privKeyringRefusal(refusalOf(handedOut))).toBe('revoked');
      expect(read).toHaveBeenCalledTimes(2);
      MarketplaceSessionService.clearSession();
    });
  });

  it('exports the released keys as the recovery file, or passes the refusal through', async () => {
    vi.spyOn(MarketplaceGatewayService, 'getPrivKeys')
      .mockResolvedValueOnce({ kind: 'needs_reauth' })
      .mockResolvedValueOnce({ kind: 'keys', keyring: keyring() });

    expect(await CommercePrivKeyringApplication.exportRecoveryKey(OWNER)).toEqual({ kind: 'needs_reauth' });
    const exported = await CommercePrivKeyringApplication.exportRecoveryKey(OWNER);
    expect(exported.kind).toBe('file');
    if (exported.kind !== 'file') return;
    expect(JSON.parse(exported.file.contents)).toMatchObject({
      owner: OWNER,
      currentKeyId: 'a'.repeat(32),
      keys: [{ keyId: 'a'.repeat(32), key: 'BQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQU' }],
    });
  });

  it('is unavailable outside the durable service', async () => {
    config.mode = 'sandbox';
    const read = vi.spyOn(MarketplaceGatewayService, 'getPrivKeys');
    expect(await CommercePrivKeyringApplication.get(OWNER)).toEqual({ kind: 'unavailable' });
    expect(read).not.toHaveBeenCalled();
  });
});
