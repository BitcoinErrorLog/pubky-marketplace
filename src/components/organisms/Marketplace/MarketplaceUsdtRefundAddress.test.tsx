import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';
import { createOrderFixture, createUsdtOrderFixture } from '@/test/fixtures/commerce/orders';
import {
  REFUND_FIXTURE_ADDRESS,
  REFUND_FIXTURE_OTHER_ADDRESS,
  REFUND_FIXTURE_TX_HASH,
} from '@/test/fixtures/commerce/usdt-refund.wire';
import { MarketplaceUsdtRefundAddress } from './MarketplaceUsdtRefundAddress';

vi.mock('@/molecules/Toaster/use-toast', () => ({ toast: vi.fn() }));

const destination = {
  address: REFUND_FIXTURE_ADDRESS,
  network: 'arbitrum-one' as const,
  asset: 'USDT' as const,
  source: 'buyer_entered',
  confirmedAt: '2026-10-09T16:00:00.000Z',
};

function renderPanel(
  order: MarketplaceOrder,
  { isBuyer = true, paymentInReview = false, actOnOrder = vi.fn(async () => true) } = {},
) {
  const view = render(
    <MarketplaceUsdtRefundAddress
      order={order}
      isBuyer={isBuyer}
      paymentInReview={paymentInReview}
      actOnOrder={actOnOrder}
    />,
  );
  return { ...view, actOnOrder };
}

describe('MarketplaceUsdtRefundAddress — buyer', () => {
  it('renders nothing for Bitcoin, PayPal and Stripe orders, whatever their state', () => {
    for (const paymentMethod of ['bitcoin', 'paypal', 'stripe'] as const) {
      for (const state of ['paid', 'return_approved', 'cancelled', 'refunded_external'] as const) {
        const { container, unmount } = renderPanel(createOrderFixture(state, { paymentMethod }));
        expect(container).toBeEmptyDOMElement();
        unmount();
      }
    }
  });

  it('renders nothing before the USDT payment settled', () => {
    const { container } = renderPanel(createUsdtOrderFixture('pending_payment'));
    expect(container).toBeEmptyDOMElement();
  });

  it('confirms another Arbitrum address after the exchange warning and network confirmation', async () => {
    const { actOnOrder } = renderPanel(createUsdtOrderFixture('return_approved'));
    const user = userEvent.setup();

    expect(screen.getByText(/Confirm where your USDT refund should go/)).toBeInTheDocument();
    expect(screen.getByTestId('usdt-refund-network-warning')).toHaveTextContent(
      'If this is an exchange deposit address, check that the exchange accepts USDT on Arbitrum One. Funds sent on the wrong network can be lost.',
    );
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('Arbitrum One USDT address'), REFUND_FIXTURE_ADDRESS);
    await user.click(screen.getByRole('button', { name: 'Confirm refund address' }));
    expect(await screen.findByText('Confirm that this address accepts USDT on Arbitrum One.')).toBeInTheDocument();
    expect(actOnOrder).not.toHaveBeenCalled();

    await user.click(screen.getByRole('checkbox', { name: 'This address accepts USDT on Arbitrum One' }));
    await user.click(screen.getByRole('button', { name: 'Confirm refund address' }));
    await waitFor(() =>
      expect(actOnOrder).toHaveBeenCalledWith(
        expect.objectContaining({ state: 'return_approved' }),
        'refund.confirm_destination',
        {
          address: REFUND_FIXTURE_ADDRESS,
        },
      ),
    );
  });

  it('shows an invalid address as an error and sends nothing', async () => {
    const { actOnOrder } = renderPanel(createUsdtOrderFixture('paid'));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Arbitrum One USDT address'), '0x1234');
    await user.click(screen.getByRole('checkbox', { name: 'This address accepts USDT on Arbitrum One' }));
    await user.click(screen.getByRole('button', { name: 'Confirm refund address' }));

    expect(await screen.findByText("That isn't a valid Arbitrum address. Check it and try again.")).toBeInTheDocument();
    expect(actOnOrder).not.toHaveBeenCalled();
  });

  it('offers the paying address as a choice only when the service projects it', async () => {
    const { actOnOrder } = renderPanel(
      createUsdtOrderFixture('paid', { paymentAddress: REFUND_FIXTURE_OTHER_ADDRESS }),
    );
    const user = userEvent.setup();

    expect(screen.getByRole('radio', { name: /Send it back to the address I paid from/ })).toBeChecked();
    expect(screen.getByText(REFUND_FIXTURE_OTHER_ADDRESS)).toBeInTheDocument();
    expect(screen.queryByLabelText('Arbitrum One USDT address')).not.toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Send it to another Arbitrum One USDT address' }));
    expect(screen.getByLabelText('Arbitrum One USDT address')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Send it back to the address I paid from/ }));
    await user.click(screen.getByRole('checkbox', { name: 'This address accepts USDT on Arbitrum One' }));
    await user.click(screen.getByRole('button', { name: 'Confirm refund address' }));
    await waitFor(() =>
      expect(actOnOrder).toHaveBeenCalledWith(expect.anything(), 'refund.confirm_destination', {
        address: REFUND_FIXTURE_OTHER_ADDRESS,
      }),
    );
  });

  it('shows the confirmed address and lets the buyer change it until a refund is recorded', async () => {
    const { actOnOrder } = renderPanel(createUsdtOrderFixture('return_approved', { refundDestination: destination }));
    const user = userEvent.setup();

    expect(screen.getByTestId('usdt-refund-destination')).toHaveTextContent(REFUND_FIXTURE_ADDRESS);
    expect(screen.getByTestId('usdt-refund-destination')).toHaveTextContent('confirmed Oct 9, 2026');
    expect(screen.getByText(/Your refund address is confirmed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm refund address' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Change address' }));
    expect(screen.getByLabelText('Arbitrum One USDT address')).toHaveValue(REFUND_FIXTURE_ADDRESS);
    await user.clear(screen.getByLabelText('Arbitrum One USDT address'));
    await user.type(screen.getByLabelText('Arbitrum One USDT address'), REFUND_FIXTURE_OTHER_ADDRESS);
    await user.click(screen.getByRole('checkbox', { name: 'This address accepts USDT on Arbitrum One' }));
    await user.click(screen.getByRole('button', { name: 'Confirm refund address' }));
    await waitFor(() =>
      expect(actOnOrder).toHaveBeenCalledWith(expect.anything(), 'refund.confirm_destination', {
        address: REFUND_FIXTURE_OTHER_ADDRESS,
      }),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument());
  });

  it('locks the address once the seller recorded a refund', () => {
    renderPanel(
      createUsdtOrderFixture('refunded_external', {
        refundDestination: destination,
        externalRefund: {
          amountMinor: 13_700,
          transactionId: REFUND_FIXTURE_TX_HASH,
          recordedAt: '2026-10-10T10:00:00.000Z',
        },
      }),
    );
    expect(screen.getByText(/locked in because the seller has recorded a refund/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Change address' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm refund address' })).not.toBeInTheDocument();
  });

  it('is offered while a USDT payment is in manual review', () => {
    renderPanel(createUsdtOrderFixture('pending_payment'), { paymentInReview: true });
    expect(screen.getByTestId('usdt-refund-buyer')).toBeInTheDocument();
  });
});

describe('MarketplaceUsdtRefundAddress — seller', () => {
  it('shows nothing on a plain paid order and waits for the buyer once a refund is due', () => {
    const { container, rerender } = renderPanel(createUsdtOrderFixture('paid'), { isBuyer: false });
    expect(container).toBeEmptyDOMElement();

    rerender(
      <MarketplaceUsdtRefundAddress
        order={createUsdtOrderFixture('return_received')}
        isBuyer={false}
        paymentInReview={false}
        actOnOrder={vi.fn(async () => true)}
      />,
    );
    expect(screen.getByTestId('usdt-refund-seller')).toHaveTextContent(
      "The buyer hasn't confirmed a refund address yet.",
    );
    expect(screen.queryByTestId('usdt-refund-destination')).not.toBeInTheDocument();
  });

  it('shows the confirmed address, the USDT amount at parity and a Bitkit instruction', () => {
    renderPanel(createUsdtOrderFixture('return_received', { refundDestination: destination }), { isBuyer: false });

    const panel = screen.getByTestId('usdt-refund-seller');
    expect(panel).toHaveTextContent(REFUND_FIXTURE_ADDRESS);
    expect(panel).toHaveTextContent('Send this refund from Bitkit, then record the Arbitrum transaction hash');
    expect(screen.getByTestId('usdt-refund-amount')).toHaveTextContent('Refund amount: 137.000000 USDT');
    expect(screen.getByRole('button', { name: 'Copy address' })).toBeInTheDocument();
  });

  it('asks for the requested return amount instead of the whole order', () => {
    renderPanel(
      createUsdtOrderFixture('return_approved', {
        refundDestination: destination,
        returnRequest: {
          state: 'approved',
          reason: 'Wrong size',
          requestedAmountMinor: 5_000,
          requestedAt: '2026-08-18T09:00:00.000Z',
          updatedAt: '2026-08-19T09:00:00.000Z',
        },
      }),
      { isBuyer: false },
    );
    expect(screen.getByTestId('usdt-refund-amount')).toHaveTextContent('Refund amount: 50.000000 USDT');
  });

  it('says the seller recorded it, without claiming a check, once recorded', () => {
    renderPanel(
      createUsdtOrderFixture('refunded_external', {
        refundDestination: destination,
        externalRefund: {
          amountMinor: 13_700,
          transactionId: REFUND_FIXTURE_TX_HASH,
          recordedAt: '2026-10-10T10:00:00.000Z',
        },
      }),
      { isBuyer: false },
    );
    expect(screen.getByTestId('usdt-refund-seller')).toHaveTextContent(
      'You recorded a refund to this address. The Shop has not checked it on Arbitrum.',
    );
    expect(screen.queryByTestId('usdt-refund-amount')).not.toBeInTheDocument();
  });
});
