import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CAPABILITIES } from '@/config/app';
import { MARKETPLACE_SESSION_STORAGE_KEY, MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import captured from '@/test/fixtures/auth/marketplace-grant-priv-parity.staging.json';
import { CommerceController } from './commerce';

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return {
    ...actual,
    getCommerceAdapterMode: () => 'transaction-service',
    getMarketplaceUrl: () => 'http://127.0.0.1:8080',
  };
});

const PUBKY = 'y'.repeat(52);
const WIDE_TOKEN = 'W'.repeat(43);
const OTHER_TAB_TOKEN = 'N'.repeat(43);
const parity = captured.parity_request.homeserver_verified;
const previous = captured.previous_request.homeserver_verified;

function inOneDay(): string {
  return new Date(Date.now() + 86_400_000).toISOString();
}

/** What another tab's accepted writer leaves in the shared slot. */
function otherTabPersists(capabilities: string): string {
  const blob = JSON.stringify({ token: OTHER_TAB_TOKEN, pubky: PUBKY, capabilities, expiresAt: inOneDay() });
  window.localStorage.setItem(MARKETPLACE_SESSION_STORAGE_KEY, blob);
  return blob;
}

describe('purchase-session restore never downgrades memory or the store mirror', () => {
  beforeEach(() => {
    MarketplaceSessionService.clearForSignOut();
    useCommerceStore.getState().reset();
  });

  function holdWideSessionInThisTab() {
    const info = MarketplaceSessionService.establishClaimedGrantSession(
      { token: WIDE_TOKEN, pubky: PUBKY, capabilities: parity, expiresAt: inOneDay() },
      PUBKY,
    );
    CommerceController.writeMarketplaceSessionStore(info);
  }

  it('keeps the wide in-memory session when another tab persisted the inventory-only grant', () => {
    holdWideSessionInThisTab();
    const blob = otherTabPersists(previous);

    const restored = CommerceController.restorePersistedMarketplaceSession(PUBKY);

    expect(restored?.capabilities).toBe(parity);
    expect(MarketplaceSessionService.getActiveSession()).toMatchObject({ token: WIDE_TOKEN, capabilities: parity });
    expect(useCommerceStore.getState().marketplaceSession?.capabilities).toBe(parity);
    expect(window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY)).toBe(blob);
  });

  it.each([
    ['empty', ''],
    ['root', '/:rw'],
    ['extra scope', `${parity},/pub/paykit/:rw`],
    ['malformed', 'garbage'],
  ])('drops a persisted %s grant, keeps memory, and never mirrors it', (_label, capabilities) => {
    holdWideSessionInThisTab();
    otherTabPersists(capabilities);

    CommerceController.restorePersistedMarketplaceSession(PUBKY);

    expect(MarketplaceSessionService.getActiveSession()?.token).toBe(WIDE_TOKEN);
    expect(useCommerceStore.getState().marketplaceSession?.capabilities).toBe(parity);
    expect(window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY)).toBeNull();
  });

  it('with nothing in memory, restores only a grant a writer may have stored', () => {
    otherTabPersists('');
    expect(CommerceController.restorePersistedMarketplaceSession(PUBKY)).toBeNull();
    expect(useCommerceStore.getState().marketplaceSession).toBeNull();

    for (const capabilities of [parity, previous, CAPABILITIES]) {
      MarketplaceSessionService.clearSession();
      useCommerceStore.getState().reset();
      otherTabPersists(capabilities);
      expect(CommerceController.restorePersistedMarketplaceSession(PUBKY)?.capabilities).toBe(capabilities);
      expect(MarketplaceSessionService.getActiveSession()?.token).toBe(OTHER_TAB_TOKEN);
    }
  });

  it('a wider persisted grant replaces a narrower in-memory one', () => {
    const narrow = MarketplaceSessionService.establishClaimedGrantSession(
      { token: WIDE_TOKEN, pubky: PUBKY, capabilities: previous, expiresAt: inOneDay() },
      PUBKY,
    );
    CommerceController.writeMarketplaceSessionStore(narrow);
    otherTabPersists(parity);

    expect(CommerceController.restorePersistedMarketplaceSession(PUBKY)?.capabilities).toBe(parity);
    expect(MarketplaceSessionService.getActiveSession()?.token).toBe(OTHER_TAB_TOKEN);
  });
});

describe('clearing the purchase session from the controller', () => {
  beforeEach(() => {
    MarketplaceSessionService.clearForSignOut();
    useCommerceStore.getState().reset();
  });

  function thisTabHoldsAndOtherTabPersistsNewer(): string {
    const info = MarketplaceSessionService.establishClaimedGrantSession(
      { token: WIDE_TOKEN, pubky: PUBKY, capabilities: parity, expiresAt: inOneDay() },
      PUBKY,
    );
    CommerceController.writeMarketplaceSessionStore(info);
    return otherTabPersists(parity);
  }

  it('a failed or losing sign-in clears only this tab’s bearer', () => {
    const newer = thisTabHoldsAndOtherTabPersistsNewer();
    CommerceController.clearMarketplaceSession();
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
    expect(window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY)).toBe(newer);
  });

  it('sign-out leaves no purchase bearer at rest, whichever tab persisted it', () => {
    thisTabHoldsAndOtherTabPersistsNewer();
    CommerceController.clearMarketplaceSessionForSignOut();
    expect(MarketplaceSessionService.getActiveSession()).toBeNull();
    expect(useCommerceStore.getState().marketplaceSession).toBeNull();
    expect(window.localStorage.getItem(MARKETPLACE_SESSION_STORAGE_KEY)).toBeNull();
  });
});
