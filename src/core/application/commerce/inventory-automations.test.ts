import { beforeEach, describe, expect, it, vi } from 'vitest';
import { INVENTORY_GRANT } from '@/services/marketplace/marketplace-inventory-grant';
import { MarketplaceInventorySessionService } from '@/services/marketplace/marketplace-inventory-session';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import { MarketplaceShopClientService, PubkyShopError } from '@/services/marketplace/marketplace-shop-client';
import { DexieWebhookStore } from '@/services/marketplace/marketplace-webhook-store';
import bitkitParityCapture from '@/test/fixtures/auth/marketplace-grant-priv-parity.staging.json';
import ringCookie from '@/test/fixtures/auth/ring-cookie-signin.pubky-common-0.11.json';
import {
  classifySessionKind,
  CommerceInventoryAutomationsApplication,
  isPublicHttpsWebhookUrl,
  WEBHOOK_SECRET_COPY,
  WEBHOOK_URL_COPY,
} from './inventory-automations';

const PUBKY = 'y'.repeat(52);
const WEBHOOK_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const INVENTORY_SESSION_ID = '33333333-3333-4333-8333-333333333333';

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return {
    ...actual,
    getCommerceAdapterMode: () => 'transaction-service',
    getMarketplaceUrl: () => 'https://staging-api.pubky.app',
    isDurableCommerceMode: () => true,
  };
});

vi.mock('@/services/marketplace/marketplace-shop-client', () => {
  class MockPubkyShopError extends Error {
    readonly code: string;
    readonly details: { status?: number; serviceCode?: string; field?: string };
    constructor(code: string, details: { status?: number; serviceCode?: string; field?: string } = {}) {
      super(code);
      this.code = code;
      this.details = details;
    }
  }
  return {
    PubkyShopError: MockPubkyShopError,
    MarketplaceShopClientService: {
      createInventoryClient: vi.fn(() => ({ token: 'inventory' })),
      listSessions: vi.fn(),
      revokeSession: vi.fn(),
      addWebhook: vi.fn(),
      rotateWebhook: vi.fn(),
      deleteWebhook: vi.fn(),
      isCapabilityRequired: (error: InstanceType<typeof MockPubkyShopError>) =>
        error.code === 'service_error' && error.details.serviceCode === 'capability_required',
      isRevisionConflict: () => false,
      isSessionRejected: (error: InstanceType<typeof MockPubkyShopError>) => error.code === 'session_rejected',
      isRateLimited: () => false,
      formatRateLimitCopy: () => 'Too many inventory requests. Wait a few seconds.',
    },
  };
});

vi.mock('@/services/marketplace/marketplace-webhook-store', () => ({
  DexieWebhookStore: vi.fn(),
}));

describe('classifySessionKind', () => {
  it('labels empty caps Purchase, exact inventory grant Inventory, and root CLI', () => {
    expect(classifySessionKind('')).toBe('purchase');
    expect(classifySessionKind(INVENTORY_GRANT)).toBe('inventory');
    expect(classifySessionKind('/:rw')).toBe('cli');
    expect(classifySessionKind(`${INVENTORY_GRANT},/:rw`)).toBe('cli');
    expect(classifySessionKind('/pub/other/:rw')).toBe('cli');
  });

  it('labels the marketplace session grant and the Shop sign-in grant Purchase in any order', () => {
    const captured = bitkitParityCapture.parity_request.homeserver_verified;
    expect(classifySessionKind(captured)).toBe('purchase');
    expect(classifySessionKind(captured.split(',').reverse().join(','))).toBe('purchase');
    expect(classifySessionKind('/pub/pubky.app/:rw,/pub/paykit/:rw,/priv/pubky.app/:rw')).toBe('purchase');
    expect(classifySessionKind('/priv/pubky.app/:rw,/pub/paykit/:rw,/pub/pubky.app/:rw')).toBe('purchase');
    expect(classifySessionKind(`${captured},/pub/paykit/:rw`)).toBe('cli');
    expect(classifySessionKind('/priv/pubky.app/:rw')).toBe('cli');
  });

  it('labels the Ring cookie sign-in redeem Purchase in any order, and pubky.app-only sets CLI', () => {
    const ringRedeem = ringCookie.service_normalized;
    expect(classifySessionKind(ringRedeem)).toBe('purchase');
    expect(classifySessionKind(ringRedeem.split(',').reverse().join(','))).toBe('purchase');
    expect(classifySessionKind(ringCookie.pubky_app_signin)).toBe('cli');
    expect(classifySessionKind(`${ringRedeem},/:rw`)).toBe('cli');
  });
});

describe('isPublicHttpsWebhookUrl', () => {
  it('accepts public HTTPS and rejects private, local, and non-https hosts', () => {
    expect(isPublicHttpsWebhookUrl('https://httpbin.org/post')).toBe(true);
    expect(isPublicHttpsWebhookUrl('https://example.com/hooks')).toBe(true);
    expect(isPublicHttpsWebhookUrl('http://example.com/hooks')).toBe(false);
    expect(isPublicHttpsWebhookUrl('https://localhost/hooks')).toBe(false);
    expect(isPublicHttpsWebhookUrl('https://127.0.0.1/hooks')).toBe(false);
    expect(isPublicHttpsWebhookUrl('https://10.0.0.4/hooks')).toBe(false);
    expect(isPublicHttpsWebhookUrl('https://192.168.1.9/hooks')).toBe(false);
    expect(isPublicHttpsWebhookUrl('https://169.254.1.1/hooks')).toBe(false);
    expect(isPublicHttpsWebhookUrl('https://[::1]/hooks')).toBe(false);
    expect(isPublicHttpsWebhookUrl('https://user:pass@example.com/hooks')).toBe(false);
  });
});

describe('CommerceInventoryAutomationsApplication', () => {
  const store = {
    list: vi.fn(async () => [] as { id: string; seller_id: string; url: string; created_at: number }[]),
    put: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  };

  beforeEach(() => {
    store.list.mockReset();
    store.put.mockReset();
    store.remove.mockReset();
    store.list.mockResolvedValue([]);
    vi.mocked(DexieWebhookStore).mockImplementation(function MockStore() {
      return store;
    } as never);
    vi.spyOn(MarketplaceSessionService, 'getActiveSession').mockReturnValue({
      token: 'A'.repeat(43),
      sessionId: SESSION_ID,
      pubky: PUBKY,
      capabilities: '',
      expiresAt: '2099-01-01T00:00:00.000Z',
      expiresAtMs: Date.parse('2099-01-01T00:00:00.000Z'),
      issuedAt: '2026-09-21T00:00:00.000Z',
    });
    vi.spyOn(MarketplaceInventorySessionService, 'getActiveSession').mockReturnValue({
      token: 'I'.repeat(43),
      sessionId: INVENTORY_SESSION_ID,
      pubky: PUBKY,
      capabilities: INVENTORY_GRANT,
      expiresAt: '2099-01-01T00:00:00.000Z',
      expiresAtMs: Date.parse('2099-01-01T00:00:00.000Z'),
      issuedAt: '2026-09-21T00:00:00.000Z',
    });
    vi.spyOn(MarketplaceInventorySessionService, 'clearSession').mockImplementation(() => undefined);
    vi.spyOn(MarketplaceSessionService, 'clearSession').mockImplementation(() => undefined);
    vi.mocked(MarketplaceShopClientService.listSessions).mockReset();
    vi.mocked(MarketplaceShopClientService.revokeSession).mockReset();
    vi.mocked(MarketplaceShopClientService.addWebhook).mockReset();
    vi.mocked(MarketplaceShopClientService.rotateWebhook).mockReset();
    vi.mocked(MarketplaceShopClientService.deleteWebhook).mockReset();
  });

  it('returns grant-needed when listing sessions with identity-only coverage', async () => {
    vi.spyOn(MarketplaceInventorySessionService, 'getActiveSession').mockReturnValue(null);
    await expect(CommerceInventoryAutomationsApplication.load(PUBKY)).resolves.toEqual({ status: 'grant-needed' });
    expect(MarketplaceShopClientService.listSessions).not.toHaveBeenCalled();
  });

  it('maps GET sessions 403 capability_required to grant-needed, not a mint bug', async () => {
    vi.mocked(MarketplaceShopClientService.listSessions).mockResolvedValue({
      ok: false,
      error: new PubkyShopError('service_error', { status: 403, serviceCode: 'capability_required' }),
    });
    await expect(CommerceInventoryAutomationsApplication.load(PUBKY)).resolves.toEqual({ status: 'grant-needed' });
  });

  it('lists purchase, inventory, and CLI rows and never surfaces a bearer', async () => {
    vi.mocked(MarketplaceShopClientService.listSessions).mockResolvedValue({
      ok: true,
      value: {
        schema_version: 1,
        sessions: [
          {
            id: SESSION_ID,
            label: 'Shop',
            capabilities: '',
            created_at: '2026-09-21T00:00:00.000Z',
            expires_at: '2099-01-01T00:00:00.000Z',
            last_used_at: '2026-09-21T01:00:00.000Z',
          },
          {
            id: INVENTORY_SESSION_ID,
            label: 'Studio',
            capabilities: INVENTORY_GRANT,
            created_at: '2026-09-21T00:00:00.000Z',
            expires_at: '2099-01-01T00:00:00.000Z',
            last_used_at: null,
          },
          {
            id: '44444444-4444-4444-8444-444444444444',
            label: 'CLI',
            capabilities: '/:rw',
            created_at: '2026-09-21T00:00:00.000Z',
            expires_at: '2099-01-01T00:00:00.000Z',
          },
        ],
      },
    });
    const load = await CommerceInventoryAutomationsApplication.load(PUBKY);
    expect(load.status).toBe('ready');
    if (load.status !== 'ready') return;
    expect(load.sessions.map((row) => row.kind)).toEqual(['purchase', 'inventory', 'cli']);
    expect(JSON.stringify(load)).not.toMatch(/bearer|A{43}|I{43}/i);
  });

  it('clears only the inventory session when that row is revoked', async () => {
    vi.mocked(MarketplaceShopClientService.revokeSession).mockResolvedValue({ ok: true, value: null });
    await expect(
      CommerceInventoryAutomationsApplication.revoke(PUBKY, INVENTORY_SESSION_ID, 'inventory'),
    ).resolves.toEqual({ status: 'revoked', id: INVENTORY_SESSION_ID });
    expect(MarketplaceInventorySessionService.clearSession).toHaveBeenCalled();
    expect(MarketplaceSessionService.clearSession).not.toHaveBeenCalled();
  });

  it('persists webhook id and url and returns the secret once without storing it', async () => {
    vi.mocked(MarketplaceShopClientService.addWebhook).mockResolvedValue({
      ok: true,
      value: {
        webhook: {
          id: WEBHOOK_ID,
          url: 'https://httpbin.org/post',
          key_id: 'k1',
          created_at: '2026-09-21T00:00:00.000Z',
        },
        secret: 'once-secret-value',
      },
    });
    const result = await CommerceInventoryAutomationsApplication.addWebhook(PUBKY, 'https://httpbin.org/post');
    expect(result).toEqual({
      status: 'secret',
      id: WEBHOOK_ID,
      url: 'https://httpbin.org/post',
      secret: 'once-secret-value',
      message: WEBHOOK_SECRET_COPY,
    });
    expect(store.put).toHaveBeenCalledWith({
      id: WEBHOOK_ID,
      url: 'https://httpbin.org/post',
      createdAt: Date.parse('2026-09-21T00:00:00.000Z'),
    });
    expect(JSON.stringify(store.put.mock.calls)).not.toContain('once-secret-value');
  });

  it('rejects private webhook hosts before calling the service', async () => {
    await expect(CommerceInventoryAutomationsApplication.addWebhook(PUBKY, 'https://127.0.0.1/hook')).resolves.toEqual({
      status: 'invalid-url',
      message: WEBHOOK_URL_COPY,
    });
    expect(MarketplaceShopClientService.addWebhook).not.toHaveBeenCalled();
  });

  it('returns a rotated secret without writing it to Dexie', async () => {
    store.list.mockResolvedValue([
      { id: WEBHOOK_ID, seller_id: PUBKY, url: 'https://httpbin.org/post', created_at: 1 },
    ]);
    vi.mocked(MarketplaceShopClientService.rotateWebhook).mockResolvedValue({
      ok: true,
      value: { id: WEBHOOK_ID, key_id: 'k2', secret: 'rotated-secret-value' },
    });
    const result = await CommerceInventoryAutomationsApplication.rotateWebhook(PUBKY, WEBHOOK_ID);
    expect(result).toEqual({
      status: 'secret',
      id: WEBHOOK_ID,
      url: 'https://httpbin.org/post',
      secret: 'rotated-secret-value',
      message: WEBHOOK_SECRET_COPY,
    });
    expect(store.put).not.toHaveBeenCalled();
    expect(JSON.stringify(store.list.mock.calls)).not.toContain('rotated-secret-value');
  });

  it('deletes the webhook on the service and removes the local {id,url} row', async () => {
    vi.mocked(MarketplaceShopClientService.deleteWebhook).mockResolvedValue({ ok: true, value: null });
    await expect(CommerceInventoryAutomationsApplication.deleteWebhook(PUBKY, WEBHOOK_ID)).resolves.toEqual({
      status: 'deleted',
      id: WEBHOOK_ID,
    });
    expect(store.remove).toHaveBeenCalledWith(WEBHOOK_ID);
  });
});
