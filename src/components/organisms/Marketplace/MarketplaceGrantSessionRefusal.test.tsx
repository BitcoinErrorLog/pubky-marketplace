import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MarketplaceInventoryGrantDialog } from './MarketplaceInventoryGrantDialog';
import { MarketplaceMessagingEnablePanel } from './MarketplaceMessagingEnableDialog';

const state = vi.hoisted(() => ({
  isGrantSession: true,
  grantSigner: 'bitkit' as 'bitkit' | 'passport',
  inventoryStart: vi.fn(),
  messagingStart: vi.fn(),
}));

vi.mock('@/hooks/useIsGrantSession/useIsGrantSession', () => ({
  useIsGrantSession: () => state.isGrantSession,
}));

vi.mock('@/hooks/useGrantSigner/useGrantSigner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useGrantSigner/useGrantSigner')>()),
  useGrantSigner: () => (state.isGrantSession ? state.grantSigner : null),
}));

vi.mock('@/hooks/useMarketplaceInventoryGrantConnect/useMarketplaceInventoryGrantConnect', () => ({
  useMarketplaceInventoryGrantConnect: () => ({
    status: 'awaiting',
    authorizationUrl: 'pubkyauth:///?relay=https%3A%2F%2Frelay.example.com%2Finbox&secret=x',
    errorMessage: null,
    start: state.inventoryStart,
    cancel: vi.fn(),
    copyAuthUrl: vi.fn(async () => {}),
    openInSigner: vi.fn(),
    isOpeningSigner: false,
  }),
}));

vi.mock('@/hooks/useMarketplaceMessagingEnable/useMarketplaceMessagingEnable', () => ({
  useMarketplaceMessagingEnable: () => ({
    status: 'awaiting',
    authorizationUrl: 'pubkyauth:///?relay=https%3A%2F%2Frelay.example.com%2Finbox&secret=y',
    errorMessage: null,
    start: state.messagingStart,
    cancel: vi.fn(),
    copyAuthUrl: vi.fn(async () => {}),
    openInRing: vi.fn(),
    isOpeningRing: false,
  }),
}));

vi.mock('./MarketplaceSessionConnectDialog', () => ({
  MarketplaceSessionConnectDialog: ({ triggerLabel }: { triggerLabel?: string }) => (
    <div data-testid="purchase-session-connect">{triggerLabel}</div>
  ),
}));

vi.mock('@/atoms/Dialog/Dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('classic Pubky Ring approvals and a grant session', () => {
  beforeEach(() => {
    state.isGrantSession = true;
    state.grantSigner = 'bitkit';
    state.inventoryStart.mockClear();
    state.messagingStart.mockClear();
  });

  it('grant session re-approves its purchase session instead of a Ring-only inventory grant', () => {
    render(<MarketplaceInventoryGrantDialog autoOpen />);

    expect(screen.getByTestId('purchase-session-connect')).toHaveTextContent('Approve in your Pubky signer');
    expect(screen.queryByTestId('grant-session-refusal')).not.toBeInTheDocument();
    expect(screen.queryByText(/Pubky Ring sign-in/)).not.toBeInTheDocument();
    expect(state.inventoryStart).not.toHaveBeenCalled();
  });

  it('inventory copy names Ring only', () => {
    state.isGrantSession = false;
    render(<MarketplaceInventoryGrantDialog autoOpen />);

    expect(
      screen.getByText('Approve this grant in Pubky Ring; it does not replace your purchase session.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Bitkit/)).not.toBeInTheDocument();
    expect(state.inventoryStart).toHaveBeenCalled();
  });

  it('grant session sees messaging refusal without qr', () => {
    render(<MarketplaceMessagingEnablePanel reconnect={false} />);

    expect(screen.getByTestId('grant-session-refusal')).toHaveTextContent(
      'Messages are not available for Bitkit sign-ins yet. Everything else in Shop works with this sign-in.',
    );
    expect(screen.queryByText(/Approve in your Pubky signer/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('qr-auth-url')).not.toBeInTheDocument();
    expect(state.messagingStart).not.toHaveBeenCalled();
  });

  it('a Pubky Passport sign-in reads that messages are not available yet, without being sent to Ring', () => {
    state.grantSigner = 'passport';
    render(<MarketplaceMessagingEnablePanel reconnect={false} />);

    const refusal = screen.getByTestId('grant-session-refusal');
    expect(refusal).toHaveTextContent(
      'Messages are not available for Pubky Passport sign-ins yet. Everything else in Shop works with this sign-in.',
    );
    expect(refusal).not.toHaveTextContent(/Pubky Ring/);
    expect(state.messagingStart).not.toHaveBeenCalled();
  });

  it('cookie session keeps messaging resume path (the paykit-wasm flow still starts)', () => {
    state.isGrantSession = false;
    render(<MarketplaceMessagingEnablePanel reconnect={false} />);

    expect(screen.queryByTestId('grant-session-refusal')).not.toBeInTheDocument();
    expect(state.messagingStart).toHaveBeenCalled();
  });
});
