import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPABILITIES } from '@/config/app';
import { resetRuntimeConfigForTests } from '@/libs/runtime-config/runtime-config';
import { beginMarketplaceBootstrapFlow } from '@/services/marketplace/marketplace-bootstrap-client';
import { beginMarketplaceGrantFlow } from '@/services/marketplace/marketplace-grant-client';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import { MARKETPLACE_DISCLOSURE_PRIVATE_DATA } from '@/services/marketplace/marketplace-session-grant';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import parityCapture from '@/test/fixtures/auth/marketplace-grant-priv-parity.staging.json';
import { asOpaque } from '@/test-utils/type-assertions';
import { MarketplaceReauthDialog } from './MarketplaceReauthDialog';
import { MarketplaceSessionRequiredCard } from './MarketplaceSessionRequiredCard';

/**
 * Bitkit approval routing through the real hooks: only the BFF network
 * clients and the Ring step-up hook are stubbed. The auth store (a
 * grant-backed Bitkit sign-in), the purchase session service, the commerce
 * store and the session-connect hook are real. The re-approval dialog is
 * mounted directly; `MarketplaceWatchlist.keyRelease.journey.test.tsx`
 * proves the key-release producer opens it.
 */
vi.mock('@/services/marketplace/marketplace-grant-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/marketplace/marketplace-grant-client')>()),
  beginMarketplaceGrantFlow: vi.fn(),
}));
vi.mock('@/services/marketplace/marketplace-bootstrap-client', () => ({
  beginMarketplaceBootstrapFlow: vi.fn(),
}));
const ringStepUp = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock('@/hooks/useStepUpReauth/useStepUpReauth', () => ({
  useStepUpReauth: () => ({
    status: 'awaiting',
    authorizationUrl: 'pubkyauth://signin?caps=x&relay=r&secret=s',
    errorMessage: null,
    start: ringStepUp.start,
    cancel: vi.fn(),
    copyAuthUrl: vi.fn(),
    openInRing: vi.fn(),
    isOpeningRing: false,
  }),
}));

const PUBKY = 'y'.repeat(52);
const CURRENT_TOKEN = 'W'.repeat(43);
const CLAIMED_TOKEN = 'C'.repeat(43);
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const SERVICE_CID = 'marketplace.staging.shop.pubky.app';

function grantUrl(caps: string): string {
  return `pubkyauth://signin_grant?caps=${encodeURIComponent(caps)}&relay=r&secret=s&cid=${SERVICE_CID}&cpk=k`;
}

function deferredGrantFlow(url: string) {
  let resolve!: (result: {
    status: 'connected';
    token: string;
    pubky: string;
    capabilities: string;
    expires_at: string;
  }) => void;
  const pending = new Promise<Parameters<typeof resolve>[0]>((done) => {
    resolve = done;
  });
  return {
    flow: { authorizationUrl: url, awaitResult: vi.fn(() => pending), cancel: vi.fn().mockResolvedValue(undefined) },
    resolve,
  };
}

function signIn(kind: 'bitkit' | 'ring') {
  useAuthStore.setState({
    currentUserPubky: asOpaque(PUBKY),
    session: asOpaque({
      ...(kind === 'bitkit' ? { grant: {} } : {}),
      info: { publicKey: { z32: () => PUBKY }, capabilities: CAPABILITIES.split(',') },
    }),
  });
}

function seedPurchaseSession(capabilities: string) {
  const session = MarketplaceSessionService.establishClaimedGrantSession(
    { token: CURRENT_TOKEN, pubky: PUBKY, capabilities, expiresAt: FUTURE },
    PUBKY,
  );
  useCommerceStore.getState().setMarketplaceSession(session);
}

describe('#49 Bitkit approval journeys (real hooks)', () => {
  beforeEach(() => {
    process.env.PUBKY_RUNTIME_MARKETPLACE_GRANT_FLOW_ENABLED = 'true';
    resetRuntimeConfigForTests();
    vi.mocked(beginMarketplaceGrantFlow).mockReset();
    vi.mocked(beginMarketplaceBootstrapFlow).mockReset();
    ringStepUp.start.mockReset();
    MarketplaceSessionService.clearSession();
    useCommerceStore.getState().setMarketplaceSession(null);
  });

  afterEach(() => {
    delete process.env.PUBKY_RUNTIME_MARKETPLACE_GRANT_FLOW_ENABLED;
    resetRuntimeConfigForTests();
    MarketplaceSessionService.clearSession();
    useCommerceStore.getState().setMarketplaceSession(null);
    useAuthStore.setState({ currentUserPubky: null, session: null });
  });

  it('a Bitkit buyer with no purchase session approves purchases in Bitkit', async () => {
    signIn('bitkit');
    const bootstrap = deferredGrantFlow(grantUrl(parityCapture.parity_request.caps));
    vi.mocked(beginMarketplaceBootstrapFlow).mockResolvedValue(bootstrap.flow);
    const user = userEvent.setup();

    render(<MarketplaceSessionRequiredCard />);
    expect(screen.getByRole('heading', { name: 'Approve purchases in Bitkit' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve in Bitkit' }));

    await waitFor(() => expect(beginMarketplaceBootstrapFlow).toHaveBeenCalledWith({ pubky: PUBKY }));
    expect(await screen.findByRole('button', { name: 'Open in Bitkit' })).toBeEnabled();
    expect(screen.getByTestId('session-approval-disclosure')).toHaveTextContent(MARKETPLACE_DISCLOSURE_PRIVATE_DATA);
    expect(screen.queryByRole('button', { name: /open in pubky ring/i })).not.toBeInTheDocument();

    bootstrap.resolve({
      status: 'connected',
      token: CLAIMED_TOKEN,
      pubky: PUBKY,
      capabilities: parityCapture.parity_request.homeserver_verified,
      expires_at: FUTURE,
    });
    await waitFor(() =>
      expect(useCommerceStore.getState().marketplaceSession?.capabilities).toBe(
        parityCapture.parity_request.homeserver_verified,
      ),
    );
    expect(MarketplaceSessionService.getActiveSession()?.token).toBe(CLAIMED_TOKEN);
  });

  it('a Bitkit sign-in whose purchase session predates /priv re-approves in Bitkit or Ring', async () => {
    signIn('bitkit');
    seedPurchaseSession(parityCapture.previous_request.homeserver_verified);
    const reconnect = deferredGrantFlow(grantUrl(parityCapture.parity_request.caps));
    vi.mocked(beginMarketplaceGrantFlow).mockResolvedValue(reconnect.flow);
    const onReauthenticated = vi.fn();
    const user = userEvent.setup();

    render(
      <MarketplaceReauthDialog
        refusal="homeserver"
        triggerLabel="Sign in again"
        onReauthenticated={onReauthenticated}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Sign in again' }));

    await waitFor(() => expect(beginMarketplaceGrantFlow).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'Open in signer' })).toBeEnabled();
    expect(screen.getByTestId('session-approval-disclosure')).toHaveTextContent(MARKETPLACE_DISCLOSURE_PRIVATE_DATA);
    expect(ringStepUp.start).not.toHaveBeenCalled();

    reconnect.resolve({
      status: 'connected',
      token: CLAIMED_TOKEN,
      pubky: PUBKY,
      capabilities: parityCapture.parity_request.homeserver_verified,
      expires_at: FUTURE,
    });
    await waitFor(() => expect(onReauthenticated).toHaveBeenCalledTimes(1));
    expect(MarketplaceSessionService.getActiveSession()?.token).toBe(CLAIMED_TOKEN);
    expect(useCommerceStore.getState().marketplaceSession?.capabilities).toBe(
      parityCapture.parity_request.homeserver_verified,
    );
  });

  it.each([
    ['is inventory-only', parityCapture.previous_request.homeserver_verified],
    ['is missing', null],
  ])(
    'a Ring sign-in whose purchase session %s gets the Ring step-up, the only fix for a homeserver refusal',
    async (_label, capabilities) => {
      signIn('ring');
      if (capabilities !== null) seedPurchaseSession(capabilities);
      const user = userEvent.setup();

      render(<MarketplaceReauthDialog refusal="homeserver" triggerLabel="Sign in again" />);
      await user.click(screen.getByRole('button', { name: 'Sign in again' }));

      await waitFor(() => expect(ringStepUp.start).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('button', { name: 'Open in Pubky Ring' })).toBeInTheDocument();
      expect(beginMarketplaceGrantFlow).not.toHaveBeenCalled();
    },
  );

  it('a Ring sign-in whose purchase session already covers /priv gets the homeserver step-up', async () => {
    signIn('ring');
    seedPurchaseSession(parityCapture.parity_request.homeserver_verified);
    const user = userEvent.setup();

    render(<MarketplaceReauthDialog refusal="homeserver" triggerLabel="Sign in again" />);
    await user.click(screen.getByRole('button', { name: 'Sign in again' }));

    await waitFor(() => expect(ringStepUp.start).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Open in Pubky Ring' })).toBeInTheDocument();
    expect(beginMarketplaceGrantFlow).not.toHaveBeenCalled();
  });
});
