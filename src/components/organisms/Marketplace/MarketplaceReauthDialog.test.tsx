import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPABILITIES, RING_COOKIE_CAPABILITIES } from '@/config/app';
import type { UseStepUpReauthReturn } from '@/hooks/useStepUpReauth/useStepUpReauth.types';
import { MARKETPLACE_DISCLOSURE_RING_SIGN_IN } from '@/services/marketplace/marketplace-session-grant';
import ringCapture from '@/test/fixtures/auth/ring-signin-url.sdk-0.8.0.json';
import { MarketplaceReauthDialog } from './MarketplaceReauthDialog';

const reauth: UseStepUpReauthReturn = {
  status: 'idle',
  authorizationUrl: '',
  errorMessage: null,
  start: vi.fn(),
  cancel: vi.fn(),
  copyAuthUrl: vi.fn(),
  openInRing: vi.fn(),
  isOpeningRing: false,
};

vi.mock('@/hooks/useStepUpReauth/useStepUpReauth', () => ({
  useStepUpReauth: () => reauth,
}));

const signIn = vi.hoisted(() => ({ isGrantSession: false }));
vi.mock('@/hooks/useIsGrantSession/useIsGrantSession', () => ({
  useIsGrantSession: () => signIn.isGrantSession,
}));

const config = vi.hoisted(() => ({ singleApproval: true, mode: 'transaction-service' as string }));
vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>()),
  getMarketplaceGrantFlowEnabled: () => true,
  getSingleApprovalSignIn: () => config.singleApproval,
  getCommerceAdapterMode: () => config.mode,
}));

const RING_STEP_UP_URL = `${ringCapture.scheme}//${ringCapture.host}?${ringCapture.params
  .map((name) => `${name}=${encodeURIComponent(name === 'caps' ? RING_COOKIE_CAPABILITIES : 'x')}`)
  .join('&')}`;

const RECONNECT_URL =
  'pubkyauth://signin_grant?caps=%2Fpub%2Fpubky.app%2Fmarketplace-service%2Fv1%2F%3Arw%2C%2Fpriv%2Fpubky.app%2F%3Arw&relay=r&secret=s&cid=marketplace.staging.shop.pubky.app&cpk=k';

const connect = vi.hoisted(() => ({
  start: vi.fn(),
  bootstrap: false,
  approvalSigner: 'Bitkit' as 'Bitkit' | 'Pubky Ring or Bitkit',
}));
vi.mock('@/hooks/useMarketplaceSessionConnect/useMarketplaceSessionConnect', () => ({
  useMarketplaceSessionConnect: () => ({
    status: 'awaiting',
    authorizationUrl: RECONNECT_URL,
    errorMessage: null,
    requestsFullGrant: false,
    requestsGrantReconnect: !connect.bootstrap,
    requestsGrantBootstrap: connect.bootstrap,
    approvalSigner: connect.approvalSigner,
    start: connect.start,
    cancel: vi.fn(),
    copyAuthUrl: vi.fn(async () => {}),
    openInRing: vi.fn(),
    isOpeningRing: false,
  }),
}));

describe('MarketplaceReauthDialog', () => {
  beforeEach(() => {
    vi.mocked(reauth.start).mockClear();
    connect.start.mockClear();
    connect.bootstrap = false;
    connect.approvalSigner = 'Bitkit';
    signIn.isGrantSession = false;
    config.singleApproval = true;
    config.mode = 'transaction-service';
    reauth.status = 'idle';
    reauth.authorizationUrl = '';
  });

  it('the Ring step-up QR discloses the marketplace access its single approval also grants', async () => {
    reauth.status = 'awaiting';
    reauth.authorizationUrl = RING_STEP_UP_URL;
    render(<MarketplaceReauthDialog refusal="homeserver" triggerLabel="Sign in again" />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in again' }));

    expect(screen.getByTestId('session-approval-disclosure')).toHaveTextContent(MARKETPLACE_DISCLOSURE_RING_SIGN_IN);
    expect(screen.queryByText(RING_COOKIE_CAPABILITIES)).not.toBeInTheDocument();
  });

  it.each([
    ['single approval is off', false, 'transaction-service'],
    ['no durable commerce backend', true, 'unavailable'],
  ])('the Ring step-up QR makes no marketplace claim when %s', async (_label, singleApproval, mode) => {
    config.singleApproval = singleApproval;
    config.mode = mode;
    reauth.status = 'awaiting';
    reauth.authorizationUrl = RING_STEP_UP_URL;
    render(<MarketplaceReauthDialog refusal="homeserver" triggerLabel="Sign in again" />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in again' }));

    expect(screen.queryByTestId('session-approval-disclosure')).not.toBeInTheDocument();
  });

  it('opening starts a fresh step-up flow and shows its QR', async () => {
    render(<MarketplaceReauthDialog refusal="homeserver" triggerLabel="Sign in again" />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in again' }));

    expect(reauth.start).toHaveBeenCalledOnce();
    expect(screen.getByLabelText('Copy authorization link')).toBeInTheDocument();
    expect(screen.queryByTestId('grant-session-refusal')).not.toBeInTheDocument();
  });

  it('asks for a sign-in in product language and does not print capability paths', async () => {
    render(<MarketplaceReauthDialog refusal="homeserver" triggerLabel="Sign in again" />);

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign in again' }));

    expect(screen.getByRole('heading', { name: 'Sign in again' })).toBeInTheDocument();
    expect(screen.getByText('Sign in again for this device.')).toBeInTheDocument();
    expect(screen.queryByText(CAPABILITIES)).not.toBeInTheDocument();
    expect(screen.queryByText(/compare it before approving/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/permission list/i)).not.toBeInTheDocument();
  });

  it.each([false, true])('blocks unsupported Bitkit re-approval (bootstrap: %s)', async (bootstrap) => {
    signIn.isGrantSession = true;
    connect.bootstrap = bootstrap;
    render(<MarketplaceReauthDialog refusal="homeserver" triggerLabel="Sign in again" />);
    await userEvent.click(screen.getByRole('button', { name: 'Sign in again' }));
    expect(reauth.start).not.toHaveBeenCalled();
    expect(connect.start).not.toHaveBeenCalled();
    expect(screen.getByText('Support for Bitkit is coming soon.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Copy authorization link')).not.toBeInTheDocument();
  });

  it.each([
    ['a Pubky Ring sign-in', false],
    ['a Bitkit sign-in', true],
  ])(
    'sends %s refused the private data key to the marketplace approval, never the homeserver step-up',
    async (_label, isGrantSession) => {
      signIn.isGrantSession = isGrantSession;
      render(<MarketplaceReauthDialog refusal="purchase_session" triggerLabel="Approve private sync" />);

      await userEvent.setup().click(screen.getByRole('button', { name: 'Approve private sync' }));

      expect(reauth.start).not.toHaveBeenCalled();
      if (isGrantSession) {
        expect(connect.start).not.toHaveBeenCalled();
        expect(screen.getByText('Support for Bitkit is coming soon.')).toBeInTheDocument();
      } else {
        expect(connect.start).toHaveBeenCalledOnce();
        expect(screen.getByTestId('session-approval-disclosure')).toHaveTextContent(
          'Authorize with your keychain to let the marketplace handle your purchases and marketplace data.',
        );
      }
    },
  );
});
