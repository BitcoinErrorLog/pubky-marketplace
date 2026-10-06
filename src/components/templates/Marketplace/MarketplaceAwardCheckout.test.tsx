import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceAwardCheckout } from './MarketplaceAwardCheckout';

const replace = vi.fn();

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('offer=offer-1'),
  usePathname: () => '/marketplace/award-checkout',
  useRouter: () => ({ replace, push: vi.fn() }),
}));

describe('MarketplaceAwardCheckout leftover redirect', () => {
  beforeEach(() => {
    replace.mockClear();
  });

  it('joins the one Checkout screen', async () => {
    render(<MarketplaceAwardCheckout />);
    await waitFor(() => {
      expect(replace).toHaveBeenCalledWith('/marketplace/checkout?offer=offer-1');
    });
  });
});
