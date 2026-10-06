import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as commerceConfig from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { toast } from '@/molecules/Toaster/use-toast';
import { createOrderFixture } from '@/test/fixtures/commerce/orders';
import { MarketplaceShippingLabelDialog } from './MarketplaceShippingLabelDialog';

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getShippingLabel: vi.fn(async () => null),
    quoteShippingRates: vi.fn(async () => []),
    purchaseShippingLabel: vi.fn(async () => null),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({ toast: vi.fn() }));

const mockedController = vi.mocked(CommerceController);

const RATE = {
  rateId: 'rate_1',
  provider: 'USPS',
  servicelevel: 'Ground',
  amount: '7.85',
  currency: 'USD',
  estimatedDays: 3,
  durationTerms: null,
};

const LABEL = {
  transactionId: 'txn_1',
  carrier: 'USPS',
  servicelevel: 'Ground',
  amount: '7.85',
  currency: 'USD',
  trackingNumber: 'TRACK123',
  trackingUrl: null,
  labelUrl: 'https://deliver.goshippo.com/label_1.pdf',
  purchasedAt: '2026-08-24T12:00:00.000Z',
};

beforeEach(() => {
  mockedController.getShippingLabel.mockReset().mockResolvedValue(null);
  mockedController.quoteShippingRates.mockReset().mockResolvedValue([RATE]);
  mockedController.purchaseShippingLabel.mockReset().mockResolvedValue(LABEL);
  vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('transaction-service');
});

function renderDialog() {
  const order = createOrderFixture('paid');
  const actOnOrder = vi.fn(async () => true);
  render(<MarketplaceShippingLabelDialog order={order} actOnOrder={actOnOrder} />);
  return { order, actOnOrder };
}

async function fillParcelAndQuote() {
  await userEvent.type(screen.getByLabelText('Weight (g)'), '900');
  await userEvent.type(screen.getByLabelText('Length (mm)'), '300');
  await userEvent.type(screen.getByLabelText('Width (mm)'), '200');
  await userEvent.type(screen.getByLabelText('Height (mm)'), '150');
  await userEvent.click(screen.getByRole('button', { name: 'Get rates' }));
}

describe('MarketplaceShippingLabelDialog', () => {
  it('quotes rates for the confirmed parcel and buys the selected one', async () => {
    const { order } = renderDialog();
    await userEvent.click(screen.getByRole('button', { name: /Shipping label/ }));
    await waitFor(() => expect(mockedController.getShippingLabel).toHaveBeenCalledWith(order.id));

    await fillParcelAndQuote();
    expect(mockedController.quoteShippingRates).toHaveBeenCalledWith(order.id, {
      weightGrams: 900,
      lengthMm: 300,
      widthMm: 200,
      heightMm: 150,
    });
    await screen.findByText('USPS Ground');

    await userEvent.click(screen.getByRole('button', { name: 'Buy for 7.85 USD' }));
    expect(mockedController.purchaseShippingLabel).toHaveBeenCalledWith(order.id, 'rate_1');
    // The purchased label surfaces printing and tracking reuse.
    await screen.findByRole('link', { name: /Print label/ });
    expect(screen.getByText(/Tracking TRACK123/)).toBeInTheDocument();
  });

  it('reuses the purchased tracking for the ship action', async () => {
    mockedController.getShippingLabel.mockResolvedValue(LABEL);
    const { order, actOnOrder } = renderDialog();
    await userEvent.click(screen.getByRole('button', { name: /Shipping label/ }));
    await screen.findByRole('link', { name: /Print label/ });

    await userEvent.click(screen.getByRole('button', { name: 'Mark shipped with this tracking' }));
    await waitFor(() =>
      expect(actOnOrder).toHaveBeenCalledWith(order, 'fulfillment.ship', {
        carrier: 'USPS',
        trackingNumber: 'TRACK123',
      }),
    );
  });

  it('does not expose quote or purchase sentinel errors in toast copy', async () => {
    const sentinel = (operation: string) =>
      new AppError({
        category: ErrorCategory.Client,
        code: ClientErrorCode.CONFLICT,
        message: `SENTINEL_SHIPPING_LABEL_${operation}`,
        service: ErrorService.Marketplace,
        operation,
      });
    mockedController.quoteShippingRates.mockRejectedValueOnce(sentinel('quote'));
    const { order } = renderDialog();
    await userEvent.click(screen.getByRole('button', { name: /Shipping label/ }));
    await fillParcelAndQuote();
    await waitFor(() => expect(vi.mocked(toast)).toHaveBeenCalled());
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain('SENTINEL_SHIPPING_LABEL_quote');

    mockedController.quoteShippingRates.mockResolvedValueOnce([RATE]);
    await fillParcelAndQuote();
    await screen.findByText('USPS Ground');
    mockedController.purchaseShippingLabel.mockRejectedValueOnce(sentinel('purchase'));
    await userEvent.click(screen.getByRole('button', { name: 'Buy for 7.85 USD' }));
    await waitFor(() => expect(vi.mocked(toast).mock.calls.length).toBeGreaterThan(1));
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain('SENTINEL_SHIPPING_LABEL_purchase');
    expect(order.id).toBeTruthy();
  });

  it('renders nothing outside the durable modes', () => {
    vi.spyOn(commerceConfig, 'getCommerceAdapterMode').mockReturnValue('sandbox');
    renderDialog();
    expect(screen.queryByRole('button', { name: /Shipping label/ })).not.toBeInTheDocument();
  });
});
