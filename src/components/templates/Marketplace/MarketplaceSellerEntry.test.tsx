import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { MarketplaceSellerEntry } from './MarketplaceSellerEntry';

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

describe('MarketplaceSellerEntry', () => {
  it('replaces the bare shop route not-found with seller setup links', () => {
    render(<MarketplaceSellerEntry />);

    expect(screen.getByRole('heading', { name: 'Set up your seller account to start listing' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Payment settings/i })).toHaveAttribute(
      'href',
      MARKETPLACE_ROUTES.SETTINGS,
    );
    expect(screen.getByRole('link', { name: /My Shop/i })).toHaveAttribute('href', MARKETPLACE_ROUTES.MY_SHOP);
  });
});
