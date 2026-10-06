import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnDropRow } from '@/hooks/useOwnDrops/useOwnDrops';
import { DropStudioHome } from './DropStudioHome';

const view = vi.hoisted(() => ({
  currentUserPubky: 'y'.repeat(52) as string | null,
  isDurable: true,
  isLoading: false,
  rows: [] as OwnDropRow[],
  refresh: vi.fn(async () => undefined),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/marketplace/sell/drops',
}));

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string | null }) => unknown) =>
    selector({ currentUserPubky: view.currentUserPubky }),
}));

vi.mock('@/hooks/useOwnDrops/useOwnDrops', () => ({
  useOwnDrops: () => ({
    isLoading: view.isLoading,
    isDurable: view.isDurable,
    rows: view.rows,
    refresh: view.refresh,
  }),
}));

vi.mock('@/hooks/useDropStudio/useDropStudio', () => ({
  useDropStudio: () => ({ isDurable: view.isDurable }),
}));

vi.mock('@/organisms/ContentLayout/ContentLayout', () => ({
  ContentLayout: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

vi.mock('@/organisms/Marketplace/DropStudioComposer', () => ({
  DropStudioComposer: () => <div data-testid="drop-composer" />,
}));

vi.mock('@/organisms/Marketplace/MarketplaceSessionConnectDialog', () => ({
  MarketplaceSessionConnectDialog: ({
    triggerLabel,
    onConnected,
  }: {
    triggerLabel?: string;
    onConnected?: () => void;
  }) => (
    <button type="button" onClick={() => void onConnected?.()}>
      {triggerLabel ?? 'Connect marketplace session'}
    </button>
  ),
}));

const liveRow: OwnDropRow = {
  dropId: 'drop-live',
  record: {
    dropId: 'drop-live',
    title: 'Winter capsule',
    startsAt: '2026-01-01T10:00:00.000Z',
    endsAt: '2026-01-02T10:00:00.000Z',
  } as OwnDropRow['record'],
  projection: { status: 'loaded', drop: { dropId: 'drop-live', state: 'live', revision: 3 } as never },
};

const draftRow: OwnDropRow = {
  dropId: 'drop-draft',
  record: {
    dropId: 'drop-draft',
    title: 'Spring preview',
    startsAt: '2025-12-20T10:00:00.000Z',
  } as OwnDropRow['record'],
  projection: { status: 'unregistered' },
};

describe('DropStudioHome', () => {
  beforeEach(() => {
    view.currentUserPubky = 'y'.repeat(52);
    view.isDurable = true;
    view.isLoading = false;
    view.rows = [liveRow, draftRow];
    view.refresh.mockClear();
  });

  it('keeps New drop above the drop list and does not double a status card', () => {
    render(<DropStudioHome />);

    const newDropLink = screen.getByRole('link', { name: 'New drop' });
    expect(newDropLink).toHaveAttribute('href', '#new-drop');
    expect(newDropLink.compareDocumentPosition(screen.getByRole('heading', { name: 'Your drops' }))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.getByRole('heading', { name: 'New drop' })).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.queryByText('Status unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText('Status unavailable — retry.')).not.toBeInTheDocument();
  });

  it('routes a missing marketplace session to the seller bootstrap, not unavailable', () => {
    view.rows = [{ ...liveRow, projection: { status: 'session-unavailable' } }, draftRow];
    render(<DropStudioHome />);

    expect(screen.getByText('Connect a marketplace session to read drop status.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Connect marketplace session' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByText('Status unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText('Approve purchases in Pubky Ring')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New drop' })).toBeInTheDocument();
  });

  it('shows one retry line for a transient read failure and Retry refetches', async () => {
    const user = userEvent.setup();
    view.rows = [{ ...liveRow, projection: { status: 'unavailable' } }, draftRow];
    render(<DropStudioHome />);

    expect(screen.getByText("Could not read this drop's status.")).toBeInTheDocument();
    expect(screen.getAllByText("Could not read this drop's status.")).toHaveLength(1);
    expect(screen.queryByText('Status unavailable')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New drop' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(view.refresh).toHaveBeenCalledTimes(1);
  });

  it('reconnects then refetches after the seller session is approved', async () => {
    const user = userEvent.setup();
    view.rows = [{ ...liveRow, projection: { status: 'session-unavailable' } }];
    render(<DropStudioHome />);

    await user.click(screen.getByRole('button', { name: 'Connect marketplace session' }));
    expect(view.refresh).toHaveBeenCalledTimes(1);
  });
});
