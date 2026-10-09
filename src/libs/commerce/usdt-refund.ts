import { keccak_256 } from '@noble/hashes/sha3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { z } from 'zod';
import { formatCommerceMoney } from '@/libs/commerce/format';
import { formatUsdt, USDT_EXPONENT } from '@/libs/commerce/payment-options';

/**
 * USDT refund domain (docs/ecommerce/usdt-payments.md, plan §2.6). The
 * marketplace never holds funds, so a refund is two human steps the Shop only
 * records: the buyer confirms an Arbitrum One USDT address on the order page,
 * and the seller sends the refund from Bitkit and records the Arbitrum
 * transaction hash. Nothing here verifies a transfer on-chain; every string
 * says "recorded", never "verified" or "confirmed on Arbitrum".
 *
 * Wire contract with the service's S6 slice (pinned here and in
 * `src/test/fixtures/commerce/usdt-refund.wire.ts`):
 *
 * - Command `refund.confirm_destination`, buyer only, payload
 *   `{ order_id, address }` (camelCased in the Shop). The buyer may replace the
 *   address until a refund is recorded; afterwards the service refuses with
 *   `INVALID_STATE`.
 * - Participant order projection `refund_destination`:
 *   `{ address, network: 'arbitrum-one', asset: 'USDT', source, confirmed_at }`,
 *   null or absent until confirmed. `source` is `buyer_entered` today and is
 *   only ever displayed, never branched on, so a later source never hides an
 *   address.
 * - On a USDT order `refund.record_external` carries the Arbitrum transaction
 *   hash (`0x` + 64 hex, lowercase on the wire) as `transaction_id`, and the
 *   service refuses it without a confirmed destination.
 * - Closed refusal reasons: `refund_destination_required`,
 *   `invalid_refund_destination`, `invalid_refund_reference`.
 */

export const REFUND_DESTINATION_ASSET = 'USDT';
export const REFUND_DESTINATION_NETWORK = 'arbitrum-one';
export const CONFIRM_REFUND_DESTINATION_KIND = 'refund.confirm_destination';

export const ARBITRUM_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
export const ARBITRUM_TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export const refundDestinationSchema = z.object({
  address: z.string().regex(ARBITRUM_ADDRESS_PATTERN),
  network: z.literal(REFUND_DESTINATION_NETWORK),
  asset: z.literal(REFUND_DESTINATION_ASSET),
  source: z.string().min(1),
  confirmedAt: z.string().min(1),
});

export type RefundDestination = z.infer<typeof refundDestinationSchema>;

/**
 * Order projection fields for the refund address. Tolerant like the other
 * display-only payment fields: a value the Shop cannot read is dropped for
 * that order and never fails the order parse.
 *
 * `paymentAddress` is the buyer's own paying address when the service knows
 * it. The S6 slice does not send it (rc10 status exposes no payer address,
 * plan §2.6 / N2), so the "send it back to the address I paid from" choice
 * stays hidden until a service starts sending it.
 */
export const refundDestinationFieldsShape = {
  refundDestination: refundDestinationSchema.nullish().catch(undefined),
  paymentAddress: z.string().regex(ARBITRUM_ADDRESS_PATTERN).nullish().catch(undefined),
};

function isEip55Checksummed(address: string): boolean {
  const body = address.slice(2);
  const hash = bytesToHex(keccak_256(utf8ToBytes(body.toLowerCase())));
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (!/[a-f]/i.test(character)) continue;
    const expected = Number.parseInt(hash[index], 16) >= 8 ? character.toUpperCase() : character.toLowerCase();
    if (character !== expected) return false;
  }
  return true;
}

/**
 * `0x` + 40 hex. A mixed-case address must carry a correct EIP-55 checksum
 * (a typo is caught before it can cost the buyer their refund); all-lowercase
 * and all-uppercase addresses carry no checksum and are accepted as typed.
 */
export function isValidArbitrumAddress(value: string): boolean {
  if (!ARBITRUM_ADDRESS_PATTERN.test(value)) return false;
  const body = value.slice(2);
  const isMixedCase = body !== body.toLowerCase() && body !== body.toUpperCase();
  return !isMixedCase || isEip55Checksummed(value);
}

export function isArbitrumTxHash(value: string): boolean {
  return ARBITRUM_TX_HASH_PATTERN.test(value);
}

/** The service stores and compares the lowercase form of a transaction hash. */
export function normalizeArbitrumTxHash(value: string): string {
  return value.trim().toLowerCase();
}

export function sameArbitrumAddress(left: string | null | undefined, right: string | null | undefined): boolean {
  return !!left && !!right && left.toLowerCase() === right.toLowerCase();
}

export type UsdtRefundOrder = {
  state: string;
  total: { amountMinor: number; currency: string; exponent: number };
  paymentAsset?: string | null;
  receiptId?: string | null;
  refundDestination?: RefundDestination | null;
  paymentAddress?: string | null;
  returnRequest?: { state: string; requestedAmountMinor: number } | null;
  externalRefund?: { amountMinor: number; transactionId: string } | null;
};

/**
 * The refund-address surfaces belong to orders the service projects as paid
 * in USDT. They are never gated by the new-offer flag: a USDT order that
 * exists must be refundable after the flag flips (plan §3, "Off never strands
 * money"). Bitcoin, PayPal and Stripe orders never carry `paymentAsset`.
 */
export function isUsdtRefundOrder(order: { paymentAsset?: string | null }): boolean {
  return order.paymentAsset === REFUND_DESTINATION_ASSET;
}

/** States that are only reachable once the buyer's money has settled or is under review. */
const SETTLED_STATES = new Set([
  'paid',
  'processing',
  'ready_for_pickup',
  'shipped',
  'delivered',
  'completed',
  'cancel_requested',
  'return_requested',
  'return_approved',
  'return_received',
  'refunded_external',
  'refunded_partial',
]);

/** States where a refund is plainly on its way, so the address is the next step. */
const REFUND_DUE_STATES = new Set([
  'cancel_requested',
  'cancelled',
  'return_requested',
  'return_approved',
  'return_received',
]);

/** `cancelled` and `closed` can also mean "never paid"; only a paid order has a receipt. */
function hasSettledPayment(order: UsdtRefundOrder, paymentInReview: boolean): boolean {
  if (SETTLED_STATES.has(order.state)) return true;
  if (order.state === 'cancelled' || order.state === 'closed') return !!order.receiptId;
  return order.state === 'pending_payment' && paymentInReview;
}

export type UsdtRefundSurface =
  | { kind: 'hidden' }
  | {
      kind: 'buyer';
      /** `recorded` once the seller recorded the refund; the address can no longer change. */
      phase: 'needed' | 'confirmed' | 'recorded';
      refundDue: boolean;
    }
  | { kind: 'seller'; phase: 'waiting' | 'confirmed' | 'recorded' };

/**
 * What the refund-address panel shows for a viewer. `paymentInReview` is the
 * payment projection's `manual_review` state: late or mismatched money the
 * seller may have to return (plan §2.6, flow step 1).
 */
export function usdtRefundSurface(
  order: UsdtRefundOrder,
  isBuyer: boolean,
  paymentInReview: boolean,
): UsdtRefundSurface {
  if (!isUsdtRefundOrder(order) || !hasSettledPayment(order, paymentInReview)) return { kind: 'hidden' };
  const recorded = !!order.externalRefund;
  const refundDue = REFUND_DUE_STATES.has(order.state) || paymentInReview;
  if (isBuyer) {
    return {
      kind: 'buyer',
      phase: recorded ? 'recorded' : order.refundDestination ? 'confirmed' : 'needed',
      refundDue,
    };
  }
  if (!order.refundDestination && !refundDue && !recorded) return { kind: 'hidden' };
  return { kind: 'seller', phase: recorded ? 'recorded' : order.refundDestination ? 'confirmed' : 'waiting' };
}

/**
 * Order totals for USDT are USD at exact parity: one cent is 10,000 millionths
 * of a USDT (plan §2.2). Any other currency has no parity amount.
 */
export function usdtParityMillionths(money: {
  amountMinor: number;
  currency: string;
  exponent: number;
}): number | null {
  if (money.currency !== 'USD' || money.exponent !== 2) return null;
  const millionths = money.amountMinor * 10 ** (USDT_EXPONENT - money.exponent);
  return Number.isSafeInteger(millionths) && millionths >= 0 ? millionths : null;
}

export function formatUsdtParity(money: { amountMinor: number; currency: string; exponent: number }): string | null {
  const millionths = usdtParityMillionths(money);
  return millionths === null ? null : formatUsdt(millionths);
}

/** The amount the seller is asked to send: the requested return amount, else the whole order. */
export function usdtRefundDueMoney(order: UsdtRefundOrder): UsdtRefundOrder['total'] {
  const requested = order.returnRequest && order.returnRequest.state !== 'refunded' ? order.returnRequest : null;
  return requested ? { ...order.total, amountMinor: requested.requestedAmountMinor } : order.total;
}

export const USDT_REFUND_COPY = {
  buyerTitle: 'Refund address',
  buyerNeededDue: 'Confirm where your USDT refund should go. The seller sends it and records it here.',
  buyerNeeded:
    'If you are ever refunded, the seller sends it to the address you confirm here. You can confirm it now or when a refund is due.',
  buyerConfirmed: 'Your refund address is confirmed. The seller sends the refund there and records it on this order.',
  buyerRecorded: 'Your refund address is locked in because the seller has recorded a refund.',
  sellerTitle: 'Buyer refund address',
  sellerWaiting: "Ask the buyer to confirm a refund address first. It's on their order page.",
  sellerAwaitingBuyer: "The buyer hasn't confirmed a refund address yet.",
  sellerConfirmed: 'Send this refund from Bitkit, then record the Arbitrum transaction hash with Record refund.',
  sellerRecorded: 'You recorded a refund to this address. The Shop has not checked it on Arbitrum.',
  networkWarning:
    'If this is an exchange deposit address, check that the exchange accepts USDT on Arbitrum One. Funds sent on the wrong network can be lost.',
  networkConfirmation: 'This address accepts USDT on Arbitrum One',
  networkConfirmationRequired: 'Confirm that this address accepts USDT on Arbitrum One.',
  addressRequired: 'Enter an Arbitrum One address.',
  addressInvalid: "That isn't a valid Arbitrum address. Check it and try again.",
  anotherAddressChoice: 'Send it to another Arbitrum One USDT address',
  originalAddressChoice: 'Send it back to the address I paid from',
  recordedBySeller: 'Recorded by the seller',
  notChecked: "The Shop hasn't checked it on Arbitrum.",
  referenceLabel: 'Arbitrum transaction hash',
  referenceRequired: 'Enter the Arbitrum transaction hash (0x followed by 64 characters).',
  recordHint: 'Send the refund from Bitkit to this address first, then record its Arbitrum transaction hash here.',
} as const;

export const USDT_REFUND_REFUSAL_COPY: ReadonlyMap<string, string> = new Map([
  ['refund_destination_required', USDT_REFUND_COPY.sellerWaiting],
  ['invalid_refund_destination', USDT_REFUND_COPY.addressInvalid],
  ['invalid_refund_reference', USDT_REFUND_COPY.referenceRequired],
]);

/**
 * The static copy for a USDT refund refusal from `refund.confirm_destination`
 * or `refund.record_external`. Reads the closed `reason` (or a message that is
 * exactly that token) and never echoes service text, which could carry the
 * rejected address.
 */
export function usdtRefundRefusalMessage(error: { reason?: unknown; message?: unknown }): string | null {
  for (const candidate of [error.reason, error.message]) {
    if (typeof candidate !== 'string') continue;
    const copy = USDT_REFUND_REFUSAL_COPY.get(candidate.trim());
    if (copy) return copy;
  }
  return null;
}

/**
 * The buyer's receipt line for a recorded USDT refund. It states what the
 * seller recorded and that nobody checked it; the Paykit `refunded` outcome is
 * an annotation, never an independently verified on-chain refund (D5).
 */
export function usdtRefundRecordLine(order: UsdtRefundOrder): string | null {
  const refund = order.externalRefund;
  if (!refund || !isUsdtRefundOrder(order)) return null;
  const amount = formatUsdtParity({ ...order.total, amountMinor: refund.amountMinor });
  const destination = order.refundDestination ? ` to ${order.refundDestination.address}` : '';
  const isPartial = order.state === 'refunded_partial' || refund.amountMinor < order.total.amountMinor;
  const scope = isPartial
    ? ` (${formatCommerceMoney({ ...order.total, amountMinor: refund.amountMinor })} of ${formatCommerceMoney(order.total)})`
    : '';
  const what = amount ? `a refund of ${amount}${scope}` : `a refund${scope}`;
  return `The seller recorded ${what}${destination} (transaction ${refund.transactionId}). ${USDT_REFUND_COPY.notChecked}`;
}
