import { z } from 'zod';
import { OTHER_CARRIER_ID, SHIPPING_CARRIERS } from '@/libs/commerce/carriers';
import { isArbitrumTxHash, USDT_REFUND_COPY } from '@/libs/commerce/usdt-refund';

const carrierIds = SHIPPING_CARRIERS.map(({ id }) => id) as [string, ...string[]];

export const marketplaceOrderActionSchema = z
  .object({
    action: z.enum(['cancel', 'ship', 'return', 'refund', 'review', 'review_edit']),
    reason: z.string().trim().max(2_000),
    /** Curated carrier id from the registry, or `other` with a free-text name below. */
    carrierChoice: z.enum(carrierIds),
    carrier: z.string().trim().max(100),
    trackingNumber: z.string().trim().max(200),
    amount: z.string().trim(),
    transactionId: z.string().trim().max(200),
    rating: z.string().trim(),
    text: z.string().trim().max(5_000),
    /**
     * Buyer-side amount-band opt-in (ratified D2): rendered only when the
     * seller's standing consent allows bands at all; the attestation carries
     * a band only when both sides agreed.
     */
    allowAmountBand: z.boolean(),
  })
  .superRefine((data, context) => {
    if (['cancel', 'return'].includes(data.action) && !data.reason) {
      context.addIssue({ code: 'custom', path: ['reason'], message: 'Reason is required.' });
    }
    if (data.action === 'ship') {
      if (!data.trackingNumber) {
        context.addIssue({ code: 'custom', path: ['trackingNumber'], message: 'The tracking number is required.' });
      }
      if (data.carrierChoice === OTHER_CARRIER_ID && !data.carrier) {
        context.addIssue({ code: 'custom', path: ['carrier'], message: 'Name the carrier.' });
      }
    }
    if (data.action === 'refund') {
      if (!/^\d+(?:\.\d{1,2})?$/.test(data.amount)) {
        context.addIssue({ code: 'custom', path: ['amount'], message: 'Enter a valid refund amount.' });
      }
    }
    if (['review', 'review_edit'].includes(data.action) && (!/^[1-5]$/.test(data.rating) || !data.text)) {
      context.addIssue({ code: 'custom', path: ['rating'], message: 'Rating and review text are required.' });
    }
  });

export type MarketplaceOrderActionData = z.infer<typeof marketplaceOrderActionSchema>;

/** Order total the refund dialog is capped against. The service stores one partial refund when `1 <= amount_minor <= total`. */
export type MarketplaceRefundCap = {
  amountMinor: number;
  exponent: number;
};

export function majorToMinor(amount: string, exponent: number): number {
  return Math.round(Number(amount) * 10 ** exponent);
}

export function formatOrderMajor(total: MarketplaceRefundCap): string {
  return (total.amountMinor / 10 ** total.exponent).toFixed(Math.max(0, total.exponent));
}

/**
 * Same action schema, plus the service rules for `refund.record_external`.
 * The entered amount is what has not been recorded yet: the whole refund,
 * or what was refunded outside PayPal after PayPal refunds (`refundedMinor`).
 * The recorded total, `refundedMinor` plus the entry, must be positive and
 * at most the order total.
 */
export function marketplaceOrderActionSchemaFor(
  total: MarketplaceRefundCap,
  refundedMinor = 0,
  rail: 'paypal' | 'usdt' | 'other' = 'other',
) {
  return marketplaceOrderActionSchema.superRefine((data, context) => {
    if (data.action !== 'refund') return;
    // A USDT refund is recorded with the Arbitrum transaction hash, which the
    // service checks as `0x` + 64 hex; any other rail takes free evidence.
    if (rail === 'usdt') {
      if (!isArbitrumTxHash(data.transactionId)) {
        context.addIssue({ code: 'custom', path: ['transactionId'], message: USDT_REFUND_COPY.referenceRequired });
      }
    } else if (data.transactionId.length < 8) {
      context.addIssue({ code: 'custom', path: ['transactionId'], message: 'Transaction evidence is required.' });
    }
    if (!/^\d+(?:\.\d{1,2})?$/.test(data.amount)) return;
    if (total.exponent === 0 && !/^\d+$/.test(data.amount)) {
      context.addIssue({ code: 'custom', path: ['amount'], message: 'Enter a whole number.' });
      return;
    }
    const amountMinor = majorToMinor(data.amount, total.exponent);
    if (refundedMinor === 0 && amountMinor <= 0) {
      context.addIssue({ code: 'custom', path: ['amount'], message: 'Enter a valid refund amount.' });
      return;
    }
    if (!Number.isSafeInteger(amountMinor) || refundedMinor + amountMinor > total.amountMinor) {
      context.addIssue({
        code: 'custom',
        path: ['amount'],
        message:
          refundedMinor === 0
            ? 'Enter a refund up to the order total.'
            : rail === 'paypal'
              ? 'Enter a refund up to the amount PayPal has not refunded.'
              : 'Enter a refund up to the amount not yet recorded.',
      });
    }
  });
}

/**
 * What PayPal refund notifications already recorded on an order the seller
 * can still record a refund on. A seller's own record always moves the order
 * to `refunded_external`, so an `externalRefund` on `return_received` or
 * `cancelled` is PayPal's running sum.
 */
export function paypalRefundedMinor(order: { externalRefund?: { amountMinor: number } | null }): number {
  return order.externalRefund?.amountMinor ?? 0;
}

export const marketplaceOrderActionDefaults: MarketplaceOrderActionData = {
  action: 'cancel',
  reason: '',
  carrierChoice: 'usps',
  carrier: '',
  trackingNumber: '',
  amount: '',
  transactionId: '',
  rating: '5',
  text: '',
  allowAmountBand: false,
};
