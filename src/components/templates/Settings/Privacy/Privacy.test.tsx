import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Privacy } from './Privacy';

vi.mock('@/organisms/Settings/MarketplaceRecoveryKey/MarketplaceRecoveryKey', () => ({
  MarketplaceRecoveryKey: () => <section data-testid="marketplace-recovery-key" />,
}));

describe('Privacy', () => {
  it('renders privacy content', () => {
    render(<Privacy />);
    expect(screen.getByText('Privacy and Safety')).toBeInTheDocument();
  });

  it('offers the marketplace recovery key export', () => {
    render(<Privacy />);
    expect(screen.getByTestId('marketplace-recovery-key')).toBeInTheDocument();
  });

  it('renders privacy switches', () => {
    render(<Privacy />);
    expect(screen.getByText('Show confirmation before redirecting')).toBeInTheDocument();
    expect(screen.getByText('Blur censored posts or profile pictures')).toBeInTheDocument();
  });
});

describe('Privacy - Snapshots', () => {
  it('matches snapshot', () => {
    const { container } = render(<Privacy />);
    expect(container.firstChild).toMatchSnapshot();
  });
});
