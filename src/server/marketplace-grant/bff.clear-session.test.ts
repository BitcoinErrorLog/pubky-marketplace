/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSession } from './bff';
import { makeBoundCookie } from './crypto';

const ORIGIN = 'https://shop.example';

const bridges = vi.hoisted(() => ({
  rows: new Map<string, string>(),
  deleteBridge: vi.fn(),
  deleteBridgeForSession: vi.fn(),
}));

vi.mock('./config', () => ({
  getMarketplaceGrantConfig: () => ({ allowedOrigins: ['https://shop.example'] }),
}));

vi.mock('./db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./db')>()),
  deleteBridge: bridges.deleteBridge,
  deleteBridgeForSession: bridges.deleteBridgeForSession,
}));

const THIS_TAB_SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER_TAB_SESSION = '22222222-2222-4222-8222-222222222222';
const BRIDGE_ID = '33333333-3333-4333-8333-333333333333';

function request(query = ''): Request {
  return new Request(`${ORIGIN}/api/marketplace/session${query}`, {
    method: 'DELETE',
    headers: { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
  });
}

describe('BFF session unpair is scoped to the marketplace session a tab owns', () => {
  const cookie = makeBoundCookie(BRIDGE_ID).value;

  beforeEach(() => {
    bridges.rows = new Map([[BRIDGE_ID, OTHER_TAB_SESSION]]);
    bridges.deleteBridge.mockReset().mockImplementation(async (_config: unknown, id: string) => {
      bridges.rows.delete(id);
    });
    bridges.deleteBridgeForSession
      .mockReset()
      .mockImplementation(async (_config: unknown, id: string, sessionId: string) => {
        if (bridges.rows.get(id) === sessionId) {
          bridges.rows.delete(id);
          return true;
        }
        return !bridges.rows.has(id);
      });
  });

  it('keeps another tab’s newer pairing and its cookie when this tab’s session expires', async () => {
    const cleared = await clearSession(request(`?session_id=${THIS_TAB_SESSION}`), cookie);

    expect(cleared).toBe(false);
    expect(bridges.rows.get(BRIDGE_ID)).toBe(OTHER_TAB_SESSION);
    expect(bridges.deleteBridge).not.toHaveBeenCalled();
    expect(bridges.deleteBridgeForSession).toHaveBeenCalledWith(expect.anything(), BRIDGE_ID, THIS_TAB_SESSION);
  });

  it('unpairs the bridge when it still holds this tab’s session', async () => {
    bridges.rows.set(BRIDGE_ID, THIS_TAB_SESSION);
    expect(await clearSession(request(`?session_id=${THIS_TAB_SESSION}`), cookie)).toBe(true);
    expect(bridges.rows.has(BRIDGE_ID)).toBe(false);
  });

  it('sign-out (no session id) unpairs whatever the cookie names', async () => {
    expect(await clearSession(request(), cookie)).toBe(true);
    expect(bridges.deleteBridge).toHaveBeenCalledWith(expect.anything(), BRIDGE_ID);
    expect(bridges.deleteBridgeForSession).not.toHaveBeenCalled();
  });

  it('refuses a malformed session id before touching a bridge', async () => {
    await expect(clearSession(request('?session_id=not%0Aan-id'), cookie)).rejects.toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(bridges.deleteBridge).not.toHaveBeenCalled();
    expect(bridges.deleteBridgeForSession).not.toHaveBeenCalled();
  });
});
