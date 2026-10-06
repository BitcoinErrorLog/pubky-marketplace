import { formatCommerceMoney } from './format';
import { formatBitcoinAmount, hasSameAsset, isBitcoinAsset, MAX_BITCOIN_BASE_UNITS } from './pricing';
import type { CommerceMoney } from './transaction-contracts';

/**
 * A Bitcoin payment adds a random 1–999 sat amount so the seller's wallet
 * can match that payment. The checkout total is the list price. The exact
 * figure exists only after the order is placed.
 */
export const BITCOIN_PAYMENT_CODE_MIN_SATS = 1;
export const BITCOIN_PAYMENT_CODE_MAX_SATS = 999;

export const BITCOIN_PAYMENT_CODE_CHECKOUT_NOTE =
  'The payment adds a small unique amount of 1–999 sats. The exact amount appears when you place the order.';

/** Says what the payment code line of the amount breakdown is, with the figure drawn for this order. */
export function bitcoinPaymentCodeExplanation(paymentCode: CommerceMoney): string {
  return `Payment code ${formatBitcoinAwareMoney(paymentCode)}: a small unique amount (${BITCOIN_PAYMENT_CODE_MIN_SATS}–${BITCOIN_PAYMENT_CODE_MAX_SATS} sats) added so the seller's wallet can match your payment. It is included in the total you send.`;
}

const SATOSHI: CommerceMoney = { amountMinor: 0, currency: 'SAT', exponent: 0 };

export type BitcoinPaymentOrder = {
  paymentMethod?: 'bitcoin' | 'stripe' | 'paypal' | null;
  subtotal: CommerceMoney;
  shipping: CommerceMoney;
  total?: CommerceMoney;
  merchandiseTotal?: CommerceMoney | null;
  bitcoinPayable?: CommerceMoney | null;
  paykitTotalSats?: number | null;
  bitcoinQuote?: { quotedSats: number | null } | null;
};

export type BitcoinPaymentBreakdown = {
  items: CommerceMoney;
  shipping: CommerceMoney;
  paymentCode: CommerceMoney;
  payable: CommerceMoney;
};

/** BTC at exponent 8 and SAT at exponent 0 are both integer satoshis. */
export function satoshiCount(money: CommerceMoney | null | undefined): number | null {
  if (!money) return null;
  if (!Number.isSafeInteger(money.amountMinor) || money.amountMinor < 0) return null;
  if (money.amountMinor > MAX_BITCOIN_BASE_UNITS) return null;
  if (isBitcoinAsset(money)) return money.amountMinor;
  if (money.currency === 'SAT' && money.exponent === 0) return money.amountMinor;
  return null;
}

export function formatBitcoinAwareMoney(money: CommerceMoney): string {
  const sats = satoshiCount(money);
  return sats === null ? formatCommerceMoney(money) : formatBitcoinAmount(sats);
}

export type OrderAmountEntry = {
  amountMinor: number;
  exponent: number;
  unitLabel: string;
};

/**
 * The amount a refund or return form records. A Bitcoin order is integer
 * satoshis (the payable, including the payment code). Any other rail keeps
 * the order total's own currency and exponent.
 */
export function orderAmountEntry(order: BitcoinPaymentOrder & { total: CommerceMoney }): OrderAmountEntry {
  const breakdown = bitcoinPaymentBreakdown(order);
  if (breakdown) {
    const sats = satoshiCount(breakdown.payable);
    if (sats !== null) return { amountMinor: sats, exponent: 0, unitLabel: '₿' };
  }
  if (order.paymentMethod === 'bitcoin') {
    const sats = satoshiCount(order.total);
    if (sats !== null) return { amountMinor: sats, exponent: 0, unitLabel: '₿' };
  }
  return { amountMinor: order.total.amountMinor, exponent: order.total.exponent, unitLabel: order.total.currency };
}

export function formatBitcoinAmountBreakdown(breakdown: BitcoinPaymentBreakdown): string {
  return `Items ${formatBitcoinAwareMoney(breakdown.items)} · Shipping ${formatBitcoinAwareMoney(breakdown.shipping)} · Payment code ${formatBitcoinAwareMoney(breakdown.paymentCode)} = Total ${formatBitcoinAwareMoney(breakdown.payable)}`;
}

function money(amountMinor: number, asset: Pick<CommerceMoney, 'currency' | 'exponent'>): CommerceMoney {
  return { amountMinor, currency: asset.currency, exponent: asset.exponent };
}

function payableSats(order: BitcoinPaymentOrder): number | null {
  const fromPayable = satoshiCount(order.bitcoinPayable);
  if (fromPayable !== null && fromPayable > 0) return fromPayable;
  const raw = order.paykitTotalSats;
  if (typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 && raw <= MAX_BITCOIN_BASE_UNITS) return raw;
  return null;
}

/**
 * Items + shipping + payment code = the exact bitcoin amount, once the
 * service has drawn the code. Returns null before that draw, for any other
 * rail, and when the parts would not add up.
 */
export function bitcoinPaymentBreakdown(order: BitcoinPaymentOrder): BitcoinPaymentBreakdown | null {
  if (order.paymentMethod !== 'bitcoin') return null;
  const payable = payableSats(order);
  if (payable === null) return null;

  const itemsSats = satoshiCount(order.subtotal);
  const shippingSats = satoshiCount(order.shipping);
  if (itemsSats !== null && shippingSats !== null && hasSameAsset(order.subtotal, order.shipping)) {
    const merchandiseFromParts = itemsSats + shippingSats;
    const merchandiseFromField = satoshiCount(order.merchandiseTotal);
    if (merchandiseFromField !== null && merchandiseFromField !== merchandiseFromParts) return null;
    const code = payable - merchandiseFromParts;
    if (!Number.isSafeInteger(code) || code < BITCOIN_PAYMENT_CODE_MIN_SATS) return null;
    return {
      items: order.subtotal,
      shipping: order.shipping,
      paymentCode: money(code, order.subtotal),
      payable: money(payable, order.subtotal),
    };
  }

  const quoted = order.bitcoinQuote?.quotedSats;
  if (typeof quoted !== 'number' || !Number.isSafeInteger(quoted) || quoted <= 0) return null;
  if (!hasSameAsset(order.subtotal, order.shipping)) return null;
  const code = payable - quoted;
  if (!Number.isSafeInteger(code) || code < BITCOIN_PAYMENT_CODE_MIN_SATS) return null;
  return {
    items: order.subtotal,
    shipping: order.shipping,
    paymentCode: money(code, SATOSHI),
    payable: money(payable, SATOSHI),
  };
}
