import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { NexusDropStreamEntry } from '@/hooks/useMarketplaceDrops/drops-stream';
import { DropCard } from './DropCard';

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', () => ({
  useMarketplaceFirstMediaUrl: () => null,
}));

vi.mock('./DropCountdown', () => ({
  DropCountdown: () => <span>Starts in 2 hours</span>,
}));

const entry: NexusDropStreamEntry = {
  id: 'drop-1',
  owner_id: 'owner-pubky',
  title: 'Limited signed print',
  description: 'A numbered release.',
  media_urls: [],
  format: 'fixed_price',
  starts_at: '2026-09-21T12:00:00.000Z',
  ends_at: '2026-09-22T12:00:00.000Z',
  total_quantity: 50,
  per_buyer_limit: 1,
};

describe('DropCard', () => {
  it('keeps indexed status, countdown, quantity, and authoritative navigation visible', () => {
    render(<DropCard entry={entry} bucket="upcoming" />);

    expect(screen.getByRole('link', { name: 'View Limited signed print' })).toHaveAttribute(
      'href',
      '/marketplace/drop/owner-pubky/drop-1',
    );
    expect(screen.getByText('Upcoming')).toBeInTheDocument();
    expect(screen.getByText('Starts in 2 hours')).toBeInTheDocument();
    expect(screen.getByText('50 editions')).toBeInTheDocument();
    expect(screen.getByText('View drop')).toBeInTheDocument();
  });

  it('shows a known shop name and singular edition count', () => {
    render(<DropCard entry={{ ...entry, total_quantity: 1 }} bucket="ended" shopName="Example shop" />);
    expect(screen.getByText('Example shop')).toBeInTheDocument();
    expect(screen.getByText('1 edition')).toBeInTheDocument();
    expect(screen.getByText('End time passed')).toBeInTheDocument();
  });

  it('renders the live indexed state in the production list layout without a countdown', () => {
    render(<DropCard entry={entry} bucket="live" layout="list" />);

    expect(screen.getByTestId('card')).toHaveClass('flex-row');
    expect(screen.getByText('Start time passed')).toBeInTheDocument();
    expect(screen.queryByText('Starts in 2 hours')).not.toBeInTheDocument();
  });

  it('renders the owner fallback in secondary-foreground so 14px body text meets contrast on the card', () => {
    render(<DropCard entry={entry} bucket="live" />);

    const owner = screen.getByText('owner-pu…');
    expect(owner).toHaveClass('text-secondary-foreground');
    expect(owner).not.toHaveClass('text-muted-foreground');
  });
});
