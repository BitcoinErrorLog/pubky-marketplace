import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ShopProfileCard } from './ShopProfileCard';

describe('ShopProfileCard', () => {
  it('renders the mini preview with compressed type and location', () => {
    render(
      <ShopProfileCard
        variant="mini"
        name="Satoshi Vintage"
        bio="Circular fashion."
        avatarUrl={null}
        bannerUrl={null}
        location={{ countryCode: 'US', region: 'NY' }}
        vacation
        bannerAlt="banner preview"
        avatarAlt="avatar preview"
        testId="shop-live-preview"
      />,
    );

    const preview = screen.getByTestId('shop-live-preview');
    expect(preview).toHaveTextContent('Satoshi Vintage');
    expect(preview).toHaveTextContent('Vacation mode');
    expect(preview).toHaveTextContent('NY, US');
    expect(screen.getByRole('heading', { level: 2, name: 'Satoshi Vintage' })).toBeInTheDocument();
  });

  it('renders the full shop heading level', () => {
    render(
      <ShopProfileCard
        variant="full"
        name="Satoshi Vintage"
        bio="Circular fashion."
        avatarUrl={null}
        bannerUrl={null}
        location={{ countryCode: 'US', region: 'NY' }}
        bannerAlt="banner"
        avatarAlt="avatar"
      />,
    );

    expect(screen.getByRole('heading', { level: 1, name: 'Satoshi Vintage' })).toBeInTheDocument();
  });
});
