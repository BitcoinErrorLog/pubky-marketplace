import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceRecoveryKey } from './MarketplaceRecoveryKey';

const hook = vi.hoisted(() => ({
  isAvailable: true,
  status: 'idle' as string,
  exportKey: vi.fn(async () => true),
}));

vi.mock('@/hooks/useExportPrivRecoveryKey/useExportPrivRecoveryKey', () => ({
  useExportPrivRecoveryKey: () => hook,
}));

describe('MarketplaceRecoveryKey', () => {
  beforeEach(() => {
    hook.isAvailable = true;
    hook.status = 'idle';
    hook.exportKey.mockClear();
  });

  it('asks for confirmation before downloading the recovery key', async () => {
    render(<MarketplaceRecoveryKey />);

    expect(screen.getByText('Marketplace data')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Export recovery key' }));
    expect(hook.exportKey).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        'Anyone who has this file can read your encrypted watchlist and order receipts. Keep it offline and never share it.',
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Download recovery key' }));
    await waitFor(() => expect(hook.exportKey).toHaveBeenCalledOnce());
  });

  it('cancels without exporting', () => {
    render(<MarketplaceRecoveryKey />);
    fireEvent.click(screen.getByRole('button', { name: 'Export recovery key' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(hook.exportKey).not.toHaveBeenCalled();
  });

  it.each([
    ['exported', 'Recovery key downloaded. Store it offline, away from this device.'],
    [
      'needs_reauth',
      'The marketplace releases your recovery key only to a purchase session that includes your private Shop data. Approve one, then export again.',
    ],
    ['unavailable', 'The marketplace cannot provide your recovery key right now. Try again later.'],
    ['error', 'The recovery key could not be exported. Try again.'],
  ])('explains the %s state', (status, copy) => {
    hook.status = status;
    render(<MarketplaceRecoveryKey />);
    expect(screen.getByTestId('export-recovery-key-status')).toHaveTextContent(copy);
    expect(screen.queryByRole('button', { name: 'Approve private data' }) !== null).toBe(status === 'needs_reauth');
  });

  it('renders nothing where the marketplace holds no data keys', () => {
    hook.isAvailable = false;
    const { container } = render(<MarketplaceRecoveryKey />);
    expect(container).toBeEmptyDOMElement();
  });
});
