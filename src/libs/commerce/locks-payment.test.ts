import { describe, expect, it } from 'vitest';
import { buyerVisiblePaymentStatus, lockPolicyCreator, toBareLockResource } from './locks-payment';
import { locksBareLockResourceSchema } from './transaction-commands';

const CREATOR = 'y'.repeat(52);
const LOCK_ID = '000G40R40M30E209185GR38E1W8124GK2GAHC5RR34D1P70X3RFG';

describe('toBareLockResource', () => {
  it('converts a policy URI into the bare form the service contract accepts', () => {
    const bare = toBareLockResource(`pubky://${CREATOR}/pub/locks.app/${LOCK_ID}.json`);
    expect(bare).toBe(`${CREATOR}/pub/locks.app/${LOCK_ID}.json`);
    expect(locksBareLockResourceSchema.safeParse(bare).success).toBe(true);
  });

  it('rejects URIs outside the Locks namespace', () => {
    expect(toBareLockResource(`pubky://${CREATOR}/pub/pubky.app/marketplace/v1/listings/x`)).toBeNull();
    expect(toBareLockResource(`https://${CREATOR}/pub/locks.app/${LOCK_ID}.json`)).toBeNull();
    expect(toBareLockResource('')).toBeNull();
  });
});

describe('lockPolicyCreator', () => {
  it('extracts the creator pubky', () => {
    expect(lockPolicyCreator(`pubky://${CREATOR}/pub/locks.app/${LOCK_ID}.json`)).toBe(CREATOR);
    expect(lockPolicyCreator('not-a-policy-uri')).toBeNull();
  });
});

describe('buyerVisiblePaymentStatus', () => {
  it('folds detected into awaiting entitlement — detection stays internal', () => {
    expect(buyerVisiblePaymentStatus('detected')).toBe('awaiting_entitlement');
  });

  it('maps the buyer-visible states to themselves', () => {
    expect(buyerVisiblePaymentStatus('awaiting_entitlement')).toBe('awaiting_entitlement');
    expect(buyerVisiblePaymentStatus('confirmed')).toBe('confirmed');
    expect(buyerVisiblePaymentStatus('expired')).toBe('expired');
    expect(buyerVisiblePaymentStatus('manual_review')).toBe('manual_review');
  });
});
