import { describe, expect, it, vi } from 'vitest';
import MarketplaceShopPage from './page';

const notFound = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
);
const rendered = vi.hoisted(() => vi.fn(() => <div data-testid="marketplace-shop" />));

vi.mock('next/navigation', () => ({ notFound }));
vi.mock('@/templates/Marketplace/MarketplaceShop', () => ({
  MarketplaceShop: rendered,
}));

describe('MarketplaceShopPage', () => {
  it('uses notFound for an invalid seller pubky', async () => {
    await expect(MarketplaceShopPage({ params: Promise.resolve({ sellerPubky: 'seller' }) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    expect(notFound).toHaveBeenCalledOnce();
    expect(rendered).not.toHaveBeenCalled();
  });

  it('uses notFound for a base32-confusable seller pubky', async () => {
    await expect(MarketplaceShopPage({ params: Promise.resolve({ sellerPubky: 'l'.repeat(52) }) })).rejects.toThrow(
      'NEXT_NOT_FOUND',
    );
    expect(notFound).toHaveBeenCalled();
    expect(rendered).not.toHaveBeenCalled();
  });

  it('renders the shop template for a valid seller pubky', async () => {
    const sellerPubky = 'y'.repeat(52);
    const result = await MarketplaceShopPage({ params: Promise.resolve({ sellerPubky }) });

    expect(result.type).toBe(rendered);
    expect(result.props).toEqual({ sellerPubky });
  });
});
