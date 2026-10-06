import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useMarketplaceDisplayStore } from '@/stores/marketplace-display/marketplace-display.store';
import { MarketplaceCardPrice } from './MarketplaceCardPrice';

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getIndicativeBtcRate: vi.fn(),
  },
}));

const USD_PRICE = { amountMinor: 12_500, currency: 'USD', exponent: 2 };
const RATE = { satUsd: 0.001, btcUsd: 100_000, lastUpdatedAt: new Date('2026-08-21T00:00:00Z') };

describe('MarketplaceCardPrice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMarketplaceDisplayStore.setState({ displayCurrency: 'USD' });
  });

  it('shows the listed amount when it matches the display currency', () => {
    render(<MarketplaceCardPrice money={USD_PRICE} />);

    expect(screen.getByText('$125.00')).toBeInTheDocument();
    expect(CommerceController.getIndicativeBtcRate).not.toHaveBeenCalled();
  });

  it('keeps the approximation marker when displaying a converted currency', async () => {
    useMarketplaceDisplayStore.setState({ displayCurrency: 'BTC' });
    vi.mocked(CommerceController.getIndicativeBtcRate).mockResolvedValue(RATE);

    render(<MarketplaceCardPrice money={USD_PRICE} />);

    expect(await screen.findByText('≈ ₿125,000')).toHaveAttribute('title', 'Indicative conversion · Listed at $125.00');
  });
});
