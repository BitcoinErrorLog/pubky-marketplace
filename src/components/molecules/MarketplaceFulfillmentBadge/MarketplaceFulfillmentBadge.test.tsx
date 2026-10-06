import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MarketplaceFulfillmentBadge, marketplaceFulfillmentLabel } from './MarketplaceFulfillmentBadge';

describe('MarketplaceFulfillmentBadge', () => {
  it('names every method combination a listing can sell by', () => {
    expect(marketplaceFulfillmentLabel(['shipping'])).toBe('Shipping');
    expect(marketplaceFulfillmentLabel(['pickup'])).toBe('Local pickup');
    expect(marketplaceFulfillmentLabel(['shipping', 'pickup'])).toBe('Pickup or shipping');
    expect(marketplaceFulfillmentLabel(['digital'])).toBe('Digital delivery');
    expect(marketplaceFulfillmentLabel(['shipping', 'digital'])).toBe('Shipping or digital');
    expect(marketplaceFulfillmentLabel(['pickup', 'digital'])).toBe('Pickup or digital');
    expect(marketplaceFulfillmentLabel(['shipping', 'pickup', 'digital'])).toBe('Pickup, shipping or digital');
  });

  it('renders nothing for a source without the vocabulary', () => {
    const { container } = render(<MarketplaceFulfillmentBadge methods={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the label as a badge', () => {
    render(<MarketplaceFulfillmentBadge methods={['digital']} />);
    expect(screen.getByText('Digital delivery')).toHaveAttribute('data-slot', 'badge');
  });
});
