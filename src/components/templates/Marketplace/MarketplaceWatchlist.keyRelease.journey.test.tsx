import { AppRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {
  PathnameContext,
  PathParamsContext,
  SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceApplication } from '@/application/commerce/commerce';
import { CommercePrivKeyringApplication } from '@/application/commerce/priv-keyring';
import { CAPABILITIES, RING_COOKIE_CAPABILITIES } from '@/config/app';
import { decryptPrivRecord, privEntryName, privEntryUrl } from '@/libs/commerce/priv-envelope';
import { privKeyringFromResponse } from '@/libs/commerce/priv-keys';
import { resetRuntimeConfigForTests } from '@/libs/runtime-config/runtime-config';
import { HomeserverService } from '@/services/homeserver/homeserver';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import {
  MARKETPLACE_PREVIOUS_SESSION_GRANT,
  MARKETPLACE_SESSION_GRANT,
} from '@/services/marketplace/marketplace-session-grant';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import {
  PRIV_KEYS_WIRE_NEEDS_REAUTH,
  PRIV_KEYS_WIRE_OK,
  PRIV_KEYS_WIRE_OWNER,
} from '@/test/fixtures/commerce/priv-keys.wire';
import { type FakeHomeserver, installFakeHomeserver } from '@/test-utils/fake-homeserver';
import { asOpaque } from '@/test-utils/type-assertions';
import { installWebLocks, removeWebLocks } from '@/test-utils/web-locks';
import { MarketplaceWatchlist } from './MarketplaceWatchlist';

/**
 * #49 end to end: the marketplace refuses to release the private data key
 * (`GET /v1/me/priv-keys` 403 `needs_reauth`) to a Bitkit sign-in's purchase
 * session, the watchlist offers the marketplace approval as a grant link, the
 * signer approves, and the next sync gets the key and seals the watchlist. A
 * Pubky Ring cookie sign-in gets the same grant link, never the Ring AuthToken
 * connect that Bitkit rejects.
 *
 * Nothing in the Shop is mocked: the watchlist template and every hook it
 * runs, the keyring holder, the purchase-session service and its
 * replacement guard, the grant and bootstrap clients, Dexie and the stores
 * are real. Only the network is stubbed: `fetch` (marketplace service and
 * Shop BFF, answering with the service's wire bodies) and the homeserver
 * transport (`installFakeHomeserver`).
 */

const OWNER = PRIV_KEYS_WIRE_OWNER;
const SELLER = 'n'.repeat(52);
const MARKETPLACE_URL = 'https://marketplace.journey.test';
const CURRENT_TOKEN = 'W'.repeat(43);
const CLAIMED_TOKEN = 'C'.repeat(43);
const FUTURE = new Date(Date.now() + 86_400_000).toISOString();
const STATE_ID = '0b0f3c3e-6d1f-4c3a-9a55-3f1f3f7c1a01';
const CHALLENGE_ID = '0b0f3c3e-6d1f-4c3a-9a55-3f1f3f7c1a02';
const GRANT_URL = `pubkyauth://signin_grant?caps=${encodeURIComponent(MARKETPLACE_SESSION_GRANT)}&relay=r&secret=s&cid=marketplace.staging.shop.pubky.app&cpk=k`;

type Recorded = { method: string; path: string; bearer: string | null };

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * The marketplace service and Shop BFF, as they answer on the wire. The signer
 * approves when `approved` is set. With `bffPaired` false the BFF holds no
 * paired cookie, so the grant reconnect answers `shop_session_missing`.
 */
function installNetwork(signer: { approved: boolean; bffPaired?: boolean }) {
  const requests: Recorded[] = [];
  const connected = {
    status: 'connected',
    state_id: STATE_ID,
    token: CLAIMED_TOKEN,
    pubky: OWNER,
    capabilities: MARKETPLACE_SESSION_GRANT,
    expires_at: FUTURE,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.toString(), 'https://shop.journey.test');
      const method = (init.method ?? 'GET').toUpperCase();
      const authorization = new Headers(init.headers).get('authorization');
      const path = url.origin === MARKETPLACE_URL ? `${MARKETPLACE_URL}${url.pathname}` : url.pathname;
      requests.push({ method, path, bearer: authorization?.replace(/^Bearer /, '') ?? null });

      if (path === `${MARKETPLACE_URL}/v1/me/priv-keys` && method === 'GET') {
        return authorization === `Bearer ${CLAIMED_TOKEN}`
          ? json(200, PRIV_KEYS_WIRE_OK)
          : json(403, PRIV_KEYS_WIRE_NEEDS_REAUTH);
      }
      if (path === '/api/marketplace/grant-flows' && method === 'POST') {
        if (signer.bffPaired === false) return json(401, { error: 'shop_session_missing' });
        return json(200, { authorization_url: GRANT_URL, expires_at: FUTURE, state_id: STATE_ID, status: 'awaiting' });
      }
      if (path === `/api/marketplace/grant-flows/${STATE_ID}/status`) {
        return json(200, signer.approved ? connected : { status: 'awaiting', state_id: STATE_ID });
      }
      if (path === '/api/marketplace/bootstrap-challenges' && method === 'POST') {
        return json(200, {
          challenge_id: CHALLENGE_ID,
          expires_at: FUTURE,
          nonce: 'n0nce',
          proof_document: { challenge: CHALLENGE_ID },
          proof_uri: `pubky://${OWNER}/pub/pubky.app/marketplace-bootstrap/${CHALLENGE_ID}`,
          result_cpk: 'k',
          result_delivery_id: 'd',
        });
      }
      if (path === `/api/marketplace/bootstrap-challenges/${CHALLENGE_ID}/verify`) {
        return json(200, { authorization_url: GRANT_URL, expires_at: FUTURE, state_id: STATE_ID, status: 'awaiting' });
      }
      if (path === `/api/marketplace/bootstrap-flows/${STATE_ID}/status`) {
        return json(200, signer.approved ? connected : { status: 'awaiting', state_id: STATE_ID });
      }
      if (path.endsWith('/cancel') || path === '/api/marketplace/session') return json(200, {});
      return json(404, { error: 'not_found' });
    }),
  );
  return requests;
}

function signInWithBitkit() {
  useAuthStore.setState({
    currentUserPubky: asOpaque(OWNER),
    session: asOpaque({
      grant: {},
      info: { publicKey: { z32: () => OWNER }, capabilities: CAPABILITIES.split(',') },
    }),
  });
}

/** A Pubky Ring cookie sign-in, also what Bitkit gets by scanning the Ring create QR. */
function signInWithRingCookie() {
  useAuthStore.setState({
    currentUserPubky: asOpaque(OWNER),
    session: asOpaque({
      info: { publicKey: { z32: () => OWNER }, capabilities: RING_COOKIE_CAPABILITIES.split(',') },
    }),
  });
}

function renderWatchlist() {
  const router = {
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  };
  return render(
    <AppRouterContext.Provider value={asOpaque(router)}>
      <PathnameContext.Provider value="/marketplace/watchlist">
        <PathParamsContext.Provider value={{}}>
          <SearchParamsContext.Provider value={new URLSearchParams()}>
            <MarketplaceWatchlist />
          </SearchParamsContext.Provider>
        </PathParamsContext.Provider>
      </PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

function sealedWatchlist(homeserver: FakeHomeserver): unknown {
  const keyring = privKeyringFromResponse(
    {
      schemaVersion: 1,
      owner: PRIV_KEYS_WIRE_OK.owner,
      currentKeyId: PRIV_KEYS_WIRE_OK.current_key_id,
      keys: PRIV_KEYS_WIRE_OK.keys.map((key) => ({ keyId: key.key_id, key: key.key, createdAt: key.created_at })),
    } as never,
    OWNER,
  );
  if (!keyring) throw new Error('the wire fixture does not parse into a keyring');
  const envelope = homeserver.files.get(privEntryUrl(keyring, 'watchlist', 'watchlist'));
  if (envelope === undefined) return null;
  return decryptPrivRecord({
    keyring,
    family: 'watchlist',
    name: privEntryName(keyring, 'watchlist', 'watchlist'),
    envelope,
  });
}

describe('#49 key-release refusal → marketplace approval → grant link (watchlist, nothing mocked)', () => {
  let homeserver: FakeHomeserver;

  beforeEach(() => {
    process.env.PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE = 'transaction-service';
    process.env.PUBKY_RUNTIME_MARKETPLACE_URL = MARKETPLACE_URL;
    process.env.PUBKY_RUNTIME_MARKETPLACE_GRANT_FLOW_ENABLED = 'true';
    process.env.PUBKY_RUNTIME_MARKETPLACE_GRANT_POLL_MILLISECONDS = '750';
    resetRuntimeConfigForTests();
    homeserver = installFakeHomeserver();
    installWebLocks();
    MarketplaceSessionService.clearSession();
    CommercePrivKeyringApplication.clear();
    CommerceApplication.resetWatchlistSyncInFlight();
    useCommerceStore.getState().setMarketplaceSession(null);
    useCommerceStore.getState().setWatchlistSyncStatus('idle');
  });

  afterEach(() => {
    MarketplaceSessionService.clearSession();
    CommercePrivKeyringApplication.clear();
    CommerceApplication.resetWatchlistSyncInFlight();
    useCommerceStore.getState().setMarketplaceSession(null);
    useAuthStore.setState({ currentUserPubky: null, session: null });
    removeWebLocks();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    for (const name of [
      'PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE',
      'PUBKY_RUNTIME_MARKETPLACE_URL',
      'PUBKY_RUNTIME_MARKETPLACE_GRANT_FLOW_ENABLED',
      'PUBKY_RUNTIME_MARKETPLACE_GRANT_POLL_MILLISECONDS',
    ]) {
      delete process.env[name];
    }
    resetRuntimeConfigForTests();
  });

  it.each([
    ['a Bitkit', 'an inventory-only purchase session', 'reconnect', true, 'Approve purchases', 'Open in signer'],
    ['a Bitkit', 'no purchase session', 'bootstrap', true, 'Approve purchases in Bitkit', 'Open in Bitkit'],
    [
      'a Pubky Ring (cookie)',
      'no purchase session',
      'bootstrap',
      true,
      'Approve purchases in Pubky Ring or Bitkit',
      'Open in signer',
    ],
    [
      'a Pubky Ring (cookie)',
      'an inventory-only purchase session the BFF has not paired',
      'reconnect',
      false,
      'Approve purchases in Pubky Ring or Bitkit',
      'Open in signer',
    ],
  ] as const)(
    '%s sign-in with %s approves a grant link and then syncs',
    async (signIn, _label, flow, bffPaired, _dialogTitle, _openLabel) => {
      const signer = { approved: false, bffPaired };
      const requests = installNetwork(signer);
      const stepUp = vi.spyOn(HomeserverService, 'generateAuthUrl');
      const ringConnect = vi.spyOn(HomeserverService, 'generateAuthTokenFlow');
      if (signIn === 'a Bitkit') signInWithBitkit();
      else signInWithRingCookie();
      if (flow === 'reconnect') {
        useCommerceStore.getState().setMarketplaceSession(
          MarketplaceSessionService.establishClaimedGrantSession(
            {
              token: CURRENT_TOKEN,
              pubky: OWNER,
              capabilities: MARKETPLACE_PREVIOUS_SESSION_GRANT,
              expiresAt: FUTURE,
            },
            OWNER,
          ),
        );
      }
      await CommerceApplication.commitCreateFavorite(OWNER, `${SELLER}:boots_01`);
      const user = userEvent.setup();

      renderWatchlist();

      expect(await screen.findByRole('button', { name: 'Enable device sync' }, { timeout: 8000 })).toBeInTheDocument();
      expect(useCommerceStore.getState().watchlistSyncStatus).toBe('needs_marketplace_approval');
      const keyReads = () => requests.filter((request) => request.path === `${MARKETPLACE_URL}/v1/me/priv-keys`);
      // With no purchase session there is nothing to ask the marketplace; the holder refuses locally.
      // The watchlist sync and the section badges' checkpoint pull each ask with the inventory-only bearer.
      const refusedReads = keyReads().map((request) => request.bearer);
      if (flow === 'reconnect') {
        expect(refusedReads.length).toBeGreaterThan(0);
        expect(new Set(refusedReads)).toEqual(new Set([CURRENT_TOKEN]));
      } else {
        expect(refusedReads).toEqual([]);
      }
      expect(homeserver.log.some((entry) => entry.includes('/priv/'))).toBe(false);

      await user.click(screen.getByRole('button', { name: 'Enable device sync' }));

      const dialog = await screen.findByRole('dialog');
      expect(await within(dialog).findByRole('heading', { name: 'Enable device sync' })).toBeInTheDocument();
      if (signIn === 'a Bitkit') {
        expect(within(dialog).getByText('Support for Bitkit is coming soon.')).toBeInTheDocument();
        expect(within(dialog).queryByLabelText('Copy authorization link')).not.toBeInTheDocument();
        expect(within(dialog).getByRole('radio', { name: 'Pubky Ring' })).toBeDisabled();
        expect(stepUp).not.toHaveBeenCalled();
        expect(ringConnect).not.toHaveBeenCalled();
        expect(useCommerceStore.getState().watchlistSyncStatus).toBe('needs_marketplace_approval');
        return;
      }
      expect(await within(dialog).findByRole('button', { name: 'Authorize with Pubky Ring' })).toBeEnabled();
      expect(ringConnect).not.toHaveBeenCalled();
      expect(requests.some((request) => request.path === '/api/marketplace/bootstrap-challenges')).toBe(
        flow === 'bootstrap' || !bffPaired,
      );
      expect(within(dialog).getByTestId('session-approval-disclosure')).toHaveTextContent(
        'Authorize with your keychain to sync your watchlist across devices and enable selling and buying.',
      );
      expect(stepUp).not.toHaveBeenCalled();

      signer.approved = true;

      await waitFor(() => expect(useCommerceStore.getState().watchlistSyncStatus).toBe('synced'), { timeout: 8_000 });
      expect(screen.queryByText('Enable device sync')).not.toBeInTheDocument();
      expect(MarketplaceSessionService.getActiveSession()).toMatchObject({
        token: CLAIMED_TOKEN,
        capabilities: MARKETPLACE_SESSION_GRANT,
      });
      expect(keyReads().at(-1)?.bearer).toBe(CLAIMED_TOKEN);
      expect(sealedWatchlist(homeserver)).toMatchObject({ items: [{ listingId: 'boots_01' }] });
      expect(stepUp).not.toHaveBeenCalled();
      expect(ringConnect).not.toHaveBeenCalled();
    },
    15_000,
  );
});
