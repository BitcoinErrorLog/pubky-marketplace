import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import captured from '@/test/fixtures/auth/marketplace-grant-priv-parity.staging.json';
import { MARKETPLACE_SESSION_STORAGE_KEY, MarketplaceSessionService } from './marketplace-session';

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return {
    ...actual,
    getCommerceAdapterMode: () => 'transaction-service',
    getMarketplaceUrl: () => 'http://127.0.0.1:8080',
  };
});

const config = vi.hoisted(() => ({ grantFlow: true }));
vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>()),
  getMarketplaceGrantFlowEnabled: () => config.grantFlow,
}));

const PUBKY = 'y'.repeat(52);
const THIS_TAB = { token: 'A'.repeat(43), sessionId: '11111111-1111-4111-8111-111111111111' };
const OTHER_TAB = { token: 'B'.repeat(43), sessionId: '22222222-2222-4222-8222-222222222222' };
const parity = captured.parity_request.homeserver_verified;
const HOUR = 3_600_000;

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** This tab holds a session expiring in `ttlMs`, persisted by its own writer. */
function thisTabHolds(ttlMs: number) {
  return MarketplaceSessionService.establishClaimedGrantSession(
    { ...THIS_TAB, pubky: PUBKY, capabilities: parity, expiresAt: iso(Date.now() + ttlMs) },
    PUBKY,
  );
}

/** Another tab's writer leaves its newer bearer in the shared slot. */
function otherTabPersists(ttlMs: number): string {
  const blob = JSON.stringify({ ...OTHER_TAB, pubky: PUBKY, capabilities: parity, expiresAt: iso(Date.now() + ttlMs) });
  window.localStorage.setItem(MARKETPLACE_SESSION_STORAGE_KEY, blob);
  return blob;
}

function stored(): string | null {
  return window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY);
}

let fetchSpy: MockInstance<typeof fetch>;

function bffDeletes(): string[] {
  return fetchSpy.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => String(url));
}

describe('purchase-session persistence: a tab only removes the record it owns', () => {
  beforeEach(() => {
    config.grantFlow = true;
    MarketplaceSessionService.clearForSignOut();
    window.localStorage.clear();
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 204 }));
  });

  afterEach(() => {
    vi.useRealTimers();
    fetchSpy.mockRestore();
  });

  it('expiry in this tab keeps the newer bearer another tab persisted', () => {
    vi.useFakeTimers();
    thisTabHolds(HOUR);
    vi.advanceTimersByTime(30 * 60_000);
    const newer = otherTabPersists(24 * HOUR);
    fetchSpy.mockClear();

    vi.advanceTimersByTime(30 * 60_000);
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();

    expect(stored()).toBe(newer);
    expect(bffDeletes()).toEqual([`/api/marketplace/session?session_id=${THIS_TAB.sessionId}`]);
  });

  it('adopting the newer persisted bearer while memory expires keeps it persisted', () => {
    vi.useFakeTimers();
    thisTabHolds(HOUR);
    vi.advanceTimersByTime(30 * 60_000);
    const newer = otherTabPersists(24 * HOUR);
    vi.advanceTimersByTime(30 * 60_000);

    const restored = MarketplaceSessionService.restorePersistedSession(PUBKY);

    expect(restored?.capabilities).toBe(parity);
    expect(MarketplaceSessionService.getActiveSession()?.token).toBe(OTHER_TAB.token);
    expect(stored()).toBe(newer);
  });

  it('expiry still removes this tab’s own record', () => {
    vi.useFakeTimers();
    thisTabHolds(HOUR);
    vi.advanceTimersByTime(HOUR);

    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
    expect(stored()).toBeNull();
  });

  it('a 401 for the bearer a request carried never clears a newer session adopted meanwhile', () => {
    thisTabHolds(HOUR);
    const newer = otherTabPersists(24 * HOUR);
    vi.useFakeTimers();
    vi.advanceTimersByTime(HOUR);
    MarketplaceSessionService.restorePersistedSession(PUBKY);

    MarketplaceSessionService.clearSessionIfBearer(THIS_TAB.token, 'rejected');

    expect(MarketplaceSessionService.getActiveSession()?.token).toBe(OTHER_TAB.token);
    expect(stored()).toBe(newer);
  });

  it('a 401 for the current bearer removes it and only its record', () => {
    thisTabHolds(HOUR);
    MarketplaceSessionService.clearSessionIfBearer(THIS_TAB.token, 'rejected');
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
    expect(stored()).toBeNull();
  });

  it('an explicit clear in this tab leaves another tab’s newer record', () => {
    thisTabHolds(HOUR);
    const newer = otherTabPersists(24 * HOUR);
    MarketplaceSessionService.clearSession('cleared');
    expect(stored()).toBe(newer);
  });

  it('a clear with nothing in memory removes nothing and unpairs nothing', () => {
    const newer = otherTabPersists(24 * HOUR);
    fetchSpy.mockClear();
    MarketplaceSessionService.clearSession('cleared');
    expect(stored()).toBe(newer);
    expect(bffDeletes()).toEqual([]);
  });

  it('a session without an id never asks the BFF to unpair the shared cookie', () => {
    MarketplaceSessionService.establishClaimedGrantSession(
      { token: THIS_TAB.token, pubky: PUBKY, capabilities: parity, expiresAt: iso(Date.now() + HOUR) },
      PUBKY,
    );
    fetchSpy.mockClear();
    MarketplaceSessionService.clearSession('rejected');
    expect(bffDeletes()).toEqual([]);
  });

  it('a mint that lands after another tab persisted a newer bearer does not overwrite it', () => {
    const newer = otherTabPersists(24 * HOUR);
    thisTabHolds(HOUR);
    expect(MarketplaceSessionService.getActiveSession()?.token).toBe(THIS_TAB.token);
    expect(stored()).toBe(newer);
  });

  it('a mint overwrites an older record', () => {
    otherTabPersists(HOUR);
    thisTabHolds(24 * HOUR);
    expect(JSON.parse(stored()!)).toMatchObject({ token: THIS_TAB.token });
  });

  it('sign-out removes whatever bearer is at rest and unpairs the cookie unscoped', () => {
    thisTabHolds(HOUR);
    otherTabPersists(24 * HOUR);
    fetchSpy.mockClear();

    MarketplaceSessionService.clearForSignOut();

    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
    expect(stored()).toBeNull();
    expect(bffDeletes()).toEqual(['/api/marketplace/session']);
  });

  it('old memory at its expiry margin with a newer valid record: restore adopts it and it survives the next reload', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    thisTabHolds(HOUR);
    vi.setSystemTime(Date.now() + HOUR - 30_000);
    const newer = otherTabPersists(24 * HOUR);

    expect(MarketplaceSessionService.restorePersistedSession(PUBKY)?.capabilities).toBe(parity);
    expect(MarketplaceSessionService.getActiveSession()?.token).toBe(OTHER_TAB.token);
    expect(stored()).toBe(newer);

    vi.resetModules();
    const { MarketplaceSessionService: afterReload } = await import('./marketplace-session');
    expect(afterReload.restorePersistedSession(PUBKY)?.capabilities).toBe(parity);
    expect(afterReload.getActiveSession()?.token).toBe(OTHER_TAB.token);
  });

  it('an account switch drops the departed account’s bearer from memory and rest, and keeps the new account’s', () => {
    thisTabHolds(HOUR);
    MarketplaceSessionService.clearOtherAccounts('z'.repeat(52));
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
    expect(stored()).toBeNull();

    const kept = otherTabPersists(HOUR);
    MarketplaceSessionService.clearOtherAccounts(PUBKY);
    expect(stored()).toBe(kept);
  });

  it('an account switch unpairs the BFF session of the departed record, and only that one', () => {
    const departed = JSON.stringify({
      ...OTHER_TAB,
      pubky: 'z'.repeat(52),
      capabilities: parity,
      expiresAt: iso(Date.now() + 24 * HOUR),
    });
    window.localStorage.setItem(MARKETPLACE_SESSION_STORAGE_KEY, departed);
    fetchSpy.mockClear();

    MarketplaceSessionService.clearOtherAccounts(PUBKY);

    expect(stored()).toBeNull();
    expect(bffDeletes()).toEqual([`/api/marketplace/session?session_id=${OTHER_TAB.sessionId}`]);
  });

  it('an account switch persists the new account’s bearer that a later-expiring departed record kept out', () => {
    window.localStorage.setItem(
      MARKETPLACE_SESSION_STORAGE_KEY,
      JSON.stringify({
        ...OTHER_TAB,
        pubky: 'z'.repeat(52),
        capabilities: parity,
        expiresAt: iso(Date.now() + 48 * HOUR),
      }),
    );
    thisTabHolds(HOUR);
    expect(JSON.parse(stored()!)).toMatchObject({ token: OTHER_TAB.token });

    MarketplaceSessionService.clearOtherAccounts(PUBKY);

    expect(JSON.parse(stored()!)).toMatchObject({ token: THIS_TAB.token, pubky: PUBKY });
  });

  it('restore leaves another account’s record in place', () => {
    const foreign = JSON.stringify({
      ...OTHER_TAB,
      pubky: 'z'.repeat(52),
      capabilities: parity,
      expiresAt: iso(Date.now() + 24 * HOUR),
    });
    window.localStorage.setItem(MARKETPLACE_SESSION_STORAGE_KEY, foreign);
    expect(MarketplaceSessionService.restorePersistedSession(PUBKY)).toBeNull();
    expect(stored()).toBe(foreign);
  });

  it('restore drops an expired record it read, and only that record', () => {
    vi.useFakeTimers();
    const expired = otherTabPersists(10_000);
    vi.advanceTimersByTime(20_000);
    expect(stored()).toBe(expired);
    expect(MarketplaceSessionService.restorePersistedSession(PUBKY)).toBeNull();
    expect(stored()).toBeNull();
  });
});
