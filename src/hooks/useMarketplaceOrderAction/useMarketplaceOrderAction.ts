'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { orderAmountEntry } from '@/libs/commerce/bitcoin-payment-code';
import { getCarrierById, OTHER_CARRIER_ID } from '@/libs/commerce/carriers';
import { isUsdtRefundOrder, normalizeArbitrumTxHash } from '@/libs/commerce/usdt-refund';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';
import {
  formatOrderMajor,
  majorToMinor,
  type MarketplaceOrderActionData,
  marketplaceOrderActionDefaults,
  marketplaceOrderActionSchemaFor,
  paypalRefundedMinor,
} from './useMarketplaceOrderAction.types';

export function useMarketplaceOrderAction(
  order: MarketplaceOrder,
  actOnOrder: (order: MarketplaceOrder, kind: string, payload: Record<string, unknown>) => Promise<boolean>,
) {
  const refundedMinor = paypalRefundedMinor(order);
  const entry = orderAmountEntry(order);
  const isUsdt = isUsdtRefundOrder(order);
  const rail = isUsdt ? 'usdt' : order.paymentMethod === 'paypal' ? 'paypal' : 'other';
  const form = useForm<MarketplaceOrderActionData>({
    resolver: zodResolver(marketplaceOrderActionSchemaFor(entry, refundedMinor, rail)),
    defaultValues: marketplaceOrderActionDefaults,
    mode: 'onChange',
  });

  const setAction = (
    action: MarketplaceOrderActionData['action'],
    overrides: Partial<MarketplaceOrderActionData> = {},
  ) => {
    form.reset({
      ...marketplaceOrderActionDefaults,
      action,
      amount:
        action === 'refund'
          ? formatOrderMajor({
              amountMinor: Math.max(0, entry.amountMinor - refundedMinor),
              exponent: entry.exponent,
            })
          : formatOrderMajor(entry),
      ...overrides,
    });
  };

  const submit = async (): Promise<boolean> => {
    let succeeded = false;
    await form.handleSubmit(async (data) => {
      switch (data.action) {
        case 'cancel':
          succeeded = await actOnOrder(order, 'order.cancel_request', { reason: data.reason });
          break;
        case 'ship':
          // The service's `carrier` field is a structured free string; the
          // curated select writes the registry's canonical display name into
          // it (resolvable back to a tracking link on the buyer side), and
          // "Other" passes the seller's own carrier name through verbatim.
          succeeded = await actOnOrder(order, 'fulfillment.ship', {
            carrier:
              data.carrierChoice === OTHER_CARRIER_ID
                ? data.carrier
                : (getCarrierById(data.carrierChoice)?.name ?? data.carrier),
            trackingNumber: data.trackingNumber,
          });
          break;
        case 'return':
          succeeded = await actOnOrder(order, 'return.request', {
            reason: data.reason,
            requestedAmountMinor: majorToMinor(data.amount, entry.exponent),
          });
          break;
        case 'refund':
          // The record replaces PayPal's running sum, so it carries the
          // recorded total, never below what PayPal already refunded.
          succeeded = await actOnOrder(order, 'refund.record_external', {
            amountMinor: refundedMinor + majorToMinor(data.amount, entry.exponent),
            transactionId: isUsdt ? normalizeArbitrumTxHash(data.transactionId) : data.transactionId,
          });
          break;
        case 'review':
          succeeded = await actOnOrder(order, 'review.create', {
            rating: Number(data.rating),
            text: data.text,
            // D2 both-sides consent: this is only half the gate — the
            // service includes a band only when the seller also consented.
            allowAmountBand: data.allowAmountBand,
          });
          break;
        case 'review_edit':
          // Durable service only (24h edit window). `actOnOrder` sources
          // `expected_revision` from the loaded order. A revision conflict
          // re-reads the order and succeeds when that review is already there.
          succeeded = await actOnOrder(order, 'review.update', {
            rating: Number(data.rating),
            text: data.text,
          });
          break;
      }
    })();
    return succeeded;
  };

  return { form, setAction, submit };
}
