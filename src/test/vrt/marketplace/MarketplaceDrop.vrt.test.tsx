// Intentional import order — browser-mode mock factories rely on stable aliases.
/* eslint-disable simple-import-sort/imports */
import { createMarketplaceVrtAuthStore, createMarketplaceVrtCommerceController } from '@/test/mocks/marketplace-vrt';
import { describe, expect, it, vi } from 'vitest';
import { renderForVRT, VRT_ROOT_TESTID } from '@/test-utils/vrt';
import { HOUR_MS, VRT_FROZEN_NOW_MS } from '@/test-utils/vrt.clock';
import type { VrtViewport } from '@/test-utils/vrt.viewports';
import { MarketplaceDrop } from '@/templates/Marketplace/MarketplaceDrop';

// Taller-than-standard viewports: the drop page stacks teaser, ready check,
// claim/archive, and the no-fake-promise footer — the promise line is part
// of every baseline on purpose, so the capture must reach the footer.
const VRT_VIEWPORT_DROP_DESKTOP: VrtViewport = { width: 1440, height: 1300 };
const VRT_VIEWPORT_DROP_MOBILE: VrtViewport = { width: 390, height: 1300 };

/**
 * Every shopper-facing drop page state (ADR 0026 / drops design):
 * announced (countdown + all-green ready check + remind-me), live (claim
 * surface, exact stock), a live refusal with the service's pinned copy
 * verbatim, the three ended archive states (sold out / closed / cancelled
 * — the honest final-state labels), and the unregistered estimate state.
 * The no-fake-promise footer is part of every baseline on purpose.
 */

const VRT_SELLER = vi.hoisted(() => 's'.repeat(52));
const VRT_BUYER = vi.hoisted(() => 'b'.repeat(52));

const view = vi.hoisted(() => ({
  drop: {} as Record<string, unknown>,
  claim: {} as Record<string, unknown>,
  currentUserPubky: VRT_BUYER as string | null,
}));
const shopFollow = vi.hoisted(() => ({
  toggle: vi.fn(),
}));

vi.mock('@/hooks/useMarketplaceDrop/useMarketplaceDrop', async () => {
  const actual = await vi.importActual<typeof import('@/hooks/useMarketplaceDrop/useMarketplaceDrop')>(
    '@/hooks/useMarketplaceDrop/useMarketplaceDrop',
  );
  return { ...actual, useMarketplaceDrop: () => view.drop };
});

vi.mock('@/hooks/useMarketplaceDropClaim/useMarketplaceDropClaim', () => ({
  useMarketplaceDropClaim: () => view.claim,
}));

vi.mock('@/hooks/useCommerceShopFollow/useCommerceShopFollow', () => ({
  useCommerceShopFollow: () => ({ isFollowing: false, isLoading: false, isMutating: false, toggle: shopFollow.toggle }),
}));

vi.mock('@/hooks/useIndicativeBtcRate/useIndicativeBtcRate', () => ({
  useIndicativeBtcRate: () => null,
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    ...createMarketplaceVrtCommerceController(),
    getOrFetchShop: vi.fn(async () => ({ name: 'Analog Sound Co.' })),
    getOrFetchListing: vi.fn(async (_seller: string, listingId: string) => ({
      ownerPubky: VRT_SELLER,
      listingId,
      title: listingId === 'listing-a' ? 'Field Recordings Vol. 1 — Vinyl' : 'Field Recordings Vol. 1 — Tape',
      media: [],
      sale: {
        format: 'fixed_price',
        unitPrice: { amountMinor: 4_500, currency: 'USD', exponent: 2 },
      },
    })),
  },
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: createMarketplaceVrtAuthStore({ getCurrentUserPubky: () => view.currentUserPubky }),
}));

vi.mock('@/stores/commerce/commerce.store', () => ({
  useCommerceStore: (selector: (state: { marketplaceSession: object }) => unknown) =>
    selector({
      marketplaceSession: {
        pubky: VRT_BUYER,
        capabilities: '/pub/pubky.app/:rw',
        expiresAt: '2026-01-02T00:00:00Z',
        issuedAt: '2026-01-01T00:00:00Z',
      },
    }),
}));

// Teaser/listing media resolve to null → the deterministic gradient fallback,
// same as the other marketplace VRT suites (no doomed network fetches).
vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  const { createMarketplaceMediaHooks } = await import('@/test/mocks/marketplace-media-hooks');
  return createMarketplaceMediaHooks(() => null);
});

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main className="w-full py-6">{children}</main>,
}));

const STARTS_AT = new Date(VRT_FROZEN_NOW_MS + 2 * HOUR_MS).toISOString();
const ENDS_AT = new Date(VRT_FROZEN_NOW_MS + 26 * HOUR_MS).toISOString();
// A live/ended drop's window opened in the past — the fixtures must agree
// with the state they claim.
const STARTED_AT = new Date(VRT_FROZEN_NOW_MS - HOUR_MS).toISOString();
const ENDED_AT = new Date(VRT_FROZEN_NOW_MS - HOUR_MS / 2).toISOString();

function makeRecord() {
  return {
    schemaVersion: 1,
    recordType: 'drop',
    ownerPubky: VRT_SELLER,
    dropId: 'vol1',
    title: 'Field Recordings Vol. 1',
    description:
      'One hundred numbered copies, first come first served. The clock and the caps are enforced by the transaction service — this page never pretends otherwise.',
    media: [],
    format: 'fcfs',
    startsAt: STARTS_AT,
    endsAt: ENDS_AT,
    listingIds: ['listing-a', 'listing-b'],
    totalQuantity: 100,
    perBuyerLimit: 2,
    stockDisplay: 'exact',
    revision: 1,
    createdAt: '2025-12-20T12:00:00.000Z',
    updatedAt: '2025-12-20T12:00:00.000Z',
  };
}

function makeProjection(overrides: Record<string, unknown> = {}) {
  return {
    sellerPubky: VRT_SELLER,
    dropId: 'vol1',
    aggregateId: `drop:${VRT_SELLER}_vol1`,
    state: 'announced',
    format: 'fcfs',
    startsAt: STARTS_AT,
    endsAt: ENDS_AT,
    stockDisplay: 'exact',
    totalQuantity: 100,
    perBuyerLimit: 2,
    remaining: 100,
    remainingBand: null,
    revision: 3,
    serverTime: new Date(VRT_FROZEN_NOW_MS).toISOString(),
    ...overrides,
  };
}

function setDropView(overrides: Record<string, unknown>) {
  view.currentUserPubky = VRT_BUYER;
  view.drop = {
    record: makeRecord(),
    recordError: null,
    projection: makeProjection(),
    clockOffsetMs: 0,
    readyCheck: { purchased: 0, perBuyerLimit: 2, remainingAllowance: 2 },
    displayState: 'announced',
    isLoading: false,
    adapterMode: 'transaction-service',
    refresh: vi.fn(async () => {}),
    ...overrides,
  };
}

function setClaimView(overrides: Record<string, unknown> = {}) {
  view.claim = {
    addresses: [{ id: `${VRT_BUYER}:addr1` }],
    claimAddress: { id: `${VRT_BUYER}:addr1` },
    submittingListingId: null,
    claimedListingIds: new Set<string>(),
    failure: null,
    needsSession: false,
    sessionError: null,
    claim: vi.fn(async () => true),
    ...overrides,
  };
}

async function renderDropPage(viewport = VRT_VIEWPORT_DROP_DESKTOP) {
  return await renderForVRT(<MarketplaceDrop sellerPubky={VRT_SELLER} dropId="vol1" />, {
    viewport,
    disableHover: true,
  });
}

describe('Marketplace drop page — visual regression', () => {
  it('renders the announced state with countdown, all-green ready check, and remind-me at desktop viewport', async () => {
    setDropView({});
    setClaimView();
    const screen = await renderDropPage();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-announced-desktop');
  });

  it('renders the announced state at mobile viewport', async () => {
    setDropView({});
    setClaimView();
    const screen = await renderDropPage(VRT_VIEWPORT_DROP_MOBILE);
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-announced-mobile');
  });

  it('renders the live claim surface with exact stock at desktop viewport', async () => {
    setDropView({
      projection: makeProjection({ state: 'live', startsAt: STARTED_AT, remaining: 12 }),
      displayState: 'live',
    });
    setClaimView();
    const screen = await renderDropPage();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-live-desktop');
  });

  it('renders the claimed confirmation with the payment deadline at desktop viewport', async () => {
    setDropView({
      projection: makeProjection({ state: 'live', startsAt: STARTED_AT, remaining: 12 }),
      displayState: 'live',
    });
    setClaimView({
      claimedListingIds: new Set(['s'.repeat(52) + ':listing-a']),
      claimDeadlines: new Map([
        ['s'.repeat(52) + ':listing-a', new Date(VRT_FROZEN_NOW_MS + 2 * HOUR_MS).toISOString()],
      ]),
    });
    const screen = await renderDropPage();
    await expect.element(screen.getByText('Claimed — Continue checkout')).toBeVisible();
    await expect.element(screen.getByText(/Complete payment by/i)).toBeVisible();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-live-claimed-deadline-desktop');
  });

  it("renders a live refusal with the service's pinned copy verbatim at desktop viewport", async () => {
    setDropView({
      projection: makeProjection({
        state: 'live',
        startsAt: STARTED_AT,
        stockDisplay: 'bands',
        remaining: null,
        remainingBand: 'last_few',
      }),
      displayState: 'live',
    });
    setClaimView({ failure: "You have reached this drop's per-buyer limit." });
    const screen = await renderDropPage();
    await expect.element(screen.getByText("You have reached this drop's per-buyer limit.")).toBeInTheDocument();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-live-refusal-desktop');
  });

  it('renders the sold-out archive at desktop viewport', async () => {
    setDropView({
      projection: makeProjection({ state: 'ended_sold_out', startsAt: STARTED_AT, endsAt: ENDED_AT, remaining: 0 }),
      displayState: 'ended_sold_out',
      readyCheck: null,
    });
    setClaimView();
    const screen = await renderDropPage();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-ended-sold-out-desktop');
  });

  it('renders the ended (closed) archive at desktop viewport', async () => {
    setDropView({
      projection: makeProjection({ state: 'ended_closed', startsAt: STARTED_AT, endsAt: ENDED_AT, remaining: 37 }),
      displayState: 'ended_closed',
      readyCheck: null,
    });
    setClaimView();
    const screen = await renderDropPage();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-ended-closed-desktop');
  });

  it('renders the cancelled-by-seller archive with honest copy at desktop viewport', async () => {
    setDropView({
      projection: makeProjection({ state: 'ended_cancelled', startsAt: STARTED_AT, endsAt: ENDED_AT, remaining: 88 }),
      displayState: 'ended_cancelled',
      readyCheck: null,
    });
    setClaimView();
    const screen = await renderDropPage();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-ended-cancelled-desktop');
  });

  it('renders the unregistered estimate state at desktop viewport', async () => {
    setDropView({ projection: null, clockOffsetMs: null, displayState: 'unregistered', readyCheck: null });
    setClaimView();
    const screen = await renderDropPage();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-unregistered-desktop');
  });

  it('renders the logged-out live claim path at desktop viewport', async () => {
    setDropView({
      projection: makeProjection({ state: 'live', startsAt: STARTED_AT, remaining: 12 }),
      displayState: 'live',
      readyCheck: null,
    });
    view.currentUserPubky = null;
    setClaimView({ needsSession: true, addresses: [], claimAddress: null });
    const screen = await renderDropPage();
    await expect(screen.getByRole('button', { name: 'Sign in to buy' })).toBeVisible();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-logged-out-desktop');
  });

  it('renders the logged-out live claim path at mobile viewport', async () => {
    setDropView({
      projection: makeProjection({ state: 'live', startsAt: STARTED_AT, remaining: 12 }),
      displayState: 'live',
      readyCheck: null,
    });
    view.currentUserPubky = null;
    setClaimView({ needsSession: true, addresses: [], claimAddress: null });
    const screen = await renderDropPage(VRT_VIEWPORT_DROP_MOBILE);
    await expect(screen.getByRole('button', { name: 'Sign in to buy' })).toBeVisible();
    await expect(screen.getByTestId(VRT_ROOT_TESTID)).toMatchScreenshot('drop-logged-out-mobile');
  });
});
