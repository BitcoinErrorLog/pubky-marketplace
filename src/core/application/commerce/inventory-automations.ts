import { CAPABILITIES, RING_COOKIE_CAPABILITIES } from '@/config/app';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { INVENTORY_GRANT } from '@/services/marketplace/marketplace-inventory-grant';
import {
  type InventoryBearer,
  MarketplaceInventorySessionService,
} from '@/services/marketplace/marketplace-inventory-session';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import { MARKETPLACE_SESSION_GRANT } from '@/services/marketplace/marketplace-session-grant';
import {
  MarketplaceShopClientService,
  PubkyShopError,
  type SdkResult,
} from '@/services/marketplace/marketplace-shop-client';
import { DexieWebhookStore } from '@/services/marketplace/marketplace-webhook-store';

export const WEBHOOK_SECRET_COPY = 'Copy this secret now. It cannot be shown again.';
export const WEBHOOK_DELIVERY_COPY = 'Delivery status is not listed. Use the events feed.';
export const WEBHOOK_URL_COPY = 'Use an HTTPS URL on a public host.';

export type InventoryAutomationsAuth =
  | { status: 'durable-unavailable' }
  | { status: 'unauthenticated' }
  | { status: 'session-required' }
  | { status: 'grant-needed' }
  | { status: 'ready' };

export type InventorySessionKind = 'purchase' | 'inventory' | 'cli';

export type InventorySessionRow = {
  id: string;
  kind: InventorySessionKind;
  kindLabel: 'Purchase' | 'Inventory' | 'CLI';
  label: string;
  grant: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
};

export type InventoryWebhookRow = {
  id: string;
  url: string;
  createdAt: number;
};

export type InventoryAutomationsBlocked = Exclude<InventoryAutomationsAuth, { status: 'ready' }>;

export type InventoryAutomationsLoad =
  | InventoryAutomationsBlocked
  | { status: 'empty'; sessions: []; webhooks: InventoryWebhookRow[] }
  | { status: 'ready'; sessions: InventorySessionRow[]; webhooks: InventoryWebhookRow[] }
  | { status: 'error'; message: string };

export type InventoryRevokeResult =
  | { status: 'revoked'; id: string }
  | InventoryAutomationsBlocked
  | { status: 'error'; message: string };

export type InventoryWebhookSecretResult =
  | { status: 'secret'; id: string; url: string; secret: string; message: string }
  | InventoryAutomationsBlocked
  | { status: 'invalid-url'; message: string }
  | { status: 'error'; message: string };

export type InventoryWebhookDeleteResult =
  | { status: 'deleted'; id: string }
  | InventoryAutomationsBlocked
  | { status: 'error'; message: string };

const KIND_LABEL: Record<InventorySessionKind, InventorySessionRow['kindLabel']> = {
  purchase: 'Purchase',
  inventory: 'Inventory',
  cli: 'CLI',
};

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'bigint') return value.toString();
  return null;
}

function ipv4Octets(host: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = match.slice(1).map(Number) as [number, number, number, number];
  if (octets.some((octet) => octet > 255)) return null;
  return octets;
}

function isBlockedIpv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function mappedIpv4(host: string): [number, number, number, number] | null {
  const prefix = '::ffff:';
  if (!host.startsWith(prefix)) return null;
  return ipv4Octets(host.slice(prefix.length));
}

/** HTTPS on a public host. Rejects credentials, localhost, and RFC1918/link-local. */
export function isPublicHttpsWebhookUrl(value: string): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.username || parsed.password) return false;
  const host = parsed.hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0' || host === '::' || host === '::1') {
    return false;
  }
  const ipv4 = ipv4Octets(host) ?? mappedIpv4(host);
  if (ipv4 && isBlockedIpv4(ipv4)) return false;
  if (host.includes(':')) {
    if (host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return false;
  }
  return true;
}

const PURCHASE_GRANTS: readonly string[] = [MARKETPLACE_SESSION_GRANT, RING_COOKIE_CAPABILITIES, CAPABILITIES];

/**
 * Purchase: empty caps (bridged or legacy identity session), the marketplace
 * session grant (Bitkit or Ring grant flow, Ring QR), or the sign-in set a
 * Ring sign-in redeems (the Ring cookie set, or the Shop grant it requested
 * before it included pubky.app's scopes). Exact Studio inventory grant → Inventory.
 * Root `/:rw` and every other grant string → CLI (not Studio).
 */
export function classifySessionKind(capabilities: string): InventorySessionKind {
  const parts = capabilities
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return 'purchase';
  if (parts.length === 1 && parts[0] === INVENTORY_GRANT) return 'inventory';
  const normalized = [...parts].sort().join(',');
  if (PURCHASE_GRANTS.some((grant) => grant.split(',').sort().join(',') === normalized)) return 'purchase';
  return 'cli';
}

function classifyClientError(error: PubkyShopError): InventoryAutomationsAuth['status'] | 'error' {
  if (MarketplaceShopClientService.isSessionRejected(error)) return 'grant-needed';
  if (MarketplaceShopClientService.isCapabilityRequired(error)) return 'grant-needed';
  return 'error';
}

function mapError(
  error: PubkyShopError,
  bearer: InventoryBearer,
): InventoryAutomationsBlocked | { status: 'error'; message: string } {
  if (MarketplaceShopClientService.isRateLimited(error)) {
    return { status: 'error', message: MarketplaceShopClientService.formatRateLimitCopy(error) };
  }
  const classified = classifyClientError(error);
  if (classified === 'grant-needed') {
    if (MarketplaceShopClientService.isSessionRejected(error)) {
      MarketplaceInventorySessionService.clearRejectedBearer(bearer);
    }
    return { status: 'grant-needed' };
  }
  return { status: 'error', message: error.message };
}

function decodeSessions(value: unknown): InventorySessionRow[] {
  const object = asObject(value);
  const list = Array.isArray(object?.sessions) ? object.sessions : Array.isArray(value) ? value : [];
  const rows: InventorySessionRow[] = [];
  for (const entry of list) {
    const session = asObject(entry);
    if (!session) continue;
    if (asString(session.revoked_at) || asString(session.revokedAt)) continue;
    const id = asString(session.id);
    if (!id) continue;
    const capabilities = asString(session.capabilities) ?? '';
    const kind = classifySessionKind(capabilities);
    const createdAt = asString(session.created_at) ?? asString(session.createdAt) ?? '';
    const expiresAt = asString(session.expires_at) ?? asString(session.expiresAt) ?? '';
    const lastUsedAt = asString(session.last_used_at) ?? asString(session.lastUsedAt);
    const label = asString(session.label) ?? KIND_LABEL[kind];
    rows.push({
      id,
      kind,
      kindLabel: KIND_LABEL[kind],
      label,
      grant: capabilities.length === 0 ? '—' : capabilities,
      createdAt,
      expiresAt,
      lastUsedAt,
    });
  }
  return rows;
}

function decodeWebhookCreated(value: unknown): { id: string; url: string; secret: string; createdAt?: number } | null {
  const object = asObject(value);
  if (!object) return null;
  const webhook = asObject(object.webhook) ?? object;
  const id = asString(webhook.id);
  const url = asString(webhook.url) ?? asString(object.url);
  const secret = asString(object.secret);
  if (!id || !url || !secret) return null;
  const created = asString(webhook.created_at) ?? asString(webhook.createdAt);
  const createdAt = created ? Date.parse(created) : undefined;
  return { id, url, secret, createdAt: Number.isFinite(createdAt) ? createdAt : undefined };
}

function decodeWebhookRotated(value: unknown, fallbackId: string): { id: string; secret: string } | null {
  const object = asObject(value);
  if (!object) return null;
  const webhook = asObject(object.webhook);
  const id = asString(object.id) ?? asString(webhook?.id) ?? fallbackId;
  const secret = asString(object.secret);
  if (!id || !secret) return null;
  return { id, secret };
}

function sessionHasBearer(row: InventorySessionRow): boolean {
  const haystack = `${row.id}${row.label}${row.grant}${row.kindLabel}`;
  return /bearer|token/i.test(haystack);
}

export class CommerceInventoryAutomationsApplication {
  private constructor() {}

  static authStatus(sellerPubky: string): InventoryAutomationsAuth {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) return { status: 'durable-unavailable' };
    if (!sellerPubky) return { status: 'unauthenticated' };
    if (!MarketplaceSessionService.getActiveSession()) return { status: 'session-required' };
    if (!MarketplaceInventorySessionService.getCoveringBearer(sellerPubky)) return { status: 'grant-needed' };
    return { status: 'ready' };
  }

  static async load(sellerPubky: string): Promise<InventoryAutomationsLoad> {
    const auth = this.authStatus(sellerPubky);
    if (auth.status !== 'ready') return auth;
    const inventory = MarketplaceInventorySessionService.getCoveringBearer(sellerPubky);
    if (!inventory) return { status: 'grant-needed' };
    const client = MarketplaceShopClientService.createInventoryClient(inventory.token);
    const listed = await MarketplaceShopClientService.listSessions(client);
    if (!listed.ok) return this.fail(listed, inventory);
    const sessions = decodeSessions(listed.value).filter((row) => !sessionHasBearer(row));
    const webhooks = await new DexieWebhookStore(sellerPubky).list();
    const webhookRows = webhooks.map((row) => ({ id: row.id, url: row.url, createdAt: row.created_at }));
    if (sessions.length === 0 && webhookRows.length === 0) {
      return { status: 'empty', sessions: [], webhooks: [] };
    }
    return { status: 'ready', sessions, webhooks: webhookRows };
  }

  static async revoke(sellerPubky: string, id: string, kind: InventorySessionKind): Promise<InventoryRevokeResult> {
    const auth = this.authStatus(sellerPubky);
    if (auth.status !== 'ready') return auth;
    const inventory = MarketplaceInventorySessionService.getCoveringBearer(sellerPubky);
    if (!inventory) return { status: 'grant-needed' };
    const client = MarketplaceShopClientService.createInventoryClient(inventory.token);
    const result = await MarketplaceShopClientService.revokeSession(client, id);
    if (!result.ok) return this.fail(result, inventory);
    this.clearLocalAfterRevoke(id, kind);
    return { status: 'revoked', id };
  }

  static async addWebhook(sellerPubky: string, url: string): Promise<InventoryWebhookSecretResult> {
    const auth = this.authStatus(sellerPubky);
    if (auth.status !== 'ready') return auth;
    if (!isPublicHttpsWebhookUrl(url)) {
      return { status: 'invalid-url', message: WEBHOOK_URL_COPY };
    }
    const inventory = MarketplaceInventorySessionService.getCoveringBearer(sellerPubky);
    if (!inventory) return { status: 'grant-needed' };
    const client = MarketplaceShopClientService.createInventoryClient(inventory.token);
    const result = await MarketplaceShopClientService.addWebhook(client, url);
    if (!result.ok) {
      if (result.error.code === 'validation_failed') {
        return { status: 'invalid-url', message: WEBHOOK_URL_COPY };
      }
      return this.fail(result, inventory);
    }
    const created = decodeWebhookCreated(result.value);
    if (!created) {
      return { status: 'error', message: 'The service returned an invalid webhook response.' };
    }
    await new DexieWebhookStore(sellerPubky).put({
      id: created.id,
      url: created.url,
      createdAt: created.createdAt,
    });
    return { status: 'secret', id: created.id, url: created.url, secret: created.secret, message: WEBHOOK_SECRET_COPY };
  }

  static async rotateWebhook(sellerPubky: string, id: string): Promise<InventoryWebhookSecretResult> {
    const auth = this.authStatus(sellerPubky);
    if (auth.status !== 'ready') return auth;
    const inventory = MarketplaceInventorySessionService.getCoveringBearer(sellerPubky);
    if (!inventory) return { status: 'grant-needed' };
    const store = new DexieWebhookStore(sellerPubky);
    const existing = (await store.list()).find((row) => row.id === id);
    const client = MarketplaceShopClientService.createInventoryClient(inventory.token);
    const result = await MarketplaceShopClientService.rotateWebhook(client, id);
    if (!result.ok) return this.fail(result, inventory);
    const rotated = decodeWebhookRotated(result.value, id);
    if (!rotated) {
      return { status: 'error', message: 'The service returned an invalid webhook response.' };
    }
    return {
      status: 'secret',
      id: rotated.id,
      url: existing?.url ?? '',
      secret: rotated.secret,
      message: WEBHOOK_SECRET_COPY,
    };
  }

  static async deleteWebhook(sellerPubky: string, id: string): Promise<InventoryWebhookDeleteResult> {
    const auth = this.authStatus(sellerPubky);
    if (auth.status !== 'ready') return auth;
    const inventory = MarketplaceInventorySessionService.getCoveringBearer(sellerPubky);
    if (!inventory) return { status: 'grant-needed' };
    const client = MarketplaceShopClientService.createInventoryClient(inventory.token);
    const result = await MarketplaceShopClientService.deleteWebhook(client, id);
    if (!result.ok) return this.fail(result, inventory);
    await new DexieWebhookStore(sellerPubky).remove(id);
    return { status: 'deleted', id };
  }

  private static fail<T>(
    result: Extract<SdkResult<T>, { ok: false }>,
    bearer: InventoryBearer,
  ): InventoryAutomationsBlocked | { status: 'error'; message: string } {
    return mapError(result.error, bearer);
  }

  private static clearLocalAfterRevoke(id: string, kind: InventorySessionKind): void {
    const inventory = MarketplaceInventorySessionService.getActiveSession();
    if (inventory && (inventory.sessionId === id || (kind === 'inventory' && !inventory.sessionId))) {
      MarketplaceInventorySessionService.clearSession('cleared');
    }
    const identity = MarketplaceSessionService.getActiveSession();
    if (identity && (identity.sessionId === id || (kind === 'purchase' && !identity.sessionId))) {
      MarketplaceSessionService.clearSessionIfBearer(identity.token, 'cleared');
    }
  }
}
