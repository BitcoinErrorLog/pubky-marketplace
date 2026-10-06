import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarketplaceSellerIdentity } from './MarketplaceSellerIdentity';

describe('MarketplaceSellerIdentity', () => {
  it('does not render a shop-opened tenure line', () => {
    render(
      <MarketplaceSellerIdentity
        sellerPubky={'s'.repeat(52)}
        displayName="Satoshi Vintage"
        reputation={{ status: 'new_seller' }}
      />,
    );

    expect(screen.queryByText('Sold by')).not.toBeInTheDocument();
    expect(screen.getByText('Satoshi Vintage')).toBeInTheDocument();
    expect(screen.queryByText(/Shop opened/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Seller-stated/)).not.toBeInTheDocument();
  });

  it('preserves the full seller name in the owner card layout contract', () => {
    render(
      <div className="w-40">
        <MarketplaceSellerIdentity
          sellerPubky={'s'.repeat(52)}
          displayName="Northwind Vintage Goods"
          reputation={{ status: 'new_seller' }}
        />
      </div>,
    );

    const identity = screen.getByText('Northwind Vintage Goods').closest('div')?.parentElement;
    expect(identity).toHaveClass('min-w-0');
    expect(identity).not.toHaveClass('shrink-0');
    expect(screen.getByText('Northwind Vintage Goods')).toHaveClass('break-words');
  });
});
