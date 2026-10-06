import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RequiredToPublishSummary } from './RequiredToPublishSummary';

describe('RequiredToPublishSummary', () => {
  it('focuses the selected required field', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(<RequiredToPublishSummary items={[{ id: 'title', label: 'Title', onSelect }]} />);

    await user.click(screen.getByRole('link', { name: 'Title' }));

    expect(onSelect).toHaveBeenCalledOnce();
  });

  it('renders the completion message without required links', () => {
    render(<RequiredToPublishSummary items={[]} emptyMessage="Everything is ready." isComplete />);

    expect(screen.getByText('Everything is ready.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
