import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { MarketplaceAuctionPanel } from './MarketplaceAuctionPanel';

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getMarketplaceListingBids: vi.fn(async () => null),
  },
}));

const mockedController = vi.mocked(CommerceController);

const SELLER = 's'.repeat(52);
const BIDDER_A = 'a'.repeat(52);
const BIDDER_B = 'b'.repeat(52);

const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', exponent: 2 });

function auctionProjection(overrides: Record<string, unknown> = {}) {
  return {
    startsAt: '2026-08-24T10:00:00.000Z',
    endsAt: new Date(Date.now() + 3_600_000).toISOString(),
    minimumIncrement: usd(500),
    currentPrice: usd(8_500),
    leaderPubky: BIDDER_A,
    bidCount: 2,
    ...overrides,
  };
}

beforeEach(() => {
  mockedController.getMarketplaceListingBids.mockReset().mockResolvedValue({
    bids: [
      { sequence: 1, bidderPubky: BIDDER_A, visibleAmount: usd(4_500), createdAt: '2026-08-24T11:00:00.000Z' },
      { sequence: 2, bidderPubky: BIDDER_B, visibleAmount: usd(8_500), createdAt: '2026-08-24T11:05:00.000Z' },
    ],
    auction: { endsAt: new Date(Date.now() + 3_600_000).toISOString(), status: 'active', bidCount: 2 },
    serverTime: new Date().toISOString(),
  });
});

describe('MarketplaceAuctionPanel', () => {
  it('shows unavailable history without a retry action', async () => {
    mockedController.getMarketplaceListingBids.mockResolvedValueOnce(null);
    render(
      <MarketplaceAuctionPanel
        sellerPubky={SELLER}
        listingId="listing01"
        auction={null}
        scheduledEndsAt={null}
        isSignedIn
      />,
    );
    await screen.findByText('Bid history unavailable');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(mockedController.getMarketplaceListingBids).toHaveBeenCalledTimes(1);
  });

  it('stops indefinite loading after 15 seconds', async () => {
    vi.useFakeTimers();
    try {
      mockedController.getMarketplaceListingBids.mockReturnValue(new Promise(() => {}));
      const { unmount } = render(
        <MarketplaceAuctionPanel
          sellerPubky={SELLER}
          listingId="listing01"
          auction={null}
          scheduledEndsAt={null}
          isSignedIn
        />,
      );
      expect(screen.getByText('Loading bid history…')).toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(15_000));
      expect(screen.getByText('Bid history unavailable')).toBeInTheDocument();
      expect(screen.queryByText('Loading bid history…')).not.toBeInTheDocument();
      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the visible-price bid history newest first with the proxy-secrecy note', async () => {
    render(
      <MarketplaceAuctionPanel
        sellerPubky={SELLER}
        listingId="listing01"
        auction={auctionProjection()}
        scheduledEndsAt={null}
        isSignedIn={true}
      />,
    );
    await screen.findByText(/#2/);
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('#2');
    expect(rows[0]).toHaveTextContent('$85.00');
    expect(rows[1]).toHaveTextContent('#1');
    expect(rows[1]).toHaveTextContent('$45.00');
    expect(screen.getByText(/private maximum stays\s+secret/)).toBeInTheDocument();
  });

  it('shows the end countdown from the auction terms', async () => {
    render(
      <MarketplaceAuctionPanel
        sellerPubky={SELLER}
        listingId="listing01"
        auction={auctionProjection()}
        scheduledEndsAt={null}
        isSignedIn={true}
      />,
    );
    await screen.findByText(/Ends in/);
    expect(screen.getByText(/anti-sniping/)).toBeInTheDocument();
  });

  it('renders bids without a recorded visible amount honestly', async () => {
    mockedController.getMarketplaceListingBids.mockResolvedValue({
      bids: [{ sequence: 1, bidderPubky: BIDDER_A, visibleAmount: null, createdAt: '2026-08-24T11:00:00.000Z' }],
      auction: null,
      serverTime: new Date().toISOString(),
    });
    render(
      <MarketplaceAuctionPanel
        sellerPubky={SELLER}
        listingId="listing01"
        auction={auctionProjection({ bidCount: 1 })}
        scheduledEndsAt={null}
        isSignedIn={true}
      />,
    );
    await screen.findByText(/amount not recorded/);
  });

  it('falls back to the scheduled end and asks for sign-in when signed out', () => {
    render(
      <MarketplaceAuctionPanel
        sellerPubky={SELLER}
        listingId="listing01"
        auction={null}
        scheduledEndsAt={new Date(Date.now() + 7_200_000).toISOString()}
        isSignedIn={false}
      />,
    );
    expect(screen.getByText(/Ends in/)).toBeInTheDocument();
    expect(screen.getByText(/Sign in to see the bid history/)).toBeInTheDocument();
    expect(mockedController.getMarketplaceListingBids).not.toHaveBeenCalled();
  });

  it('shows ended state and refuses bidding after the end time', () => {
    render(
      <MarketplaceAuctionPanel
        sellerPubky={SELLER}
        listingId="listing01"
        auction={auctionProjection({ endsAt: new Date(Date.now() - 1_000).toISOString() })}
        scheduledEndsAt={null}
        isSignedIn={false}
        auctionPhase="ended"
      />,
    );

    expect(screen.getByText(/Auction ended/)).toBeInTheDocument();
    expect(screen.getByText(/Bidding is closed/)).toBeInTheDocument();
  });
});
