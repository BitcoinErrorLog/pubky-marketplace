import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { createOrderFixture } from '@/test/fixtures/commerce/orders';
import { useMarketplaceOrderAction } from './useMarketplaceOrderAction';

describe('useMarketplaceOrderAction ship action', () => {
  it('sends the curated carrier by its canonical display name', async () => {
    const order = createOrderFixture('paid');
    const actOnOrder = vi.fn(async () => true);
    const { result } = renderHook(() => useMarketplaceOrderAction(order, actOnOrder));

    act(() => {
      result.current.setAction('ship', { carrierChoice: 'royal-mail', trackingNumber: 'RN123456785GB' });
    });
    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(true);
    expect(actOnOrder).toHaveBeenCalledWith(order, 'fulfillment.ship', {
      carrier: 'Royal Mail',
      trackingNumber: 'RN123456785GB',
    });
  });

  it('passes an "Other" carrier through as the seller\'s own free text', async () => {
    const order = createOrderFixture('paid');
    const actOnOrder = vi.fn(async () => true);
    const { result } = renderHook(() => useMarketplaceOrderAction(order, actOnOrder));

    act(() => {
      result.current.setAction('ship', {
        carrierChoice: 'other',
        carrier: 'Correio da Aldeia',
        trackingNumber: 'CA-0001',
      });
    });
    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(true);
    expect(actOnOrder).toHaveBeenCalledWith(order, 'fulfillment.ship', {
      carrier: 'Correio da Aldeia',
      trackingNumber: 'CA-0001',
    });
  });

  it('refuses to ship without a tracking number or an unnamed Other carrier', async () => {
    const order = createOrderFixture('paid');
    const actOnOrder = vi.fn(async () => true);
    const { result } = renderHook(() => useMarketplaceOrderAction(order, actOnOrder));

    act(() => {
      result.current.setAction('ship', { carrierChoice: 'usps', trackingNumber: '' });
    });
    await act(async () => {
      await result.current.submit();
    });
    expect(actOnOrder).not.toHaveBeenCalled();

    act(() => {
      result.current.setAction('ship', { carrierChoice: 'other', carrier: '', trackingNumber: 'X-1' });
    });
    await act(async () => {
      await result.current.submit();
    });
    expect(actOnOrder).not.toHaveBeenCalled();
  });
});

describe('useMarketplaceOrderAction refund', () => {
  const paypalOrder = createOrderFixture('return_received', {
    paymentMethod: 'paypal',
    total: { amountMinor: 250, currency: 'USD', exponent: 2 },
  });

  it('prefills the order total and records a smaller PayPal refund', async () => {
    const actOnOrder = vi.fn(async () => true);
    const { result } = renderHook(() => useMarketplaceOrderAction(paypalOrder, actOnOrder));

    act(() => {
      result.current.setAction('refund');
    });
    expect(result.current.form.getValues('amount')).toBe('2.50');

    act(() => {
      result.current.form.setValue('amount', '1.89');
      result.current.form.setValue('transactionId', 'PAYPALREFUND189');
    });
    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(true);
    expect(actOnOrder).toHaveBeenCalledWith(paypalOrder, 'refund.record_external', {
      amountMinor: 189,
      transactionId: 'PAYPALREFUND189',
    });
  });

  it('refuses a refund above the order total', async () => {
    const actOnOrder = vi.fn(async () => true);
    const { result } = renderHook(() => useMarketplaceOrderAction(paypalOrder, actOnOrder));

    act(() => {
      result.current.setAction('refund', { amount: '2.51', transactionId: 'PAYPALREFUND251' });
    });
    await act(async () => {
      await result.current.submit();
    });

    expect(actOnOrder).not.toHaveBeenCalled();
    expect(result.current.form.getFieldState('amount').error?.message).toBe('Enter a refund up to the order total.');
  });

  describe('after a PayPal partial refund', () => {
    const partialOrder = createOrderFixture('return_received', {
      paymentMethod: 'paypal',
      total: { amountMinor: 250, currency: 'USD', exponent: 2 },
      externalRefund: { amountMinor: 189, transactionId: '9RF12345AB678901C', recordedAt: '2026-09-24T18:00:00.000Z' },
    });

    it('prefills the remaining amount and records the PayPal sum plus it', async () => {
      const actOnOrder = vi.fn(async () => true);
      const { result } = renderHook(() => useMarketplaceOrderAction(partialOrder, actOnOrder));

      act(() => {
        result.current.setAction('refund', { transactionId: 'BANKTRANSFER061' });
      });
      expect(result.current.form.getValues('amount')).toBe('0.61');
      let succeeded = false;
      await act(async () => {
        succeeded = await result.current.submit();
      });

      expect(succeeded).toBe(true);
      expect(actOnOrder).toHaveBeenCalledWith(partialOrder, 'refund.record_external', {
        amountMinor: 250,
        transactionId: 'BANKTRANSFER061',
      });
    });

    it('closes the order at the PayPal amount when nothing else was refunded', async () => {
      const actOnOrder = vi.fn(async () => true);
      const { result } = renderHook(() => useMarketplaceOrderAction(partialOrder, actOnOrder));

      act(() => {
        result.current.setAction('refund', { amount: '0', transactionId: '9RF12345AB678901C' });
      });
      await act(async () => {
        await result.current.submit();
      });

      expect(actOnOrder).toHaveBeenCalledWith(partialOrder, 'refund.record_external', {
        amountMinor: 189,
        transactionId: '9RF12345AB678901C',
      });
    });

    it('refuses more than PayPal left unrefunded', async () => {
      const actOnOrder = vi.fn(async () => true);
      const { result } = renderHook(() => useMarketplaceOrderAction(partialOrder, actOnOrder));

      act(() => {
        result.current.setAction('refund', { amount: '0.62', transactionId: 'BANKTRANSFER062' });
      });
      await act(async () => {
        await result.current.submit();
      });

      expect(actOnOrder).not.toHaveBeenCalled();
      expect(result.current.form.getFieldState('amount').error?.message).toBe(
        'Enter a refund up to the amount PayPal has not refunded.',
      );
    });
  });

  it('records a Bitcoin refund as integer satoshis of the payable', async () => {
    const order = createOrderFixture('return_received', {
      paymentMethod: 'bitcoin',
      paykitTotalSats: 1_255,
      merchandiseTotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
      bitcoinPayable: { amountMinor: 1_255, currency: 'SAT', exponent: 0 },
      subtotal: { amountMinor: 1_000, currency: 'BTC', exponent: 8 },
      shipping: { amountMinor: 0, currency: 'BTC', exponent: 8 },
      total: { amountMinor: 1_255, currency: 'BTC', exponent: 8 },
    });
    const actOnOrder = vi.fn(async () => true);
    const { result } = renderHook(() => useMarketplaceOrderAction(order, actOnOrder));

    act(() => {
      result.current.setAction('refund', { transactionId: 'txid-canary-refund' });
    });
    expect(result.current.form.getValues('amount')).toBe('1255');
    let succeeded = false;
    await act(async () => {
      succeeded = await result.current.submit();
    });

    expect(succeeded).toBe(true);
    expect(actOnOrder).toHaveBeenCalledWith(order, 'refund.record_external', {
      amountMinor: 1_255,
      transactionId: 'txid-canary-refund',
    });
  });

  it('still refuses a zero refund when PayPal has refunded nothing', async () => {
    const actOnOrder = vi.fn(async () => true);
    const { result } = renderHook(() => useMarketplaceOrderAction(paypalOrder, actOnOrder));

    act(() => {
      result.current.setAction('refund', { amount: '0', transactionId: 'PAYPALREFUND000' });
    });
    await act(async () => {
      await result.current.submit();
    });

    expect(actOnOrder).not.toHaveBeenCalled();
    expect(result.current.form.getFieldState('amount').error?.message).toBe('Enter a valid refund amount.');
  });
});
