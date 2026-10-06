import { slowCypressDown } from 'cypress-slow-down';
// registers the cy.slowDown and cy.slowDownEnd commands
import 'cypress-slow-down/commands';
import {
  ensureSignedIn,
  findOrderAs,
  getListingRevision,
  getOffersAs,
  listingAggregateId,
  listingRoute,
  MARKETPLACE_SERVICE_URL,
  onboardMarketplaceUser,
  SANDBOX_MODERATOR,
  SCRIPTED_BUYER,
  sandboxCommand,
  SEEDED_LISTINGS,
  seedSandboxCatalog,
  shipOrderAs,
  purchaseListingAs,
  usd,
} from '../support/marketplace';
import { defaultMs } from '../support/slow-down';

// These journeys run against the SANDBOX adapter with the local sandbox
// transaction service (`npm run marketplace:dev`) and a local pubky testnet
// homeserver, per docs/ecommerce/RUNNING.md. The browser user performs every
// step a real user can perform in the UI. Counterparty steps that require a
// different identity (a seeded fictional seller shipping an order, a scripted
// buyer purchasing from the browser user's shop, the sandbox moderator
// resolving a dispute) are driven through the sandbox service's own API with
// its own identity model — the trusted `x-pubky-actor` header — because those
// identities cannot hold a browser session by design.

describe('marketplace public browsing', () => {
  before(() => {
    slowCypressDown();
  });

  it('shows signed-out visitors the sandbox catalog shell with an empty local cache', () => {
    cy.visit('/marketplace');
    cy.contains('h1', 'Find something rare.').should('be.visible');
    cy.contains('Sandbox · no real funds').should('be.visible');
    // the catalog cache is account-scoped; a guest who has not seeded sees the empty state
    cy.contains('No listings match').should('be.visible');
  });

  it('keeps seller, transaction, and seeding routes authentication protected', () => {
    cy.visit('/marketplace/sell');
    cy.location('pathname').should('not.eq', '/marketplace/sell');

    cy.visit('/marketplace/cart');
    cy.location('pathname').should('not.eq', '/marketplace/cart');

    // the sandbox seed page is gated on auth as well as adapter mode
    cy.visit('/marketplace/sandbox');
    cy.location('pathname').should('not.eq', '/marketplace/sandbox');
  });
});

describe('marketplace journeys', () => {
  const username = 'Marketeer';
  const pubkyAlias = 'marketeerPubky';

  before(() => {
    slowCypressDown();
    cy.deleteDownloadsFolder();
    onboardMarketplaceUser(username, pubkyAlias);
  });

  beforeEach(() => {
    cy.slowDown(defaultMs);
    // aliases are cleared between tests; re-create from the exposed value
    cy.wrap(Cypress.expose(pubkyAlias)).as(pubkyAlias);
    // sign back in when test isolation dropped the session
    ensureSignedIn(username);
    // Seed per test: signing back in from the backup file restores the account
    // with a fresh local database, so the account-scoped catalog cache must be
    // repopulated. Seeding is idempotent — the service skips already-registered
    // listings and local records are upserts.
    seedSandboxCatalog();
    cy.visit('/marketplace');
  });

  it('browses, filters, and searches the seeded catalog, opening a listing and its shop', () => {
    cy.contains('8 items').should('be.visible');

    // free-text search narrows and clears
    cy.get('input[placeholder="Search items, styles, or sellers"]').type('camera');
    cy.contains('1 item').should('be.visible');
    cy.contains(SEEDED_LISTINGS.camera.title).should('be.visible');
    cy.contains(SEEDED_LISTINGS.boots.title).should('not.exist');
    cy.contains('button', 'Clear').click();
    cy.contains('8 items').should('be.visible');

    // sale-format filter narrows to the two seeded auctions
    cy.get('[aria-label="Sale format"]').click();
    cy.contains('[role="option"]', 'Auctions').click();
    cy.contains('2 items').should('be.visible');
    cy.get('[aria-label="Sale format"]').click();
    cy.contains('[role="option"]', 'All formats').click();
    cy.contains('8 items').should('be.visible');

    // category chips filter and reset
    cy.contains('button', 'Electronics').click();
    cy.contains(SEEDED_LISTINGS.camera.title).should('be.visible');
    cy.contains(SEEDED_LISTINGS.boots.title).should('not.exist');
    // exact match: a substring match would hit the "All formats" select trigger
    cy.contains('button', /^All$/).click();
    cy.contains('8 items').should('be.visible');

    // open a listing and walk through to its shop
    cy.get(`[aria-label="View ${SEEDED_LISTINGS.boots.title}"]`).first().click();
    cy.location('pathname').should('eq', listingRoute(SEEDED_LISTINGS.boots.seller, SEEDED_LISTINGS.boots.listingId));
    cy.contains('h1', SEEDED_LISTINGS.boots.title).should('be.visible');
    cy.contains('View shop').click();
    cy.location('pathname').should('eq', `/marketplace/shop/${SEEDED_LISTINGS.boots.seller}`);
    cy.contains(SEEDED_LISTINGS.boots.title).should('be.visible');
  });

  it('buyer: carts a listing, checks out, advances payment, confirms delivery, and reviews', () => {
    const boots = SEEDED_LISTINGS.boots;
    const bootsAggregate = listingAggregateId(boots.seller, boots.listingId);

    cy.visit(listingRoute(boots.seller, boots.listingId));
    cy.contains('button', 'Add to cart').click();
    cy.visit('/marketplace/cart');
    cy.contains(boots.title).should('be.visible');

    // seeded inventory is a single unit: quantity is clamped on both sides
    cy.get(`[aria-label="Decrease ${boots.title} quantity"]`).should('be.disabled');
    cy.get(`[aria-label="Increase ${boots.title} quantity"]`).should('be.disabled');

    cy.get('#name').type('Marketeer Tester');
    cy.get('#line1').type('42 Journey Street');
    cy.get('#city').type('Lisbon');
    cy.get('#region').type('Lisbon');
    cy.get('#postalCode').type('1100-001');
    cy.get('#countryCode').clear().type('PT');
    // the guarantee checkbox is pre-accepted by default; confirm rather than toggle
    cy.get('[role="checkbox"]').should('have.attr', 'aria-checked', 'true');
    cy.contains('button', 'Place sandbox order').click();

    cy.location('pathname').should('eq', '/marketplace/orders');
    cy.contains('[data-slot="card"]', boots.title).within(() => {
      cy.contains('pending payment').should('be.visible');
      cy.contains('button', 'Simulate detected').click();
      cy.contains('detected').should('be.visible');
      cy.contains('button', 'Confirm payment').click();
      cy.contains('paid').should('be.visible');
      cy.get('[data-testid=order-reference-label]').should('be.visible').and('contain', 'Order ');
      cy.get('[data-testid=order-reference-copy]').should('be.visible');
      cy.get('[data-testid=order-receipt-hash]').should('not.be.visible');
      cy.contains('summary', 'Receipt').click();
      cy.get('[data-testid=order-receipt-hash]').should('be.visible').and('contain', 'Receipt integrity');
    });

    // the fictional seeded seller ships through the sandbox service API
    shipOrderAs(boots.seller, bootsAggregate, 'TRACK-BOOTS-1');
    cy.reload();
    cy.contains('[data-slot="card"]', boots.title).within(() => {
      cy.contains('shipped').should('be.visible');
      cy.contains('TRACK-BOOTS-1').should('be.visible');
      cy.contains('button', 'Confirm delivery').click();
      cy.contains('delivered').should('be.visible');
      cy.contains('button', 'Leave review').click();
    });
    cy.get('#text').type('Exactly as described. Fast sandbox logistics.');
    cy.contains('button', 'Confirm').click();
    cy.contains('[data-slot="card"]', boots.title).within(() => {
      cy.contains('button', 'Leave review').should('not.exist');
    });
  });

  it('buyer: makes an offer, receives a counter, and accepts it', () => {
    const jacket = SEEDED_LISTINGS.jacket;
    const jacketAggregate = listingAggregateId(jacket.seller, jacket.listingId);

    cy.visit(listingRoute(jacket.seller, jacket.listingId));
    cy.contains('button', 'Make offer').click();
    cy.get('#amount').type('70.00');
    cy.get('#message').type('Would you take seventy?');
    cy.contains('button', 'Send offer').click();

    cy.visit('/marketplace/offers');
    cy.contains('[data-slot="card"]', 'Sent').within(() => {
      cy.contains('pending').should('be.visible');
    });

    // the fictional seller counters through the sandbox service API
    getOffersAs(jacket.seller, jacketAggregate).then((offers) => {
      const offer = offers.find(({ state }) => state === 'pending');
      expect(offer, 'the pending offer reached the seller').to.not.eq(undefined);
      sandboxCommand(jacket.seller, 'offer.counter', offer!.aggregateId, offer!.revision, {
        offerId: offer!.id,
        amount: usd(80),
        quantity: 1,
        expiresInSeconds: 3_600,
        message: 'Eighty and it ships today.',
      });
    });

    cy.reload();
    cy.contains('[data-slot="card"]', 'Eighty and it ships today.').within(() => {
      cy.contains('Incoming').should('be.visible');
      cy.contains('countered').should('be.visible');
      cy.contains('button', 'Accept').click();
    });
    cy.contains('[data-slot="card"]', 'Eighty and it ships today.').within(() => {
      cy.contains('accepted').should('be.visible');
    });
  });

  it('bidder: places a proxy bid on a live auction and sees a rival bid land', () => {
    const camera = SEEDED_LISTINGS.camera;
    const cameraAggregate = listingAggregateId(camera.seller, camera.listingId);

    cy.visit(listingRoute(camera.seller, camera.listingId));
    cy.contains('button', 'Place a bid').click();
    cy.get('#maximumAmount').type('100.00');
    cy.contains('button', 'Confirm bid').click();
    cy.contains('Current bid').should('be.visible');
    cy.contains('1 bid').should('be.visible');

    // a scripted rival outbids through the sandbox service API
    getListingRevision(cameraAggregate).then((revision) => {
      sandboxCommand(SCRIPTED_BUYER, 'auction.place_bid', cameraAggregate, revision, {
        maximumAmount: usd(200),
      });
    });
    cy.reload();
    cy.contains('2 bids').should('be.visible');
  });

  it('seller: publishes a listing to the homeserver, accepts an offer, and fulfils a sale', () => {
    cy.visit('/marketplace/sell');
    cy.get('#title').type('Cypress workshop lamp');
    cy.get('#description').type('A study lamp published by the marketplace E2E journey. Warm light, steel shade.');
    cy.get('input[type="file"]').selectFile('fixtures/mustache-you.png', { force: true });
    cy.get('#altText').type('A steel workshop lamp with a warm bulb');
    cy.get('#price').type('45.00');
    cy.get('[id="variants.0.quantity"]').clear().type('3');
    cy.get('#shippingPrice').type('10.00');
    cy.get('#weightGrams').type('800');
    cy.get('#lengthMillimeters').type('200');
    cy.get('#widthMillimeters').type('150');
    cy.get('#heightMillimeters').type('120');
    cy.contains('button', 'Publish listing').click();

    // publish writes the owner-signed record to the local testnet homeserver
    cy.location('pathname', { timeout: 30_000 }).should('include', '/marketplace/listing/');
    cy.contains('h1', 'Cypress workshop lamp').should('be.visible');
    cy.location('pathname').then((pathname) => {
      const [, , , sellerPubky, publishedListingId] = pathname.split('/');
      const lampAggregate = listingAggregateId(sellerPubky, publishedListingId);

      cy.visit('/marketplace/dashboard');
      cy.contains('Cypress workshop lamp').should('be.visible');

      // a scripted buyer makes an offer on the published listing
      getListingRevision(lampAggregate).then((revision) => {
        sandboxCommand(SCRIPTED_BUYER, 'offer.create', lampAggregate, revision, {
          amount: usd(40),
          quantity: 1,
          expiresInSeconds: 3_600,
          message: 'Scripted buyer would like the lamp.',
        });
      });
      cy.visit('/marketplace/offers');
      cy.contains('[data-slot="card"]', 'Scripted buyer would like the lamp.').within(() => {
        cy.contains('Incoming').should('be.visible');
        cy.contains('button', 'Accept').click();
      });
      cy.contains('[data-slot="card"]', 'Scripted buyer would like the lamp.').within(() => {
        cy.contains('accepted').should('be.visible');
      });

      // the scripted buyer then buys a unit outright and pays
      purchaseListingAs(SCRIPTED_BUYER, lampAggregate);
      cy.visit('/marketplace/orders');
      cy.contains('[data-slot="card"]', 'Cypress workshop lamp').within(() => {
        cy.contains('Sale').should('be.visible');
        cy.contains('paid').should('be.visible');
        cy.contains('button', 'Add tracking').click();
      });
      cy.get('#carrier').type('Cypress Freight');
      cy.get('#trackingNumber').type('TRACK-LAMP-1');
      cy.contains('button', 'Confirm').click();
      cy.contains('[data-slot="card"]', 'Cypress workshop lamp').within(() => {
        cy.contains('shipped').should('be.visible');
      });

      // the scripted buyer confirms delivery; the seller sees the final state
      findOrderAs(SCRIPTED_BUYER, lampAggregate).then((order) => {
        sandboxCommand(SCRIPTED_BUYER, 'fulfillment.confirm_delivery', `order:${order.id}`, order.revision, {
          orderId: order.id,
        });
      });
      cy.reload();
      cy.contains('[data-slot="card"]', 'Cypress workshop lamp').within(() => {
        cy.contains('delivered').should('be.visible');
      });
    });
  });

  it('moderator: a buyer dispute is resolved by the sandbox moderator, and reports reach only moderators', () => {
    const boots = SEEDED_LISTINGS.boots;
    const bootsAggregate = listingAggregateId(boots.seller, boots.listingId);

    // the buyer opens a dispute on the delivered order from the buyer journey
    cy.visit('/marketplace/orders');
    cy.contains('[data-slot="card"]', boots.title).within(() => {
      cy.contains('button', 'Open dispute').click();
    });
    cy.get('#reason').type('The sole cracked on first wear.');
    cy.contains('button', 'Confirm').click();
    cy.contains('[data-slot="card"]', boots.title).within(() => {
      cy.contains('Dispute open').should('be.visible');
    });

    // only the configured sandbox moderator may resolve; the buyer's own read
    // supplies the order revision the moderator command must carry
    cy.get('@marketeerPubky').then((buyerPubky) => {
      findOrderAs(String(buyerPubky), bootsAggregate).then((order) => {
        // a non-moderator resolution attempt is refused
        cy.request({
          method: 'POST',
          url: `${MARKETPLACE_SERVICE_URL}/v1/commands`,
          headers: { 'x-pubky-actor': String(buyerPubky) },
          failOnStatusCode: false,
          body: {
            version: 1,
            commandId: crypto.randomUUID(),
            aggregateId: `order:${order.id}`,
            expectedRevision: order.revision,
            issuedAt: new Date().toISOString(),
            kind: 'dispute.resolve',
            payload: { orderId: order.id, resolution: 'buyer_refund', rationale: 'Trying to self-resolve.' },
          },
        }).then((response) => {
          expect(response.status, 'non-moderator dispute resolution is refused').to.eq(403);
        });
        sandboxCommand(SANDBOX_MODERATOR, 'dispute.resolve', `order:${order.id}`, order.revision, {
          orderId: order.id,
          resolution: 'buyer_refund',
          rationale: 'Photos support the buyer. Refund externally and close.',
        });
      });
    });
    cy.reload();
    cy.contains('[data-slot="card"]', boots.title).within(() => {
      cy.contains('resolved as buyer refund').should('be.visible');
    });

    // the seller records the external refund evidence the resolution requires
    findOrderAs(boots.seller, bootsAggregate).then((order) => {
      sandboxCommand(boots.seller, 'refund.record_external', `order:${order.id}`, order.revision, {
        orderId: order.id,
        amountMinor: order.total.amountMinor,
        transactionId: 'e2e-external-refund-0001',
      });
    });
    cy.reload();
    cy.contains('[data-slot="card"]', boots.title).within(() => {
      cy.contains('External refund evidence: e2e-external-refund-0001').should('be.visible');
    });

    // the buyer reports a listing through the UI
    const jacket = SEEDED_LISTINGS.jacket;
    cy.visit(listingRoute(jacket.seller, jacket.listingId));
    cy.contains('button', 'Report listing').click();
    cy.get('[aria-label="Report reason"]').click();
    cy.contains('[role="option"]', 'Counterfeit').click();
    cy.get('#details').type('Stitching and labels do not match the brand.');
    cy.contains('button', 'Submit report').click();

    // the report is readable by the moderator role and by no one else
    cy.request({
      url: `${MARKETPLACE_SERVICE_URL}/v1/reports`,
      headers: { 'x-pubky-actor': SANDBOX_MODERATOR },
    }).then((response) => {
      expect(response.status).to.eq(200);
      const details = JSON.stringify(response.body.reports);
      expect(details, 'the UI-submitted report reached the moderation queue').to.include(
        'Stitching and labels do not match the brand.',
      );
    });
    cy.get('@marketeerPubky').then((buyerPubky) => {
      cy.request({
        url: `${MARKETPLACE_SERVICE_URL}/v1/reports`,
        headers: { 'x-pubky-actor': String(buyerPubky) },
        failOnStatusCode: false,
      }).then((response) => {
        expect(response.status, 'non-moderators cannot read the report queue').to.eq(403);
      });
    });

    // the in-app moderation page states the truth for this non-moderator account
    cy.visit('/marketplace/moderation');
    cy.contains('This account does not have marketplace moderator access.').should('be.visible');
    cy.contains('no dispute queue and no evidence records').should('be.visible');
  });

  it('buyer: requests a return on a delivered order and follows it to received', () => {
    const runners = SEEDED_LISTINGS.runners;
    const runnersAggregate = listingAggregateId(runners.seller, runners.listingId);

    cy.visit(listingRoute(runners.seller, runners.listingId));
    cy.contains('button', 'Add to cart').click();
    cy.visit('/marketplace/cart');
    cy.get('#name').type('Marketeer Tester');
    cy.get('#line1').type('42 Journey Street');
    cy.get('#city').type('Lisbon');
    cy.get('#region').type('Lisbon');
    cy.get('#postalCode').type('1100-001');
    cy.get('#countryCode').clear().type('PT');
    // the guarantee checkbox is pre-accepted by default; confirm rather than toggle
    cy.get('[role="checkbox"]').should('have.attr', 'aria-checked', 'true');
    cy.contains('button', 'Place sandbox order').click();
    cy.location('pathname').should('eq', '/marketplace/orders');
    cy.contains('[data-slot="card"]', runners.title).within(() => {
      cy.contains('button', 'Confirm payment').click();
      cy.contains('paid').should('be.visible');
    });

    shipOrderAs(runners.seller, runnersAggregate, 'TRACK-RUNNERS-1');
    cy.reload();
    cy.contains('[data-slot="card"]', runners.title).within(() => {
      cy.contains('button', 'Confirm delivery').click();
      cy.contains('delivered').should('be.visible');
      cy.contains('button', 'Request return').click();
    });
    cy.get('#reason').type('Half a size too small.');
    cy.contains('button', 'Confirm').click();
    cy.contains('[data-slot="card"]', runners.title).within(() => {
      cy.contains('Return requested').should('be.visible');
    });

    // the fictional seller approves and receives the return via the service
    findOrderAs(runners.seller, runnersAggregate).then((order) => {
      sandboxCommand(runners.seller, 'return.approve', `order:${order.id}`, order.revision, {
        orderId: order.id,
      }).then(({ revision }) => {
        sandboxCommand(runners.seller, 'return.receive', `order:${order.id}`, revision, { orderId: order.id });
      });
    });
    cy.reload();
    cy.contains('[data-slot="card"]', runners.title).within(() => {
      cy.contains('Return received').should('be.visible');
    });
  });

  it('buyer: messages a seller with sandbox messaging and sees commerce notifications', () => {
    const boots = SEEDED_LISTINGS.boots;

    cy.visit(listingRoute(boots.seller, boots.listingId));
    cy.contains('button', 'Message seller').click();
    cy.get('#text').type('Is the leather full-grain?');
    cy.contains('button', 'Send').click();
    cy.contains('Is the leather full-grain?').should('be.visible');
    cy.get('[data-testid="dialog-close"]').click();

    cy.visit('/marketplace/messages');
    cy.contains('Is the leather full-grain?').should('be.visible');

    // commerce activity accumulated across the journeys; mark it read
    cy.visit('/marketplace/notifications');
    cy.contains('unread transaction').should('be.visible');
    cy.contains('button', 'Mark all read').then(($button) => {
      if (!$button.prop('disabled')) {
        cy.wrap($button).click();
      }
    });
    cy.contains('0 unread transaction updates.').should('be.visible');
  });
});
