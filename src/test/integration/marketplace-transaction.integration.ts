import { beforeAll, describe, expect, it } from 'vitest';

/**
 * End-to-end proof that the client transport speaks to the REAL Marketplace
 * Transaction Service (github.com/BitcoinErrorLog/pubky-marketplace-service):
 * a genuine Pubky auth flow (the test acts as the signer with a throwaway
 * keypair via `Signer.approveAuthRequest`, exactly what Pubky Ring does),
 * `AuthToken` bytes exchanged for a bearer session, and snake_case commands
 * executed and parsed back through the client's own transport code.
 *
 * Requirements (see docs/ecommerce/RUNNING.md):
 *   - the service running at MARKETPLACE_SERVICE_URL (default http://127.0.0.1:8080)
 *   - network access to the Pubky HTTP relay (staging relay by default)
 *
 * Nothing here is mocked; this file is excluded from the unit gates and run
 * explicitly with `npm run test:marketplace:service`.
 */

const SERVICE_URL = process.env.MARKETPLACE_SERVICE_URL ?? 'http://127.0.0.1:8080';

// Runtime config must be present before any app module is imported (lenient
// env parse: these layer over staging defaults). The `Env` singleton also
// parses at import time, so its required values are set here too.
process.env.PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE = 'transaction-service';
process.env.PUBKY_RUNTIME_MARKETPLACE_URL = SERVICE_URL;
process.env.PUBKY_RUNTIME_TESTNET = 'false';
process.env.NEXT_PUBLIC_APP_VERSION ??= '0.0.0-integration';
process.env.NEXT_PUBLIC_DB_VERSION ??= '1';
process.env.NEXT_PUBLIC_DEBUG_MODE ??= 'false';

type AppModules = {
  MarketplaceSessionService: typeof import('@/services/marketplace/marketplace-session').MarketplaceSessionService;
  MarketplaceGatewayService: typeof import('@/services/marketplace/marketplace').MarketplaceGatewayService;
  sdk: typeof import('@synonymdev/pubky');
};

async function loadModules(): Promise<AppModules> {
  const [{ MarketplaceSessionService }, { MarketplaceGatewayService }, sdk] = await Promise.all([
    import('@/services/marketplace/marketplace-session'),
    import('@/services/marketplace/marketplace'),
    import('@synonymdev/pubky'),
  ]);
  return { MarketplaceSessionService, MarketplaceGatewayService, sdk };
}

describe('marketplace transaction service integration', () => {
  let modules: AppModules;

  beforeAll(async () => {
    const health = await fetch(`${SERVICE_URL}/health`).catch(() => null);
    if (!health?.ok) {
      throw new Error(
        `The marketplace transaction service is not reachable at ${SERVICE_URL}. ` +
          'Start it first: docker compose up -d --wait && cargo run -p marketplace-service ' +
          '(see docs/ecommerce/RUNNING.md).',
      );
    }
    modules = await loadModules();
  });

  /**
   * Runs the full app-side session flow for one throwaway identity: start the
   * auth-token flow, approve it as the signer (what Pubky Ring does), and let
   * `awaitSession` exchange the AuthToken bytes for a bearer session.
   */
  async function establishSessionFor(keypair: import('@synonymdev/pubky').Keypair): Promise<string> {
    const { MarketplaceSessionService, sdk } = modules;
    const flow = MarketplaceSessionService.beginSessionFlow();
    expect(flow.authorizationUrl).toContain('pubkyauth');
    const signerSdk = new sdk.Pubky();
    await signerSdk.signer(keypair).approveAuthRequest(flow.authorizationUrl);
    const session = await flow.awaitSession();
    const actor = keypair.publicKey.z32();
    expect(session.pubky).toBe(actor);
    expect(session).not.toHaveProperty('token');
    return actor;
  }

  it('establishes signer-approved sessions and executes real commands', async () => {
    const { MarketplaceSessionService, MarketplaceGatewayService, sdk } = modules;

    // --- Seller session: register a listing ---
    const seller = await establishSessionFor(sdk.Keypair.random());

    const listingId = `it_${Date.now().toString(36)}`;
    const registerCommand = {
      version: 1 as const,
      commandId: crypto.randomUUID(),
      aggregateId: `listing:${seller}_${listingId}`,
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'listing.register' as const,
      payload: {
        sellerPubky: seller,
        listingId,
        title: 'Integration test listing',
        listingRevision: 1,
        contentHash: 'a'.repeat(64),
        quantity: 5,
        unitPrice: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
        shippingMinor: 0,
        saleFormat: 'fixed_price' as const,
        fulfillmentMethods: ['shipping'] as ('shipping' | 'pickup')[],
      },
    };
    const registered = await MarketplaceGatewayService.execute(seller, registerCommand);
    expect(registered).toMatchObject({
      ok: true,
      aggregateId: registerCommand.aggregateId,
      revision: 1,
      result: { kind: 'listing' },
    });

    // Idempotency: replaying the exact command returns the stored result.
    const replayed = await MarketplaceGatewayService.execute(seller, registerCommand);
    expect(replayed).toEqual(registered);

    // The transport acts only for the pubky its session was minted for.
    await expect(
      MarketplaceGatewayService.execute(sdk.Keypair.random().publicKey.z32(), registerCommand),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // --- Buyer session (a second full auth flow replaces the seller's): reserve ---
    const buyer = await establishSessionFor(sdk.Keypair.random());

    const reserved = await MarketplaceGatewayService.execute(buyer, {
      version: 1 as const,
      commandId: crypto.randomUUID(),
      aggregateId: registerCommand.aggregateId,
      expectedRevision: 1,
      issuedAt: new Date().toISOString(),
      kind: 'inventory.reserve' as const,
      payload: { quantity: 2, reservationTtlSeconds: 300 },
    });
    expect(reserved).toMatchObject({ ok: true, revision: 2, result: { kind: 'reservation' } });

    // A stale revision is a structured conflict, parsed from the snake_case
    // error body (current_revision -> currentRevision).
    const conflicted = await MarketplaceGatewayService.execute(buyer, {
      version: 1 as const,
      commandId: crypto.randomUUID(),
      aggregateId: registerCommand.aggregateId,
      expectedRevision: 1,
      issuedAt: new Date().toISOString(),
      kind: 'inventory.reserve' as const,
      payload: { quantity: 1, reservationTtlSeconds: 300 },
    });
    expect(conflicted).toMatchObject({
      ok: false,
      error: { code: 'REVISION_CONFLICT', currentRevision: 2 },
    });

    // Sandbox-only affordances stay client-rejected in this mode — no bytes sent.
    await expect(
      MarketplaceGatewayService.execute(buyer, {
        version: 1 as const,
        commandId: crypto.randomUUID(),
        aggregateId: 'payment:00000000-0000-4000-8000-000000000001',
        expectedRevision: 1,
        issuedAt: new Date().toISOString(),
        kind: 'payment.sandbox_advance' as const,
        payload: { paymentId: '00000000-0000-4000-8000-000000000001', target: 'confirmed' as const, confirmations: 1 },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // After the session is dropped (sign-out path), the transport refuses to send.
    MarketplaceSessionService.clearSession();
    await expect(MarketplaceGatewayService.execute(buyer, registerCommand)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });
  });

  /**
   * The interactive-flow loop the UI depends on, against the real service:
   * every `expected_revision` a command sends is sourced from a projection
   * read moments earlier, and the mutated state is read back afterwards.
   */
  it('reads projections, commands with the read revisions, and reads the results back', async () => {
    const { MarketplaceSessionService, MarketplaceGatewayService, sdk } = modules;

    const envelope = (aggregateId: string, expectedRevision: number, kind: string, payload: unknown) =>
      ({
        version: 1 as const,
        commandId: crypto.randomUUID(),
        aggregateId,
        expectedRevision,
        issuedAt: new Date().toISOString(),
        kind,
        payload,
      }) as never;

    // --- Seller: register a listing, then read the projection back ---
    const sellerKeypair = sdk.Keypair.random();
    const seller = await establishSessionFor(sellerKeypair);
    const listingId = `it_reads_${Date.now().toString(36)}`;
    const aggregateId = `listing:${seller}_${listingId}`;
    const registered = await MarketplaceGatewayService.execute(
      seller,
      envelope(aggregateId, 0, 'listing.register', {
        sellerPubky: seller,
        listingId,
        title: 'Integration read-side listing',
        listingRevision: 1,
        contentHash: 'c'.repeat(64),
        quantity: 5,
        unitPrice: { amountMinor: 10_000, currency: 'USD', exponent: 2 },
        shippingMinor: 0,
        saleFormat: 'fixed_price' as const,
      }),
    );
    expect(registered).toMatchObject({ ok: true, revision: 1 });

    const sellerView = await MarketplaceGatewayService.getListing(seller, aggregateId);
    expect(sellerView).toMatchObject({
      aggregateId,
      sellerPubky: seller,
      serverRevision: 1,
      state: 'available',
      availableQuantity: 5,
      saleFormat: 'fixed_price',
      auction: null,
    });

    // An aggregate that was never registered is null, not an invented shape.
    await expect(
      MarketplaceGatewayService.getListing(seller, `listing:${seller}_never_registered`),
    ).resolves.toBeNull();

    // --- Buyer: read the projection, reserve with the revision just read ---
    const buyer = await establishSessionFor(sdk.Keypair.random());
    const preReserve = await MarketplaceGatewayService.getListing(buyer, aggregateId);
    expect(preReserve?.serverRevision).toBe(1);

    const reserved = await MarketplaceGatewayService.execute(
      buyer,
      envelope(aggregateId, preReserve!.serverRevision, 'inventory.reserve', {
        quantity: 2,
        reservationTtlSeconds: 300,
      }),
    );
    expect(reserved).toMatchObject({ ok: true, revision: 2, result: { kind: 'reservation' } });

    // The mutation is visible on the next read: revision moved, stock held.
    const postReserve = await MarketplaceGatewayService.getListing(buyer, aggregateId);
    expect(postReserve).toMatchObject({ serverRevision: 2, availableQuantity: 3, reservedQuantity: 2 });

    // --- Checkout with the freshly-read line revision, then read the order back ---
    const checkoutCommandId = crypto.randomUUID();
    const checkedOut = await MarketplaceGatewayService.execute(buyer, {
      version: 1 as const,
      commandId: checkoutCommandId,
      aggregateId: `checkout:${checkoutCommandId}`,
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'checkout.create' as const,
      payload: {
        lines: [{ listingAggregateId: aggregateId, expectedRevision: postReserve!.serverRevision, quantity: 1 }],
        deliveryAddress: {
          name: 'Integration Buyer',
          line1: '1 Read Side Way',
          line2: '',
          city: 'Lisbon',
          region: 'Lisboa',
          postalCode: '1000-001',
          countryCode: 'PT',
        },
        guaranteePolicyVersion: 1 as const,
      },
    });
    expect(checkedOut).toMatchObject({ ok: true, result: { kind: 'checkout' } });

    const orders = await MarketplaceGatewayService.getOrders(buyer);
    expect(orders).toHaveLength(1);
    const order = orders[0];
    expect(order).toMatchObject({
      buyerPubky: buyer,
      sellerPubky: seller,
      state: 'pending_payment',
      guaranteePolicyVersion: 1,
      // No receipt until payment confirmation — which this client refuses to
      // simulate against the durable service — so this is honestly null.
      receiptId: null,
    });
    expect(order.lines).toEqual([expect.objectContaining({ listingAggregateId: aggregateId, quantity: 1 })]);
    // Redactions hold on the wire, not just in the client schema.
    expect(order).not.toHaveProperty('deliveryAddress');
    expect(order.payment).toMatchObject({ orderId: order.id, adapter: 'sandbox', state: 'awaiting_entitlement' });
    expect(order.payment).not.toHaveProperty('locksBundleId');

    // The embedded payment is also individually readable by a participant.
    const payment = await MarketplaceGatewayService.getPayment(buyer, order.paymentId);
    expect(payment).toMatchObject({ id: order.paymentId, orderId: order.id, revision: order.payment!.revision });
    // A payment id that is not yours (or does not exist) is a plain 404 -> null.
    await expect(MarketplaceGatewayService.getPayment(buyer, crypto.randomUUID())).resolves.toBeNull();

    // --- Offer: create against the current listing revision, read it back, act on the read revision ---
    const preOffer = await MarketplaceGatewayService.getListing(buyer, aggregateId);
    const offered = await MarketplaceGatewayService.execute(
      buyer,
      envelope(aggregateId, preOffer!.serverRevision, 'offer.create', {
        amount: { amountMinor: 9_000, currency: 'USD', exponent: 2 },
        quantity: 1,
        expiresInSeconds: 3_600,
        message: 'Read-side integration offer.',
      }),
    );
    expect(offered).toMatchObject({ ok: true, result: { kind: 'offer' } });

    const offers = await MarketplaceGatewayService.getOffers(buyer);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      listingAggregateId: aggregateId,
      buyerPubky: buyer,
      sellerPubky: seller,
      state: 'pending',
      amount: { amountMinor: 9_000, currency: 'USD', exponent: 2 },
    });

    const withdrawn = await MarketplaceGatewayService.execute(
      buyer,
      envelope(offers[0].aggregateId, offers[0].revision, 'offer.withdraw', { offerId: offers[0].id }),
    );
    expect(withdrawn).toMatchObject({ ok: true, result: { kind: 'offer' } });
    const offersAfter = await MarketplaceGatewayService.getOffers(buyer);
    expect(offersAfter[0]).toMatchObject({ state: 'withdrawn', revision: offers[0].revision + 1 });

    // --- Role scoping: a bystander sees none of this ---
    const bystander = await establishSessionFor(sdk.Keypair.random());
    await expect(MarketplaceGatewayService.getOrders(bystander)).resolves.toEqual([]);
    await expect(MarketplaceGatewayService.getOffers(bystander)).resolves.toEqual([]);
    await expect(MarketplaceGatewayService.getPayment(bystander, order.paymentId)).resolves.toBeNull();

    // --- Seller again: the same events land as recipient-scoped notifications,
    // delivered at-least-once by the outbox worker (10s pass interval), so poll. ---
    await establishSessionFor(sellerKeypair);
    const sellerOrders = await MarketplaceGatewayService.getOrders(seller);
    expect(sellerOrders.map(({ id }) => id)).toContain(order.id);

    const deadline = Date.now() + 60_000;
    let notificationTypes: string[] = [];
    while (Date.now() < deadline) {
      const notifications = await MarketplaceGatewayService.getNotifications(seller);
      notificationTypes = notifications.map(({ type }) => type);
      if (notificationTypes.includes('order_created') && notificationTypes.includes('offer_received')) break;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    expect(notificationTypes).toContain('order_created');
    expect(notificationTypes).toContain('offer_received');

    MarketplaceSessionService.clearSession();
  });
});
