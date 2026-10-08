import { describe, expect, it } from 'vitest';
import {
  appRegistryReceivesPaymentRequests,
  bitcoinWalletUnsupportedBody,
  bitcoinWalletUnsupportedPayReason,
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

describe('appRegistryReceivesPaymentRequests', () => {
  it('is true when an app takes payment requests over a private link', () => {
    expect(
      appRegistryReceivesPaymentRequests(
        registry({
          'to.bitkit': { private_payments: true, payment_requests: true },
        }),
      ),
    ).toBe(true);
  });

  it('finds the capable app among others', () => {
    expect(
      appRegistryReceivesPaymentRequests(
        registry({
          'app.chat': { private_payments: true, payment_requests: false },
          'to.bitkit': { private_payments: true, payment_requests: true },
        }),
      ),
    ).toBe(true);
  });

  it('is false when no app has both capabilities', () => {
    expect(
      appRegistryReceivesPaymentRequests(
        registry({
          'app.chat': { private_payments: true, payment_requests: false },
          'app.public': { private_payments: false, payment_requests: true },
        }),
      ),
    ).toBe(false);
    expect(appRegistryReceivesPaymentRequests(registry({}))).toBe(false);
  });

  it('is false for anything that is not a v1 Paykit App Registry', () => {
    const capable = registry({ 'to.bitkit': { private_payments: true, payment_requests: true } });
    expect(appRegistryReceivesPaymentRequests({ ...capable, version: 2 })).toBe(false);
    expect(appRegistryReceivesPaymentRequests({ ...capable, kind: 'paykit.receiver' })).toBe(false);
    expect(appRegistryReceivesPaymentRequests({ ...capable, apps: [] })).toBe(false);
    expect(
      appRegistryReceivesPaymentRequests({
        ...capable,
        apps: { 'to.bitkit': { display_name: 'Bitkit', capabilities: { payment_requests: 'yes' } } },
      }),
    ).toBe(false);
    expect(appRegistryReceivesPaymentRequests(null)).toBe(false);
    expect(appRegistryReceivesPaymentRequests('{}')).toBe(false);
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
