import { z } from 'zod';
import { ValidationErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';

/**
 * Payment option model (docs/ecommerce/usdt-payments.md). A buyer-facing
 * payment method (`PaymentMethodKind`, the wire `payment_method`) is a label;
 * what the buyer actually sends and where it settles live on separate axes so
 * a new fiat method, stablecoin or network is a new value here rather than a
 * new special case. The canonical id is `{method}.{asset}.{network}`, with
 * `fiat` standing for "the order's own fiat currency".
 */

/** The method-label values the service may send, in the order the Shop prefers them. */
export const PAYMENT_METHOD_KINDS = ['bitcoin', 'usdt', 'paypal', 'stripe'] as const;

/** What the buyer sends on a Paykit rail. Fiat methods pay in the order's own currency and carry no asset. */
export const PAYMENT_ASSETS = ['BTC', 'USDT'] as const;
export type PaymentAsset = (typeof PAYMENT_ASSETS)[number];

/** Where the asset settles. USDT is USDT0 on Arbitrum One (chain 42161). */
export const PAYMENT_NETWORKS = ['bitcoin', 'arbitrum-one'] as const;
export type PaymentNetwork = (typeof PAYMENT_NETWORKS)[number];

/**
 * Who decides "paid". `locked` is a Lock Server entitlement; every other mode
 * is verified by the service itself ("unlocked"). Locks is a verification
 * gate, never escrow: no mode here means the marketplace holds funds.
 */
export const SETTLEMENT_MODES = ['locked', 'paykit', 'gateway-notified', 'processor', 'seller-attested'] as const;
export type SettlementMode = (typeof SETTLEMENT_MODES)[number];

export const PAYMENT_OPTION_IDS = [
  'paykit.btc.bitcoin',
  'paykit.usdt.arbitrum-one',
  'paypal.fiat',
  'stripe.fiat',
] as const;
export type PaymentOptionId = (typeof PAYMENT_OPTION_IDS)[number];

export const USDT_PAYMENT_OPTION_ID = 'paykit.usdt.arbitrum-one' satisfies PaymentOptionId;

type PaymentOptionMethod = (typeof PAYMENT_METHOD_KINDS)[number];

export type PaymentOption = {
  id: PaymentOptionId;
  method: PaymentOptionMethod;
  /** Null for a fiat method: the asset is the order's currency. */
  asset: PaymentAsset | null;
  network: PaymentNetwork | null;
};

export const PAYMENT_OPTIONS: Record<PaymentOptionId, PaymentOption> = {
  'paykit.btc.bitcoin': { id: 'paykit.btc.bitcoin', method: 'bitcoin', asset: 'BTC', network: 'bitcoin' },
  'paykit.usdt.arbitrum-one': {
    id: 'paykit.usdt.arbitrum-one',
    method: 'usdt',
    asset: 'USDT',
    network: 'arbitrum-one',
  },
  'paypal.fiat': { id: 'paypal.fiat', method: 'paypal', asset: null, network: null },
  'stripe.fiat': { id: 'stripe.fiat', method: 'stripe', asset: null, network: null },
};

const OPTION_ID_BY_METHOD: Record<PaymentOptionMethod, PaymentOptionId> = {
  bitcoin: 'paykit.btc.bitcoin',
  usdt: 'paykit.usdt.arbitrum-one',
  paypal: 'paypal.fiat',
  stripe: 'stripe.fiat',
};

/** The option a method label stands for. Each method label maps to exactly one option today. */
export function paymentOptionForMethod(method: PaymentOptionMethod): PaymentOption {
  return PAYMENT_OPTIONS[OPTION_ID_BY_METHOD[method]];
}

/** Parses an option id; null for anything the Shop does not know, so a newer service never breaks a read. */
export function parsePaymentOptionId(value: unknown): PaymentOptionId | null {
  return (PAYMENT_OPTION_IDS as readonly unknown[]).includes(value) ? (value as PaymentOptionId) : null;
}

/**
 * Order projection fields that describe how the buyer pays. Every field is
 * display-only and tolerant: a value the Shop does not recognise is dropped
 * for that order and never fails the order parse. All are null/absent for
 * Bitcoin, PayPal and Stripe orders.
 */
export const paymentAssetFieldsShape = {
  paymentAsset: z.enum(PAYMENT_ASSETS).nullish().catch(undefined),
  paymentNetwork: z.enum(PAYMENT_NETWORKS).nullish().catch(undefined),
  paymentAmountMinor: z.number().int().nonnegative().nullish().catch(undefined),
  paymentExponent: z.number().int().nonnegative().nullish().catch(undefined),
  paymentQuoteBasis: z.enum(['parity']).nullish().catch(undefined),
};

export const USDT_EXPONENT = 6;
const USDT_UNIT = 10 ** USDT_EXPONENT;

/**
 * Renders USDT millionths ("25000000" minor units) as "25.000000 USDT": always
 * six decimals, no grouping, so an exact amount can be read back digit for digit.
 */
export function formatUsdt(millionths: number): string {
  if (!Number.isSafeInteger(millionths) || millionths < 0) {
    throw Err.validation(
      ValidationErrorCode.INVALID_INPUT,
      'A USDT amount must be a non-negative whole number of millionths.',
      { service: ErrorService.Local, operation: 'formatUsdt', context: { millionths } },
    );
  }
  const whole = Math.floor(millionths / USDT_UNIT);
  const fraction = String(millionths % USDT_UNIT).padStart(USDT_EXPONENT, '0');
  return `${whole}.${fraction} USDT`;
}
