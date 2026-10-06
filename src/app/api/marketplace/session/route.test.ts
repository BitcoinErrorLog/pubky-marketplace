/** @vitest-environment node */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DELETE } from './route';

const bff = vi.hoisted(() => ({ cleared: true }));

vi.mock('@/server/marketplace-grant/bff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/marketplace-grant/bff')>()),
  clearSession: async () => bff.cleared,
}));

function del(): NextRequest {
  return new NextRequest('https://shop.example/api/marketplace/session?session_id=x', { method: 'DELETE' });
}

function deletedCookies(response: Response): string[] {
  return response.headers
    .getSetCookie()
    .filter((cookie) => /Max-Age=0|Expires=Thu, 01 Jan 1970/i.test(cookie))
    .map((cookie) => cookie.split('=')[0]);
}

describe('DELETE /api/marketplace/session', () => {
  beforeEach(() => {
    bff.cleared = true;
  });

  it('keeps the shared session cookie when the bridge belongs to another tab’s session', async () => {
    bff.cleared = false;
    const response = await DELETE(del());
    expect(response.status).toBe(204);
    expect(deletedCookies(response)).toEqual([]);
  });

  it('drops the session and flow cookies once the bridge is unpaired', async () => {
    const response = await DELETE(del());
    expect(response.status).toBe(204);
    expect(deletedCookies(response).sort()).toEqual(['__Host-shop-bff-session', '__Host-shop-marketplace-grant']);
  });
});
