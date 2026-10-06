import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { type MarketplacePickupReveal, MaskedPickupDetails } from '@/libs/commerce/pickup';
import type { AppError } from '@/libs/error/error';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { createOrderFixture } from '@/test/fixtures/commerce/orders';
import { MarketplacePickupRevealDialog } from './MarketplacePickupRevealDialog';

// The HTTP seam: the reveal is the ONLY controller method this surface may
// call — the mock defines nothing else, so any other controller call throws
// a TypeError and fails the test (the persistence guard below relies on it).
const revealState = vi.hoisted(() => ({
  reveal: null as MarketplacePickupReveal | null,
  error: null as AppError | null,
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    fetchPickupReveal: vi.fn(async () => {
      if (revealState.error) throw revealState.error;
      return revealState.reveal;
    }),
  },
}));

const mockedController = vi.mocked(CommerceController);

const SPOT_SNAPSHOT = {
  kind: 'spot' as const,
  spot: 'Central Station, north entrance',
  instructions: 'Ring the bell twice.',
  availability: {
    windows: [{ day: 'sat' as const, start: '10:00', end: '14:00' }],
    zone: 'Europe/Berlin',
  },
};

function revealFixture(overrides: Partial<MarketplacePickupReveal['lines'][number]> = {}): MarketplacePickupReveal {
  return {
    orderId: '018f47d2-6a27-7c23-a49d-000000000002',
    firstRevealedAt: '2026-08-19T21:00:00.000Z',
    lines: [
      {
        lineIndex: 0,
        listingAggregateId: `listing:${'s'.repeat(52)}_boots`,
        version: 2,
        currentVersion: 2,
        updatedSincePayment: false,
        withdrawnBySeller: false,
        updatedAt: '2026-08-10T09:00:00.000Z',
        details: MaskedPickupDetails.wrap(SPOT_SNAPSHOT),
        ...overrides,
      },
    ],
  };
}

/** A paid pickup order whose line matches the reveal fixture's aggregate id. */
function pickupOrder(overrides: Parameters<typeof createOrderFixture>[1] = {}) {
  return createOrderFixture('paid', {
    fulfillment: 'pickup',
    lines: [
      {
        listingAggregateId: `listing:${'s'.repeat(52)}_boots`,
        listingRevision: 2,
        contentHash: 'a'.repeat(64),
        title: 'Handmade leather boots',
        quantity: 1,
        unitPrice: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
        subtotal: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
        fulfillment: 'pickup',
        versionAtPayment: 2,
      },
    ],
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  revealState.reveal = revealFixture();
  revealState.error = null;
});

describe('MarketplacePickupRevealDialog', () => {
  it('reveals the pinned snapshot per line on open, with the windows read-only', async () => {
    const user = userEvent.setup();
    render(<MarketplacePickupRevealDialog order={pickupOrder()} />);

    await user.click(screen.getByRole('button', { name: 'Show meeting point' }));

    expect(await screen.findByText('Central Station, north entrance')).toBeInTheDocument();
    expect(screen.getByText('Ring the bell twice.')).toBeInTheDocument();
    expect(screen.getByText('Saturdays 10:00–14:00')).toBeInTheDocument();
    expect(screen.getByText('Times are local to Europe/Berlin.')).toBeInTheDocument();
    expect(screen.getByText('When the seller is usually around (read-only)')).toBeInTheDocument();
    expect(screen.getByText(/Pinned as terms version 2 at payment/)).toBeInTheDocument();
    // Telemetry masking is binding (§7.2), and the dialog carries the VRT
    // capture marker on its content root.
    const content = screen.getByText('Meeting point').closest('[data-surface="pickup-reveal-dialog"]');
    expect(content).not.toBeNull();
    expect(screen.getByText('Central Station, north entrance').closest('[data-sentry-mask]')).not.toBeNull();
    expect(mockedController.fetchPickupReveal).toHaveBeenCalledWith(pickupOrder().id);
  });

  it('renders the terms-change and withdrawn notices against the pinned snapshot', async () => {
    revealState.reveal = revealFixture({ updatedSincePayment: true, withdrawnBySeller: true, currentVersion: null });
    const user = userEvent.setup();
    render(<MarketplacePickupRevealDialog order={pickupOrder()} />);

    await user.click(screen.getByRole('button', { name: 'Show meeting point' }));

    expect(await screen.findByText(/Seller changed the pickup terms since you paid/)).toBeInTheDocument();
    expect(screen.getByText(/Details withdrawn by seller/)).toBeInTheDocument();
    // The pinned snapshot is still what is served (§A3) — never current details.
    expect(screen.getByText('Central Station, north entrance')).toBeInTheDocument();
  });

  it('renders typed refusals as clear messages, not raw errors', async () => {
    revealState.error = Err.client(
      ClientErrorCode.CONFLICT,
      'The order is terminal; the pickup details are no longer revealed.',
      {
        service: ErrorService.Marketplace,
        operation: 'getOrderPickupDetails',
        context: { statusCode: 409, refusal: 'order_terminal' },
      },
    );
    const user = userEvent.setup();
    render(<MarketplacePickupRevealDialog order={pickupOrder({ state: 'cancelled' })} />);

    await user.click(screen.getByRole('button', { name: 'Show meeting point' }));

    expect(
      await screen.findByText('This order is closed, so the meeting point is no longer shown.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/terminal; the pickup details/)).not.toBeInTheDocument();
  });

  it('holds the snapshot in memory only: closing drops it and reopening re-fetches', async () => {
    const user = userEvent.setup();
    render(<MarketplacePickupRevealDialog order={pickupOrder()} />);

    await user.click(screen.getByRole('button', { name: 'Show meeting point' }));
    expect(await screen.findByText('Central Station, north entrance')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByText('Central Station, north entrance')).not.toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Show meeting point' }));
    expect(await screen.findByText('Central Station, north entrance')).toBeInTheDocument();
    // One reveal read per view (§A1/§7.2): nothing was cached anywhere.
    expect(mockedController.fetchPickupReveal).toHaveBeenCalledTimes(2);
  });
});

describe('MarketplacePickupRevealDialog persistence guard', () => {
  it('never touches Dexie or any store, and calls no other controller method — the reveal is memory-only (§A1, §7.2)', async () => {
    // Trap every persistence seam: the Dexie database and the zustand stores
    // throw the moment anything in this tree reads them, and the controller
    // mock above defines only the reveal read. A single stray write — a
    // Dexie row, a store update, a commit* call — fails this test.
    const franky = await import('@/core/database/franky/franky');
    const authStore = await import('@/stores/auth/auth.store');
    const commerceStore = await import('@/stores/commerce/commerce.store');
    const dbSpy = vi.spyOn(franky.db, 'table').mockImplementation(() => {
      throw new Error('Dexie must not be touched by the reveal dialog');
    });
    const authSpy = vi.spyOn(authStore.useAuthStore, 'getState').mockImplementation(() => {
      throw new Error('stores must not be touched by the reveal dialog');
    });
    const commerceSpy = vi.spyOn(commerceStore.useCommerceStore, 'getState').mockImplementation(() => {
      throw new Error('stores must not be touched by the reveal dialog');
    });

    try {
      const user = userEvent.setup();
      render(<MarketplacePickupRevealDialog order={pickupOrder()} />);
      await user.click(screen.getByRole('button', { name: 'Show meeting point' }));
      expect(await screen.findByText('Central Station, north entrance')).toBeInTheDocument();

      // The one and only seam call is the reveal read itself; the dialog
      // held the snapshot in component state and wrote nothing anywhere.
      expect(mockedController.fetchPickupReveal).toHaveBeenCalledTimes(1);
      expect(Object.keys(CommerceController)).toEqual(['fetchPickupReveal']);
    } finally {
      dbSpy.mockRestore();
      authSpy.mockRestore();
      commerceSpy.mockRestore();
    }
  });
});
