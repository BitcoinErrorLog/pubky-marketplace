import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceApplication } from '@/application/commerce/commerce';
import { MarketplaceGetPaidSettings } from '@/organisms/Marketplace/MarketplaceGetPaidSettings';
import { MARKETPLACE_SESSION_STORAGE_KEY, MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import { CommerceController } from './commerce';

const PUBKY = 'y'.repeat(52);
const SESSION_TOKENS = {
  ttl: 'T'.repeat(43),
  drop: 'D'.repeat(43),
  signout: 'S'.repeat(43),
  old: 'O'.repeat(43),
  next: 'N'.repeat(43),
};

const config = vi.hoisted(() => ({
  mode: 'transaction-service' as string,
}));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return {
    ...actual,
    getCommerceAdapterMode: () => config.mode,
    getMarketplaceUrl: () => 'http://127.0.0.1:8080',
  };
});

vi.mock('@/services/homeserver/homeserver', () => ({
  HomeserverService: {
    generateAuthTokenFlow: () => ({
      authorizationUrl: 'pubkyauth:///?relay=http%3A%2F%2Flocalhost%2Finbox&secret=s',
      awaitToken: vi.fn(),
      cancelAuthFlow: vi.fn(),
    }),
  },
}));

vi.mock('@/hooks/useMarketplaceSellerPaymentConfig/useMarketplaceSellerPaymentConfig', () => ({
  useMarketplaceSellerPaymentConfig: () => ({
    config: null,
    isLoading: false,
    loadError: null,
    claimStatus: 'idle',
    save: vi.fn(),
    claimBitcoinAccount: vi.fn(),
    removeBitcoinAccount: vi.fn(),
  }),
}));

vi.mock('@/organisms/Marketplace/MarketplaceSessionConnectDialog', () => ({
  MarketplaceSessionConnectDialog: () => <button type="button">Approve in Pubky Ring</button>,
}));

function DropSessionProbe() {
  const marketplaceSession = useCommerceStore((state) => state.marketplaceSession);
  return <p>{marketplaceSession !== null ? 'drop-has-session' : 'drop-no-session'}</p>;
}

function sessionResponse(expiresAt: string, token: string): Response {
  return new Response(JSON.stringify({ token, pubky: PUBKY, capabilities: '', expires_at: expiresAt }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
}

async function establishIntoStore(expiresAt: string, token: string) {
  vi.mocked(fetch).mockResolvedValueOnce(sessionResponse(expiresAt, token));
  const info = await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([1]), PUBKY);
  useCommerceStore.getState().setMarketplaceSession(info);
  return info;
}

async function flushSessionEnded() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('CommerceController marketplace session-ended binding', () => {
  beforeEach(() => {
    config.mode = 'transaction-service';
    vi.stubGlobal('fetch', vi.fn());
    MarketplaceSessionService.clearSession();
    useCommerceStore.getState().reset();
    useAuthStore.setState({ currentUserPubky: PUBKY });
    CommerceController.bindMarketplaceSessionStore();
  });

  afterEach(() => {
    CommerceController.unbindMarketplaceSessionStore();
    MarketplaceSessionService.clearSession();
    useCommerceStore.getState().reset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('nulls the store and session UI after TTL expiry, drop-lifecycle 401, and sign-out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-20T12:00:00.000Z'));
    await establishIntoStore('2026-08-20T13:00:00.000Z', SESSION_TOKENS.ttl);

    render(
      <>
        <DropSessionProbe />
        <MarketplaceGetPaidSettings
          locksConnect={{
            connectedCreator: null,
            isExchanging: false,
            error: null,
            openConnect: () => {},
          }}
        />
      </>,
    );
    expect(screen.getByText('drop-has-session')).toBeInTheDocument();
    expect(screen.queryByText(/Saving payment settings requires a marketplace session/)).not.toBeInTheDocument();

    vi.setSystemTime(new Date('2026-08-20T12:59:31.000Z'));
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
    await flushSessionEnded();

    await waitFor(() => {
      expect(useCommerceStore.getState().marketplaceSession).toBeNull();
      expect(screen.getByText('drop-no-session')).toBeInTheDocument();
      expect(screen.getAllByText(/Saving payment settings requires a marketplace session/).length).toBeGreaterThan(0);
    });

    vi.setSystemTime(new Date('2026-08-20T14:00:00.000Z'));
    await establishIntoStore('2026-08-21T14:00:00.000Z', SESSION_TOKENS.drop);
    await waitFor(() => expect(screen.getByText('drop-has-session')).toBeInTheDocument());

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'The session is invalid or expired.' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await expect(CommerceController.cancelDrop('drop1', 1)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    await flushSessionEnded();

    await waitFor(() => {
      expect(useCommerceStore.getState().marketplaceSession).toBeNull();
      expect(MarketplaceSessionService.getActiveSession()).toBeNull();
      expect(screen.getByText('drop-no-session')).toBeInTheDocument();
      expect(screen.getAllByText(/Saving payment settings requires a marketplace session/).length).toBeGreaterThan(0);
    });

    await establishIntoStore('2026-08-21T16:00:00.000Z', SESSION_TOKENS.signout);
    await waitFor(() => expect(screen.getByText('drop-has-session')).toBeInTheDocument());
    CommerceController.clearMarketplaceSession();
    await flushSessionEnded();

    expect(useCommerceStore.getState().marketplaceSession).toBeNull();
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
    await waitFor(() => {
      expect(screen.getByText('drop-no-session')).toBeInTheDocument();
      expect(screen.getAllByText(/Saving payment settings requires a marketplace session/).length).toBeGreaterThan(0);
    });
    expect(window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('keeps a connect that finishes after a clear and never resurrects the cleared session', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-08-20T12:00:00.000Z'));
    const cleared = await establishIntoStore('2026-08-20T13:00:00.000Z', SESSION_TOKENS.old);

    vi.spyOn(CommerceApplication, 'beginMarketplaceSessionFlow').mockReturnValue({
      authorizationUrl: 'pubkyauth:///?caps=test',
      awaitSession: async () => {
        vi.setSystemTime(new Date('2026-08-20T12:59:31.000Z'));
        expect(MarketplaceSessionService.getActiveSession()).toBeNull();
        await flushSessionEnded();
        expect(useCommerceStore.getState().marketplaceSession).toBeNull();
        vi.setSystemTime(new Date('2026-08-20T13:00:00.000Z'));
        vi.mocked(fetch).mockResolvedValueOnce(sessionResponse('2026-08-20T15:00:00.000Z', SESSION_TOKENS.next));
        return await MarketplaceSessionService.establishWithAuthToken(new Uint8Array([9]), PUBKY);
      },
      cancel: vi.fn(),
    });

    const session = await CommerceController.beginMarketplaceSessionConnect().awaitSession();
    await flushSessionEnded();

    expect(session.issuedAt).not.toBe(cleared.issuedAt);
    expect(useCommerceStore.getState().marketplaceSession).toEqual(session);
    expect(MarketplaceSessionService.getActiveSession()).toMatchObject({ token: SESSION_TOKENS.next });

    vi.spyOn(CommerceApplication, 'beginMarketplaceSessionFlow').mockReturnValue({
      authorizationUrl: 'pubkyauth:///?caps=stale',
      awaitSession: async () => ({
        pubky: PUBKY,
        capabilities: '',
        expiresAt: cleared.expiresAt,
        issuedAt: cleared.issuedAt,
      }),
      cancel: vi.fn(),
    });
    await CommerceController.beginMarketplaceSessionConnect().awaitSession();
    expect(useCommerceStore.getState().marketplaceSession).toEqual(session);
    expect(useCommerceStore.getState().marketplaceSession?.issuedAt).not.toBe(cleared.issuedAt);
  });
});
