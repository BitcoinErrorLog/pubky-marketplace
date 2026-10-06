import type {
  AuctionState,
  DropState,
  ListingState,
  OfferState,
  OrderState,
  PaymentState,
  ReservationState,
  ReturnState,
} from './transaction-contracts';

type TransitionMap<State extends string> = Readonly<Record<State, readonly State[]>>;

// -----------------------------------------------------------------------------
// Transition tables.
//
// These mirror the Marketplace Transaction Service's canonical contract
// artifact (vendored at `./contracts/state-machines.json`); the service is the
// authority when the two disagree (ADR-0022). Each table lists exactly the
// reachable `from -> to` edges — whether a transition is driven by a client
// command or a server-time sweep is the artifact's concern, not this table's.
// `state-machines.contract.test.ts` fails whenever a table drifts from the
// artifact.
// -----------------------------------------------------------------------------

export const listingTransitions = {
  available: ['reserved'],
  reserved: ['available', 'sold'],
  // Approving the cancellation of a paid order returns its quantity to stock.
  // The durable service moves quantity reserved -> sold on payment confirmation,
  // so releasing it again is a sold -> available edge rather than reserved ->
  // available. Driven by order.cancel_approve and — for the Wave 7 unilateral
  // pickup exits (terms-change cancel and bounded post-reveal withdrawal,
  // local pickup design §A3), which reuse approve's release path verbatim —
  // by order.cancel_request.
  sold: ['available'],
} as const satisfies TransitionMap<ListingState>;

export const reservationTransitions = {
  active: ['converted', 'released', 'expired'],
  converted: [],
  released: [],
  expired: [],
} as const satisfies TransitionMap<ReservationState>;

export const offerTransitions = {
  pending: ['countered', 'accepted', 'rejected', 'withdrawn', 'expired'],
  countered: ['countered', 'accepted', 'rejected', 'withdrawn', 'expired'],
  accepted: [],
  rejected: [],
  withdrawn: [],
  expired: [],
} as const satisfies TransitionMap<OfferState>;

/** `cancelled` is declared but unreachable — reserved for a future command. */
export const auctionTransitions = {
  scheduled: ['active'],
  active: ['sold', 'unsold'],
  sold: [],
  unsold: [],
  cancelled: [],
} as const satisfies TransitionMap<AuctionState>;

export const paymentTransitions = {
  awaiting_entitlement: ['detected', 'confirmed', 'expired', 'manual_review'],
  detected: ['confirmed', 'manual_review'],
  confirmed: [],
  // A Locks entitlement that completes after the marketplace payment window
  // has elapsed is reconciled rather than discarded: the service moves the
  // expired payment to manual_review instead of confirming it late.
  expired: ['manual_review'],
  manual_review: ['confirmed', 'expired'],
} as const satisfies TransitionMap<PaymentState>;

/**
 * `processing` and `closed` are declared but unreachable — reserved for future commands.
 *
 * The Wave 7 local-pickup path (local pickup design §A6): `fulfillment.mark_ready`
 * arms `ready_for_pickup` from `paid`; `fulfillment.confirm_pickup` (buyer OR
 * seller) completes the handover from `paid` or `ready_for_pickup`; the
 * buyer-protection unilateral exits (terms-change cancel, bounded post-reveal
 * withdrawal) move `paid`/`ready_for_pickup` straight to `cancelled` through
 * `order.cancel_request`, which also gains the ordinary `ready_for_pickup ->
 * cancel_requested` edge. Shipped orders behave exactly as before.
 *
 * `paypal_refund` is the service's server trigger for a verified PayPal refund
 * or reversal whose recorded refunds reach the order total: every state holding
 * a confirmed payment (including an open cancel or return request) reaches
 * `refunded_external`. `paypal_reversal_cancelled` returns the order to the
 * state a reversal replaced when PayPal cancels that reversal. No client
 * command drives these edges; a partial refund leaves the state unchanged.
 */
export const orderTransitions = {
  pending_payment: ['paid', 'cancelled'],
  paid: ['shipped', 'ready_for_pickup', 'delivered', 'cancel_requested', 'cancelled', 'refunded_external'],
  ready_for_pickup: ['delivered', 'cancel_requested', 'cancelled', 'refunded_external'],
  processing: ['shipped', 'cancel_requested'],
  shipped: ['delivered', 'refunded_external'],
  delivered: ['return_requested', 'completed', 'refunded_external'],
  completed: ['return_requested', 'refunded_external'],
  cancel_requested: ['cancelled', 'refunded_external'],
  cancelled: ['paid', 'refunded_external'],
  return_requested: ['return_approved', 'refunded_external'],
  return_approved: ['return_received', 'refunded_external'],
  return_received: ['refunded_external'],
  refunded_external: [
    'paid',
    'ready_for_pickup',
    'shipped',
    'delivered',
    'completed',
    'cancel_requested',
    'cancelled',
    'return_requested',
    'return_approved',
    'return_received',
  ],
  closed: [],
} as const satisfies TransitionMap<OrderState>;

export const returnTransitions = {
  requested: ['approved', 'refunded'],
  approved: ['received', 'refunded'],
  received: ['refunded'],
  refunded: ['requested', 'approved', 'received'],
} as const satisfies TransitionMap<ReturnState>;

export const dropTransitions = {
  announced: ['live', 'ended_closed', 'ended_cancelled'],
  live: ['ended_sold_out', 'ended_closed', 'ended_cancelled'],
  ended_sold_out: [],
  ended_closed: [],
  ended_cancelled: [],
} as const satisfies TransitionMap<DropState>;

/**
 * Every aggregate machine, keyed exactly as in the service's contract artifact.
 * The contract-drift test iterates this registry against the vendored JSON, so
 * a machine cannot be added, removed, or reshaped without the artifact agreeing.
 */
export const commerceAggregateMachines = {
  listing: { initial: 'available', transitions: listingTransitions },
  reservation: { initial: 'active', transitions: reservationTransitions },
  offer: { initial: 'pending', transitions: offerTransitions },
  auction: { initial: 'scheduled', transitions: auctionTransitions },
  order: { initial: 'pending_payment', transitions: orderTransitions },
  payment: { initial: 'awaiting_entitlement', transitions: paymentTransitions },
  return: { initial: 'requested', transitions: returnTransitions },
  drop: { initial: 'announced', transitions: dropTransitions },
} as const;

export function canTransitionListing(from: ListingState, to: ListingState): boolean {
  return includesState(listingTransitions[from], to);
}

export function canTransitionReservation(from: ReservationState, to: ReservationState): boolean {
  return includesState(reservationTransitions[from], to);
}

export function canTransitionOffer(from: OfferState, to: OfferState): boolean {
  return includesState(offerTransitions[from], to);
}

export function canTransitionAuction(from: AuctionState, to: AuctionState): boolean {
  return includesState(auctionTransitions[from], to);
}

export function canTransitionPayment(from: PaymentState, to: PaymentState): boolean {
  return includesState(paymentTransitions[from], to);
}

export function canTransitionOrder(from: OrderState, to: OrderState): boolean {
  return includesState(orderTransitions[from], to);
}

function includesState<State extends string>(allowed: readonly State[], target: State): boolean {
  return allowed.includes(target);
}
