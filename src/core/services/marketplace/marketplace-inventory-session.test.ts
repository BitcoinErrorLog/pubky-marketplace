import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import captured from '@/test/fixtures/auth/marketplace-grant-priv-parity.staging.json';
import { INVENTORY_GRANT, INVENTORY_SESSION_STORAGE_KEY } from './marketplace-inventory-grant';
import { MarketplaceInventorySessionService } from './marketplace-inventory-session';
import { MARKETPLACE_SESSION_STORAGE_KEY, MarketplaceSessionService } from './marketplace-session';

const PUBKY = 'y'.repeat(52);
const TOKEN = 'A'.repeat(43);
const INVENTORY_TOKEN = 'I'.repeat(43);

const config = vi.hoisted(() => ({
  mode: 'transaction-service' as string,
}));

const authTokenFlow = vi.hoisted(() => ({
  awaitToken: vi.fn(),
  cancelAuthFlow: vi.fn(),
  capabilities: '' as string | undefined,
}));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return {
    ...actual,
    getCommerceAdapterMode: () => config.mode,
    getMarketplaceUrl: () => 'http://127.0.0.1:8080',
  };
});

vi.mock('@/services/homeserver/homeserver', () => ({
  HomeserverService: {
    generateAuthTokenFlow: (capabilities = '') => {
      authTokenFlow.capabilities = capabilities;
      return {
        authorizationUrl: 'pubkyauth:///?relay=http%3A%2F%2Flocalhost%2Finbox&secret=s',
        awaitToken: authTokenFlow.awaitToken,
        cancelAuthFlow: authTokenFlow.cancelAuthFlow,
      };
    },
  },
}));

function sessionResponse(expiresAt: string, token: string, capabilities: string): Response {
  return new Response(
    JSON.stringify({
      token,
      pubky: PUBKY,
      capabilities,
      expires_at: expiresAt,
      session_id: '11111111-1111-4111-8111-111111111111',
    }),
    { status: 201, headers: { 'content-type': 'application/json' } },
  );
}

function inOneDay(): string {
  return new Date(Date.now() + 86_400_000).toISOString();
}

async function establishIdentity(capabilities = ''): Promise<void> {
  vi.mocked(fetch).mockResolvedValueOnce(sessionResponse(inOneDay(), TOKEN, capabilities));
  await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1, 2, 3]), PUBKY);
}

describe('MarketplaceInventorySessionService', () => {
  beforeEach(() => {
    config.mode = 'transaction-service';
    authTokenFlow.capabilities = undefined;
    MarketplaceInventorySessionService.clearSession();
    MarketplaceSessionService.clearSession();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('mints with the inventory grant only and never overwrites the identity bearer', async () => {
    await establishIdentity();
    const identityBefore = window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY);
    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse(inOneDay(), INVENTORY_TOKEN, INVENTORY_GRANT));

    const bytes = new Uint8Array([9, 8, 7]);
    const info = await MarketplaceInventorySessionService.mintInventorySession(bytes, PUBKY);

    expect(info.capabilities).toBe(INVENTORY_GRANT);
    expect(fetch).toHaveBeenLastCalledWith(
      'http://127.0.0.1:8080/v1/auth/sessions',
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes,
      }),
    );
    expect(MarketplaceSessionService.getActiveSession()?.token).toBe(TOKEN);
    expect(window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY)).toBe(identityBefore);
    expect(MarketplaceInventorySessionService.getActiveSession()?.token).toBe(INVENTORY_TOKEN);
    expect(window.localStorage.getItem(INVENTORY_SESSION_STORAGE_KEY)).toContain(INVENTORY_TOKEN);
    expect(JSON.parse(window.localStorage.getItem(INVENTORY_SESSION_STORAGE_KEY) ?? '{}').capabilities).toBe(
      INVENTORY_GRANT,
    );
  });

  it('revert-fail: keeps a migration-0035 inventory session id through mint and restore', async () => {
    const legacySessionId = 'c91ac604-4109-a63d-ab8b-327fc9decd05';
    expect(z.uuid().safeParse(legacySessionId).success).toBe(false);
    await establishIdentity();
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          token: INVENTORY_TOKEN,
          pubky: PUBKY,
          capabilities: INVENTORY_GRANT,
          expires_at: inOneDay(),
          session_id: legacySessionId,
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      ),
    );
    await MarketplaceInventorySessionService.mintInventorySession(new Uint8Array([1]), PUBKY);
    expect(MarketplaceInventorySessionService.getActiveSession()?.sessionId).toBe(legacySessionId);

    const persisted = window.localStorage.getItem(INVENTORY_SESSION_STORAGE_KEY);
    MarketplaceInventorySessionService.clearSession();
    window.localStorage.setItem(INVENTORY_SESSION_STORAGE_KEY, persisted ?? '');
    expect(MarketplaceInventorySessionService.restorePersistedSession(PUBKY)?.pubky).toBe(PUBKY);
    expect(MarketplaceInventorySessionService.getActiveSession()?.sessionId).toBe(legacySessionId);
  });

  it('passes INVENTORY_GRANT into generateAuthTokenFlow', async () => {
    await establishIdentity();
    MarketplaceInventorySessionService.beginInventorySessionFlow(PUBKY);
    expect(authTokenFlow.capabilities).toBe(INVENTORY_GRANT);
    expect(authTokenFlow.capabilities).not.toBe('/:rw');
    expect(authTokenFlow.capabilities).not.toBe('');
  });

  it('refuses to mint when the identity session is missing', async () => {
    await expect(
      MarketplaceInventorySessionService.mintInventorySession(new Uint8Array([1]), PUBKY),
    ).rejects.toMatchObject({
      operation: 'mintInventorySession',
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not clear inventory when the identity session is dropped', async () => {
    await establishIdentity();
    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse(inOneDay(), INVENTORY_TOKEN, INVENTORY_GRANT));
    await MarketplaceInventorySessionService.mintInventorySession(new Uint8Array([1]), PUBKY);

    MarketplaceSessionService.clearSession('rejected');
    expect(MarketplaceInventorySessionService.getActiveSession()?.token).toBe(INVENTORY_TOKEN);
  });

  it('clears only the inventory slot', async () => {
    await establishIdentity();
    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse(inOneDay(), INVENTORY_TOKEN, INVENTORY_GRANT));
    await MarketplaceInventorySessionService.mintInventorySession(new Uint8Array([1]), PUBKY);

    MarketplaceInventorySessionService.clearSession('rejected');
    expect(MarketplaceInventorySessionService.getActiveSession()).toBeNull();
    expect(MarketplaceSessionService.getActiveSession()?.token).toBe(TOKEN);
  });

  it('clamps padded returned caps to the requested grant and refuses wider blobs', async () => {
    await establishIdentity();
    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse(inOneDay(), INVENTORY_TOKEN, ` ${INVENTORY_GRANT} `));
    const padded = await MarketplaceInventorySessionService.mintInventorySession(new Uint8Array([1]), PUBKY);
    expect(padded.capabilities).toBe(INVENTORY_GRANT);
    expect(JSON.parse(window.localStorage.getItem(INVENTORY_SESSION_STORAGE_KEY) ?? '{}').capabilities).toBe(
      INVENTORY_GRANT,
    );

    MarketplaceInventorySessionService.clearSession();
    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse(inOneDay(), INVENTORY_TOKEN, '/:rw'));
    await expect(
      MarketplaceInventorySessionService.mintInventorySession(new Uint8Array([1]), PUBKY),
    ).rejects.toMatchObject({ operation: 'mintInventorySession' });
    expect(MarketplaceInventorySessionService.getActiveSession()).toBeNull();
    expect(window.localStorage.getItem(INVENTORY_SESSION_STORAGE_KEY)).toBeNull();

    vi.mocked(fetch).mockResolvedValueOnce(sessionResponse(inOneDay(), INVENTORY_TOKEN, `${INVENTORY_GRANT},/:rw`));
    await expect(
      MarketplaceInventorySessionService.mintInventorySession(new Uint8Array([1]), PUBKY),
    ).rejects.toMatchObject({ operation: 'mintInventorySession' });
    expect(window.localStorage.getItem(INVENTORY_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('drops a restored session whose stored caps are wider than the Studio grant', () => {
    window.localStorage.setItem(
      INVENTORY_SESSION_STORAGE_KEY,
      JSON.stringify({
        token: INVENTORY_TOKEN,
        pubky: PUBKY,
        capabilities: '/:rw',
        expiresAt: inOneDay(),
      }),
    );
    expect(MarketplaceInventorySessionService.restorePersistedSession(PUBKY)).toBeNull();
    expect(window.localStorage.getItem(INVENTORY_SESSION_STORAGE_KEY)).toBeNull();
  });

  describe('getCoveringBearer', () => {
    it.each([
      ['the Bitkit parity grant', captured.parity_request.homeserver_verified],
      ['the previous service grant', captured.previous_request.homeserver_verified],
      ['the Shop sign-in grant', captured.shop_signin_request.homeserver_verified],
      ['root', '/:rw'],
    ])('uses the purchase session when it carries %s', async (_label, capabilities) => {
      await establishIdentity(capabilities);

      expect(MarketplaceInventorySessionService.getCoveringBearer(PUBKY)).toEqual({ token: TOKEN, source: 'purchase' });
    });

    it.each([
      ['an empty grant', ''],
      ['read only', '/pub/pubky.app/marketplace-service/v1/:r'],
      ['a narrower tree', '/pub/pubky.app/marketplace-service/v1/listings/:rw'],
      ['a sibling tree', '/pub/pubky.app/marketplace-service/v2/:rw'],
      ['only /priv', '/priv/pubky.app/:rw'],
      ['a path without a trailing slash', '/pub/pubky.app/marketplace-service:rw'],
      ['unknown actions', '/pub/pubky.app/marketplace-service/v1/:rwx'],
      ['repeated actions', '/pub/pubky.app/marketplace-service/v1/:rrw'],
    ])('needs a Studio grant when the purchase session carries %s', async (_label, capabilities) => {
      await establishIdentity(capabilities);

      expect(MarketplaceInventorySessionService.getCoveringBearer(PUBKY)).toBeNull();
    });

    it('never returns a purchase bearer for another pubky', async () => {
      await establishIdentity(captured.parity_request.homeserver_verified);

      expect(MarketplaceInventorySessionService.getCoveringBearer('z'.repeat(52))).toBeNull();
    });

    it('prefers the Studio session and clears only the session the service refused', async () => {
      await establishIdentity(captured.parity_request.homeserver_verified);
      vi.mocked(fetch).mockResolvedValueOnce(sessionResponse(inOneDay(), INVENTORY_TOKEN, INVENTORY_GRANT));
      await MarketplaceInventorySessionService.mintInventorySession(new Uint8Array([4]), PUBKY);

      const studio = MarketplaceInventorySessionService.getCoveringBearer(PUBKY);
      expect(studio).toEqual({ token: INVENTORY_TOKEN, source: 'inventory' });
      MarketplaceInventorySessionService.clearRejectedBearer(studio!);
      expect(MarketplaceInventorySessionService.getActiveSession()).toBeNull();
      expect(MarketplaceSessionService.getActiveSession()?.token).toBe(TOKEN);

      const purchase = MarketplaceInventorySessionService.getCoveringBearer(PUBKY);
      expect(purchase).toEqual({ token: TOKEN, source: 'purchase' });
      MarketplaceInventorySessionService.clearRejectedBearer(purchase!);
      expect(MarketplaceSessionService.getActiveSession()).toBeNull();
    });
  });
});
