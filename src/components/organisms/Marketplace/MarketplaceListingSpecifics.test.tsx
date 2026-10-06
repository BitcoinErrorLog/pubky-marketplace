import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import { MarketplaceListingSpecifics } from './MarketplaceListingSpecifics';

const push = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));
beforeEach(() => {
  useCommerceStore.getState().reset();
  push.mockClear();
});

it.each([
  ['Fashion', 'fashion'],
  ['Men', 'fashion-men'],
  ['Footwear', 'fashion-men-footwear'],
  ['Boots', 'fashion-men-footwear-boots'],
])('browses the %s category and clears unrelated filters', (label, id) => {
  const store = useCommerceStore.getState();
  store.setQuery('unrelated');
  store.setSaleFormat('drops');
  store.setAttributeFilter('color', 'red');
  render(
    <MarketplaceListingSpecifics
      record={{ categoryId: 'fashion-men-footwear-boots', attributes: {}, description: 'Item description' }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: `Browse ${label}` }));
  expect(useCommerceStore.getState()).toMatchObject({
    categoryId: id,
    query: '',
    saleFormat: 'all',
    attributeFilters: {},
  });
  expect(push).toHaveBeenCalledWith('/marketplace');
});

it('keeps unknown categories browsable by their original ID', () => {
  render(
    <MarketplaceListingSpecifics
      record={{ categoryId: 'custom-category', attributes: {}, description: 'Item description' }}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Browse Custom category' }));
  expect(useCommerceStore.getState().categoryId).toBe('custom-category');
});
