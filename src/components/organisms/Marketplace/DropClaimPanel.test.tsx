import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseMarketplaceDropClaimResult } from '@/hooks/useMarketplaceDropClaim/useMarketplaceDropClaim';
import type { CommerceDropRecord } from '@/libs/commerce/marketplace-records';
import { DropClaimPanel } from './DropClaimPanel';

const SELLER = 's'.repeat(52);
const BUYER = 'b'.repeat(52);
const authState = vi.hoisted(() => ({
  currentUserPubky: 'b'.repeat(52) as string | null,
  setShowSignInDialog: vi.fn(),
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: Object.assign((selector: (state: typeof authState) => unknown) => selector(authState), {
    getState: () => authState,
  }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getOrFetchListing: vi.fn(async () => ({
      title: 'Field Recordings',
      media: [],
      sale: { format: 'fixed_price', unitPrice: { amountMinor: 5_000, currency: 'USD', exponent: 2 } },
    })),
    getIndicativeBtcRate: vi.fn(async () => null),
  },
}));

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', () => ({
  useMarketplaceFirstMediaUrls: () => [],
}));

function makeClaim(): UseMarketplaceDropClaimResult {
  return {
    addresses: [],
    claimAddress: {
      id: 'buyer:address',
      owner_id: 'b'.repeat(52),
      label: 'Home',
      name: 'Alice Buyer',
      line1: '1 Market Street',
      line2: '',
      city: 'New York',
      region: 'NY',
      postal_code: '10001',
      country_code: 'US',
      is_default: true,
      last_used_at: null,
      created_at: 1,
      updated_at: 1,
    },
    submittingListingId: null,
    claimedListingIds: new Set(),
    failure: null,
    needsSession: false,
    sessionError: null,
    claim: vi.fn(async () => true),
  };
}

describe('DropClaimPanel', () => {
  beforeEach(() => {
    authState.currentUserPubky = BUYER;
    authState.setShowSignInDialog.mockClear();
  });

  it('disables repeat claims and states the per-buyer limit at zero allowance', async () => {
    render(
      <DropClaimPanel
        record={{ ownerPubky: SELLER, dropId: 'vol1', listingIds: ['listing1'] } as CommerceDropRecord}
        claim={makeClaim()}
        remainingAllowance={0}
      />,
    );

    const button = await screen.findByRole('button', { name: 'Per-buyer limit reached' });
    expect(button).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent("You have reached this drop's per-buyer limit.");
  });

  it('uses one Sign in to buy path for logged-out visitors instead of Claim one', async () => {
    authState.currentUserPubky = null;
    const user = userEvent.setup();
    render(
      <DropClaimPanel
        record={{ ownerPubky: SELLER, dropId: 'vol1', listingIds: ['listing1'] } as CommerceDropRecord}
        claim={makeClaim()}
        remainingAllowance={2}
      />,
    );

    const purchase = await screen.findByRole('button', { name: 'Sign in to buy' });
    expect(purchase).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Claim one' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Approve purchases in Pubky Ring' })).not.toBeInTheDocument();
    expect(screen.queryByText(/No saved delivery address/)).not.toBeInTheDocument();

    await user.click(purchase);
    expect(authState.setShowSignInDialog).toHaveBeenCalledWith(true);
  });

  it('sends Claim one through the single Checkout screen', async () => {
    render(
      <DropClaimPanel
        record={{ ownerPubky: SELLER, dropId: 'vol1', listingIds: ['listing1'] } as CommerceDropRecord}
        claim={makeClaim()}
        remainingAllowance={2}
      />,
    );

    const claim = await screen.findByRole('link', { name: 'Claim one' });
    expect(claim).toHaveAttribute('href', `/marketplace/checkout?seller=${SELLER}&drop=vol1&listing=listing1`);
    expect(screen.queryByText(/No saved delivery address/)).not.toBeInTheDocument();
  });
});
