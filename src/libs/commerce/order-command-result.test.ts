import { describe, expect, it } from 'vitest';
import { type CommandOrderSnapshot, orderShowsCommandResult } from './order-command-result';

const order = (overrides: Partial<CommandOrderSnapshot> = {}): CommandOrderSnapshot => ({
  state: 'delivered',
  ...overrides,
});

describe('orderShowsCommandResult', () => {
  it('matches the return the buyer just submitted', () => {
    expect(
      orderShowsCommandResult(
        order({
          state: 'return_requested',
          returnRequest: { state: 'requested', reason: 'mistake on my part', requestedAmountMinor: 250 },
        }),
        'return.request',
        { reason: 'mistake on my part', requestedAmountMinor: 250 },
      ),
    ).toBe(true);
  });

  it('rejects a return whose reason or amount is different', () => {
    const landed = order({
      state: 'return_requested',
      returnRequest: { state: 'requested', reason: 'mistake on my part', requestedAmountMinor: 250 },
    });
    expect(orderShowsCommandResult(landed, 'return.request', { reason: 'other', requestedAmountMinor: 250 })).toBe(
      false,
    );
    expect(
      orderShowsCommandResult(landed, 'return.request', { reason: 'mistake on my part', requestedAmountMinor: 100 }),
    ).toBe(false);
    expect(
      orderShowsCommandResult(order({ state: 'completed' }), 'return.request', {
        reason: 'mistake on my part',
        requestedAmountMinor: 250,
      }),
    ).toBe(false);
  });

  it('matches later states that still show the same command', () => {
    expect(
      orderShowsCommandResult(
        order({
          state: 'shipped',
          shipment: { carrier: 'Local Courier', trackingNumber: 'LC-1', state: 'shipped' },
        }),
        'fulfillment.ship',
        { carrier: 'Local Courier', trackingNumber: 'LC-1' },
      ),
    ).toBe(true);
    expect(
      orderShowsCommandResult(
        order({
          state: 'delivered',
          shipment: { carrier: 'Local Courier', trackingNumber: 'LC-1', state: 'delivered' },
        }),
        'fulfillment.confirm_delivery',
        {},
      ),
    ).toBe(true);
    expect(orderShowsCommandResult(order({ state: 'shipped' }), 'fulfillment.confirm_delivery', {})).toBe(false);
    expect(
      orderShowsCommandResult(
        order({ state: 'cancel_requested', cancellationReason: 'Changed my mind' }),
        'order.cancel_request',
        {
          reason: 'Changed my mind',
        },
      ),
    ).toBe(true);
    expect(
      orderShowsCommandResult(
        order({ state: 'cancelled', cancellationReason: 'Changed my mind' }),
        'order.cancel_approve',
        {},
      ),
    ).toBe(true);
    expect(orderShowsCommandResult(order({ state: 'cancel_requested' }), 'order.cancel_approve', {})).toBe(false);
    expect(
      orderShowsCommandResult(
        order({
          state: 'return_approved',
          returnRequest: { state: 'approved', reason: 'mistake on my part', requestedAmountMinor: 250 },
        }),
        'return.approve',
        {},
      ),
    ).toBe(true);
    expect(
      orderShowsCommandResult(
        order({
          state: 'return_received',
          returnRequest: { state: 'received', reason: 'mistake on my part', requestedAmountMinor: 250 },
        }),
        'return.receive',
        {},
      ),
    ).toBe(true);
    expect(
      orderShowsCommandResult(
        order({
          state: 'refunded_external',
          externalRefund: { amountMinor: 189, transactionId: 'PAYPAL-REFUND-189' },
        }),
        'refund.record_external',
        { amountMinor: 189, transactionId: 'PAYPAL-REFUND-189' },
      ),
    ).toBe(true);
    expect(
      orderShowsCommandResult(order({ reviews: [{ rating: 5, text: 'Fast' }] }), 'review.create', {
        rating: 5,
        text: 'Fast',
      }),
    ).toBe(true);
    expect(
      orderShowsCommandResult(order({ reviews: [{ rating: 5, text: 'Fast' }] }), 'review.update', {
        rating: 4,
        text: 'Fast',
      }),
    ).toBe(false);
  });

  it('does not read a PayPal refund of a shipped order as a confirmed delivery', () => {
    const shipped = { carrier: 'Local Courier', trackingNumber: 'LC-1', state: 'shipped' };
    expect(
      orderShowsCommandResult(
        order({ state: 'refunded_external', shipment: shipped }),
        'fulfillment.confirm_delivery',
        {},
      ),
    ).toBe(false);
    expect(
      orderShowsCommandResult(
        order({ state: 'refunded_external', shipment: { ...shipped, state: 'delivered' } }),
        'fulfillment.confirm_delivery',
        {},
      ),
    ).toBe(true);
  });

  it('matches a refund address the buyer just confirmed, ignoring address case', () => {
    const address = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
    const landed = order({ state: 'paid', refundDestination: { address } });
    expect(orderShowsCommandResult(landed, 'refund.confirm_destination', { address })).toBe(true);
    expect(orderShowsCommandResult(landed, 'refund.confirm_destination', { address: address.toLowerCase() })).toBe(
      true,
    );
    expect(
      orderShowsCommandResult(landed, 'refund.confirm_destination', {
        address: '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
      }),
    ).toBe(false);
    expect(orderShowsCommandResult(order({ state: 'paid' }), 'refund.confirm_destination', { address })).toBe(false);
    expect(orderShowsCommandResult(landed, 'refund.confirm_destination', {})).toBe(false);
  });

  it('does not treat an unrecognized command as applied', () => {
    expect(orderShowsCommandResult(order({ state: 'delivered' }), 'fulfillment.confirm_pickup', {})).toBe(false);
  });
});
