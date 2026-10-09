import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMERCE_REVIEW_EDIT_WINDOW_SECONDS } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { CommerceReviewModelSchema } from '@/models/commerce/commerce.schema';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';
import { createOrderFixture, createUsdtOrderFixture, ORDER_FIXTURE_BUYER } from '@/test/fixtures/commerce/orders';
import { REFUND_FIXTURE_ADDRESS, REFUND_FIXTURE_TX_HASH } from '@/test/fixtures/commerce/usdt-refund.wire';
import { MarketplaceOrderActions } from './MarketplaceOrderActions';

// The component reads two honest projections through the controller: the
// seller's D2 band consent (review dialog) and the local copy of the user's
// own published review record (status line). Both are mocked per scenario.
vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getMarketplaceBandConsent: vi.fn(async () => null),
    getOwnMarketplaceReview: vi.fn(async () => null),
    commitMarkReady: vi.fn(async () => ({ ok: true })),
    commitConfirmPickup: vi.fn(async () => ({ ok: true })),
    executeMarketplaceCommand: vi.fn(async () => ({
      ok: true,
      result: { kind: 'order', order: { state: 'cancelled' } },
    })),
    fetchPickupReveal: vi.fn(async () => {
      throw new Error('not under test here');
    }),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({
  toast: vi.fn(),
}));

const mockedController = vi.mocked(CommerceController);

beforeEach(() => {
  mockedController.getMarketplaceBandConsent.mockReset().mockResolvedValue(null);
  mockedController.getOwnMarketplaceReview.mockReset().mockResolvedValue(null);
});

const WINDOW_MS = COMMERCE_REVIEW_EDIT_WINDOW_SECONDS * 1000;

function ownReview(createdAt: string): NonNullable<MarketplaceOrder['reviews']>[number] {
  return {
    id: '018f47d2-6a27-7c23-a62f-000000000601',
    reviewerPubky: ORDER_FIXTURE_BUYER,
    subjectPubky: 's'.repeat(52),
    rating: 5,
    text: 'Accurate and fast.',
    createdAt,
  };
}

function renderActions({
  reviewCreatedAt,
  canEditReview = true,
  withOwnReview = true,
}: {
  reviewCreatedAt?: string;
  canEditReview?: boolean;
  withOwnReview?: boolean;
} = {}) {
  const order = createOrderFixture('completed', {
    reviews: withOwnReview ? [ownReview(reviewCreatedAt ?? new Date(Date.now() - 60_000).toISOString())] : [],
  });
  const actOnOrder = vi.fn(async () => true);
  render(
    <MarketplaceOrderActions order={order} isBuyer={true} canEditReview={canEditReview} actOnOrder={actOnOrder} />,
  );
  return { order, actOnOrder };
}

describe('MarketplaceOrderActions review editing', () => {
  it('offers the edit inside the 24-hour window in transaction-service mode', () => {
    renderActions({ reviewCreatedAt: new Date(Date.now() - (WINDOW_MS - 60_000)).toISOString() });

    expect(screen.getByRole('button', { name: 'Edit review' })).toBeInTheDocument();
    // The review already exists, so the create affordance is gone.
    expect(screen.queryByRole('button', { name: 'Leave review' })).not.toBeInTheDocument();
  });

  it('withholds the edit once the window has closed instead of failing on submit', () => {
    renderActions({ reviewCreatedAt: new Date(Date.now() - (WINDOW_MS + 60_000)).toISOString() });

    expect(screen.queryByRole('button', { name: 'Edit review' })).not.toBeInTheDocument();
  });

  it('withholds the edit in sandbox mode: the sandbox has no review.update command', () => {
    renderActions({ canEditReview: false });

    expect(screen.queryByRole('button', { name: 'Edit review' })).not.toBeInTheDocument();
  });

  it('withholds the edit when the caller has not reviewed the order', () => {
    renderActions({ withOwnReview: false });

    expect(screen.queryByRole('button', { name: 'Edit review' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave review' })).toBeInTheDocument();
  });

  it('prefills the existing review and submits review.update with the revised terms', async () => {
    const user = userEvent.setup();
    const { order, actOnOrder } = renderActions();

    await user.click(screen.getByRole('button', { name: 'Edit review' }));
    expect(screen.getByText('Edit your review')).toBeInTheDocument();

    const textField = screen.getByLabelText('Review');
    expect(textField).toHaveValue('Accurate and fast.');
    expect(screen.getByRole('radio', { name: '5 stars' })).toBeChecked();

    await user.click(screen.getByRole('radio', { name: '3 stars' }));
    await user.clear(textField);
    await user.type(textField, 'Item arrived scratched after all.');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(actOnOrder).toHaveBeenCalledWith(order, 'review.update', {
      rating: 3,
      text: 'Item arrived scratched after all.',
    });
  });

  it('changes the review rating with arrow keys and submits the same form field', async () => {
    const user = userEvent.setup();
    const { order, actOnOrder } = renderActions({ withOwnReview: false });

    await user.click(screen.getByRole('button', { name: 'Leave review' }));
    const oneStar = screen.getByRole('radio', { name: '1 star' });
    await user.click(oneStar);
    expect(oneStar).toBeChecked();
    expect(oneStar).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: '2 stars' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '2 stars' })).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('radio', { name: '3 stars' })).toBeChecked();
    expect(screen.getByRole('radio', { name: '3 stars' })).toHaveFocus();

    await user.type(screen.getByLabelText('Review'), 'Accurate and fast.');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(actOnOrder).toHaveBeenCalledWith(order, 'review.create', {
      rating: 3,
      text: 'Accurate and fast.',
      allowAmountBand: false,
    });
  });

  it('keeps a single tab stop on the checked rating radio', async () => {
    const user = userEvent.setup();
    renderActions({ withOwnReview: false });

    await user.click(screen.getByRole('button', { name: 'Leave review' }));
    const checked = screen.getByRole('radio', { name: '5 stars' });
    const radios = screen.getAllByRole('radio');
    expect(checked).toBeChecked();
    expect(radios.filter((radio) => radio.tabIndex >= 0)).toEqual([checked]);

    checked.focus();
    await user.tab();
    expect(screen.getByLabelText('Review')).toHaveFocus();
  });
});

describe('MarketplaceOrderActions amount-band opt-in (D2 both-sides consent)', () => {
  it('renders the opt-in only when the seller consented, and submits the buyer choice', async () => {
    mockedController.getMarketplaceBandConsent.mockResolvedValue(true);
    const user = userEvent.setup();
    const { order, actOnOrder } = renderActions({ withOwnReview: false });

    await user.click(screen.getByRole('button', { name: 'Leave review' }));
    const checkbox = await screen.findByRole('checkbox', { name: /include an approximate price range/i });
    expect(checkbox).not.toBeChecked();

    await user.type(screen.getByLabelText('Review'), 'Accurate and fast.');
    await user.click(checkbox);
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(actOnOrder).toHaveBeenCalledWith(order, 'review.create', {
      rating: 5,
      text: 'Accurate and fast.',
      allowAmountBand: true,
    });
  });

  it('defaults the opt-in to excluded (not included unless both sides opt in)', async () => {
    mockedController.getMarketplaceBandConsent.mockResolvedValue(true);
    const user = userEvent.setup();
    const { order, actOnOrder } = renderActions({ withOwnReview: false });

    await user.click(screen.getByRole('button', { name: 'Leave review' }));
    await screen.findByRole('checkbox', { name: /include an approximate price range/i });
    await user.type(screen.getByLabelText('Review'), 'Accurate and fast.');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(actOnOrder).toHaveBeenCalledWith(order, 'review.create', {
      rating: 5,
      text: 'Accurate and fast.',
      allowAmountBand: false,
    });
  });

  it('states truthfully that the seller has not enabled bands instead of a dead checkbox', async () => {
    mockedController.getMarketplaceBandConsent.mockResolvedValue(false);
    const user = userEvent.setup();
    renderActions({ withOwnReview: false });

    await user.click(screen.getByRole('button', { name: 'Leave review' }));
    expect(await screen.findByText(/has not enabled price-range sharing/i)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('renders neither checkbox nor note when the backend has no attestation support', async () => {
    mockedController.getMarketplaceBandConsent.mockResolvedValue(null);
    const user = userEvent.setup();
    renderActions({ withOwnReview: false });

    await user.click(screen.getByRole('button', { name: 'Leave review' }));
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/price-range sharing/i)).not.toBeInTheDocument();
  });
});

describe('MarketplaceOrderActions own-review verified status', () => {
  function publishedReviewRow(overrides: Partial<CommerceReviewModelSchema> = {}): CommerceReviewModelSchema {
    return {
      id: `${ORDER_FIXTURE_BUYER}:8Z8CWH8NVYQY39ZEBFGKQWWEKG`,
      owner_id: ORDER_FIXTURE_BUYER,
      review_id: '8Z8CWH8NVYQY39ZEBFGKQWWEKG',
      order_id: 'order-1',
      subject_id: 's'.repeat(52),
      record: {} as CommerceReviewModelSchema['record'],
      attestation_verified: true,
      attestation_iss: 'o'.repeat(52),
      sync_status: 'synced',
      updated_at: Date.now(),
      ...overrides,
    };
  }

  it('shows the verified state when the published record carries a verifying attestation', async () => {
    mockedController.getOwnMarketplaceReview.mockResolvedValue(publishedReviewRow());
    renderActions();

    await waitFor(() => {
      expect(screen.getByTestId('own-review-status')).toHaveTextContent(/Verified purchase/);
    });
    expect(screen.getByTestId('own-review-status')).toHaveTextContent(/signed by attestor oooooooo…/);
  });

  it('shows the pending-publication state truthfully', async () => {
    mockedController.getOwnMarketplaceReview.mockResolvedValue(publishedReviewRow({ sync_status: 'pending' }));
    renderActions();

    await waitFor(() => {
      expect(screen.getByTestId('own-review-status')).toHaveTextContent(
        /Publication is pending and will retry automatically/,
      );
    });
  });

  it('does not claim that no attestation was issued when the durable row is unavailable', async () => {
    mockedController.getOwnMarketplaceReview.mockResolvedValue(null);
    renderActions();

    await waitFor(() => {
      expect(screen.getByTestId('own-review-status')).toHaveTextContent(/publication status will appear/);
    });
  });
});

describe('MarketplaceOrderActions refund reference labels', () => {
  it.each([
    ['bitcoin', 'External Bitcoin transaction reference'],
    ['paypal', 'PayPal refund transaction id'],
    ['stripe', 'External payment reference'],
    [undefined, 'External payment reference'],
  ] as const)('uses the %s rail label', async (paymentMethod, label) => {
    const order = createOrderFixture('return_received', { paymentMethod });
    render(
      <MarketplaceOrderActions
        order={order}
        isBuyer={false}
        canEditReview={false}
        actOnOrder={vi.fn(async () => true)}
      />,
    );

    await userEvent.setup().click(screen.getByRole('button', { name: 'Record refund' }));
    expect(screen.getByLabelText(label)).toBeInTheDocument();
  });

  it('labels a Bitcoin refund amount in satoshis and shows the payment-code equation', async () => {
    const order = createOrderFixture('return_received', {
      paymentMethod: 'bitcoin',
      paykitTotalSats: 1_255,
      merchandiseTotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
      bitcoinPayable: { amountMinor: 1_255, currency: 'SAT', exponent: 0 },
      subtotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
      shipping: { amountMinor: 0, currency: 'BTC', exponent: 8 },
      total: { amountMinor: 1_255, currency: 'BTC', exponent: 8 },
    });
    const actOnOrder = vi.fn(async () => true);
    render(<MarketplaceOrderActions order={order} isBuyer={false} canEditReview={false} actOnOrder={actOnOrder} />);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Record refund' }));
    expect(screen.getByLabelText('Amount (₿)')).toHaveValue('1255');
    expect(screen.queryByLabelText('Amount (USD)')).not.toBeInTheDocument();
    expect(screen.getByTestId('bitcoin-amount-breakdown')).toHaveTextContent(
      'Items ₿1,000 · Shipping ₿0 · Payment code ₿255 = Total ₿1,255',
    );
    await user.type(screen.getByLabelText('External Bitcoin transaction reference'), 'txid-canary-refund');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() =>
      expect(actOnOrder).toHaveBeenCalledWith(order, 'refund.record_external', {
        amountMinor: 1_255,
        transactionId: 'txid-canary-refund',
      }),
    );
  });

  it('tells a PayPal seller to refund in PayPal before recording the return', async () => {
    const order = createOrderFixture('return_received', { paymentMethod: 'paypal' });
    render(
      <MarketplaceOrderActions
        order={order}
        isBuyer={false}
        canEditReview={false}
        actOnOrder={vi.fn(async () => true)}
      />,
    );

    expect(screen.getByRole('button', { name: 'Record refund' })).toBeInTheDocument();
    expect(screen.getByTestId('paypal-refund-hint')).toHaveTextContent(
      'Refund the buyer in PayPal first, then record it here',
    );
    await userEvent.setup().click(screen.getByRole('button', { name: 'Record refund' }));
    expect(screen.getByRole('heading', { name: 'Record refund' })).toBeInTheDocument();
    expect(screen.getByLabelText('Amount (USD)')).toHaveValue('137.00');
    expect(screen.getByLabelText('PayPal refund transaction id')).toBeInTheDocument();
  });

  it.each(['return_received', 'cancelled'] as const)(
    'lets the seller close a %s order after a PayPal partial refund, prefilled with the rest',
    async (state) => {
      const order = createOrderFixture(state, {
        paymentMethod: 'paypal',
        total: { amountMinor: 250, currency: 'USD', exponent: 2 },
        externalRefund: {
          amountMinor: 189,
          transactionId: '9RF12345AB678901C',
          recordedAt: '2026-09-24T18:00:00.000Z',
        },
      });
      const actOnOrder = vi.fn(async () => true);
      render(<MarketplaceOrderActions order={order} isBuyer={false} canEditReview={false} actOnOrder={actOnOrder} />);

      expect(screen.queryByTestId('paypal-refund-hint')).not.toBeInTheDocument();
      expect(screen.getByTestId('paypal-partial-refund-hint')).toHaveTextContent(
        'PayPal refunded $1.89 of $2.50. Record the rest to close this order.',
      );
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Record refund' }));
      expect(screen.getByTestId('refund-paypal-already')).toHaveTextContent('PayPal already refunded $1.89.');
      expect(screen.getByLabelText('Refunded outside PayPal (USD)')).toHaveValue('0.61');
      await user.type(screen.getByLabelText('PayPal refund transaction id'), 'BANKTRANSFER061');
      await user.click(screen.getByRole('button', { name: 'Confirm' }));

      await waitFor(() =>
        expect(actOnOrder).toHaveBeenCalledWith(order, 'refund.record_external', {
          amountMinor: 250,
          transactionId: 'BANKTRANSFER061',
        }),
      );
    },
  );

  it('offers no refund record once the order is refunded', () => {
    const order = createOrderFixture('refunded_external', {
      externalRefund: { amountMinor: 250, transactionId: '9RF12345AB678901C', recordedAt: '2026-09-24T18:00:00.000Z' },
    });
    render(
      <MarketplaceOrderActions
        order={order}
        isBuyer={false}
        canEditReview={false}
        actOnOrder={vi.fn(async () => true)}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Record refund' })).not.toBeInTheDocument();
  });
});

describe('MarketplaceOrderActions local pickup (Wave 7, §A6)', () => {
  const pickupControllerState = {
    confirmResponse: { ok: true } as unknown,
    cancelResponse: { ok: true, result: { kind: 'order', order: { state: 'cancelled' } } } as unknown,
  };

  beforeEach(() => {
    mockedController.commitMarkReady.mockClear().mockResolvedValue({ ok: true } as never);
    mockedController.commitConfirmPickup
      .mockClear()
      .mockImplementation(async () => pickupControllerState.confirmResponse as never);
    mockedController.executeMarketplaceCommand
      .mockClear()
      .mockImplementation(async () => pickupControllerState.cancelResponse as never);
    pickupControllerState.confirmResponse = { ok: true };
    pickupControllerState.cancelResponse = { ok: true, result: { kind: 'order', order: { state: 'cancelled' } } };
  });

  function renderPickupActions({
    state,
    isBuyer,
    overrides = {},
  }: {
    state: 'paid' | 'ready_for_pickup' | 'delivered';
    isBuyer: boolean;
    overrides?: Partial<MarketplaceOrder>;
  }) {
    const order = createOrderFixture(state, { fulfillment: 'pickup', ...overrides });
    const actOnOrder = vi.fn(async () => true);
    const onChanged = vi.fn();
    render(
      <MarketplaceOrderActions
        order={order}
        isBuyer={isBuyer}
        canEditReview={false}
        actOnOrder={actOnOrder}
        onChanged={onChanged}
      />,
    );
    return { order, actOnOrder, onChanged };
  }

  it('hints that Mark return received is for a pickup the buyer brought back', () => {
    const order = createOrderFixture('return_approved', { fulfillment: 'pickup' });
    render(
      <MarketplaceOrderActions
        order={order}
        isBuyer={false}
        canEditReview={false}
        actOnOrder={vi.fn(async () => true)}
      />,
    );

    expect(screen.getByRole('button', { name: 'Mark return received' })).toBeInTheDocument();
    expect(screen.getByTestId('mark-return-received-hint')).toHaveTextContent(
      'Press when the buyer has brought it back',
    );
  });

  it('offers the seller Mark ready for pickup and Confirm handover from paid — and no shipping actions', () => {
    renderPickupActions({ state: 'paid', isBuyer: false });

    expect(screen.getByRole('button', { name: 'Mark ready for pickup' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm handover' })).toBeInTheDocument();
    // Pickup orders never ship (§A6): no tracking, no label.
    expect(screen.queryByRole('button', { name: 'Add tracking' })).not.toBeInTheDocument();
  });

  it('hides the packing-slip print affordance on pickup orders (§A5)', () => {
    renderPickupActions({ state: 'paid', isBuyer: false });
    expect(screen.queryByRole('button', { name: 'Packing slip' })).not.toBeInTheDocument();

    renderPickupActions({ state: 'delivered', isBuyer: false });
    expect(screen.queryByRole('button', { name: 'Packing slip' })).not.toBeInTheDocument();
  });

  it('keeps the packing-slip affordance on shipped orders', () => {
    const order = createOrderFixture('paid', { fulfillment: 'shipping' });
    render(
      <MarketplaceOrderActions
        order={order}
        isBuyer={false}
        canEditReview={false}
        actOnOrder={vi.fn(async () => true)}
      />,
    );
    expect(screen.getByRole('button', { name: 'Packing slip' })).toBeInTheDocument();
  });

  it('marks ready through commitMarkReady and reloads the timeline', async () => {
    const user = userEvent.setup();
    const { order, onChanged } = renderPickupActions({ state: 'paid', isBuyer: false });

    await user.click(screen.getByRole('button', { name: 'Mark ready for pickup' }));

    await waitFor(() => {
      expect(mockedController.commitMarkReady).toHaveBeenCalledWith(order.id, order.revision);
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it('offers the buyer Show meeting point and Confirm handover from ready_for_pickup', () => {
    renderPickupActions({ state: 'ready_for_pickup', isBuyer: true });

    expect(screen.getByRole('button', { name: 'Show meeting point' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm handover' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel order' })).toBeInTheDocument();
  });

  it('withholds the meeting-point reveal once the order is terminal (§A3)', () => {
    // A delivered pickup order is NOT terminal — the buyer may still need the
    // pinned meeting point (a return is still possible).
    renderPickupActions({ state: 'delivered', isBuyer: true });
    expect(screen.getByRole('button', { name: 'Show meeting point' })).toBeInTheDocument();
  });

  it('hides the reveal on a cancelled pickup order — the entitlement ended at the cancel (§A3)', () => {
    // The order keeps its payment receipt — the gate is the terminal state,
    // not the receipt, per the reveal cutoff.
    renderPickupActions({ state: 'delivered', isBuyer: true, overrides: { state: 'cancelled' } });
    expect(screen.queryByRole('button', { name: 'Show meeting point' })).not.toBeInTheDocument();
  });

  it('warns the buyer before confirm — only once the item is in their hands', async () => {
    const user = userEvent.setup();
    renderPickupActions({ state: 'ready_for_pickup', isBuyer: true });

    await user.click(screen.getByRole('button', { name: 'Confirm handover' }));
    expect(screen.getByText('Only confirm once the item is in your hands.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Confirm handover' }));
    await waitFor(() => {
      expect(mockedController.commitConfirmPickup).toHaveBeenCalled();
    });
  });

  it('carries the seller-attested wording on the seller confirm', async () => {
    const user = userEvent.setup();
    renderPickupActions({ state: 'paid', isBuyer: false });

    await user.click(screen.getByRole('button', { name: 'Confirm handover' }));
    expect(screen.getByText(/A handover you confirm yourself counts toward your reputation/)).toBeInTheDocument();
  });

  it('renders the seller-actor terms-change refusal as an explanation, not an error toast', async () => {
    pickupControllerState.confirmResponse = {
      ok: false,
      error: {
        code: 'INVALID_STATE',
        message:
          'The pickup terms changed after payment; the seller cannot confirm the handover until the buyer has seen the change.',
      },
    };
    const user = userEvent.setup();
    renderPickupActions({ state: 'ready_for_pickup', isBuyer: false });

    await user.click(screen.getByRole('button', { name: 'Confirm handover' }));
    await user.click(screen.getByRole('button', { name: 'Confirm handover' }));

    expect(
      await screen.findByText(/Until the buyer has seen the change, only the buyer can confirm the handover/),
    ).toBeInTheDocument();
  });

  it('states that cancelling moves no money on the pickup cancel dialog, and confirms the unilateral exit', async () => {
    const user = userEvent.setup();
    renderPickupActions({ state: 'paid', isBuyer: true, overrides: { pickupTermsChanged: true } });

    await user.click(screen.getByRole('button', { name: 'Cancel order' }));
    expect(screen.getByRole('heading', { name: 'Cancel order' })).toBeInTheDocument();
    expect(screen.getByText(/Cancelling moves no money/)).toBeInTheDocument();
    expect(screen.getByTestId('dialog-content')).toHaveClass('max-w-lg');

    await user.type(screen.getByLabelText('Reason'), 'The new spot is unreachable for me');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(mockedController.executeMarketplaceCommand).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'order.cancel_request' }),
      );
    });
    const { toast } = await import('@/molecules/Toaster/use-toast');
    expect(toast).toHaveBeenCalledWith({ title: 'Order cancelled' });
  });

  it('asks for seller approval on the pickup cancel dialog while no unilateral exit is open', async () => {
    const user = userEvent.setup();
    renderPickupActions({ state: 'paid', isBuyer: true });

    await user.click(screen.getByRole('button', { name: 'Cancel order' }));
    expect(screen.getByText(/Cancelling moves no money/)).toBeInTheDocument();
  });

  it('confirms a cancelled pickup order with the completed-cancellation toast', async () => {
    const { toast } = await import('@/molecules/Toaster/use-toast');
    const user = userEvent.setup();
    renderPickupActions({ state: 'paid', isBuyer: true });

    await user.click(screen.getByRole('button', { name: 'Cancel order' }));
    await user.type(screen.getByLabelText('Reason'), 'The spot does not work for me');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith({ title: 'Order cancelled' }));
  });

  it('reports a cancel_requested pickup outcome as a cancellation request', async () => {
    pickupControllerState.cancelResponse = {
      ok: true,
      result: { kind: 'order', order: { state: 'cancel_requested' } },
    };
    const { toast } = await import('@/molecules/Toaster/use-toast');
    const user = userEvent.setup();
    renderPickupActions({ state: 'paid', isBuyer: true, overrides: { firstRevealedAt: '2026-08-19T21:00:00.000Z' } });

    await user.click(screen.getByRole('button', { name: 'Cancel order' }));
    await user.type(screen.getByLabelText('Reason'), 'The spot does not work for me');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith({
        variant: 'info',
        title: 'Cancellation requested',
      }),
    );
  });

  it('uses the shared compact cancellation dialog and request toast for shipping orders', async () => {
    const order = createOrderFixture('pending_payment', { fulfillment: 'shipping' });
    const actOnOrder = vi.fn(async () => true);
    const user = userEvent.setup();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
    render(<MarketplaceOrderActions order={order} isBuyer canEditReview={false} actOnOrder={actOnOrder} />);

    await user.click(screen.getByRole('button', { name: 'Cancel checkout' }));
    expect(screen.getByRole('heading', { name: 'Cancel checkout' })).toBeInTheDocument();
    expect(screen.getByText(/Cancelling moves no money/)).toBeInTheDocument();
    expect(screen.getByTestId('dialog-content')).toHaveClass('m-6', 'rounded-xl', 'w-full', 'max-w-lg');
    expect(screen.getByTestId('dialog-content')).not.toHaveClass('sm:max-w-[calc(100vw-2rem)]');

    await user.type(screen.getByLabelText('Reason'), 'No longer needed');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() =>
      expect(actOnOrder).toHaveBeenCalledWith(order, 'order.cancel_request', { reason: 'No longer needed' }),
    );
    const { toast } = await import('@/molecules/Toaster/use-toast');
    expect(toast).toHaveBeenCalledWith({
      variant: 'info',
      title: 'Cancellation requested',
    });
  });
});

describe('MarketplaceOrderActions digital orders (digital delivery design §6 E1–E4)', () => {
  function renderDigital(state: 'paid' | 'delivered' | 'completed', isBuyer: boolean) {
    const order = createOrderFixture(state, { fulfillment: 'digital' });
    render(
      <MarketplaceOrderActions
        order={order}
        isBuyer={isBuyer}
        canEditReview={false}
        actOnOrder={vi.fn(async () => true)}
      />,
    );
  }

  it('offers the buyer no return on a delivered digital order, and says why (E4)', () => {
    renderDigital('delivered', true);

    expect(screen.queryByRole('button', { name: 'Request return' })).not.toBeInTheDocument();
    expect(screen.getByTestId('digital-no-return-note')).toHaveTextContent(
      "Digital purchases can't be returned. Message the seller about a refund.",
    );
  });

  it('offers the seller no tracking, label or packing slip on a digital order (E1)', () => {
    renderDigital('paid', false);

    expect(screen.queryByRole('button', { name: 'Add tracking' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Packing slip' })).not.toBeInTheDocument();
  });

  it('keeps Request return on a delivered shipped order', () => {
    const order = createOrderFixture('delivered', { fulfillment: 'shipping' });
    render(
      <MarketplaceOrderActions order={order} isBuyer canEditReview={false} actOnOrder={vi.fn(async () => true)} />,
    );

    expect(screen.getByRole('button', { name: 'Request return' })).toBeInTheDocument();
    expect(screen.queryByTestId('digital-no-return-note')).not.toBeInTheDocument();
  });
});

describe('MarketplaceOrderActions digital orders in an inconsistent shipped state (review P2)', () => {
  it('offers no Confirm delivery on a digital order projected as shipped', () => {
    render(
      <MarketplaceOrderActions
        order={createOrderFixture('shipped', { fulfillment: 'digital' })}
        isBuyer
        canEditReview={false}
        actOnOrder={vi.fn(async () => true)}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Confirm delivery' })).not.toBeInTheDocument();
  });

  it('keeps Confirm delivery on a shipped order', () => {
    render(
      <MarketplaceOrderActions
        order={createOrderFixture('shipped', { fulfillment: 'shipping' })}
        isBuyer
        canEditReview={false}
        actOnOrder={vi.fn(async () => true)}
      />,
    );

    expect(screen.getByRole('button', { name: 'Confirm delivery' })).toBeInTheDocument();
  });
});

describe('MarketplaceOrderActions digital refunds and cancels (digital delivery design §6 E8, E9)', () => {
  const base = createOrderFixture('delivered');

  it.each(['delivered', 'completed'] as const)(
    'lets the seller record a refund on a %s digital order, and says what it changes (E9)',
    async (state) => {
      const { toast } = await import('@/molecules/Toaster/use-toast');
      const order = createOrderFixture(state, { fulfillment: 'digital', paymentMethod: 'bitcoin' });
      const actOnOrder = vi.fn(async () => true);
      render(<MarketplaceOrderActions order={order} isBuyer={false} canEditReview={false} actOnOrder={actOnOrder} />);

      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: 'Record refund' }));
      await user.type(screen.getByLabelText('External Bitcoin transaction reference'), 'txid-digital-refund');
      await user.click(screen.getByRole('button', { name: 'Confirm' }));

      await waitFor(() =>
        expect(actOnOrder).toHaveBeenCalledWith(order, 'refund.record_external', expect.objectContaining({})),
      );
      expect(vi.mocked(toast)).toHaveBeenCalledWith({
        variant: 'info',
        title: "Refund recorded. The buyer can no longer download. An email already sent can't be recalled.",
      });
    },
  );

  it('offers no refund record on a delivered shipped order', () => {
    render(
      <MarketplaceOrderActions
        order={createOrderFixture('delivered', { fulfillment: 'shipping' })}
        isBuyer={false}
        canEditReview={false}
        actOnOrder={vi.fn(async () => true)}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Record refund' })).not.toBeInTheDocument();
  });

  it('tells the seller opened files stay sold before approving a cancel (E8)', () => {
    const order = createOrderFixture('cancel_requested', {
      fulfillment: 'digital',
      lines: [{ ...base.lines[0], fulfillment: 'digital', digitalKind: 'file' }],
    });
    render(
      <MarketplaceOrderActions
        order={order}
        isBuyer={false}
        canEditReview={false}
        actOnOrder={vi.fn(async () => true)}
      />,
    );

    expect(screen.getByRole('button', { name: 'Approve cancellation' })).toBeInTheDocument();
    expect(screen.getByTestId('digital-opened-stay-sold')).toHaveTextContent('Opened files stay counted as sold.');
  });

  it('says nothing about opened files on a cancel with no instant line', () => {
    const order = createOrderFixture('cancel_requested', {
      fulfillment: 'digital',
      lines: [{ ...base.lines[0], fulfillment: 'digital', digitalKind: 'email' }],
    });
    render(
      <MarketplaceOrderActions
        order={order}
        isBuyer={false}
        canEditReview={false}
        actOnOrder={vi.fn(async () => true)}
      />,
    );

    expect(screen.queryByTestId('digital-opened-stay-sold')).not.toBeInTheDocument();
  });
});

describe('MarketplaceOrderActions USDT refund recording', () => {
  const destination = {
    address: REFUND_FIXTURE_ADDRESS,
    network: 'arbitrum-one' as const,
    asset: 'USDT' as const,
    source: 'buyer_entered',
    confirmedAt: '2026-10-09T16:00:00.000Z',
  };

  it('holds Record refund until the buyer confirmed an address', () => {
    render(
      <MarketplaceOrderActions
        order={createUsdtOrderFixture('return_received')}
        isBuyer={false}
        canEditReview={false}
        actOnOrder={vi.fn(async () => true)}
      />,
    );

    expect(screen.getByRole('button', { name: 'Record refund' })).toBeDisabled();
    expect(screen.getByTestId('usdt-refund-address-hint')).toHaveTextContent(
      "Ask the buyer to confirm a refund address first. It's on their order page.",
    );
  });

  it('records the lowercase Arbitrum hash with the destination and parity amount shown', async () => {
    const order = createUsdtOrderFixture('return_received', { refundDestination: destination });
    const actOnOrder = vi.fn(async () => true);
    render(<MarketplaceOrderActions order={order} isBuyer={false} canEditReview={false} actOnOrder={actOnOrder} />);
    const user = userEvent.setup();

    expect(screen.queryByTestId('usdt-refund-address-hint')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Record refund' }));
    expect(screen.getByTestId('refund-usdt-destination')).toHaveTextContent(REFUND_FIXTURE_ADDRESS);
    expect(screen.getByTestId('refund-usdt-destination')).toHaveTextContent('Amount to send: 137.000000 USDT');

    await user.type(screen.getByLabelText('Arbitrum transaction hash'), 'not-a-hash');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(
      await screen.findByText('Enter the Arbitrum transaction hash (0x followed by 64 characters).'),
    ).toBeInTheDocument();
    expect(actOnOrder).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('Arbitrum transaction hash'));
    await user.type(
      screen.getByLabelText('Arbitrum transaction hash'),
      REFUND_FIXTURE_TX_HASH.toUpperCase().replace('0X', '0x'),
    );
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() =>
      expect(actOnOrder).toHaveBeenCalledWith(order, 'refund.record_external', {
        amountMinor: 13_700,
        transactionId: REFUND_FIXTURE_TX_HASH,
      }),
    );
  });

  it('does not touch a Bitcoin refund: no hold, free-form evidence', () => {
    render(
      <MarketplaceOrderActions
        order={createOrderFixture('return_received', { paymentMethod: 'bitcoin' })}
        isBuyer={false}
        canEditReview={false}
        actOnOrder={vi.fn(async () => true)}
      />,
    );
    expect(screen.getByRole('button', { name: 'Record refund' })).toBeEnabled();
    expect(screen.queryByTestId('usdt-refund-address-hint')).not.toBeInTheDocument();
  });
});
