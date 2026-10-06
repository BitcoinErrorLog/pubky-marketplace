import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceApplication } from '@/application/commerce/commerce';
import type { CommerceAdapterMode } from '@/config/commerce';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import { useNotificationStore } from '@/stores/notification/notification.store';
import {
  COMMERCE_FIXTURE_BUYER,
  COMMERCE_FIXTURE_SELLER,
  createCommerceListingFixture,
  createCommerceShopFixture,
} from '@/test/fixtures/commerce/commerce';
import { createNotificationFixture } from '@/test/fixtures/commerce/notifications';
import { CommerceController } from './commerce';

vi.mock('@/services/marketplace/marketplace-shop-client', () => ({
  PubkyShopError: class extends Error {
    code = 'service_error';
    details = {};
  },
  MarketplaceShopClientService: {
    createInventoryClient: vi.fn(),
    listSellerListings: vi.fn(),
    getInventoryProjection: vi.fn(),
    adjustInventory: vi.fn(),
    syncMany: vi.fn(),
    isCapabilityRequired: vi.fn(() => false),
    isRevisionConflict: vi.fn(() => false),
    isSessionRejected: vi.fn(() => false),
  },
}));

const commerceConfig = vi.hoisted(() => ({ mode: 'sandbox' as string }));
vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => commerceConfig.mode as CommerceAdapterMode };
});

describe('CommerceController', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    commerceConfig.mode = 'sandbox';
    useAuthStore.setState({ currentUserPubky: COMMERCE_FIXTURE_SELLER });
    useCommerceStore.getState().reset();
    useNotificationStore.getState().reset();
  });

  it('binds a valid creator to the Paykit setup URL and rejects invalid creators', () => {
    const getPaykitSetupUrl = vi
      .spyOn(CommerceApplication, 'getPaykitSetupUrl')
      .mockReturnValue('https://paykit.example/setup?creator=valid');

    expect(
      CommerceController.getPaykitSetupUrl(
        'https://app.example/marketplace/settings',
        'opaque-state',
        COMMERCE_FIXTURE_SELLER,
      ),
    ).toBe('https://paykit.example/setup?creator=valid');
    expect(getPaykitSetupUrl).toHaveBeenCalledWith(
      'https://app.example/marketplace/settings',
      'opaque-state',
      COMMERCE_FIXTURE_SELLER,
    );
    expect(() =>
      CommerceController.getPaykitSetupUrl('https://app.example/marketplace/settings', 'opaque-state', 'not-a-pubky'),
    ).toThrow();
  });

  it('maps catalog filters onto the server-side filters Nexus supports', async () => {
    const fetchCatalog = vi.spyOn(CommerceApplication, 'fetchCatalogListings').mockResolvedValue(undefined);

    await CommerceController.fetchCatalogListings({ saleFormat: 'auction', conditions: ['like_new'], sort: 'newest' });
    expect(fetchCatalog).toHaveBeenCalledWith({ saleFormat: 'auction', condition: 'like_new' });

    await CommerceController.fetchCatalogListings({ saleFormat: 'all', conditions: [], sort: 'recommended' });
    expect(fetchCatalog).toHaveBeenLastCalledWith({});
  });

  it('keeps multi-condition filtering client-side because Nexus accepts one condition', async () => {
    const fetchCatalog = vi.spyOn(CommerceApplication, 'fetchCatalogListings').mockResolvedValue(undefined);

    await CommerceController.fetchCatalogListings({ saleFormat: 'all', conditions: ['new', 'good'], sort: 'newest' });

    expect(fetchCatalog).toHaveBeenCalledWith({});
  });

  it('maps the ending-soon sort onto the auction end-time stream', async () => {
    const fetchCatalog = vi.spyOn(CommerceApplication, 'fetchCatalogListings').mockResolvedValue(undefined);

    await CommerceController.fetchCatalogListings({ saleFormat: 'all', conditions: [], sort: 'ending_soon' });

    expect(fetchCatalog).toHaveBeenCalledWith({ endingSoonest: true });
  });

  it('validates the followed pubkys before refreshing the followed-sellers shelf', async () => {
    const fetchFollowed = vi
      .spyOn(CommerceApplication, 'fetchFollowedSellerCatalogListings')
      .mockResolvedValue(undefined);

    await CommerceController.fetchFollowedSellerListings([COMMERCE_FIXTURE_SELLER, COMMERCE_FIXTURE_BUYER]);
    expect(fetchFollowed).toHaveBeenCalledWith([COMMERCE_FIXTURE_SELLER, COMMERCE_FIXTURE_BUYER]);

    await expect(CommerceController.fetchFollowedSellerListings(['not-a-pubky'])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(CommerceController.fetchFollowedSellerListings('not-a-list')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(fetchFollowed).toHaveBeenCalledTimes(1);
  });

  it('validates local listing lookup identity before calling application', async () => {
    const getListing = vi.spyOn(CommerceApplication, 'getListing').mockResolvedValue(null);

    await CommerceController.getListing(COMMERCE_FIXTURE_SELLER, 'boots_01');

    expect(getListing).toHaveBeenCalledWith(`${COMMERCE_FIXTURE_SELLER}:boots_01`);
    await expect(CommerceController.getListing('invalid', '../private')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(getListing).toHaveBeenCalledTimes(1);
  });

  it('marks a valid listing pending only while its application workflow runs', async () => {
    let finish: (() => void) | undefined;
    const workflow = new Promise<{ registered: boolean; verified: boolean }>((resolve) => {
      finish = () => resolve({ registered: true, verified: true });
    });
    vi.spyOn(CommerceApplication, 'commitUpsertListing').mockReturnValue(workflow);
    const listing = createCommerceListingFixture();

    const commitment = CommerceController.commitUpsertListing(listing);
    expect(useCommerceStore.getState().pendingEntityIds).toEqual([`${COMMERCE_FIXTURE_SELLER}:boots_01`]);

    finish?.();
    await commitment;

    expect(useCommerceStore.getState().pendingEntityIds).toEqual([]);
  });

  it('rejects an owner mismatch before starting an application write', async () => {
    const commit = vi.spyOn(CommerceApplication, 'commitUpsertShop').mockResolvedValue(undefined);
    const shop = createCommerceShopFixture({ ownerPubky: COMMERCE_FIXTURE_BUYER });

    await expect(CommerceController.commitUpsertShop(shop)).rejects.toMatchObject({
      name: 'AppError',
      code: 'INVALID_INPUT',
      category: 'validation',
    });

    expect(commit).not.toHaveBeenCalled();
    expect(useCommerceStore.getState().pendingEntityIds).toEqual([]);
  });

  it('always clears pending UI state when publication fails', async () => {
    vi.spyOn(CommerceApplication, 'commitUpsertListing').mockRejectedValue(new TypeError('homeserver unavailable'));

    await expect(CommerceController.commitUpsertListing(createCommerceListingFixture())).rejects.toThrow(
      'homeserver unavailable',
    );

    expect(useCommerceStore.getState().pendingEntityIds).toEqual([]);
  });

  it('scopes favorite writes to the signed-in owner', async () => {
    const create = vi.spyOn(CommerceApplication, 'commitCreateFavorite').mockResolvedValue(undefined);
    const listingId = `${COMMERCE_FIXTURE_BUYER}:boots_01`;

    await CommerceController.commitCreateFavorite(listingId);

    expect(create).toHaveBeenCalledWith(COMMERCE_FIXTURE_SELLER, listingId);
    await expect(CommerceController.commitCreateFavorite('../invalid')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('prevents following the signed-in seller own shop', async () => {
    const create = vi.spyOn(CommerceApplication, 'commitCreateShopFollow').mockResolvedValue(undefined);

    await expect(CommerceController.commitCreateShopFollow(COMMERCE_FIXTURE_SELLER)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('validates and scopes marketplace media uploads', async () => {
    const upload = vi
      .spyOn(CommerceApplication, 'commitCreateMedia')
      .mockResolvedValue(`pubky://${COMMERCE_FIXTURE_SELLER}/pub/pubky.app/marketplace/v1/media/image_01`);
    const bytes = new Uint8Array([1, 2, 3]);

    await CommerceController.commitCreateMedia('image_01', bytes);

    expect(upload).toHaveBeenCalledWith(COMMERCE_FIXTURE_SELLER, 'image_01', bytes);
    await expect(CommerceController.commitCreateMedia('image_02', new Uint8Array())).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });

  it('validates and scopes local listing draft autosave data', async () => {
    const update = vi.spyOn(CommerceApplication, 'commitUpdateListingDraft').mockResolvedValue(undefined);

    await CommerceController.commitUpdateListingDraft('draft_01', { title: 'Autosaved boots', quantity: '1' });

    expect(update).toHaveBeenCalledWith(
      COMMERCE_FIXTURE_SELLER,
      'draft_01',
      {
        title: 'Autosaved boots',
        quantity: '1',
      },
      {},
    );

    const photo = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });
    await CommerceController.commitUpdateListingDraft('draft_01', { title: 'With photo' }, { p1: photo });
    expect(update).toHaveBeenCalledWith(COMMERCE_FIXTURE_SELLER, 'draft_01', { title: 'With photo' }, { p1: photo });
    await expect(CommerceController.commitUpdateListingDraft('draft_01', { invalid: BigInt(1) })).rejects.toMatchObject(
      {
        code: 'INVALID_INPUT',
      },
    );
  });

  it('validates and scopes sandbox transaction commands to the signed-in actor', async () => {
    const execute = vi.spyOn(CommerceApplication, 'executeMarketplaceCommand').mockResolvedValue({
      ok: false,
      error: { code: 'BID_TOO_LOW', message: 'Bid is too low.' },
    });
    const command = {
      version: 1,
      commandId: '00000000-0000-4000-8000-000000000820',
      aggregateId: `listing:${COMMERCE_FIXTURE_BUYER}_boots_01`,
      expectedRevision: 1,
      issuedAt: '2026-08-19T23:00:00.000Z',
      kind: 'auction.place_bid',
      payload: { maximumAmount: { amountMinor: 10_000, currency: 'USD', exponent: 2 } },
    };

    await CommerceController.executeMarketplaceCommand(command);

    expect(execute).toHaveBeenCalledWith(COMMERCE_FIXTURE_SELLER, command);
    await expect(
      CommerceController.executeMarketplaceCommand({ ...command, privateData: 'leak' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('validates private message attachments before gateway upload', async () => {
    const upload = vi.spyOn(CommerceApplication, 'uploadMarketplaceAttachment').mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000996',
      senderPubky: COMMERCE_FIXTURE_SELLER,
      recipientPubky: COMMERCE_FIXTURE_BUYER,
      mimeType: 'image/jpeg',
      byteSize: 5,
      contentHash: 'a'.repeat(64),
      createdAt: '2026-08-19T23:00:00.000Z',
    });
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 1, 2])], 'proof.jpg', { type: 'image/jpeg' });

    await CommerceController.uploadMarketplaceAttachment(COMMERCE_FIXTURE_BUYER, file);

    expect(upload).toHaveBeenCalledWith(COMMERCE_FIXTURE_SELLER, COMMERCE_FIXTURE_BUYER, file);
    await expect(
      CommerceController.uploadMarketplaceAttachment(
        COMMERCE_FIXTURE_BUYER,
        new File(['<svg/>'], 'unsafe.svg', { type: 'image/svg+xml' }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  describe('getMarketplaceFeedNotifications', () => {
    it('normalizes projections to the redacted feed shape for the general surface', async () => {
      vi.spyOn(CommerceApplication, 'getMarketplaceNotifications').mockResolvedValue([
        createNotificationFixture('order_shipped', { readAt: null }),
      ]);

      const items = await CommerceController.getMarketplaceFeedNotifications();

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ source: 'marketplace', type: 'order_shipped', isUnread: true });
    });

    it('never returns unread rows in transaction-service mode: durable rows carry no read state', async () => {
      commerceConfig.mode = 'transaction-service';
      vi.spyOn(CommerceApplication, 'getMarketplaceNotifications').mockResolvedValue([
        createNotificationFixture('order_shipped', { readAt: null, revision: undefined }),
      ]);

      const items = await CommerceController.getMarketplaceFeedNotifications();

      expect(items).toHaveLength(1);
      expect(items[0].isUnread).toBe(false);
    });

    it('returns nothing without fetching when no transactional backend is configured', async () => {
      commerceConfig.mode = 'unavailable';
      const fetchNotifications = vi.spyOn(CommerceApplication, 'getMarketplaceNotifications');

      await expect(CommerceController.getMarketplaceFeedNotifications()).resolves.toEqual([]);
      expect(fetchNotifications).not.toHaveBeenCalled();
    });

    it('returns nothing without fetching for signed-out sessions', async () => {
      useAuthStore.setState({ currentUserPubky: null });
      const fetchNotifications = vi.spyOn(CommerceApplication, 'getMarketplaceNotifications');

      await expect(CommerceController.getMarketplaceFeedNotifications()).resolves.toEqual([]);
      expect(fetchNotifications).not.toHaveBeenCalled();
    });
  });

  describe('refreshMarketplaceNotificationBadge', () => {
    it('counts unread sandbox notifications into the notification store', async () => {
      vi.spyOn(CommerceApplication, 'getMarketplaceNotifications').mockResolvedValue([
        createNotificationFixture('offer_received', { readAt: null }),
        createNotificationFixture('outbid', { readAt: null }),
        createNotificationFixture('order_shipped', { readAt: '2026-08-19T18:00:00.000Z' }),
      ]);

      await CommerceController.refreshMarketplaceNotificationBadge();

      expect(useNotificationStore.getState().selectMarketplaceUnread()).toBe(2);
    });

    it('keeps the badge at 0 without fetching in transaction-service mode: no read state means no actionable count', async () => {
      commerceConfig.mode = 'transaction-service';
      useNotificationStore.getState().setMarketplaceUnread(4);
      const fetchNotifications = vi.spyOn(CommerceApplication, 'getMarketplaceNotifications');

      await CommerceController.refreshMarketplaceNotificationBadge();

      expect(useNotificationStore.getState().selectMarketplaceUnread()).toBe(0);
      expect(fetchNotifications).not.toHaveBeenCalled();
    });

    it('clears the badge without fetching for signed-out sessions', async () => {
      useAuthStore.setState({ currentUserPubky: null });
      useNotificationStore.getState().setMarketplaceUnread(4);
      const fetchNotifications = vi.spyOn(CommerceApplication, 'getMarketplaceNotifications');

      await CommerceController.refreshMarketplaceNotificationBadge();

      expect(useNotificationStore.getState().selectMarketplaceUnread()).toBe(0);
      expect(fetchNotifications).not.toHaveBeenCalled();
    });

    it('never fetches marketplace notification preferences: the badge only needs the rows', async () => {
      vi.spyOn(CommerceApplication, 'getMarketplaceNotifications').mockResolvedValue([]);
      const fetchPreferences = vi.spyOn(CommerceApplication, 'getMarketplaceNotificationPreferences');

      await CommerceController.refreshMarketplaceNotificationBadge();

      expect(fetchPreferences).not.toHaveBeenCalled();
    });
  });

  describe('markAllMarketplaceNotificationsRead', () => {
    it('sends one mark_read command per unread sandbox row and clears the badge after all succeed', async () => {
      const unreadA = createNotificationFixture('offer_received', { readAt: null });
      const unreadB = createNotificationFixture('outbid', { readAt: null });
      const read = createNotificationFixture('order_shipped', { readAt: '2026-08-19T18:00:00.000Z' });
      vi.spyOn(CommerceApplication, 'getMarketplaceNotifications').mockResolvedValue([unreadA, unreadB, read]);
      const execute = vi
        .spyOn(CommerceApplication, 'executeMarketplaceCommand')
        .mockResolvedValue({ ok: true } as never);
      useNotificationStore.getState().setMarketplaceUnread(2);

      await CommerceController.markAllMarketplaceNotificationsRead();

      expect(execute).toHaveBeenCalledTimes(2);
      for (const notification of [unreadA, unreadB]) {
        expect(execute).toHaveBeenCalledWith(
          COMMERCE_FIXTURE_SELLER,
          expect.objectContaining({
            aggregateId: `notification:${notification.id}`,
            expectedRevision: notification.revision,
            kind: 'notification.mark_read',
            payload: { notificationId: notification.id },
          }),
        );
      }
      expect(useNotificationStore.getState().selectMarketplaceUnread()).toBe(0);
    });

    it('keeps the badge when any mark_read command fails, so unread rows are never hidden by a failed write', async () => {
      vi.spyOn(CommerceApplication, 'getMarketplaceNotifications').mockResolvedValue([
        createNotificationFixture('offer_received', { readAt: null }),
        createNotificationFixture('outbid', { readAt: null }),
      ]);
      vi.spyOn(CommerceApplication, 'executeMarketplaceCommand')
        .mockResolvedValueOnce({ ok: true } as never)
        .mockResolvedValueOnce({ ok: false, error: { code: 'NOT_FOUND', message: 'gone' } } as never);
      useNotificationStore.getState().setMarketplaceUnread(2);

      await CommerceController.markAllMarketplaceNotificationsRead();

      expect(useNotificationStore.getState().selectMarketplaceUnread()).toBe(2);
    });

    it('writes nothing in transaction-service mode: the durable service has no mark_read command', async () => {
      commerceConfig.mode = 'transaction-service';
      const fetchNotifications = vi.spyOn(CommerceApplication, 'getMarketplaceNotifications');
      const execute = vi.spyOn(CommerceApplication, 'executeMarketplaceCommand');

      await CommerceController.markAllMarketplaceNotificationsRead();

      expect(fetchNotifications).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
    });

    it('clears the badge without commands when nothing is unread', async () => {
      vi.spyOn(CommerceApplication, 'getMarketplaceNotifications').mockResolvedValue([
        createNotificationFixture('order_shipped', { readAt: '2026-08-19T18:00:00.000Z' }),
      ]);
      const execute = vi.spyOn(CommerceApplication, 'executeMarketplaceCommand');
      useNotificationStore.getState().setMarketplaceUnread(1);

      await CommerceController.markAllMarketplaceNotificationsRead();

      expect(execute).not.toHaveBeenCalled();
      expect(useNotificationStore.getState().selectMarketplaceUnread()).toBe(0);
    });
  });

  describe('publishOrderReceipts', () => {
    it('mirrors the publication outcome into the store (skipped maps to idle)', async () => {
      const publish = vi.spyOn(CommerceApplication, 'publishOrderReceipts').mockResolvedValue('needs_reauth');

      await CommerceController.publishOrderReceipts([]);
      expect(publish).toHaveBeenCalledWith(COMMERCE_FIXTURE_SELLER, []);
      expect(useCommerceStore.getState().receiptsPublicationStatus).toBe('needs_reauth');

      publish.mockResolvedValue('published');
      await CommerceController.publishOrderReceipts([]);
      expect(useCommerceStore.getState().receiptsPublicationStatus).toBe('published');

      publish.mockResolvedValue('skipped');
      await CommerceController.publishOrderReceipts([]);
      expect(useCommerceStore.getState().receiptsPublicationStatus).toBe('idle');

      publish.mockResolvedValue('unavailable');
      await CommerceController.publishOrderReceipts([]);
      expect(useCommerceStore.getState().receiptsPublicationStatus).toBe('unavailable');
    });
  });

  describe('beginMarketplaceSessionConnect', () => {
    const session = {
      pubky: COMMERCE_FIXTURE_SELLER,
      capabilities: '/pub/pubky.app/:rw',
      expiresAt: '2026-08-22T00:00:00.000Z',
    };

    it('exposes the authorization URL and mirrors the session into the store once the signer approves', async () => {
      vi.spyOn(CommerceApplication, 'beginMarketplaceSessionFlow').mockReturnValue({
        authorizationUrl: 'pubkyauth:///?caps=test',
        awaitSession: vi.fn().mockResolvedValue(session),
        cancel: vi.fn(),
      });

      const flow = CommerceController.beginMarketplaceSessionConnect();
      expect(flow.authorizationUrl).toBe('pubkyauth:///?caps=test');
      // Nothing is mirrored before approval: the URL alone proves nothing.
      expect(useCommerceStore.getState().marketplaceSession).toBeNull();

      await expect(flow.awaitSession()).resolves.toEqual(session);
      expect(useCommerceStore.getState().marketplaceSession).toEqual(session);
    });

    it('leaves the store untouched when the flow fails, and cancel reaches the underlying flow', async () => {
      const cancel = vi.fn();
      vi.spyOn(CommerceApplication, 'beginMarketplaceSessionFlow').mockReturnValue({
        authorizationUrl: 'pubkyauth:///?caps=test',
        awaitSession: vi.fn().mockRejectedValue(new Error('Relay timed out')),
        cancel,
      });

      const flow = CommerceController.beginMarketplaceSessionConnect();
      await expect(flow.awaitSession()).rejects.toThrow('Relay timed out');
      expect(useCommerceStore.getState().marketplaceSession).toBeNull();

      flow.cancel();
      expect(cancel).toHaveBeenCalledTimes(1);
    });
  });

  describe('restorePersistedMarketplaceSession', () => {
    const session = {
      pubky: COMMERCE_FIXTURE_SELLER,
      capabilities: '',
      expiresAt: '2026-08-22T00:00:00.000Z',
      issuedAt: '2026-08-21T00:00:00.000Z',
    };

    it('mirrors a still-valid persisted session into the commerce store', () => {
      vi.spyOn(CommerceApplication, 'restoreMarketplaceSession').mockReturnValue(session);
      expect(CommerceController.restorePersistedMarketplaceSession(COMMERCE_FIXTURE_SELLER)).toEqual(session);
      expect(useCommerceStore.getState().marketplaceSession).toEqual(session);
    });

    it('leaves the store empty when nothing valid is persisted', () => {
      vi.spyOn(CommerceApplication, 'restoreMarketplaceSession').mockReturnValue(null);
      expect(CommerceController.restorePersistedMarketplaceSession(COMMERCE_FIXTURE_SELLER)).toBeNull();
      expect(useCommerceStore.getState().marketplaceSession).toBeNull();
    });
  });

  describe('beginInventorySessionConnect', () => {
    const session = {
      pubky: COMMERCE_FIXTURE_SELLER,
      capabilities: '/pub/pubky.app/marketplace-service/v1/:rw',
      expiresAt: '2026-08-22T00:00:00.000Z',
      issuedAt: '2026-08-21T00:00:00.000Z',
    };

    it('mirrors the inventory session without touching the purchase session', async () => {
      vi.spyOn(CommerceApplication, 'beginInventorySessionFlow').mockReturnValue({
        authorizationUrl: 'pubkyauth:///?caps=inventory',
        awaitSession: vi.fn().mockResolvedValue(session),
        cancel: vi.fn(),
      });

      const flow = CommerceController.beginInventorySessionConnect(COMMERCE_FIXTURE_SELLER);
      expect(flow.authorizationUrl).toBe('pubkyauth:///?caps=inventory');
      expect(useCommerceStore.getState().inventorySession).toBeNull();

      await expect(flow.awaitSession()).resolves.toEqual(session);
      expect(useCommerceStore.getState().inventorySession).toEqual(session);
      expect(useCommerceStore.getState().marketplaceSession).toBeNull();
    });
  });

  describe('identity vs inventory session teardown', () => {
    it('checkout TTL identity clear leaves the inventory store and service intact', () => {
      const identity = {
        pubky: COMMERCE_FIXTURE_SELLER,
        capabilities: '',
        expiresAt: '2099-01-01T00:00:00.000Z',
        issuedAt: '2026-08-21T00:00:00.000Z',
      };
      const inventory = {
        pubky: COMMERCE_FIXTURE_SELLER,
        capabilities: '/pub/pubky.app/marketplace-service/v1/:rw',
        expiresAt: '2099-01-01T00:00:00.000Z',
        issuedAt: '2026-08-21T00:00:00.000Z',
      };
      useCommerceStore.getState().setMarketplaceSession(identity);
      useCommerceStore.getState().setInventorySession(inventory);
      const clearIdentity = vi.spyOn(CommerceApplication, 'clearMarketplaceSession').mockImplementation(() => {});
      const clearInventory = vi.spyOn(CommerceApplication, 'clearInventorySession').mockImplementation(() => {});

      CommerceController.clearIdentitySession();

      expect(clearIdentity).toHaveBeenCalledOnce();
      expect(clearInventory).not.toHaveBeenCalled();
      expect(useCommerceStore.getState().marketplaceSession).toBeNull();
      expect(useCommerceStore.getState().inventorySession).toEqual(inventory);
    });
  });
});
