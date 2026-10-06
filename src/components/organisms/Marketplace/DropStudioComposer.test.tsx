import { zodResolver } from '@hookform/resolvers/zod';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { describe, expect, it, vi } from 'vitest';
import { type DropStudioData, dropStudioDefaults, dropStudioSchema } from '@/hooks/useDropStudio/useDropStudio.types';
import { DropStudioComposer } from './DropStudioComposer';

vi.mock('./DropStudioPreviewCard', () => ({
  DropStudioPreviewCard: () => <div data-testid="drop-preview" />,
}));

function Harness({ valid, withEnd = false }: { valid: boolean; withEnd?: boolean }) {
  const form = useForm<DropStudioData>({
    defaultValues: valid
      ? {
          ...dropStudioDefaults,
          title: 'Winter capsule',
          listingIds: ['item1'],
          startsAtLocal: '2026-09-20T10:00',
          endsAtLocal: withEnd ? '2026-09-21T10:00' : '',
          totalQuantity: '10',
        }
      : {
          ...dropStudioDefaults,
          listingIds: ['item1'],
          startsAtLocal: '2026-09-20T10:00',
          totalQuantity: '0',
        },
    mode: 'onBlur',
    resolver: zodResolver(dropStudioSchema),
  });
  const publish = async () => {
    await form.handleSubmit(
      () => undefined,
      () => undefined,
    )();
  };
  return (
    <DropStudioComposer
      studio={{
        form,
        listings: [
          {
            listing_id: 'item1',
            record: {
              title: 'Numbered print',
              media: [],
              sale: { format: 'fixed_price', unitPrice: { amountMinor: 100, currency: 'USD', exponent: 2 } },
            },
          } as never,
        ],
        catalog: 'loaded',
        retryCatalog: () => undefined,
        isDurable: true,
        registration: { item1: 'registered' },
        registerListing: async () => undefined,
        publishStatus: { record: 'idle', sync: 'idle' },
        publishErrors: [],
        publishedDropId: null,
        publish,
        retrySync: async () => undefined,
      }}
    />
  );
}

describe('DropStudioComposer publish guidance', () => {
  it('renders the optional end empty by default', () => {
    render(<Harness valid />);

    expect(screen.getByLabelText('End (optional — empty runs until sell-out or cancel)')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });

  it('clears an explicit end time', async () => {
    const user = userEvent.setup();
    render(<Harness valid withEnd />);

    expect(screen.getByLabelText('End (optional — empty runs until sell-out or cancel)')).toHaveValue(
      '2026-09-21T10:00',
    );
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(screen.getByLabelText('End (optional — empty runs until sell-out or cancel)')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });

  it('scrolls and focuses the first invalid field and links the outstanding fields', async () => {
    const user = userEvent.setup();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    render(<Harness valid={false} />);

    await user.click(screen.getByRole('button', { name: 'Publish drop' }));

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(document.activeElement).toHaveAttribute('id', 'title');
    expect(screen.getByText('Required to publish')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Drop title' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Total quantity' })).toBeInTheDocument();
  });

  it('shows no required summary for a valid form', async () => {
    const user = userEvent.setup();
    render(<Harness valid />);

    await user.click(screen.getByRole('button', { name: 'Publish drop' }));

    expect(screen.queryByText('Required to publish')).not.toBeInTheDocument();
  });
});
