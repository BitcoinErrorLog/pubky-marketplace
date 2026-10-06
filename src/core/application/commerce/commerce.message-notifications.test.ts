import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceGatewayService } from '@/services/marketplace/marketplace';
import { asOpaque } from '@/test-utils/type-assertions';
import { CommerceApplication } from './commerce';

const config = vi.hoisted(() => ({ mode: 'transaction-service' as string }));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => config.mode };
});

const OWNER = 'o'.repeat(52);

type GatewayNotifications = Awaited<ReturnType<typeof MarketplaceGatewayService.getNotifications>>;
const notification = (type: string) => ({ id: crypto.randomUUID(), type, actorPubky: 'a'.repeat(52) });

describe('CommerceApplication.getMarketplaceNotifications and private messages', () => {
  afterEach(() => vi.restoreAllMocks());

  it('never returns a message notification in durable modes, where the mute list cannot vet it', async () => {
    config.mode = 'transaction-service';
    vi.spyOn(MarketplaceGatewayService, 'getNotifications').mockResolvedValue(
      asOpaque<GatewayNotifications>([notification('message_received'), notification('offer_received')]),
    );

    const notifications = await CommerceApplication.getMarketplaceNotifications(OWNER);

    expect(notifications.map((row) => row.type)).toEqual(['offer_received']);
  });

  it('keeps the sandbox’s labeled message notifications', async () => {
    config.mode = 'sandbox';
    vi.spyOn(MarketplaceGatewayService, 'getNotifications').mockResolvedValue(
      asOpaque<GatewayNotifications>([notification('message_received')]),
    );

    await expect(CommerceApplication.getMarketplaceNotifications(OWNER)).resolves.toHaveLength(1);
  });
});
