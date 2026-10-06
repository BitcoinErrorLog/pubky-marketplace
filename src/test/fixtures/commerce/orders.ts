import type { MarketplaceOrder, MarketplacePayment, MarketplaceReceipt } from '@/services/marketplace/marketplace';

export const ORDER_FIXTURE_BUYER = 'b'.repeat(52);
export const ORDER_FIXTURE_SELLER = 's'.repeat(52);

const usd = (amountMinor: number) => ({ amountMinor, currency: 'USD', exponent: 2 });

/**
 * Every order state the transaction contract defines, so each one has a
 * rendered VRT baseline instead of only the states a happy path reaches.
 */
export const ORDER_STATES = [
  'pending_payment',
  'paid',
  'ready_for_pickup',
  'processing',
  'shipped',
  'delivered',
  'completed',
  'cancel_requested',
  'cancelled',
  'return_requested',
  'return_approved',
  'return_received',
  'refunded_external',
  'closed',
] as const satisfies readonly MarketplaceOrder['state'][];

/** Every buyer-visible payment state, including the ones only reachable by timeout or reconciliation. */
export const PAYMENT_STATES = [
  'awaiting_entitlement',
  'detected',
  'confirmed',
  'expired',
  'manual_review',
] as const satisfies readonly MarketplacePayment['state'][];

function uuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, '0');
  return `018f47d2-6a27-7c23-a49d-${hex}`;
}

export function createOrderFixture(
  state: MarketplaceOrder['state'],
  overrides: Partial<MarketplaceOrder> = {},
): MarketplaceOrder {
  const listed = ORDER_STATES.indexOf(state as (typeof ORDER_STATES)[number]);
  // `refunded_partial` is accepted on the order read ahead of the vendored
  // every-state list, so it must still produce a positive revision.
  const stateIndex = listed >= 0 ? listed + 1 : ORDER_STATES.length + 1;
  const isShipped = state === 'shipped' || state === 'delivered' || state === 'completed' || state === 'closed';
  const isReturning = state === 'return_requested' || state === 'return_approved' || state === 'return_received';

  return {
    id: uuid(stateIndex),
    buyerPubky: ORDER_FIXTURE_BUYER,
    sellerPubky: ORDER_FIXTURE_SELLER,
    revision: stateIndex,
    state,
    lines: [
      {
        listingAggregateId: `listing:${ORDER_FIXTURE_SELLER}_boots`,
        listingRevision: 2,
        contentHash: 'a'.repeat(64),
        title: 'Handmade leather boots',
        quantity: 1,
        unitPrice: usd(12_500),
        subtotal: usd(12_500),
      },
    ],
    subtotal: usd(12_500),
    shipping: usd(1_200),
    total: usd(13_700),
    guaranteePolicyVersion: 1,
    paymentId: uuid(100 + stateIndex),
    receiptId: state === 'pending_payment' ? null : uuid(200 + stateIndex),
    // `ready_for_pickup` is the pickup-path state (§A6); every other state
    // fixture rides the shipped path.
    fulfillment: state === 'ready_for_pickup' ? 'pickup' : 'shipping',
    cancellationReason: state === 'cancelled' ? 'Buyer cancelled before handling' : null,
    deliveryAssumed: false,
    nextActor: defaultNextActor(state),
    shipment: isShipped
      ? {
          carrier: 'Local Courier',
          trackingNumber: 'LC-4417-8890',
          state: state === 'shipped' ? 'shipped' : 'delivered',
          shippedAt: '2026-08-14T10:00:00.000Z',
          deliveredAt: state === 'shipped' ? null : '2026-08-17T14:30:00.000Z',
        }
      : null,
    returnRequest: isReturning
      ? {
          state: state === 'return_requested' ? 'requested' : state === 'return_approved' ? 'approved' : 'received',
          reason: 'Item does not match the described condition',
          requestedAmountMinor: 13_700,
          requestedAt: '2026-08-18T09:00:00.000Z',
          updatedAt: '2026-08-19T09:00:00.000Z',
        }
      : null,
    externalRefund:
      state === 'refunded_external'
        ? { amountMinor: 13_700, transactionId: 'f'.repeat(64), recordedAt: '2026-08-19T18:00:00.000Z' }
        : null,
    createdAt: '2026-08-12T08:00:00.000Z',
    updatedAt: '2026-08-19T20:00:00.000Z',
    ...overrides,
  };
}

/** Live durable-service shape for an FX-quoted Bitcoin order projection. */
export function createBitcoinQuotedOrderFixture(): MarketplaceOrder {
  return createOrderFixture('pending_payment', {
    paymentMethod: 'bitcoin',
    bitcoinQuote: {
      quotedSats: 2_588,
      currency: 'USD',
      exponent: 2,
      rate: '77287',
      source: 'blocktank',
      fetchedAt: '2026-09-13T19:14:48.286Z',
      expiresAt: '2026-09-13T20:15:09.050Z',
      spreadBps: 0,
    },
  });
}

export function createPaymentFixture(
  state: MarketplacePayment['state'],
  overrides: Partial<MarketplacePayment> = {},
): MarketplacePayment {
  const stateIndex = PAYMENT_STATES.indexOf(state) + 1;
  return {
    id: uuid(300 + stateIndex),
    orderId: uuid(stateIndex),
    buyerPubky: ORDER_FIXTURE_BUYER,
    sellerPubky: ORDER_FIXTURE_SELLER,
    revision: stateIndex,
    adapter: 'sandbox',
    state,
    confirmations: state === 'confirmed' ? 6 : state === 'detected' ? 0 : 0,
    locksBundleId: uuid(400 + stateIndex),
    amount: usd(13_700),
    createdAt: '2026-08-12T08:00:00.000Z',
    updatedAt: '2026-08-19T20:00:00.000Z',
    ...overrides,
  };
}

export function createReceiptFixture(overrides: Partial<MarketplaceReceipt> = {}): MarketplaceReceipt {
  return {
    id: uuid(500),
    orderId: uuid(2),
    paymentId: uuid(302),
    issuerPubky: ORDER_FIXTURE_SELLER,
    recipientPubky: ORDER_FIXTURE_BUYER,
    total: usd(13_700),
    contentHash: 'c'.repeat(64),
    issuedAt: '2026-08-13T09:00:00.000Z',
    ...overrides,
  };
}

/** One order view per order state, each paired with a plausible payment for that stage. */
export function createOrderViewsForEveryState() {
  return ORDER_STATES.map((state) => ({
    order: createOrderFixture(state),
    payment: createPaymentFixture(state === 'pending_payment' ? 'awaiting_entitlement' : 'confirmed'),
    receipt: state === 'pending_payment' ? null : createReceiptFixture(),
  }));
}

/**
 * One order view per payment state, so every payment label has a baseline.
 * Each order carries a distinct id: most payment states pair with the same
 * order state, which would otherwise produce duplicate React keys in a list.
 */
export function createOrderViewsForEveryPaymentState() {
  return PAYMENT_STATES.map((state, index) => {
    const payment = createPaymentFixture(state);
    return {
      order: createOrderFixture(state === 'confirmed' ? 'paid' : 'pending_payment', {
        id: uuid(600 + index),
        paymentId: payment.id,
      }),
      payment,
      receipt: null,
    };
  });
}

function defaultNextActor(state: MarketplaceOrder['state']): MarketplaceOrder['nextActor'] {
  switch (state) {
    case 'pending_payment':
    case 'shipped':
    // A pickup order in `ready_for_pickup` waits on the buyer to confirm the
    // handover (the service's `next_actor` rule, §A6).
    case 'ready_for_pickup':
      return 'buyer';
    case 'delivered':
      return 'none';
    case 'paid':
    case 'processing':
    case 'cancel_requested':
    case 'return_requested':
    case 'return_approved':
    case 'return_received':
      return 'seller';
    case 'completed':
    case 'cancelled':
    case 'refunded_external':
    case 'refunded_partial':
    case 'closed':
      return 'none';
  }
}
