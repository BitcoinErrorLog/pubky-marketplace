import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { getMarketplacePaymentSettingsRoute, MARKETPLACE_ROUTES } from '@/app/routes';
import {
  LISTING_COMPOSER_PAYMENT_COPY,
  LISTING_COMPOSER_RETURN_INTENT_KEY,
  LISTING_PUBLISH_GUARD_CHECKING,
} from '@/libs/commerce/listing-publish-guards';
import { ListingComposerPaymentInterstitial } from './ListingComposerPaymentInterstitial';

describe('ListingComposerPaymentInterstitial', () => {
  it('renders the setup step without listing fields', () => {
    render(<ListingComposerPaymentInterstitial />);

    expect(screen.getByRole('heading', { name: LISTING_COMPOSER_PAYMENT_COPY.title })).toBeInTheDocument();
    expect(screen.getByText(LISTING_COMPOSER_PAYMENT_COPY.body)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Payment settings' })).toHaveAttribute(
      'href',
      getMarketplacePaymentSettingsRoute(MARKETPLACE_ROUTES.SELL),
    );
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(document.querySelector('[data-surface="listing-payment-setup"]')).not.toBeNull();
  });

  it('hides the settings action while payment settings are still being checked', () => {
    render(<ListingComposerPaymentInterstitial checking />);

    expect(screen.getByText(LISTING_PUBLISH_GUARD_CHECKING)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Payment settings' })).not.toBeInTheDocument();
  });

  it('remembers the composer return path when opening payment settings', async () => {
    sessionStorage.clear();
    const user = userEvent.setup();
    render(<ListingComposerPaymentInterstitial />);

    await user.click(screen.getByRole('link', { name: 'Payment settings' }));

    expect(sessionStorage.getItem(LISTING_COMPOSER_RETURN_INTENT_KEY)).toBe(MARKETPLACE_ROUTES.SELL);
  });
});
