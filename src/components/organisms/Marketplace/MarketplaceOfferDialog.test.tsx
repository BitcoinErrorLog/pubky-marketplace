import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BTC_ASSET, USD_ASSET } from '@/libs/commerce/pricing';
import { useAuthStore } from '@/stores/auth/auth.store';
import { MarketplaceOfferDialog } from './MarketplaceOfferDialog';

const SIGNED_IN_PUBKY = 'y'.repeat(52);

describe('MarketplaceOfferDialog', () => {
  beforeEach(() => {
    useAuthStore.setState({ currentUserPubky: SIGNED_IN_PUBKY });
  });

  it('disables the trigger while the listing has no server revision to offer against', () => {
    render(
      <MarketplaceOfferDialog
        aggregateId="listing:x"
        expectedRevision={null}
        priceAsset={USD_ASSET}
        onAccepted={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Make offer' })).toBeDisabled();
  });

  it('keeps the trigger enabled and asks for approval when only the marketplace session is missing', async () => {
    const user = userEvent.setup();
    const onSessionRequired = vi.fn();
    render(
      <MarketplaceOfferDialog
        aggregateId="listing:x"
        expectedRevision={null}
        priceAsset={USD_ASSET}
        isSessionRequired
        onSessionRequired={onSessionRequired}
        onAccepted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Make offer' }));

    expect(onSessionRequired).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens a labelled modal dialog, traps focus in labelled fields, and restores focus on close', async () => {
    const user = userEvent.setup();
    render(
      <MarketplaceOfferDialog
        aggregateId="listing:x"
        expectedRevision={1}
        priceAsset={USD_ASSET}
        askingPrice={{ amountMinor: 12_500, currency: 'USD', exponent: 2 }}
        onAccepted={vi.fn()}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Make offer' });
    await user.click(trigger);

    const dialog = await screen.findByRole('dialog', { name: 'Make a private offer' });
    // every field is reachable by its accessible name
    expect(screen.getByLabelText('Offer amount (USD)')).toBeInTheDocument();
    expect(screen.getByText('Asking price: $125.00')).toBeInTheDocument();
    expect(screen.getByLabelText('Quantity')).toBeInTheDocument();
    expect(screen.getByLabelText('Message (optional)')).toBeInTheDocument();
    // focus starts inside the dialog
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    // focus returns to the element that opened the dialog
    expect(document.activeElement).toBe(trigger);
  });

  it('shows the live offer percentage against asking price', async () => {
    const user = userEvent.setup();
    render(
      <MarketplaceOfferDialog
        aggregateId="listing:x"
        expectedRevision={1}
        priceAsset={USD_ASSET}
        askingPrice={{ amountMinor: 12_500, currency: 'USD', exponent: 2 }}
        onAccepted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Make offer' }));
    const amount = screen.getByLabelText('Offer amount (USD)');

    await user.type(amount, '100.00');
    expect(screen.getByText('20% below asking')).toBeInTheDocument();

    await user.clear(amount);
    await user.type(amount, '150.00');
    expect(screen.getByText('20% above asking')).toBeInTheDocument();
  });

  it('hides asking and percent lines when asking currency does not match the listing asset', async () => {
    const user = userEvent.setup();
    render(
      <MarketplaceOfferDialog
        aggregateId="listing:x"
        expectedRevision={1}
        priceAsset={BTC_ASSET}
        askingPrice={{ amountMinor: 12_500, currency: 'USD', exponent: 2 }}
        onAccepted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Make offer' }));
    await user.type(screen.getByLabelText('Offer amount (₿)'), '100000');

    expect(screen.queryByText(/Asking price:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/below asking/)).not.toBeInTheDocument();
    expect(screen.queryByText(/above asking/)).not.toBeInTheDocument();
    expect(screen.queryByText('Matches asking')).not.toBeInTheDocument();
  });

  it('shows asking and percent lines when asking currency matches the listing asset', async () => {
    const user = userEvent.setup();
    render(
      <MarketplaceOfferDialog
        aggregateId="listing:x"
        expectedRevision={1}
        priceAsset={USD_ASSET}
        askingPrice={{ amountMinor: 10_000, currency: 'USD', exponent: 2 }}
        onAccepted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Make offer' }));
    expect(screen.getByText('Asking price: $100.00')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Offer amount (USD)'), '80.00');
    expect(screen.getByText('20% below asking')).toBeInTheDocument();
  });

  it('opens the sign-in dialog instead of the offer form for signed-out visitors', async () => {
    useAuthStore.setState({ currentUserPubky: null });
    const user = userEvent.setup();
    render(
      <MarketplaceOfferDialog
        aggregateId="listing:x"
        expectedRevision={1}
        priceAsset={USD_ASSET}
        onAccepted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Make offer' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(useAuthStore.getState().showSignInDialog).toBe(true);
  });

  it('disables the trigger with hold copy while another buyer pays', () => {
    render(
      <MarketplaceOfferDialog
        aggregateId="listing:x"
        expectedRevision={1}
        priceAsset={USD_ASSET}
        holdDisabled
        holdLabel="Held while another buyer pays"
        onAccepted={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Held while another buyer pays' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Make offer' })).not.toBeInTheDocument();
  });
});
