import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPABILITIES } from '@/config/app';
import { resetRuntimeConfigForTests } from '@/libs/runtime-config/runtime-config';
import { beginMarketplaceBootstrapFlow } from '@/services/marketplace/marketplace-bootstrap-client';
import { beginMarketplaceGrantFlow } from '@/services/marketplace/marketplace-grant-client';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
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
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

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

  it.each([false, true])('keeps unsupported Bitkit approval blocked (existing session: %s)', async (existing) => {
    signIn('bitkit');
    if (existing) seedPurchaseSession(parityCapture.previous_request.homeserver_verified);
    const user = userEvent.setup();
    render(existing
      ? <MarketplaceReauthDialog refusal="homeserver" triggerLabel="Sign in again" />
      : <MarketplaceSessionRequiredCard />);
    await user.click(screen.getByRole('button', { name: existing ? 'Sign in again' : 'Authorize' }));
    expect(screen.getByText('Support for Bitkit is coming soon.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Pubky Ring' })).toBeDisabled();
    expect(screen.queryByLabelText('Copy authorization link')).not.toBeInTheDocument();
    expect(beginMarketplaceBootstrapFlow).not.toHaveBeenCalled();
    expect(beginMarketplaceGrantFlow).not.toHaveBeenCalled();
    expect(ringStepUp.start).not.toHaveBeenCalled();
    expect(MarketplaceSessionService.getActiveSession()?.token ?? null).toBe(existing ? CURRENT_TOKEN : null);
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
