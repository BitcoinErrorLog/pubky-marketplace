import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { USD_ASSET } from '@/libs/commerce/pricing';
import { useAuthStore } from '@/stores/auth/auth.store';
import {
  createAuctionProjectionFixture,
  createViewerBidAuctionProjectionFixture,
} from '@/test/fixtures/commerce/projections';
import { MarketplaceBidDialog } from './MarketplaceBidDialog';

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    executeMarketplaceCommand: vi.fn(),
  },
}));

const SIGNED_IN_PUBKY = 'y'.repeat(52);

describe('MarketplaceBidDialog', () => {
  beforeEach(() => {
    useAuthStore.setState({ currentUserPubky: SIGNED_IN_PUBKY });
  });

  it('disables the trigger while the auction has no projection to bid against', () => {
    render(
      <MarketplaceBidDialog aggregateId="listing:x" projection={null} priceAsset={USD_ASSET} onAccepted={vi.fn()} />,
    );

    expect(screen.getByRole('button', { name: 'Place a bid' })).toBeDisabled();
  });

  it('keeps the trigger enabled and asks for approval when only the marketplace session is missing', async () => {
    const user = userEvent.setup();
    const onSessionRequired = vi.fn();
    render(
      <MarketplaceBidDialog
        aggregateId="listing:x"
        projection={null}
        priceAsset={USD_ASSET}
        isSessionRequired
        onSessionRequired={onSessionRequired}
        onAccepted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Place a bid' }));

    expect(onSessionRequired).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('explains maximum-bid proxy semantics inside the dialog', async () => {
    const user = userEvent.setup();
    render(
      <MarketplaceBidDialog
        aggregateId="listing:x"
        projection={createAuctionProjectionFixture()}
        priceAsset={USD_ASSET}
        onAccepted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Place a bid' }));

    expect(screen.getByRole('dialog', { name: 'Set your maximum bid' })).toBeInTheDocument();
    expect(screen.getByText("We bid only what's needed to keep you ahead, up to your maximum.")).toBeInTheDocument();
    expect(
      screen.getByText('Your maximum stays private. The visible price advances only enough to keep you ahead.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Minimum maximum: \$74\.00/)).toBeInTheDocument();
  });

  it('shows the bidder-specific minimum and current proxy maximum', async () => {
    const user = userEvent.setup();
    render(
      <MarketplaceBidDialog
        aggregateId="listing:x"
        projection={createViewerBidAuctionProjectionFixture()}
        priceAsset={USD_ASSET}
        onAccepted={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Place a bid' }));

    expect(screen.getByText(/Minimum maximum: \$70\.01/)).toBeInTheDocument();
    expect(screen.getByText(/minimum required to exceed your own current proxy maximum\./)).toBeInTheDocument();
    expect(screen.getByText('Your current proxy maximum: $70.00')).toBeInTheDocument();
  });

  it('refreshes a higher viewer minimum after BID_TOO_LOW without clearing the entered amount', async () => {
    const user = userEvent.setup();
    const initialProjection = createViewerBidAuctionProjectionFixture();
    const refreshedProjection = {
      ...initialProjection,
      serverRevision: initialProjection.serverRevision + 1,
      viewerBid: {
        ...initialProjection.viewerBid!,
        maximumAmount: { amountMinor: 9_000, currency: 'USD', exponent: 2 },
        minimumNextBid: { amountMinor: 9_001, currency: 'USD', exponent: 2 },
      },
    };
    let projection = initialProjection;
    const onRefresh = vi.fn(() => {
      projection = refreshedProjection;
    });
    vi.mocked(CommerceController.executeMarketplaceCommand).mockResolvedValue({
      ok: false,
      error: { code: 'BID_TOO_LOW', message: 'A new proxy maximum must exceed the bidder previous maximum.' },
    });
    const { rerender } = render(
      <MarketplaceBidDialog
        aggregateId="listing:x"
        projection={projection}
        priceAsset={USD_ASSET}
        onAccepted={onRefresh}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Place a bid' }));
    const input = screen.getByRole('textbox', { name: 'Maximum bid (USD)' });
    await user.type(input, '70.01');
    await user.click(screen.getByRole('button', { name: 'Confirm bid' }));
    rerender(
      <MarketplaceBidDialog
        aggregateId="listing:x"
        projection={projection}
        priceAsset={USD_ASSET}
        onAccepted={onRefresh}
      />,
    );

    expect(onRefresh).toHaveBeenCalledOnce();
    expect(screen.getByText(/Minimum maximum: \$90\.01/)).toBeInTheDocument();
    expect(input).toHaveValue('70.01');
  });

  it('labels an ended auction instead of inviting a bid', () => {
    render(
      <MarketplaceBidDialog
        aggregateId="listing:x"
        projection={createAuctionProjectionFixture()}
        priceAsset={USD_ASSET}
        onAccepted={vi.fn()}
        auctionPhase="ended"
      />,
    );

    expect(screen.getByRole('button', { name: 'Auction ended' })).toBeDisabled();
  });
});
