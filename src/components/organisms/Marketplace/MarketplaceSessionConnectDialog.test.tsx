import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RING_COOKIE_CAPABILITIES } from '@/config/app';
import type { MarketplaceSessionConnectStatus } from '@/hooks/useMarketplaceSessionConnect/useMarketplaceSessionConnect.types';
import { BOOTSTRAP_APPROVAL_EXPIRED, MARKETPLACE_FAILURE_MESSAGES } from '@/libs/commerce/failure-messages';
import {
  MARKETPLACE_DISCLOSURE_INVENTORY,
  MARKETPLACE_DISCLOSURE_PRIVATE_DATA,
  MARKETPLACE_DISCLOSURE_RING_SIGN_IN,
  MARKETPLACE_SESSION_GRANT,
} from '@/services/marketplace/marketplace-session-grant';
import parityCapture from '@/test/fixtures/auth/marketplace-grant-priv-parity.staging.json';
import { GRANT_APPROVAL_SIGNER_HINT, MarketplaceSessionConnectDialog } from './MarketplaceSessionConnectDialog';

/**
 * Dialog states are driven entirely by the mocked hook: these tests pin WHAT
 * the dialog renders per status — in particular that the joined state (an
 * approval already in progress on another surface) shows honest copy and
 * suppresses the QR slot, Copy, and Open affordances.
 */
const view = vi.hoisted(() => ({
  status: 'joined' as MarketplaceSessionConnectStatus,
  authorizationUrl: '',
  errorMessage: null as string | null,
  isOpeningRing: false,
  requestsFullGrant: true,
  requestsGrantReconnect: false,
  requestsGrantBootstrap: false,
  requestsPassport: false,
  approvalSigner: 'Pubky Ring' as 'Bitkit' | 'Pubky Passport' | 'Pubky Ring' | 'Pubky Ring or Bitkit',
  passportRefused: false,
  isGrantSession: false,
  grantEnabled: false,
  cancel: vi.fn(),
  start: vi.fn(),
  startPassport: vi.fn(),
}));
vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>()),
  getMarketplaceGrantFlowEnabled: () => view.grantEnabled,
}));
vi.mock('@/hooks/useIsGrantSession/useIsGrantSession', () => ({
  useIsGrantSession: () => view.isGrantSession,
}));

vi.mock('@/hooks/useGrantSigner/useGrantSigner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useGrantSigner/useGrantSigner')>()),
  isPassportApprovalRefused: () => view.passportRefused,
}));

vi.mock('@/hooks/useMarketplaceApprovalSigner/useMarketplaceApprovalSigner', () => ({
  useMarketplaceApprovalSigner: () => view.approvalSigner,
}));

vi.mock('@/hooks/useMarketplaceSessionConnect/useMarketplaceSessionConnect', () => ({
  useMarketplaceSessionConnect: () => ({
    status: view.status,
    authorizationUrl: view.authorizationUrl,
    errorMessage: view.errorMessage,
    requestsFullGrant: view.requestsFullGrant,
    requestsGrantReconnect: view.requestsGrantReconnect,
    requestsGrantBootstrap: view.requestsGrantBootstrap,
    requestsPassport: view.requestsPassport,
    approvalSigner: view.approvalSigner,
    start: view.start,
    startPassport: view.startPassport,
    cancel: view.cancel,
    copyAuthUrl: vi.fn(async () => {}),
    openInRing: vi.fn(),
    isOpeningRing: view.isOpeningRing,
  }),
}));

// Render the dialog content inline (no portal, no trigger click): these tests
// assert the rendered states, not Radix wiring.
vi.mock('@/atoms/Dialog/Dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="dialog-content" className={className}>
      {children}
    </div>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('MarketplaceSessionConnectDialog', () => {
  beforeEach(() => {
    view.status = 'joined';
    view.authorizationUrl = '';
    view.errorMessage = null;
    view.isOpeningRing = false;
    view.requestsFullGrant = true;
    view.requestsGrantReconnect = false;
    view.requestsGrantBootstrap = false;
    view.requestsPassport = false;
    view.approvalSigner = 'Pubky Ring';
    view.passportRefused = false;
    view.isGrantSession = false;
    view.grantEnabled = false;
    view.cancel.mockClear();
    view.start.mockClear();
    view.startPassport.mockClear();
  });

  it('grant session sees refusal not classic qr (grant flow off)', () => {
    view.status = 'awaiting';
    view.authorizationUrl = 'pubkyauth:///?relay=https%3A%2F%2Frelay.example.com%2Finbox&secret=x';
    view.isGrantSession = true;

    render(<MarketplaceSessionConnectDialog autoOpen />);

    expect(screen.getByTestId('grant-session-refusal')).toBeInTheDocument();
    expect(screen.queryByLabelText('Copy authorization link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /authorize with pubky ring/i })).not.toBeInTheDocument();
    expect(view.start).not.toHaveBeenCalled();
  });

  it('grant session connect uses bootstrap (Bitkit copy, no refusal, flow starts)', () => {
    view.status = 'awaiting';
    view.authorizationUrl = 'pubkyauth://signin_grant?caps=%2Fpub%2Fpubky.app%2Fmarketplace-service%2Fv1%2F%3Arw';
    view.isGrantSession = true;
    view.grantEnabled = true;
    view.requestsGrantBootstrap = true;
    view.requestsFullGrant = false;
    view.approvalSigner = 'Bitkit';

    render(<MarketplaceSessionConnectDialog autoOpen />);

    expect(view.start).toHaveBeenCalled();
    expect(screen.queryByTestId('grant-session-refusal')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Enable purchases' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Approve with Bitkit to connect the marketplace for the identity signed in to Shop. Nothing is charged until you pay.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Authorize with Bitkit' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /authorize with pubky ring/i })).not.toBeInTheDocument();
    expect(screen.getByText('Waiting for approval in Bitkit…')).toBeInTheDocument();
    expect(screen.getByTestId('session-approval-disclosure')).toHaveTextContent(MARKETPLACE_DISCLOSURE_INVENTORY);
  });

  it('a Pubky Ring (cookie) sign-in gets a grant link either phone signer can approve, with no Ring-only copy', () => {
    view.status = 'awaiting';
    view.authorizationUrl = grantUrl(MARKETPLACE_SESSION_GRANT);
    view.grantEnabled = true;
    view.requestsGrantBootstrap = true;
    view.requestsFullGrant = false;
    view.approvalSigner = 'Pubky Ring or Bitkit';

    render(<MarketplaceSessionConnectDialog autoOpen />);

    expect(view.start).toHaveBeenCalled();
    expect(screen.getByRole('heading', { name: 'Enable purchases' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Approve with Pubky Ring or Bitkit, whichever holds the pubky signed in to Shop. Nothing is charged until you pay.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Authorize with Pubky Ring' })).toBeInTheDocument();
    expect(screen.getByText('Waiting for approval in Pubky Ring…')).toBeInTheDocument();
    expect(screen.queryByText(/Approve with Pubky Ring to connect/)).toBeNull();
    expect(screen.getByRole('radio', { name: 'Bitkit' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Authorize with Bitkit' })).not.toBeInTheDocument();
  });

  describe('Bitkit approval', () => {
    function bitkitSession() {
      view.status = 'awaiting';
      view.authorizationUrl = grantUrl(MARKETPLACE_SESSION_GRANT);
      view.isGrantSession = true;
      view.grantEnabled = true;
      view.requestsGrantBootstrap = true;
      view.requestsFullGrant = false;
      view.approvalSigner = 'Bitkit';
    }

    it('a Bitkit sign-in starts on the Bitkit tab and approves the same grant link', () => {
      bitkitSession();

      render(<MarketplaceSessionConnectDialog autoOpen />);

      expect(view.start).toHaveBeenCalledOnce();
      expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Bitkit' })).toBeChecked();
      expect(screen.getByRole('radio', { name: 'Pubky Ring' })).toBeDisabled();
      expect(screen.getByText('Use Bitkit to approve purchases for this sign-in.')).toBeInTheDocument();
      expect(screen.getByLabelText('Copy authorization link')).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Authorize with Bitkit' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Copy link' })).toBeEnabled();
      expect(screen.getByText('Waiting for approval in Bitkit…')).toBeInTheDocument();
      expect(screen.getByTestId('session-approval-disclosure')).toHaveTextContent(MARKETPLACE_DISCLOSURE_PRIVATE_DATA);
    });

    it('a Bitkit sign-in reconnecting an older purchase session approves in Bitkit too', () => {
      bitkitSession();
      view.requestsGrantBootstrap = false;
      view.requestsGrantReconnect = true;

      render(<MarketplaceSessionConnectDialog autoOpen />);

      expect(view.start).toHaveBeenCalledOnce();
      expect(
        screen.getByText(
          'Approve with Bitkit to reconnect the marketplace session for the identity already signed in to Shop. Nothing is charged until you pay.',
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Authorize with Bitkit' })).toBeEnabled();
      expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
    });

    it('a Ring sign-in can switch the approval app without restarting the grant link', () => {
      view.status = 'awaiting';
      view.authorizationUrl = grantUrl(MARKETPLACE_SESSION_GRANT);
      view.grantEnabled = true;
      view.requestsGrantBootstrap = true;
      view.requestsFullGrant = false;
      view.approvalSigner = 'Pubky Ring or Bitkit';

      render(<MarketplaceSessionConnectDialog autoOpen />);
      expect(screen.getByRole('radio', { name: 'Pubky Ring' })).toBeChecked();
      expect(screen.getByRole('radio', { name: 'Bitkit' })).toBeEnabled();
      view.cancel.mockClear();

      fireEvent.click(screen.getByRole('radio', { name: 'Bitkit' }));

      expect(screen.getByRole('radio', { name: 'Bitkit' })).toBeChecked();
      expect(screen.getByRole('button', { name: 'Authorize with Bitkit' })).toBeEnabled();
      expect(screen.getByLabelText('Copy authorization link')).toBeEnabled();
      expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
      expect(view.start).toHaveBeenCalledOnce();
      expect(view.cancel).not.toHaveBeenCalled();
    });

    it('does not offer Bitkit for the Pubky Ring connect link, which Bitkit cannot parse', () => {
      view.status = 'awaiting';
      view.authorizationUrl = 'pubkyauth:///?relay=https%3A%2F%2Frelay.example.com%2Finbox&secret=x';
      view.grantEnabled = false;

      render(<MarketplaceSessionConnectDialog autoOpen />);

      expect(screen.getByRole('radio', { name: 'Bitkit' })).toBeDisabled();
      expect(screen.getByText('Bitkit cannot approve this sign-in request. Use Pubky Ring.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Authorize with Pubky Ring' })).toBeEnabled();
    });
  });

  it.each([
    ['expired', 'expired', null],
    ['timed out', 'error', MARKETPLACE_FAILURE_MESSAGES.sessionTimeout],
    ['bootstrap expired', 'error', BOOTSTRAP_APPROVAL_EXPIRED],
  ] as const)('a %s grant approval names the signers that can approve it', (_label, status, errorMessage) => {
    view.status = status;
    view.errorMessage = errorMessage;
    view.grantEnabled = true;
    view.requestsGrantBootstrap = true;
    view.requestsFullGrant = false;
    view.approvalSigner = 'Pubky Ring or Bitkit';

    render(<MarketplaceSessionConnectDialog autoOpen />);

    expect(screen.getByTestId('grant-approval-signer-hint')).toHaveTextContent(GRANT_APPROVAL_SIGNER_HINT);
    expect(GRANT_APPROVAL_SIGNER_HINT).toBe(
      'Approve with the app that holds this pubky: Pubky Ring 2.0 or later, or Bitkit.',
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('no signer hint for a non-expiry failure, the Ring connect QR, or Pubky Passport', () => {
    view.status = 'error';
    view.errorMessage = 'Too many attempts. Wait a minute and try again.';
    view.grantEnabled = true;
    view.requestsGrantBootstrap = true;
    view.requestsFullGrant = false;
    view.approvalSigner = 'Pubky Ring or Bitkit';
    const { unmount } = render(<MarketplaceSessionConnectDialog autoOpen />);
    expect(screen.queryByTestId('grant-approval-signer-hint')).not.toBeInTheDocument();
    unmount();

    view.status = 'error';
    view.errorMessage = MARKETPLACE_FAILURE_MESSAGES.sessionTimeout;
    view.grantEnabled = false;
    view.requestsGrantBootstrap = false;
    view.approvalSigner = 'Pubky Ring';
    const ring = render(<MarketplaceSessionConnectDialog autoOpen />);
    expect(screen.queryByTestId('grant-approval-signer-hint')).not.toBeInTheDocument();
    ring.unmount();

    view.status = 'expired';
    view.grantEnabled = true;
    view.requestsGrantBootstrap = true;
    view.requestsPassport = true;
    view.approvalSigner = 'Pubky Passport';
    render(<MarketplaceSessionConnectDialog autoOpen />);
    expect(screen.queryByTestId('grant-approval-signer-hint')).not.toBeInTheDocument();
  });

  function grantUrl(caps: string): string {
    return `pubkyauth://signin_grant?caps=${encodeURIComponent(caps)}&relay=r&secret=s&cid=${parityCapture.parity_request.cid}&cpk=k`;
  }

  function expectOneDisclosure(sentence: string) {
    const disclosure = screen.getByTestId('session-approval-disclosure');
    expect(disclosure).toHaveTextContent(sentence);
    const content = screen.getByTestId('dialog-content').textContent ?? '';
    expect(content).not.toMatch(/\/pub\/|\/priv\/|:rw|marketplace-service|shop\.pubky\.app/);
    expect(content.split('private Shop data').length - 1).toBeLessThanOrEqual(1);
  }

  it('the Ring connect-marketplace QR discloses the private Shop data it hands over', () => {
    view.status = 'awaiting';
    view.authorizationUrl = `pubkyauth://signin?caps=${encodeURIComponent(MARKETPLACE_SESSION_GRANT)}&relay=r&secret=s`;
    view.requestsFullGrant = false;

    render(<MarketplaceSessionConnectDialog />);

    expect(screen.getByRole('heading', { name: 'Enable purchases' })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Authorize with your keychain to let the marketplace handle your purchases and marketplace data.',
      ),
    ).toBeInTheDocument();
    expectOneDisclosure(MARKETPLACE_DISCLOSURE_PRIVATE_DATA);
  });

  it('the grant reconnect QR discloses the private Shop data for either signer', () => {
    view.status = 'awaiting';
    view.authorizationUrl = grantUrl(parityCapture.parity_request.caps);
    view.requestsFullGrant = false;
    view.requestsGrantReconnect = true;
    view.grantEnabled = true;

    render(<MarketplaceSessionConnectDialog />);

    expectOneDisclosure(MARKETPLACE_DISCLOSURE_PRIVATE_DATA);
  });

  it('the bridged full Shop sign-in QR discloses the marketplace access and that Pubky App keeps working', () => {
    view.status = 'awaiting';
    view.authorizationUrl = `pubkyauth://signin?caps=${encodeURIComponent(RING_COOKIE_CAPABILITIES)}&relay=r&secret=s`;
    view.requestsFullGrant = true;

    render(<MarketplaceSessionConnectDialog />);

    expectOneDisclosure(MARKETPLACE_DISCLOSURE_RING_SIGN_IN);
  });

  it.each([
    ['previous inventory-only', parityCapture.previous_request.caps, MARKETPLACE_DISCLOSURE_INVENTORY],
    ['/priv parity', parityCapture.parity_request.caps, MARKETPLACE_DISCLOSURE_PRIVATE_DATA],
  ])('bootstrap QR for the captured %s grant discloses it in one sentence', (_label, caps, sentence) => {
    view.status = 'awaiting';
    view.authorizationUrl = grantUrl(caps);
    view.isGrantSession = true;
    view.grantEnabled = true;
    view.requestsGrantBootstrap = true;

    render(<MarketplaceSessionConnectDialog />);

    expectOneDisclosure(sentence);
  });

  it('a QR requesting anything else shows no disclosure', () => {
    view.status = 'awaiting';
    view.authorizationUrl = grantUrl('/:rw');
    view.requestsFullGrant = false;
    view.requestsGrantReconnect = true;
    view.grantEnabled = true;

    render(<MarketplaceSessionConnectDialog />);

    expect(screen.queryByTestId('session-approval-disclosure')).not.toBeInTheDocument();
  });

  it('bootstrap creating state confirms with the homeserver', () => {
    view.status = 'creating';
    view.isGrantSession = true;
    view.grantEnabled = true;
    view.requestsGrantBootstrap = true;

    render(<MarketplaceSessionConnectDialog />);

    expect(screen.getByText('Confirming with your homeserver…')).toBeInTheDocument();
  });

  it('a cookie session still starts the classic approval when opened', () => {
    view.status = 'awaiting';
    render(<MarketplaceSessionConnectDialog autoOpen />);

    expect(view.start).toHaveBeenCalled();
    expect(screen.queryByTestId('grant-session-refusal')).not.toBeInTheDocument();
  });

  it('joined state: honest copy, and no QR slot, Copy, or Open affordances', () => {
    render(<MarketplaceSessionConnectDialog />);

    expect(screen.getByText(/approval is already in progress on another surface/i)).toBeInTheDocument();
    // The QR slot button (its aria-label is the copy affordance) must not
    // render — there is no URL on this surface to scan, copy, or open.
    expect(screen.queryByLabelText('Copy authorization link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /authorize with pubky ring/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /copy link/i })).not.toBeInTheDocument();
  });

  it('awaiting state with a URL still renders the QR slot (contrast)', () => {
    view.status = 'awaiting';
    view.authorizationUrl = 'pubkyauth:///?relay=https%3A%2F%2Frelay.example.com%2Finbox&secret=x';

    render(<MarketplaceSessionConnectDialog />);

    expect(screen.getByLabelText('Copy authorization link')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /authorize with pubky ring/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy link/i })).toBeInTheDocument();
    expect(
      screen.getByText(
        'Authorize with your keychain to let the marketplace handle your purchases and marketplace data.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/permission list/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/compare it before approving/i)).not.toBeInTheDocument();
  });

  it('uses reconnect copy only when the hook selected grant reconnect', () => {
    view.requestsGrantReconnect = true;
    view.requestsFullGrant = false;
    render(<MarketplaceSessionConnectDialog />);

    expect(screen.getByRole('heading', { name: 'Enable purchases' })).toBeInTheDocument();
    expect(screen.getByText(/reconnect the marketplace session/i)).toBeInTheDocument();
  });

  describe('Pubky Passport sign-in', () => {
    beforeEach(() => {
      view.isGrantSession = true;
      view.grantEnabled = true;
      view.requestsPassport = true;
      view.approvalSigner = 'Pubky Passport';
      view.requestsGrantBootstrap = true;
      view.requestsFullGrant = false;
      view.status = 'idle';
    });

    it('asks for a click to open Passport, with Passport copy and no QR, copy link or deeplink', () => {
      render(<MarketplaceSessionConnectDialog autoOpen />);

      expect(view.start).toHaveBeenCalled();
      expect(view.startPassport).not.toHaveBeenCalled();
      expect(screen.getByRole('heading', { name: 'Enable purchases' })).toBeInTheDocument();
      expect(
        screen.getByText(
          'Approve with Pubky Passport to connect the marketplace for the identity signed in to Shop. Nothing is charged until you pay.',
        ),
      ).toBeInTheDocument();
      const approve = screen.getByRole('button', { name: 'Continue in Pubky Passport' });
      expect(approve).toBeEnabled();
      expect(screen.queryByLabelText('Copy authorization link')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /copy link/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /open in/i })).not.toBeInTheDocument();
      expect(screen.queryByText(/Bitkit/)).not.toBeInTheDocument();
      expect(screen.queryByTestId('grant-session-refusal')).not.toBeInTheDocument();

      fireEvent.click(approve);
      expect(view.startPassport).toHaveBeenCalledTimes(1);
    });

    it('waits for Passport with the button held and the disclosure for the requested grant', () => {
      view.status = 'awaiting';
      view.authorizationUrl = grantUrl(MARKETPLACE_SESSION_GRANT);

      render(<MarketplaceSessionConnectDialog autoOpen />);

      expect(screen.getByRole('button', { name: 'Continue in Pubky Passport' })).toBeDisabled();
      expect(screen.getByText('Waiting for approval in Pubky Passport…')).toBeInTheDocument();
      expect(screen.getByTestId('session-approval-disclosure')).toHaveTextContent(MARKETPLACE_DISCLOSURE_PRIVATE_DATA);
      expect(screen.queryByLabelText('Copy authorization link')).not.toBeInTheDocument();
    });

    it('confirms with the homeserver while the bootstrap is minted', () => {
      view.status = 'creating';

      render(<MarketplaceSessionConnectDialog autoOpen />);

      expect(screen.getByText('Confirming with your homeserver…')).toBeInTheDocument();
    });

    it('Try again re-arms and reopens Passport from the same click', () => {
      view.status = 'cancelled';

      render(<MarketplaceSessionConnectDialog autoOpen />);
      view.start.mockClear();
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));

      expect(view.start).toHaveBeenCalledTimes(1);
      expect(view.startPassport).toHaveBeenCalledTimes(1);
      expect(view.start.mock.invocationCallOrder[0]).toBeLessThan(view.startPassport.mock.invocationCallOrder[0]);
    });

    it('reconnect copy names Passport only', () => {
      view.requestsGrantBootstrap = false;
      view.requestsGrantReconnect = true;

      render(<MarketplaceSessionConnectDialog autoOpen />);

      expect(screen.getByRole('heading', { name: 'Enable purchases' })).toBeInTheDocument();
      expect(
        screen.getByText(
          'Approve with Pubky Passport to reconnect the marketplace session for the identity already signed in to Shop. Nothing is charged until you pay.',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/Bitkit or Pubky Ring/)).not.toBeInTheDocument();
    });
  });

  it('a Passport sign-in is refused, with no approval started, while Passport is switched off', () => {
    view.isGrantSession = true;
    view.grantEnabled = true;
    view.passportRefused = true;
    view.requestsPassport = false;
    view.requestsGrantBootstrap = true;
    view.requestsFullGrant = false;
    view.status = 'idle';

    render(<MarketplaceSessionConnectDialog autoOpen />);

    expect(screen.getByTestId('grant-session-refusal')).toBeInTheDocument();
    expect(view.start).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Continue in Pubky Passport' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Copy authorization link')).not.toBeInTheDocument();
  });
});
