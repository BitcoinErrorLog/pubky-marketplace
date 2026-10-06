// Helpers for driving the sandbox marketplace in E2E journeys.
//
// The browser user drives every step a real user can perform through the UI.
// Counterparty actors (a seeded fictional seller, a scripted buyer, the
// sandbox moderator) cannot exist as browser sessions, so their steps go
// through the sandbox transaction service's own HTTP API using the exact
// identity model that service defines: a trusted `x-pubky-actor` header.
// That is not a mock — it is the same API and the same in-memory state the
// app under test talks to.

import { backupDownloadFilePath } from './common';

export const MARKETPLACE_SERVICE_URL = 'http://localhost:3100';

/** The sandbox service's configured moderator identity (`transaction-service.ts`). */
export const SANDBOX_MODERATOR = 'm'.repeat(52);

/** A scripted counterparty for flows the seller side of the UI needs (valid z-base-32). */
export const SCRIPTED_BUYER = 'o'.repeat(52);

/** Seeded fictional sellers/listings from `src/libs/commerce/sandbox-catalog.ts`. */
export const SEEDED_LISTINGS = {
  boots: { seller: 'y'.repeat(52), listingId: 'leather_boots', title: 'Vintage leather boots' },
  jacket: { seller: 'b'.repeat(52), listingId: 'selvedge_jacket', title: 'Selvedge denim jacket' },
  camera: { seller: 'n'.repeat(52), listingId: 'rangefinder_camera', title: '35mm rangefinder camera' },
  runners: { seller: 'f'.repeat(52), listingId: 'trail_runners', title: 'Technical trail runners' },
} as const;

export interface SandboxMoney {
  amountMinor: number;
  currency: string;
  exponent: number;
}

export const usd = (amount: number): SandboxMoney => ({
  amountMinor: Math.round(amount * 100),
  currency: 'USD',
  exponent: 2,
});

export const listingAggregateId = (sellerPubky: string, listingId: string): string =>
  `listing:${sellerPubky}_${listingId}`;

export const listingRoute = (sellerPubky: string, listingId: string): string =>
  `/marketplace/listing/${sellerPubky}/${listingId}`;

/**
 * Onboard a fresh user against the local testnet homeserver.
 *
 * Same steps as the shared `onboardAsNewUser` command (invite code from the
 * homeserver admin endpoint, keys in browser, encrypted-file backup, profile),
 * with one deliberate difference: the closing welcome dialog is dismissed only
 * if it renders. That dialog requires the user's details to have synced from
 * Nexus, and the staging Nexus this environment points at can never index a
 * user who lives on the local testnet homeserver — so on this topology the
 * dialog legitimately does not appear.
 */
export function onboardMarketplaceUser(profileName: string, pubkyAlias: string): void {
  cy.visit('/');
  cy.get('#create-account-btn').click();
  cy.location('pathname').should('eq', '/onboarding/human');

  cy.get('[data-cy="invite-code-link"]').should('exist').click();
  cy.env(['homeserverAdminUrl', 'homeserverAdminPassword']).then(({ homeserverAdminUrl, homeserverAdminPassword }) => {
    cy.request({
      method: 'GET',
      url: homeserverAdminUrl,
      headers: { 'X-Admin-Password': homeserverAdminPassword },
    }).then((response) => {
      cy.get('[data-cy="human-invite-code-input"]').type(response.body);
      cy.get('[data-cy="human-invite-code-continue-btn"]').should('not.be.disabled').click();
    });
  });

  cy.location('pathname').should('eq', '/onboarding/install');
  cy.get('#create-keys-in-browser-btn').click();
  cy.location('pathname').should('eq', '/onboarding/pubky');

  cy.get('[data-cy="pubky-display"]').should('be.visible');
  cy.get('[data-cy="pubky-display"]')
    .invoke('val')
    .then((value) => {
      // the display value carries the `pubky` URI prefix; actors are bare z-base-32
      cy.saveStringToAlias(String(value).replace(/^pubky/, ''), pubkyAlias);
    });
  cy.get('#public-key-navigation-continue-btn').click();
  cy.location('pathname').should('eq', '/onboarding/backup');

  // encrypted-file backup so later tests can sign back in after test isolation
  cy.get('#backup-encrypted-file-btn').click();
  cy.get('#password').type('123456');
  cy.get('#confirmPassword').type('123456');
  cy.get('#download-file-btn').click();
  cy.renameFile(backupDownloadFilePath(), backupDownloadFilePath(profileName));
  cy.get('#backup-successful-ok-btn').click();
  cy.get('#backup-navigation-continue-btn').click();
  cy.location('pathname').should('eq', '/onboarding/profile');

  cy.get('#profile-name-input').clear().type(profileName);
  cy.get('#profile-finish-btn').click({ timeout: 60_000 });
  cy.location('pathname', { timeout: 60_000 }).should('eq', '/home');

  // dismiss the welcome dialog when the environment can render it
  cy.wait(2_000);
  cy.get('body').then(($body) => {
    if ($body.find('#welcome-title').length > 0) {
      cy.get('#welcome-explore-pubky-btn').click();
    }
  });
}

/**
 * Ensure the given onboarded user is signed in. Test isolation clears
 * per-test browser state but the app's session may or may not survive it, so
 * visit `/` and settle on whichever state actually renders: signed-in users
 * are redirected to `/home`; guests get the landing page and sign back in
 * with the encrypted backup file created during onboarding.
 */
export function ensureSignedIn(profileName: string): void {
  const settle = (attempts: number): void => {
    cy.location('pathname').then((path) => {
      if (path === '/home') return;
      cy.get('body').then(($body) => {
        if ($body.find('#create-account-btn').length > 0) {
          cy.signInWithEncryptedFile(backupDownloadFilePath(profileName));
          return;
        }
        expect(attempts, 'attempts left to settle the auth state on /').to.be.greaterThan(0);
        cy.wait(500);
        settle(attempts - 1);
      });
    });
  };
  cy.visit('/');
  settle(30);
}

/** Seed the sandbox catalog through the gated demo page, exactly as a user would. */
export function seedSandboxCatalog(): void {
  cy.visit('/marketplace/sandbox');
  cy.contains('button', 'Seed sandbox catalog').click();
  cy.contains('Sandbox catalog seeded', { timeout: 30_000 }).should('be.visible');
}

interface SandboxCommandSuccess {
  ok: true;
  commandId: string;
  aggregateId: string;
  revision: number;
  result: Record<string, unknown>;
}

/** Issue one command to the sandbox service as the given actor and assert it succeeded. */
export function sandboxCommand(
  actor: string,
  kind: string,
  aggregateId: string,
  expectedRevision: number,
  payload: Record<string, unknown>,
): Cypress.Chainable<SandboxCommandSuccess> {
  return cy
    .request({
      method: 'POST',
      url: `${MARKETPLACE_SERVICE_URL}/v1/commands`,
      headers: { 'x-pubky-actor': actor },
      body: {
        version: 1,
        commandId: crypto.randomUUID(),
        aggregateId,
        expectedRevision,
        issuedAt: new Date().toISOString(),
        kind,
        payload,
      },
    })
    .then((response) => {
      expect(response.body.ok, `${kind} on ${aggregateId}: ${JSON.stringify(response.body.error ?? '')}`).to.eq(true);
      return cy.wrap(response.body as SandboxCommandSuccess, { log: false });
    });
}

/** Read a listing's current server revision (public sandbox projection). */
export function getListingRevision(aggregateId: string): Cypress.Chainable<number> {
  return cy
    .request(`${MARKETPLACE_SERVICE_URL}/v1/listings?aggregateId=${encodeURIComponent(aggregateId)}`)
    .then((response) => {
      expect(response.body.serverRevision, `server revision of ${aggregateId}`).to.be.a('number');
      return cy.wrap(response.body.serverRevision as number, { log: false });
    });
}

interface SandboxOrder {
  id: string;
  revision: number;
  state: string;
  buyerPubky: string;
  sellerPubky: string;
  total: SandboxMoney;
  lines: Array<{ listingAggregateId: string; title: string; quantity: number }>;
}

/** Read the participant-scoped orders projection for an actor. */
export function getOrdersAs(actor: string): Cypress.Chainable<SandboxOrder[]> {
  return cy
    .request({ url: `${MARKETPLACE_SERVICE_URL}/v1/orders`, headers: { 'x-pubky-actor': actor } })
    .then((response) => cy.wrap(response.body.orders as SandboxOrder[], { log: false }));
}

/** Find the newest order for an actor that includes the given listing aggregate. */
export function findOrderAs(actor: string, aggregateOfListing: string): Cypress.Chainable<SandboxOrder> {
  return getOrdersAs(actor).then((orders) => {
    const match = orders.find((order) => order.lines.some((line) => line.listingAggregateId === aggregateOfListing));
    expect(match, `an order for ${aggregateOfListing} visible to ${actor.slice(0, 8)}…`).to.not.eq(undefined);
    return cy.wrap(match as SandboxOrder, { log: false });
  });
}

interface SandboxOffer {
  id: string;
  aggregateId: string;
  revision: number;
  state: string;
  offeredBy: string;
  buyerPubky: string;
  sellerPubky: string;
}

/** Read the offers visible to an actor, optionally scoped to one listing aggregate. */
export function getOffersAs(actor: string, aggregateOfListing?: string): Cypress.Chainable<SandboxOffer[]> {
  const query = aggregateOfListing ? `?aggregateId=${encodeURIComponent(aggregateOfListing)}` : '';
  return cy
    .request({ url: `${MARKETPLACE_SERVICE_URL}/v1/offers${query}`, headers: { 'x-pubky-actor': actor } })
    .then((response) => cy.wrap(response.body.offers as SandboxOffer[], { log: false }));
}

/**
 * Ship the actor's paid order for a listing (the seller-side step of a
 * purchase whose seller is a seeded fictional identity).
 */
export function shipOrderAs(actor: string, aggregateOfListing: string, trackingNumber: string): void {
  findOrderAs(actor, aggregateOfListing).then((order) => {
    sandboxCommand(actor, 'fulfillment.ship', `order:${order.id}`, order.revision, {
      orderId: order.id,
      carrier: 'Cypress Freight',
      trackingNumber,
    });
  });
}

interface SandboxPayment {
  id: string;
  revision: number;
  state: string;
}

/**
 * Full scripted-buyer purchase of one listing unit: checkout, then advance
 * the sandbox payment to confirmed. Used where the browser user plays the
 * seller and the buyer must be a counterparty actor. The checkout aggregate
 * id is derived from the command id, per the service contract.
 */
export function purchaseListingAs(actor: string, aggregateOfListing: string): void {
  getListingRevision(aggregateOfListing).then((revision) => {
    const commandId = crypto.randomUUID();
    cy.request({
      method: 'POST',
      url: `${MARKETPLACE_SERVICE_URL}/v1/commands`,
      headers: { 'x-pubky-actor': actor },
      body: {
        version: 1,
        commandId,
        aggregateId: `checkout:${commandId}`,
        expectedRevision: 0,
        issuedAt: new Date().toISOString(),
        kind: 'checkout.create',
        payload: {
          lines: [{ listingAggregateId: aggregateOfListing, expectedRevision: revision, quantity: 1 }],
          deliveryAddress: {
            name: 'Scripted Buyer',
            line1: '1 Test Lane',
            line2: '',
            city: 'Testville',
            region: 'TS',
            postalCode: '00001',
            countryCode: 'US',
          },
          guaranteePolicyVersion: 1,
        },
      },
    }).then((response) => {
      expect(response.body.ok, `scripted checkout of ${aggregateOfListing}`).to.eq(true);
      const payment = (response.body.result.payments as SandboxPayment[])[0];
      expect(payment, 'scripted checkout produced a payment').to.not.eq(undefined);
      sandboxCommand(actor, 'payment.sandbox_advance', `payment:${payment.id}`, payment.revision, {
        paymentId: payment.id,
        target: 'confirmed',
        confirmations: 1,
      });
    });
  });
}
