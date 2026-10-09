import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';
import { createOrderFixture } from '@/test/fixtures/commerce/orders';
import { createUsdtOrderFixture, type UsdtOrderPhase } from '@/test/fixtures/commerce/usdt-orders';
import { MarketplaceOrderActions } from './MarketplaceOrderActions';

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getMarketplaceBandConsent: vi.fn(async () => null),
    getOwnMarketplaceReview: vi.fn(async () => null),
    commitMarkReady: vi.fn(async () => ({ ok: true })),
    commitConfirmPickup: vi.fn(async () => ({ ok: true })),
    executeMarketplaceCommand: vi.fn(async () => ({ ok: true })),
    fetchPickupReveal: vi.fn(async () => {
      throw new Error('not under test here');
    }),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({ toast: vi.fn() }));

const NOT_FINAL = "Wait to ship: this USDT payment isn't final on Arbitrum yet. This usually takes a few minutes.";

function renderActions(order: MarketplaceOrder, isBuyer: boolean) {
  return render(
    <MarketplaceOrderActions
      order={order}
      isBuyer={isBuyer}
      canEditReview={false}
      actOnOrder={vi.fn(async () => true)}
    />,
  );
}

const shippedOrder = (phase: UsdtOrderPhase) => createUsdtOrderFixture(phase).order;
const pickupOrder = (phase: UsdtOrderPhase, state: 'paid' | 'ready_for_pickup' = 'paid') => ({
  ...createUsdtOrderFixture(phase).order,
  state,
  fulfillment: 'pickup' as const,
});

describe('MarketplaceOrderActions — USDT finality gate (shipping)', () => {
  it.each(['received', 'rechecking'] as const)(
    'disables Add tracking with the payment_not_final copy while %s',
    (phase) => {
      renderActions(shippedOrder(phase), false);

      expect(screen.getByRole('button', { name: 'Add tracking' })).toBeDisabled();
      expect(screen.getByTestId('usdt-payment-not-final')).toHaveTextContent(NOT_FINAL);
    },
  );

  it('enables Add tracking once the payment is final', () => {
    renderActions(shippedOrder('final'), false);

    expect(screen.getByRole('button', { name: 'Add tracking' })).toBeEnabled();
    expect(screen.queryByTestId('usdt-payment-not-final')).not.toBeInTheDocument();
  });

  it('fails closed when a paid USDT order reports no finality', () => {
    renderActions({ ...shippedOrder('final'), paymentFinality: undefined }, false);

    expect(screen.getByRole('button', { name: 'Add tracking' })).toBeDisabled();
    expect(screen.getByTestId('usdt-payment-not-final')).toBeInTheDocument();
  });

  it('does not show the seller hint to the buyer', () => {
    renderActions(shippedOrder('received'), true);

    expect(screen.queryByTestId('usdt-payment-not-final')).not.toBeInTheDocument();
  });

  it.each(['bitcoin', 'paypal', 'stripe', null] as const)('leaves a paid %s order shippable with no hint', (method) => {
    renderActions(createOrderFixture('paid', { paymentMethod: method }), false);

    expect(screen.getByRole('button', { name: 'Add tracking' })).toBeEnabled();
    expect(screen.queryByTestId('usdt-payment-not-final')).not.toBeInTheDocument();
  });
});

describe('MarketplaceOrderActions — USDT finality gate (pickup)', () => {
  it('disables Mark ready for pickup and Confirm handover for the seller until final', () => {
    renderActions(pickupOrder('received'), false);

    expect(screen.getByRole('button', { name: 'Mark ready for pickup' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Confirm handover' })).toBeDisabled();
    expect(screen.getByTestId('usdt-payment-not-final')).toHaveTextContent(NOT_FINAL);
  });

  it('keeps the buyer handover closed until final, without the seller copy', () => {
    renderActions(pickupOrder('rechecking', 'ready_for_pickup'), true);

    expect(screen.getByRole('button', { name: 'Confirm handover' })).toBeDisabled();
    expect(screen.queryByTestId('usdt-payment-not-final')).not.toBeInTheDocument();
  });

  it('opens both once the payment is final', () => {
    renderActions(pickupOrder('final'), false);

    expect(screen.getByRole('button', { name: 'Mark ready for pickup' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Confirm handover' })).toBeEnabled();
  });
});

describe('MarketplaceOrderActions — USDT digital orders', () => {
  it('never gates a service-sealed digital order, which releases at inclusion', () => {
    const order = { ...createUsdtOrderFixture('received').order, fulfillment: 'digital' as const };
    renderActions(order, false);

    expect(screen.queryByTestId('usdt-payment-not-final')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add tracking' })).not.toBeInTheDocument();
  });
});
