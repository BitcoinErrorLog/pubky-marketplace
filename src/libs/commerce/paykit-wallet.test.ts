import { describe, expect, it } from 'vitest';
import {
  bitcoinWalletUnsupportedBody,
  bitcoinWalletUnsupportedPayReason,
  bitcoinWalletUnverifiedBody,
  bitcoinWalletUnverifiedPayReason,
  foundAppRegistryShowsNewWallet,
  paykitAppRegistryUrl,
} from './paykit-wallet';

/** The registry Paykit rc70 (Bitkit 2.6) serializes, per `paykit-lib/src/app_registry.rs`. */
function registry(apps: Record<string, { private_payments: boolean; payment_requests: boolean }>) {
  return {
    version: 1,
    kind: 'paykit.app_registry',
    key_generation: 1,
    noise_public_key: 'n'.repeat(52),
    apps: Object.fromEntries(
      Object.entries(apps).map(([appId, capabilities]) => [
        appId,
        { display_name: appId, capabilities: { ...capabilities, receipts: true, outgoing_payments: true } },
      ]),
    ),
    default_app_id: Object.keys(apps)[0] ?? null,
    default_apps_by_endpoint: {},
  };
}

describe('paykitAppRegistryUrl', () => {
  it('points at the identity-wide registry Paykit rc59+ publishes', () => {
    expect(paykitAppRegistryUrl('b'.repeat(52))).toBe(`pubky://${'b'.repeat(52)}/pub/paykit/v0/app-registry.json`);
  });
});

describe('foundAppRegistryShowsNewWallet', () => {
  it('is true when an app takes payment requests over a private link', () => {
    expect(
      foundAppRegistryShowsNewWallet(
        registry({
          'to.bitkit': { private_payments: true, payment_requests: true },
        }),
      ),
    ).toBe(true);
  });

  it('finds the capable app among others', () => {
    expect(
      foundAppRegistryShowsNewWallet(
        registry({
          'app.chat': { private_payments: true, payment_requests: false },
          'to.bitkit': { private_payments: true, payment_requests: true },
        }),
      ),
    ).toBe(true);
  });

  it('is false only for a v1 registry that lists no app with both capabilities', () => {
    expect(
      foundAppRegistryShowsNewWallet(
        registry({
          'app.chat': { private_payments: true, payment_requests: false },
          'app.public': { private_payments: false, payment_requests: true },
        }),
      ),
    ).toBe(false);
    expect(foundAppRegistryShowsNewWallet(registry({}))).toBe(false);
  });

  it('counts a registry it cannot read as a new wallet, since only Paykit rc59+ writes the path', () => {
    const capable = registry({ 'to.bitkit': { private_payments: true, payment_requests: true } });
    const empty = registry({});
    expect(foundAppRegistryShowsNewWallet({ ...capable, version: 2 })).toBe(true);
    expect(foundAppRegistryShowsNewWallet({ ...empty, version: 2 })).toBe(true);
    expect(foundAppRegistryShowsNewWallet({ ...capable, kind: 'paykit.receiver' })).toBe(true);
    expect(foundAppRegistryShowsNewWallet({ ...capable, apps: [] })).toBe(true);
    expect(
      foundAppRegistryShowsNewWallet({
        ...capable,
        apps: { 'to.bitkit': { display_name: 'Bitkit', capabilities: { payment_requests: 'yes' } } },
      }),
    ).toBe(true);
    // The homeserver service hands back invalid JSON as `undefined`.
    expect(foundAppRegistryShowsNewWallet(undefined)).toBe(true);
    expect(foundAppRegistryShowsNewWallet(null)).toBe(true);
    expect(foundAppRegistryShowsNewWallet('{}')).toBe(true);
  });
});

describe('Bitkit 2.6 fallback copy', () => {
  it('offers PayPal only when the seller takes it', () => {
    expect(bitcoinWalletUnsupportedBody(true)).toBe(
      "This Pubky account uses Bitkit 2.6 or later. The Shop can't send it a Bitcoin payment request yet; that comes with an upcoming Shop update. You can pay with PayPal instead.",
    );
    expect(bitcoinWalletUnsupportedBody(false)).not.toMatch(/PayPal/);
    expect(bitcoinWalletUnsupportedPayReason(true)).toBe(
      'Bitcoin checkout does not support Bitkit 2.6 yet. Choose PayPal to pay now.',
    );
    expect(bitcoinWalletUnsupportedPayReason(false)).toBe('Bitcoin checkout does not support Bitkit 2.6 yet.');
  });
});

describe('unverified wallet copy', () => {
  it('asks for a recheck and offers PayPal only when the seller takes it', () => {
    expect(bitcoinWalletUnverifiedBody(true)).toBe(
      "The Shop couldn't check which Bitkit version this Pubky account uses, so Bitcoin Pay is paused. Check again in a moment. You can also pay with PayPal.",
    );
    expect(bitcoinWalletUnverifiedBody(false)).not.toMatch(/PayPal/);
    expect(bitcoinWalletUnverifiedPayReason(true)).toBe(
      'Check your Bitcoin wallet again to pay with Bitcoin, or choose PayPal.',
    );
    expect(bitcoinWalletUnverifiedPayReason(false)).toBe('Check your Bitcoin wallet again to pay with Bitcoin.');
  });
});
