import { describe, expect, it } from 'vitest';
import { paypalActivityUrl, sellerPaypalActivityUrl, shortOrderReference } from './order-reference';

describe('shortOrderReference', () => {
  it('uses the first eight characters of the order id', () => {
    expect(shortOrderReference('018f47d2-6a27-7c23-a49d-000000000250')).toBe('018f47d2');
    expect(shortOrderReference('14f40533abcd')).toBe('14f40533');
  });
});

describe('paypalActivityUrl', () => {
  it('links a stored PayPal txn id to the seller activity page', () => {
    expect(paypalActivityUrl('5TY05013RG002845M')).toBe(
      'https://www.paypal.com/myaccount/activities/details/5TY05013RG002845M',
    );
  });

  it('refuses ids that are not a safe alphanumeric txn id', () => {
    expect(paypalActivityUrl('')).toBeNull();
    expect(paypalActivityUrl('short')).toBeNull();
    expect(paypalActivityUrl('has space')).toBeNull();
    expect(paypalActivityUrl('has/slash')).toBeNull();
    expect(paypalActivityUrl(`${'a'.repeat(65)}`)).toBeNull();
  });
});

describe('sellerPaypalActivityUrl', () => {
  const order = { paymentMethod: 'paypal' as const, fiatTransactionRef: '5TY05013RG002845M' };

  it('is seller-only and PayPal-only', () => {
    expect(sellerPaypalActivityUrl(order, false)).toBe(
      'https://www.paypal.com/myaccount/activities/details/5TY05013RG002845M',
    );
    expect(sellerPaypalActivityUrl(order, true)).toBeNull();
    expect(sellerPaypalActivityUrl({ ...order, paymentMethod: 'bitcoin' }, false)).toBeNull();
    expect(sellerPaypalActivityUrl({ paymentMethod: 'paypal', fiatTransactionRef: null }, false)).toBeNull();
    expect(sellerPaypalActivityUrl({ ...order, fiatTransactionRef: 'not a txn' }, false)).toBeNull();
  });
});
