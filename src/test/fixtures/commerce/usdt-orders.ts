import type { PaymentFinality } from '@/libs/commerce/usdt-settlement-contract';
import type { MarketplaceOrder, MarketplacePayment } from '@/services/marketplace/marketplace';
import { createOrderFixture, createPaymentFixture } from './orders';

/**
 * Wire-shaped USDT order projections, one per settlement phase, in the
 * snake_case the service sends. They pin the contract the Shop reads from the
 * upcoming service status work (S3) in `usdt-settlement-contract.ts`; when the
 * real payloads land, replace these with captured responses and nothing else
 * has to change.
 */
const USDT_AMOUNT = {
  payment_method: 'usdt',
  payment_asset: 'USDT',
  payment_network: 'arbitrum-one',
  payment_amount_minor: 137_000_000,
  payment_exponent: 6,
  payment_quote_basis: 'parity',
} as const;

export const USDT_WIRE_ORDER_PENDING_PAYMENT = { ...USDT_AMOUNT } as const;

export const USDT_WIRE_ORDER_INCLUDED_NOT_FINAL = { ...USDT_AMOUNT, payment_finality: 'pending' } as const;

export const USDT_WIRE_ORDER_FINAL = { ...USDT_AMOUNT, payment_finality: 'final' } as const;

export const USDT_WIRE_ORDER_REORGED = { ...USDT_AMOUNT, payment_finality: 'reverted' } as const;

/** The command refusal envelope for ship, mark ready or confirm pickup before finality. */
export const USDT_WIRE_PAYMENT_NOT_FINAL_REFUSAL = {
  ok: false,
  error: { code: 'INVALID_STATE', message: 'The payment is not final.', reason: 'payment_not_final' },
} as const;

export type UsdtOrderPhase = 'awaiting' | 'received' | 'final' | 'rechecking';

const FINALITY_BY_PHASE: Record<Exclude<UsdtOrderPhase, 'awaiting'>, PaymentFinality> = {
  received: 'pending',
  final: 'final',
  rechecking: 'reverted',
};

/** A parsed USDT order for the phase, with the payment that goes with it. */
export function createUsdtOrderFixture(
  phase: UsdtOrderPhase,
  overrides: Partial<MarketplaceOrder> = {},
): { order: MarketplaceOrder; payment: MarketplacePayment } {
  const awaiting = phase === 'awaiting';
  const payment = createPaymentFixture(awaiting ? 'awaiting_entitlement' : 'confirmed', {
    adapter: 'paykit',
    locksBundleId: undefined,
  });
  const order = createOrderFixture(awaiting ? 'pending_payment' : 'paid', {
    paymentId: payment.id,
    paymentMethod: 'usdt',
    paymentAsset: 'USDT',
    paymentNetwork: 'arbitrum-one',
    paymentAmountMinor: 137_000_000,
    paymentExponent: 6,
    paymentQuoteBasis: 'parity',
    ...(awaiting ? { holdExpiresAt: '2026-08-20T21:15:00.000Z' } : { paymentFinality: FINALITY_BY_PHASE[phase] }),
    ...overrides,
  });
  return { order, payment };
}
