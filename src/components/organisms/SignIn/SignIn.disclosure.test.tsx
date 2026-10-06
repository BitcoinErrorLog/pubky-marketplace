import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RING_COOKIE_CAPABILITIES } from '@/config/app';
import { MARKETPLACE_DISCLOSURE_RING_SIGN_IN } from '@/services/marketplace/marketplace-session-grant';
import grantCapture from '@/test/fixtures/auth/marketplace-grant-priv-parity.staging.json';
import ringCapture from '@/test/fixtures/auth/ring-signin-url.sdk-0.8.0.json';
import { SignInContent } from './SignIn';

type Shape = { scheme: string; host: string; params: string[]; caps: string };

function urlFrom(shape: Shape): string {
  return `${shape.scheme}//${shape.host}?${shape.params
    .map((name) => `${name}=${encodeURIComponent(name === 'caps' ? shape.caps : 'x')}`)
    .join('&')}`;
}

const RING_SIGN_IN_URL = urlFrom({ ...ringCapture, caps: RING_COOKIE_CAPABILITIES });
const BITKIT_SIGN_IN_URL = urlFrom(grantCapture.shop_signin_request);

const view = vi.hoisted(() => ({
  singleApproval: true,
  mode: 'transaction-service' as string,
  grantSignIn: false,
}));

vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>()),
  getSingleApprovalSignIn: () => view.singleApproval,
  getCommerceAdapterMode: () => view.mode,
}));

vi.mock('@/hooks/useGrantSignInAvailable/useGrantSignInAvailable', () => ({
  useGrantSignInAvailable: () => view.grantSignIn,
}));

vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ alt }: { alt: string }) => <img alt={alt} />,
}));

vi.mock('@/hooks/useMobileAuth/useMobileAuth', () => ({
  useMobileAuth: (options?: { type?: 'grant' }) => ({
    url: options?.type === 'grant' ? BITKIT_SIGN_IN_URL : RING_SIGN_IN_URL,
    isLoading: false,
    isExpired: false,
    fetchUrl: vi.fn(),
    copyAuthUrl: vi.fn(),
    isOpeningRing: false,
    onAuthorizeClick: vi.fn(),
  }),
}));

describe('Ring sign-in marketplace disclosure', () => {
  beforeEach(() => {
    view.singleApproval = true;
    view.mode = 'transaction-service';
    view.grantSignIn = false;
  });

  it('shows the sign-in sentence beside the Ring-only desktop QR and the mobile deeplink', () => {
    render(<SignInContent />);

    const disclosures = screen.getAllByTestId('session-approval-disclosure');
    expect(disclosures).toHaveLength(2);
    for (const disclosure of disclosures) expect(disclosure).toHaveTextContent(MARKETPLACE_DISCLOSURE_RING_SIGN_IN);
    expect(screen.getByLabelText('Copy authentication link').parentElement).toContainElement(disclosures[0]);
    expect(screen.getByTestId('button').parentElement).toContainElement(disclosures[1]);
  });

  it('shows it under Ring, never under Bitkit, in the side-by-side layouts', () => {
    view.grantSignIn = true;
    render(<SignInContent />);

    expect(
      within(screen.getByTestId('sign-in-ring-option')).getByTestId('session-approval-disclosure'),
    ).toHaveTextContent(MARKETPLACE_DISCLOSURE_RING_SIGN_IN);
    expect(within(screen.getByTestId('sign-in-bitkit-option')).queryByTestId('session-approval-disclosure')).toBeNull();
    const mobileRing = screen.getByTestId('button');
    expect(mobileRing.nextElementSibling).toHaveAttribute('data-testid', 'session-approval-disclosure');
    expect(screen.getByTestId('sign-in-grant-button').nextElementSibling).not.toHaveAttribute(
      'data-testid',
      'session-approval-disclosure',
    );
    expect(screen.getAllByTestId('session-approval-disclosure')).toHaveLength(2);
  });

  it.each([
    ['single approval off', false, 'transaction-service'],
    ['no durable commerce backend', true, 'unavailable'],
    ['sandbox commerce', true, 'sandbox'],
  ])('shows nothing when the sign-in token reaches no marketplace (%s)', (_label, singleApproval, mode) => {
    view.singleApproval = singleApproval;
    view.mode = mode;
    render(<SignInContent />);
    expect(screen.queryByTestId('session-approval-disclosure')).toBeNull();
  });

  it('never prints the capability string', () => {
    view.grantSignIn = true;
    render(<SignInContent />);
    expect(document.body.textContent).not.toContain(RING_COOKIE_CAPABILITIES);
    expect(document.body.textContent).not.toMatch(/\/priv\/|\/pub\/|:rw/);
  });
});
