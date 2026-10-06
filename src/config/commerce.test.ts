import { describe, expect, it } from 'vitest';
import { isDurableCommerceMode, isTrustedMarketplaceAttestor, MARKETPLACE_TRUSTED_ATTESTORS } from '@/config/commerce';

describe('isDurableCommerceMode', () => {
  it('treats the live production locks-paykit mode as durable', () => {
    expect(isDurableCommerceMode('locks-paykit')).toBe(true);
  });
});

describe('MARKETPLACE_TRUSTED_ATTESTORS', () => {
  it('pins the staging and production transaction-service attestors', () => {
    expect(MARKETPLACE_TRUSTED_ATTESTORS).toEqual([
      'ws343aqzmcahagojhmhkbri8odqz9iqg61woxbkh9fd3bxhqomdy',
      'szhtpayftdz3mpkoyyk3zesuad11ufuudqqrc73s35w1tfju7gxy',
    ]);
  });

  it('trusts both pinned attestors and rejects anything else', () => {
    for (const attestor of MARKETPLACE_TRUSTED_ATTESTORS) {
      expect(isTrustedMarketplaceAttestor(attestor)).toBe(true);
    }
    expect(isTrustedMarketplaceAttestor('x'.repeat(52))).toBe(false);
    expect(isTrustedMarketplaceAttestor(null)).toBe(false);
  });
});
