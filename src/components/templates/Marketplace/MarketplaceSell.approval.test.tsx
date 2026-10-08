import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { MarketplaceSell } from './MarketplaceSell';

const state = vi.hoisted(() => ({ allowed: false, ready: true, pubky: 'seller' }));
const push = vi.hoisted(() => vi.fn());
const createListing = vi.hoisted(() => vi.fn(() => ({ form: {}, media: {}, publishBlocked: null })));

vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
vi.mock('@/hooks/useMarketplaceSellingAccess/useMarketplaceSellingAccess', () => ({
  useMarketplaceSellingAccess: () => ({ ...state, checkAccess: () => state.allowed }),
}));
vi.mock('@/hooks/useCreateMarketplaceListing/useCreateMarketplaceListing', () => ({
  useCreateMarketplaceListing: createListing,
}));
vi.mock('@/hooks/useSellerPaymentMethodGate/useSellerPaymentMethodGate', () => ({
  useSellerPaymentMethodGate: () => ({ isDurable: false, ready: true, reason: null }),
}));
vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));
vi.mock('@/organisms/Marketplace/MarketplaceSectionNav', () => ({ MarketplaceSectionNav: () => null }));
vi.mock('@/organisms/Marketplace/MarketplaceListingForm', () => ({
  MarketplaceListingForm: () => <div data-testid="listing-form" />,
}));
vi.mock('@/organisms/Marketplace/MarketplaceSessionConnectDialog', () => ({
  MarketplaceSessionConnectDialog: ({
    intent,
    onOpenChange,
    onConnected,
  }: {
    intent: string;
    onOpenChange: (open: boolean) => void;
    onConnected: () => void;
  }) => (
    <div role="dialog" aria-label={`Enable ${intent === 'sell' ? 'selling' : 'purchases'}`}>
      <button onClick={() => onOpenChange(false)}>Cancel</button>
      <button
        onClick={() => {
          state.allowed = true;
          onOpenChange(false);
          onConnected();
        }}
      >
        Approve
      </button>
    </div>
  ),
}));

describe('MarketplaceSell entry approval', () => {
  beforeEach(() => {
    state.allowed = false;
    state.ready = true;
    state.pubky = 'seller';
    vi.clearAllMocks();
  });

  it('shows the selling dialog without mounting the composer', () => {
    render(<MarketplaceSell />);
    expect(screen.getByRole('dialog', { name: 'Enable selling' })).toBeInTheDocument();
    expect(createListing).not.toHaveBeenCalled();
    expect(screen.queryByText('Create a listing')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('waits for saved approval to be checked before opening the dialog', () => {
    state.ready = false;
    render(<MarketplaceSell />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(createListing).not.toHaveBeenCalled();
  });

  it('opens the composer only after approval succeeds', async () => {
    render(<MarketplaceSell />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.getByTestId('listing-form')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(push).not.toHaveBeenCalled();
  });

  it('returns to My shop on cancel without creating a draft', async () => {
    render(<MarketplaceSell />);
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(push).toHaveBeenCalledWith(MARKETPLACE_ROUTES.DASHBOARD);
    expect(createListing).not.toHaveBeenCalled();
  });

  it('preserves an opened composer if approval later expires', () => {
    state.allowed = true;
    const { rerender } = render(<MarketplaceSell />);
    state.allowed = false;
    rerender(<MarketplaceSell />);
    expect(screen.getByTestId('listing-form')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
