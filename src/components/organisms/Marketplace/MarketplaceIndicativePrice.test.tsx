import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/atoms/Tooltip/Tooltip';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useMarketplaceDisplayStore } from '@/stores/marketplace-display/marketplace-display.store';
import { MarketplaceIndicativePrice } from './MarketplaceIndicativePrice';

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getIndicativeBtcRate: vi.fn(),
  },
}));

const USD_PRICE = { amountMinor: 12_500, currency: 'USD', exponent: 2 };
const BTC_PRICE = { amountMinor: 15_000, currency: 'BTC', exponent: 8 };
const RATE = { satUsd: 0.001, btcUsd: 100_000, lastUpdatedAt: new Date('2026-08-21T00:00:00Z') };

function renderPrice(money: { amountMinor: number; currency: string; exponent: number }) {
  return render(
    <TooltipProvider>
      <MarketplaceIndicativePrice money={money} />
    </TooltipProvider>,
  );
}

describe('MarketplaceIndicativePrice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useMarketplaceDisplayStore.setState({ showFxEstimate: true, measurementSystem: null });
  });

  it('shows a bitcoin estimate for a USD price once the rate arrives', async () => {
    vi.mocked(CommerceController.getIndicativeBtcRate).mockResolvedValue(RATE);
    renderPrice(USD_PRICE);

    expect(await screen.findByText('≈ ₿125,000')).toBeInTheDocument();
  });

  it('shows a USD estimate for a bitcoin price once the rate arrives', async () => {
    vi.mocked(CommerceController.getIndicativeBtcRate).mockResolvedValue(RATE);
    renderPrice(BTC_PRICE);

    expect(await screen.findByText('≈ $15.00')).toBeInTheDocument();
  });

  it('renders nothing when the rate fetch fails — no estimate, no error state', async () => {
    vi.mocked(CommerceController.getIndicativeBtcRate).mockRejectedValue(new Error('rate unavailable'));
    const { container } = renderPrice(USD_PRICE);

    await waitFor(() => expect(CommerceController.getIndicativeBtcRate).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing and never fetches while the estimate toggle is off', async () => {
    useMarketplaceDisplayStore.setState({ showFxEstimate: false });
    vi.mocked(CommerceController.getIndicativeBtcRate).mockResolvedValue(RATE);
    const { container } = renderPrice(USD_PRICE);

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(CommerceController.getIndicativeBtcRate).not.toHaveBeenCalled();
  });

  it('renders nothing and never fetches for an asset with no rate source', async () => {
    vi.mocked(CommerceController.getIndicativeBtcRate).mockResolvedValue(RATE);
    const { container } = renderPrice({ amountMinor: 12_500, currency: 'EUR', exponent: 2 });

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(CommerceController.getIndicativeBtcRate).not.toHaveBeenCalled();
  });
});
