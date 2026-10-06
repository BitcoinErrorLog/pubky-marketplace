import { createHash, randomUUID } from 'node:crypto';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { z } from 'zod';
import { commercePubkySchema, createCommerceCommandSchema } from '../../../src/libs/commerce/transaction-contracts';
import {
  type AcceptOfferCommand,
  type AdvanceSandboxPaymentCommand,
  type ApproveOrderCancellationCommand,
  type ApproveReturnCommand,
  buildMarketplaceCheckoutAggregateId,
  buildMarketplaceConversationAggregateId,
  buildMarketplaceListingAggregateId,
  buildMarketplaceOfferAggregateId,
  buildMarketplaceOrderAggregateId,
  buildMarketplacePaymentAggregateId,
  type ClearPickupDetailsCommand as SharedClearPickupDetailsCommand,
  type CloseAuctionCommand,
  type ConfirmOrderDeliveryCommand,
  type ConfirmPickupCommand as SharedConfirmPickupCommand,
  type CounterOfferCommand,
  type CreateMarketplaceCheckoutCommand,
  createMarketplaceCheckoutCommandSchema,
  type CreateOfferCommand,
  type CreateReviewCommand,
  type MarketplaceCommand,
  marketplaceCommandSchema,
  type MarkMarketplaceNotificationReadCommand,
  type MarkReadyForPickupCommand as SharedMarkReadyForPickupCommand,
  type PlaceBidCommand,
  type ReceiveReturnCommand,
  type RecordExternalRefundCommand,
  type RegisterListingCommand,
  registerListingCommandSchema,
  type RejectOfferCommand,
  type RequestOrderCancellationCommand,
  type RequestReturnCommand,
  type ReserveInventoryCommand,
  type SendMarketplaceMessageCommand,
  // The shared (durable-shaped) pickup commands, aliased to stay distinct
  // from the prototype's local variants below.
  type SetPickupDetailsCommand as SharedSetPickupDetailsCommand,
  type ShipOrderCommand,
  type UpdateMarketplaceNotificationPreferencesCommand,
  type WithdrawOfferCommand,
} from './contracts';

// ---------------------------------------------------------------------------
// Wave 7 local-pickup contract additions — PART A of
// docs/ecommerce/local-pickup-design.md (the safe subset; Part B is deferred
// and deliberately not built here). Slice 7.0 extended the shared schemas
// LOCALLY; slice 7.2a re-vendored the durable service's shapes into the
// shared registry (`src/libs/commerce/transaction-commands.ts`), so the
// register contract (including `fulfillmentMethods`) now comes from the
// shared schema directly. The prototype keeps local variants only where its
// executable-spec semantics differ: the checkout line's shipping DEFAULT and
// its own pickup-details terms shape.
// ---------------------------------------------------------------------------

export type MarketplaceFulfillmentMethod = 'shipping' | 'pickup';
/**
 * What a listing publishes. `digital` is stored as registered, but the
 * prototype seals and releases nothing, so its checkout lines accept only
 * shipping and pickup: a digital listing is never sold here, and never as
 * shipping (digital delivery design §6 A1, B5).
 */
export type MarketplaceListingFulfillmentMethod = MarketplaceFulfillmentMethod | 'digital';

const fulfillmentMethodSchema = z.enum(['shipping', 'pickup']);

// The shared register schema carries the Wave 7 fulfillment contract:
// `fulfillmentMethods` (shipping | pickup, non-empty, deduped) defaulting to
// shipping-only, with auctions shipping-only (§A2).
const prototypeRegisterListingCommandSchema = registerListingCommandSchema;

const checkoutPayloadSchema = createMarketplaceCheckoutCommandSchema.shape.payload;
const prototypeCheckoutCommandSchema = createMarketplaceCheckoutCommandSchema
  .extend({
    // The shared payload is rebuilt key-by-key (zod refuses `.extend()`,
    // `.partial()`, and `.omit()` key surgery on refined objects), keeping
    // every shared validator and re-applying the duplicate-lines refinement
    // verbatim. Wave 7 changes (§A2): per-line fulfillment choice (optional,
    // defaulting to shipping — the service splits per (seller, fulfillment)
    // and never silently falls back), and an OPTIONAL delivery address
    // (required iff any group ships; rejected on pickup-only checkouts).
    payload: z
      .object({
        ...checkoutPayloadSchema.shape,
        lines: z
          .array(
            checkoutPayloadSchema.shape.lines.element.extend({
              fulfillment: fulfillmentMethodSchema.default('shipping'),
            }),
          )
          .min(1)
          .max(50),
        deliveryAddress: checkoutPayloadSchema.shape.deliveryAddress.optional(),
      })
      .strict()
      .superRefine((payload, context) => {
        const ids = payload.lines.map(({ listingAggregateId }) => listingAggregateId);
        if (new Set(ids).size !== ids.length) {
          context.addIssue({ code: 'custom', path: ['lines'], message: 'Checkout listing lines must be unique.' });
        }
      }),
  })
  .strict();

const pickupAvailabilityWindowSchema = z
  .object({
    day: z.enum(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']),
    start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm local wall-clock time'),
    end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm local wall-clock time'),
  })
  .strict();

/** Availability authored with the details; READ-ONLY information for the buyer in Wave 7 (scheduling is 7b). */
const pickupAvailabilitySchema = z.union([
  z
    .object({
      kind: z.literal('windows'),
      zone: z.string().trim().min(1).max(64),
      windows: z.array(pickupAvailabilityWindowSchema).min(1).max(14),
    })
    .strict(),
  z.object({ kind: z.literal('arrange_after_payment') }).strict(),
]);

/** A full address OR a free-text pickup spot (spot-first: the seller never has to publish their home, §A1). */
const pickupLocationSchema = z.union([
  z.object({ kind: z.literal('spot'), spot: z.string().trim().min(1).max(200) }).strict(),
  z
    .object({
      kind: z.literal('address'),
      line1: z.string().trim().min(1).max(200),
      line2: z.string().trim().max(200).default(''),
      city: z.string().trim().min(1).max(100),
      region: z.string().trim().max(100),
      postalCode: z.string().trim().min(1).max(32),
      countryCode: z.string().regex(/^[A-Z]{2}$/),
    })
    .strict(),
]);

/** The sealed seller pickup details (§A1): held by the service, never on the public listing record. */
const pickupDetailsTermsSchema = z
  .object({
    location: pickupLocationSchema,
    instructions: z.string().trim().max(1_000).default(''),
    availability: pickupAvailabilitySchema,
  })
  .strict();

export type MarketplacePickupTerms = z.infer<typeof pickupDetailsTermsSchema>;

/**
 * `pickup_details.set` (seller, own listing): whole-payload replace, version
 * + 1. The envelope's `expected_revision` doubles as `expected_version` —
 * the CAS runs against the per-listing version COUNTER (its own row,
 * surviving `pickup_details.clear`), never against the listing's server
 * revision (§A3).
 */
const setPickupDetailsCommandSchema = createCommerceCommandSchema(
  'pickup_details.set',
  z.object({ details: pickupDetailsTermsSchema }).strict(),
);

/**
 * `pickup_details.clear` (seller, own listing): deletes the details row;
 * retains only the versions referenced as `version_at_payment` by a paid,
 * non-terminal order; the version counter row survives (§A3). Same counter
 * CAS as `pickup_details.set`.
 */
const clearPickupDetailsCommandSchema = createCommerceCommandSchema('pickup_details.clear', z.object({}).strict());

const pickupOrderIdPayload = z.object({ orderId: z.uuid() }).strict();

/** `fulfillment.mark_ready` (seller, pickup order in `paid`): order → `ready_for_pickup`. */
const markReadyForPickupCommandSchema = createCommerceCommandSchema('fulfillment.mark_ready', pickupOrderIdPayload);

/**
 * `fulfillment.confirm_pickup` (buyer OR seller, pickup order in `paid` or
 * `ready_for_pickup`): order → `delivered` with a handover record. A
 * seller-actor confirm is refused while a post-payment terms change is
 * unresolved (§A6).
 */
const confirmPickupCommandSchema = createCommerceCommandSchema('fulfillment.confirm_pickup', pickupOrderIdPayload);

// The shared registry (re-vendored in 7.2a) now also carries the durable
// service's pickup command shapes; the prototype keeps its LOCAL variants
// (its executable-spec details shape predates the durable one), so the
// shared pickup kinds are excluded alongside register/checkout.
const sharedWave7CommandSchemas = marketplaceCommandSchema.options.filter(
  (option) =>
    ![
      'listing.register',
      'checkout.create',
      'pickup_details.set',
      'pickup_details.clear',
      'fulfillment.mark_ready',
      'fulfillment.confirm_pickup',
    ].includes(option.shape.kind.value as string),
);

const prototypeMarketplaceCommandSchema = z.union([
  prototypeRegisterListingCommandSchema,
  prototypeCheckoutCommandSchema,
  setPickupDetailsCommandSchema,
  clearPickupDetailsCommandSchema,
  markReadyForPickupCommandSchema,
  confirmPickupCommandSchema,
  ...sharedWave7CommandSchemas,
]);

type PrototypeRegisterListingCommand = z.infer<typeof prototypeRegisterListingCommandSchema>;
type PrototypeCheckoutCommand = z.infer<typeof prototypeCheckoutCommandSchema>;
type SetPickupDetailsCommand = z.infer<typeof setPickupDetailsCommandSchema>;
type ClearPickupDetailsCommand = z.infer<typeof clearPickupDetailsCommandSchema>;
type MarkReadyForPickupCommand = z.infer<typeof markReadyForPickupCommandSchema>;
type ConfirmPickupCommand = z.infer<typeof confirmPickupCommandSchema>;

/**
 * The prototype's command union: the shared contract minus the two schemas
 * the prototype extends locally (the runtime filter above keeps the two
 * shared variants out of the parse union; this type mirrors that exclusion,
 * which `Array.filter` cannot express).
 */
type PrototypeMarketplaceCommand =
  | Exclude<
      MarketplaceCommand,
      | RegisterListingCommand
      | CreateMarketplaceCheckoutCommand
      | SharedSetPickupDetailsCommand
      | SharedClearPickupDetailsCommand
      | SharedMarkReadyForPickupCommand
      | SharedConfirmPickupCommand
    >
  | PrototypeRegisterListingCommand
  | PrototypeCheckoutCommand
  | SetPickupDetailsCommand
  | ClearPickupDetailsCommand
  | MarkReadyForPickupCommand
  | ConfirmPickupCommand;

/** Server-side actors (the verification worker and the auto-complete sweep) sign events with this identity. */
const SERVER_ACTOR_PUBKY = 's'.repeat(52);

export interface MarketplaceListingAggregate {
  aggregateId: string;
  sellerPubky: string;
  listingId: string;
  title: string;
  listingRevision: number;
  contentHash: string;
  serverRevision: number;
  state: 'available' | 'reserved' | 'sold';
  totalQuantity: number;
  availableQuantity: number;
  reservedQuantity: number;
  soldQuantity: number;
  unitPrice: {
    amountMinor: number;
    currency: string;
    exponent: number;
  };
  saleFormat: 'fixed_price' | 'auction';
  /**
   * Public record (§A1): which fulfillment methods the listing offers.
   * Public like the rest of the listing — the seller's pickup DETAILS are
   * never placed here; they live only in the service's sealed store.
   */
  fulfillmentMethods: MarketplaceListingFulfillmentMethod[];
  auction: {
    status: 'scheduled' | 'active' | 'sold' | 'unsold' | 'cancelled';
    startsAt: string;
    endsAt: string;
    minimumIncrement: MarketplaceListingAggregate['unitPrice'];
    antiSnipingWindowSeconds: number;
    antiSnipingExtensionSeconds: number;
    currentPrice: MarketplaceListingAggregate['unitPrice'];
    leaderPubky: string | null;
    bidCount: number;
  } | null;
  updatedAt: string;
}

export interface MarketplaceReservation {
  id: string;
  aggregateId: string;
  buyerPubky: string;
  quantity: number;
  status: 'active';
  expiresAt: string;
  createdAt: string;
}

export interface MarketplaceOfferHistoryEntry {
  revision: number;
  actorPubky: string;
  action: 'created' | 'countered' | 'accepted' | 'rejected' | 'withdrawn';
  amount: MarketplaceListingAggregate['unitPrice'];
  quantity: number;
  message: string;
  occurredAt: string;
}

export interface MarketplaceOffer {
  id: string;
  aggregateId: string;
  listingAggregateId: string;
  buyerPubky: string;
  sellerPubky: string;
  revision: number;
  state: 'pending' | 'countered' | 'accepted' | 'rejected' | 'withdrawn' | 'expired';
  offeredBy: string;
  amount: MarketplaceListingAggregate['unitPrice'];
  quantity: number;
  message: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  history: MarketplaceOfferHistoryEntry[];
}

export interface MarketplaceBid {
  id: string;
  listingAggregateId: string;
  bidderPubky: string;
  maximumAmount: MarketplaceListingAggregate['unitPrice'];
  sequence: number;
  createdAt: string;
}

export interface MarketplaceAttachmentMetadata {
  id: string;
  senderPubky: string;
  recipientPubky: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  byteSize: number;
  contentHash: string;
  createdAt: string;
}

interface MarketplaceStoredAttachment extends MarketplaceAttachmentMetadata {
  bytes: Uint8Array;
  messageId: string | null;
}

export interface MarketplaceMessage {
  id: string;
  conversationId: string;
  listingAggregateId: string;
  senderPubky: string;
  recipientPubky: string;
  text: string;
  attachments: MarketplaceAttachmentMetadata[];
  createdAt: string;
}

export interface MarketplaceConversation {
  id: string;
  listingAggregateId: string;
  sellerPubky: string;
  buyerPubky: string;
  revision: number;
  lastMessageAt: string;
  messages: MarketplaceMessage[];
}

export interface MarketplaceNotification {
  id: string;
  revision: number;
  recipientPubky: string;
  actorPubky: string;
  type:
    | 'message_received'
    | 'offer_received'
    | 'offer_countered'
    | 'offer_accepted'
    | 'offer_rejected'
    | 'outbid'
    | 'auction_won'
    | 'auction_ended'
    | 'order_created'
    | 'payment_confirmed'
    | 'order_cancelled'
    | 'order_shipped'
    | 'order_delivered'
    | 'return_updated'
    | 'refund_recorded'
    | 'review_received'
    | 'pickup_details_updated'
    | 'pickup_details_cleared'
    | 'pickup_ready';
  aggregateId: string;
  createdAt: string;
  readAt: string | null;
}

export interface MarketplaceNotificationPreferences {
  ownerPubky: string;
  revision: number;
  messages: boolean;
  offers: boolean;
  bids: boolean;
  auctions: boolean;
  updatedAt: string;
}

export interface MarketplaceOrderLine {
  listingAggregateId: string;
  listingRevision: number;
  contentHash: string;
  title: string;
  quantity: number;
  unitPrice: MarketplaceListingAggregate['unitPrice'];
  subtotal: MarketplaceListingAggregate['unitPrice'];
  /** The buyer's variant snapshot, echoed for fulfillment display (packing slips, order rows). */
  variantId?: string;
  variantOptions?: Array<{ name: string; value: string }>;
  /** Every line is exactly one fulfillment kind; one order never mixes kinds (§A2). */
  fulfillment: MarketplaceFulfillmentMethod;
  /**
   * The pickup-details version shown at payment, pinned per line inside the
   * exactly-once confirmation path (§A3). An ABSENT key reads as "no terms
   * version pinned" (the listing had no details at payment, or pre-migration
   * rows). The sealed snapshot itself lives in the service's snapshot store,
   * bound to (order id ‖ line index ‖ version) — never on this projection.
   */
  versionAtPayment?: number;
}

export interface MarketplaceDeliveryAddress {
  name: string;
  line1: string;
  line2: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
}

export interface MarketplaceShipment {
  carrier: string;
  trackingNumber: string;
  state: 'shipped' | 'delivered';
  shippedAt: string;
  deliveredAt: string | null;
}

export interface MarketplaceReturn {
  state: 'requested' | 'approved' | 'received' | 'refunded';
  reason: string;
  requestedAmountMinor: number;
  requestedAt: string;
  updatedAt: string;
}

export interface MarketplaceReview {
  id: string;
  reviewerPubky: string;
  subjectPubky: string;
  rating: number;
  text: string;
  createdAt: string;
}

export interface MarketplaceExternalRefund {
  amountMinor: number;
  transactionId: string;
  recordedAt: string;
}

/** One sealed details version (§A1). Cleared listings keep referenced versions only (§A3 retention). */
export interface MarketplacePickupDetailsVersion {
  listingAggregateId: string;
  version: number;
  terms: MarketplacePickupTerms;
  updatedAt: string;
}

/**
 * The per-line pinned snapshot written inside payment confirmation (§A3),
 * bound to (order id ‖ line index ‖ version) — the prototype's analogue of
 * the sealed snapshot's AAD, so a snapshot cannot be transplanted across
 * orders, lines, or versions.
 */
export interface MarketplacePickupSnapshot {
  orderId: string;
  lineIndex: number;
  /** `null` when the listing had no details at payment ("no terms version pinned"). */
  version: number | null;
  terms: MarketplacePickupTerms | null;
  /**
   * Which confirmation path pinned this snapshot. The buyer reveal refuses
   * `sandbox_advance` pins on every read, independent of the deployment's
   * current sandbox flag — a flag toggle window can never free a past
   * fake-money reveal (§A3).
   */
  pinnedAdapter: 'sandbox_advance' | 'locks_verification';
  pinnedAt: string;
}

/** The `fulfillment.confirm_pickup` record (§A6): one row per order, keyed on the order id. */
export interface MarketplacePickupHandover {
  orderId: string;
  confirmedBy: string;
  /**
   * A seller-only confirm is SELLER-ATTESTED: reputation counts the
   * completion only on a buyer confirm or a dispute-free auto-complete (§A6).
   */
  attestation: 'buyer_confirmed' | 'seller_attested';
  confirmedAt: string;
}

export interface MarketplaceOrder {
  id: string;
  buyerPubky: string;
  sellerPubky: string;
  revision: number;
  state:
    | 'pending_payment'
    | 'paid'
    | 'processing'
    | 'ready_for_pickup'
    | 'shipped'
    | 'delivered'
    | 'completed'
    | 'cancel_requested'
    | 'cancelled'
    | 'return_requested'
    | 'return_approved'
    | 'return_received'
    | 'refunded_external'
    | 'closed';
  lines: MarketplaceOrderLine[];
  /** Every order is exactly one fulfillment kind (§A2: split per (seller, fulfillment)). */
  fulfillment: MarketplaceFulfillmentMethod;
  /** Shipped orders carry the buyer address; pickup orders carry none (§A2). */
  deliveryAddress: MarketplaceDeliveryAddress | null;
  /** Stamped by the first successful buyer reveal read; opens the bounded withdrawal window (§A3). */
  firstRevealedAt: string | null;
  /** Set on the transition into `cancelled` (any path): ends the reveal entitlement (§A3). */
  revealRevokedAt: string | null;
  handover: MarketplacePickupHandover | null;
  subtotal: MarketplaceListingAggregate['unitPrice'];
  shipping: MarketplaceListingAggregate['unitPrice'];
  total: MarketplaceListingAggregate['unitPrice'];
  guaranteePolicyVersion: 1;
  paymentId: string;
  receiptId: string | null;
  cancellationReason: string | null;
  shipment: MarketplaceShipment | null;
  returnRequest: MarketplaceReturn | null;
  externalRefund: MarketplaceExternalRefund | null;
  reviews: MarketplaceReview[];
  createdAt: string;
  updatedAt: string;
}

export interface MarketplacePayment {
  id: string;
  orderId: string;
  buyerPubky: string;
  sellerPubky: string;
  revision: number;
  adapter: 'sandbox';
  state: 'awaiting_entitlement' | 'detected' | 'confirmed' | 'expired' | 'manual_review';
  confirmations: number;
  locksBundleId: string;
  amount: MarketplaceListingAggregate['unitPrice'];
  createdAt: string;
  updatedAt: string;
}

export interface MarketplaceReceipt {
  id: string;
  orderId: string;
  paymentId: string;
  issuerPubky: string;
  recipientPubky: string;
  total: MarketplaceListingAggregate['unitPrice'];
  contentHash: string;
  issuedAt: string;
}

export interface MarketplaceEvent {
  id: string;
  commandId: string;
  aggregateId: string;
  revision: number;
  actorPubky: string;
  kind:
    | 'listing.registered'
    | 'inventory.reserved'
    | 'offer.created'
    | 'offer.countered'
    | 'offer.accepted'
    | 'offer.rejected'
    | 'offer.withdrawn'
    | 'auction.bid_placed'
    | 'message.sent'
    | 'auction.closed_sold'
    | 'auction.closed_unsold'
    | 'notification.read'
    | 'notification.preferences_updated'
    | 'order.created'
    | 'payment.detected'
    | 'payment.confirmed'
    | 'payment.expired'
    | 'payment.manual_review'
    | 'receipt.issued'
    | 'order.cancel_requested'
    | 'order.cancelled'
    | 'order.cancelled_terms_change'
    | 'order.completed'
    | 'fulfillment.ready_for_pickup'
    | 'fulfillment.shipped'
    | 'fulfillment.delivered'
    | 'pickup_details.updated'
    | 'pickup_details.cleared'
    | 'return.requested'
    | 'return.approved'
    | 'return.received'
    | 'refund.recorded_external'
    | 'review.created';
  occurredAt: string;
}

export type MarketplaceCommandSuccess = {
  ok: true;
  version: 1;
  commandId: string;
  aggregateId: string;
  revision: number;
  eventIds: string[];
  result:
    | { kind: 'listing'; listing: MarketplaceListingAggregate }
    | { kind: 'reservation'; listing: MarketplaceListingAggregate; reservation: MarketplaceReservation }
    | { kind: 'offer'; offer: MarketplaceOffer }
    | {
        kind: 'bid';
        listing: MarketplaceListingAggregate;
        bid: MarketplaceBid;
      }
    | {
        kind: 'message';
        conversation: MarketplaceConversation;
        message: MarketplaceMessage;
      }
    | {
        kind: 'accepted_offer';
        offer: MarketplaceOffer;
        listing: MarketplaceListingAggregate;
        reservation: MarketplaceReservation;
      }
    | {
        kind: 'auction_result';
        outcome: 'sold' | 'unsold';
        winnerPubky: string | null;
        listing: MarketplaceListingAggregate;
        reservation: MarketplaceReservation | null;
      }
    | { kind: 'notification'; notification: MarketplaceNotification }
    | { kind: 'notification_preferences'; preferences: MarketplaceNotificationPreferences }
    | { kind: 'checkout'; orders: MarketplaceOrder[]; payments: MarketplacePayment[] }
    | {
        kind: 'payment';
        payment: MarketplacePayment;
        order: MarketplaceOrder;
        receipt: MarketplaceReceipt | null;
      }
    | { kind: 'order'; order: MarketplaceOrder }
    | { kind: 'review'; order: MarketplaceOrder; review: MarketplaceReview }
    | {
        kind: 'pickup_details';
        listingAggregateId: string;
        /** The surviving per-listing version counter (post-clear CAS target, §A3). */
        version: number;
        details: MarketplacePickupDetailsVersion | null;
      };
};

/** The verification worker's confirmation of a payment (non-sandbox deployments only). */
export type MarketplaceWorkerConfirmationResult =
  | { ok: true; payment: MarketplacePayment; order: MarketplaceOrder; receipt: MarketplaceReceipt }
  | { ok: false; error: { code: MarketplaceCommandFailure['error']['code']; message: string } };

/** One line of the buyer-only pickup reveal read (§A3): the PINNED snapshot, never current details. */
export interface MarketplacePickupRevealLine {
  lineIndex: number;
  listingAggregateId: string;
  /** The pinned `version_at_payment`; `null` when no terms version was pinned. */
  version: number | null;
  /** Read-only pinned terms, availability windows and their IANA zone included (no propose path in Wave 7). */
  terms: MarketplacePickupTerms | null;
  currentVersion: number;
  updatedSincePayment: boolean;
  /** Set after a `pickup_details.clear`: the pinned snapshot stands in for the (deleted) current details. */
  withdrawnBySeller: boolean;
}

export type MarketplacePickupRevealResult =
  | { ok: true; orderId: string; firstRevealedAt: string; lines: MarketplacePickupRevealLine[] }
  | { ok: false; error: { code: MarketplaceCommandFailure['error']['code']; message: string } };

/** The seller's owner read of their own pickup details (§A4). */
export type MarketplaceSellerPickupDetailsResult =
  | { ok: true; listingAggregateId: string; version: number; details: MarketplacePickupTerms | null }
  | { ok: false; error: { code: MarketplaceCommandFailure['error']['code']; message: string } };

export type MarketplaceCommandFailure = {
  ok: false;
  error: {
    code:
      | 'INVALID_COMMAND'
      | 'UNAUTHORIZED'
      | 'NOT_FOUND'
      | 'REVISION_CONFLICT'
      | 'IDEMPOTENCY_CONFLICT'
      | 'INSUFFICIENT_INVENTORY'
      | 'INVARIANT_VIOLATION'
      | 'OFFER_EXPIRED'
      | 'INVALID_STATE'
      | 'AUCTION_CLOSED'
      | 'BID_TOO_LOW';
    message: string;
    currentRevision?: number;
    issues?: Array<{ path: string; message: string }>;
    /** A typed refusal reason, as the durable service sends it. */
    reason?: string;
  };
};

export type MarketplaceCommandResult = MarketplaceCommandSuccess | MarketplaceCommandFailure;

export type MarketplaceAttachmentStoreResult =
  | { ok: true; attachment: MarketplaceAttachmentMetadata }
  | { ok: false; code: 'INVALID_ATTACHMENT' | 'UNAUTHORIZED'; message: string };

type StoredCommand = {
  requestHash: string;
  result: MarketplaceCommandSuccess;
};

export class InMemoryMarketplaceRepository {
  private listings = new Map<string, MarketplaceListingAggregate>();
  private reservations = new Map<string, MarketplaceReservation>();
  private offers = new Map<string, MarketplaceOffer>();
  private bids = new Map<string, MarketplaceBid[]>();
  private conversations = new Map<string, MarketplaceConversation>();
  private notifications: MarketplaceNotification[] = [];
  private notificationPreferences = new Map<string, MarketplaceNotificationPreferences>();
  private attachments = new Map<string, MarketplaceStoredAttachment>();
  private orders = new Map<string, MarketplaceOrder>();
  private payments = new Map<string, MarketplacePayment>();
  private receipts = new Map<string, MarketplaceReceipt>();
  // Sealed pickup families (§A1): the current details row per listing, the
  // append-only version history under retention (§A3), the per-listing
  // monotonic version counter in its OWN row (survives `pickup_details.clear`),
  // the per-line pinned snapshots written at payment, and the handover records.
  private pickupDetailsCurrent = new Map<string, MarketplacePickupDetailsVersion>();
  private pickupDetailsVersions = new Map<string, MarketplacePickupDetailsVersion>();
  private pickupVersionCounters = new Map<string, number>();
  private pickupSnapshots = new Map<string, MarketplacePickupSnapshot>();
  private handovers = new Map<string, MarketplacePickupHandover>();
  private commands = new Map<string, StoredCommand>();
  private events: MarketplaceEvent[] = [];
  private lockTail: Promise<void> = Promise.resolve();

  async transaction<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.lockTail;
    let release = (): void => {};
    this.lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  getListing(id: string): MarketplaceListingAggregate | undefined {
    return this.listings.get(id);
  }

  putListing(listing: MarketplaceListingAggregate): void {
    this.listings.set(listing.aggregateId, listing);
  }

  putReservation(reservation: MarketplaceReservation): void {
    this.reservations.set(reservation.id, reservation);
  }

  getOffer(id: string): MarketplaceOffer | undefined {
    return this.offers.get(id);
  }

  putOffer(offer: MarketplaceOffer): void {
    this.offers.set(offer.id, offer);
  }

  getOffersForListing(listingAggregateId: string): MarketplaceOffer[] {
    return [...this.offers.values()].filter((offer) => offer.listingAggregateId === listingAggregateId);
  }

  getOffersForActor(actorPubky: string): MarketplaceOffer[] {
    return [...this.offers.values()].filter(
      (offer) => offer.buyerPubky === actorPubky || offer.sellerPubky === actorPubky,
    );
  }

  putBid(bid: MarketplaceBid): void {
    const current = this.bids.get(bid.listingAggregateId) ?? [];
    this.bids.set(bid.listingAggregateId, [...current, bid]);
  }

  getBidsForListing(listingAggregateId: string): MarketplaceBid[] {
    return [...(this.bids.get(listingAggregateId) ?? [])];
  }

  getConversation(id: string): MarketplaceConversation | undefined {
    return this.conversations.get(id);
  }

  putConversation(conversation: MarketplaceConversation): void {
    this.conversations.set(conversation.id, conversation);
  }

  getConversationsForActor(actorPubky: string): MarketplaceConversation[] {
    return [...this.conversations.values()].filter(
      (conversation) => conversation.sellerPubky === actorPubky || conversation.buyerPubky === actorPubky,
    );
  }

  appendNotification(notification: MarketplaceNotification): void {
    this.notifications.push(notification);
  }

  getNotification(id: string): MarketplaceNotification | undefined {
    return this.notifications.find((notification) => notification.id === id);
  }

  putNotification(notification: MarketplaceNotification): void {
    this.notifications = this.notifications.map((current) => (current.id === notification.id ? notification : current));
  }

  getNotificationsForActor(actorPubky: string): MarketplaceNotification[] {
    return this.notifications
      .filter(({ recipientPubky }) => recipientPubky === actorPubky)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getNotificationPreferences(actorPubky: string): MarketplaceNotificationPreferences | undefined {
    return this.notificationPreferences.get(actorPubky);
  }

  putNotificationPreferences(preferences: MarketplaceNotificationPreferences): void {
    this.notificationPreferences.set(preferences.ownerPubky, preferences);
  }

  putAttachment(attachment: MarketplaceStoredAttachment): void {
    this.attachments.set(attachment.id, attachment);
  }

  getAttachment(id: string): MarketplaceStoredAttachment | undefined {
    return this.attachments.get(id);
  }

  putOrder(order: MarketplaceOrder): void {
    this.orders.set(order.id, order);
  }

  getOrder(id: string): MarketplaceOrder | undefined {
    return this.orders.get(id);
  }

  getAllOrders(): MarketplaceOrder[] {
    return [...this.orders.values()];
  }

  getCurrentPickupDetails(listingAggregateId: string): MarketplacePickupDetailsVersion | undefined {
    return this.pickupDetailsCurrent.get(listingAggregateId);
  }

  putCurrentPickupDetails(details: MarketplacePickupDetailsVersion): void {
    this.pickupDetailsCurrent.set(details.listingAggregateId, details);
  }

  deleteCurrentPickupDetails(listingAggregateId: string): void {
    this.pickupDetailsCurrent.delete(listingAggregateId);
  }

  getPickupVersionCounter(listingAggregateId: string): number {
    return this.pickupVersionCounters.get(listingAggregateId) ?? 0;
  }

  putPickupVersionCounter(listingAggregateId: string, version: number): void {
    this.pickupVersionCounters.set(listingAggregateId, version);
  }

  getPickupDetailsVersions(listingAggregateId: string): MarketplacePickupDetailsVersion[] {
    const prefix = `${listingAggregateId}:`;
    return [...this.pickupDetailsVersions.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, details]) => details);
  }

  putPickupDetailsVersion(details: MarketplacePickupDetailsVersion): void {
    this.pickupDetailsVersions.set(`${details.listingAggregateId}:${details.version}`, details);
  }

  deletePickupDetailsVersion(details: MarketplacePickupDetailsVersion): void {
    this.pickupDetailsVersions.delete(`${details.listingAggregateId}:${details.version}`);
  }

  getPickupSnapshot(orderId: string, lineIndex: number): MarketplacePickupSnapshot | undefined {
    return this.pickupSnapshots.get(`${orderId}:${lineIndex}`);
  }

  putPickupSnapshot(snapshot: MarketplacePickupSnapshot): void {
    this.pickupSnapshots.set(`${snapshot.orderId}:${snapshot.lineIndex}`, snapshot);
  }

  deletePickupSnapshotsForOrder(orderId: string): void {
    const prefix = `${orderId}:`;
    for (const key of [...this.pickupSnapshots.keys()]) {
      if (key.startsWith(prefix)) this.pickupSnapshots.delete(key);
    }
  }

  getHandover(orderId: string): MarketplacePickupHandover | undefined {
    return this.handovers.get(orderId);
  }

  putHandover(handover: MarketplacePickupHandover): void {
    this.handovers.set(handover.orderId, handover);
  }

  getOrdersForActor(actorPubky: string): MarketplaceOrder[] {
    return [...this.orders.values()]
      .filter((order) => order.buyerPubky === actorPubky || order.sellerPubky === actorPubky)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  putPayment(payment: MarketplacePayment): void {
    this.payments.set(payment.id, payment);
  }

  getPayment(id: string): MarketplacePayment | undefined {
    return this.payments.get(id);
  }

  putReceipt(receipt: MarketplaceReceipt): void {
    this.receipts.set(receipt.id, receipt);
  }

  getReceipt(id: string): MarketplaceReceipt | undefined {
    return this.receipts.get(id);
  }

  getStoredCommand(actorPubky: string, commandId: string): StoredCommand | undefined {
    return this.commands.get(`${actorPubky}:${commandId}`);
  }

  putStoredCommand(actorPubky: string, commandId: string, stored: StoredCommand): void {
    this.commands.set(`${actorPubky}:${commandId}`, stored);
  }

  appendEvent(event: MarketplaceEvent): void {
    this.events.push(event);
  }

  getEvents(): MarketplaceEvent[] {
    return [...this.events];
  }
}

export class MarketplaceTransactionService {
  /**
   * The deployment sandbox-payments flag (`config.sandbox_payments_enabled`,
   * §A7/§A8). The prototype IS the sandbox adapter, so the flag defaults ON
   * and the `pickup_available` capability is therefore OFF by default:
   * `pickup_details.set` and the buyer reveal read are refused, mirroring the
   * durable service on a sandbox-payments deployment. Tests exercise the
   * reveal only by explicitly enabling non-sandbox mode
   * (`{ sandboxPaymentsEnabled: false }`) — documented per test.
   */
  private sandboxPaymentsEnabled: boolean;
  private readonly auctionReserves = new Map<string, MarketplaceListingAggregate['unitPrice'] | null>();

  constructor(
    private readonly repository: InMemoryMarketplaceRepository,
    private readonly now: () => Date = () => new Date(),
    options: { sandboxPaymentsEnabled?: boolean } = {},
  ) {
    this.sandboxPaymentsEnabled = options.sandboxPaymentsEnabled ?? true;
  }

  /** Simulates a redeploy flipping the sandbox-payments flag (the §A3 flag-toggle window). */
  setSandboxPaymentsEnabled(enabled: boolean): void {
    this.sandboxPaymentsEnabled = enabled;
  }

  /** The public config/health surface (§A7): pickup is available iff sandbox payments are disabled. */
  getPickupCapability(): { pickupAvailable: boolean; sandboxPaymentsEnabled: boolean } {
    return { pickupAvailable: !this.sandboxPaymentsEnabled, sandboxPaymentsEnabled: this.sandboxPaymentsEnabled };
  }

  getListingProjection(aggregateId: string): MarketplaceListingAggregate | undefined {
    return this.repository.getListing(aggregateId);
  }

  getParticipantOffers(actorPubky: string, listingAggregateId: string): MarketplaceOffer[] {
    return this.repository
      .getOffersForListing(listingAggregateId)
      .filter((offer) => offer.buyerPubky === actorPubky || offer.sellerPubky === actorPubky);
  }

  getOffers(actorPubky: string): MarketplaceOffer[] {
    return this.repository.getOffersForActor(actorPubky);
  }

  getParticipantConversations(actorPubky: string): MarketplaceConversation[] {
    return this.repository.getConversationsForActor(actorPubky);
  }

  getNotifications(actorPubky: string): MarketplaceNotification[] {
    return this.repository.getNotificationsForActor(actorPubky);
  }

  getNotificationPreferences(actorPubky: string): MarketplaceNotificationPreferences {
    return (
      this.repository.getNotificationPreferences(actorPubky) ?? {
        ownerPubky: actorPubky,
        revision: 0,
        messages: true,
        offers: true,
        bids: true,
        auctions: true,
        updatedAt: this.now().toISOString(),
      }
    );
  }

  storeAttachment(
    actorPubky: string,
    recipientPubky: string,
    mimeType: string,
    bytes: Uint8Array,
  ): MarketplaceAttachmentStoreResult {
    if (!commercePubkySchema.safeParse(actorPubky).success || !commercePubkySchema.safeParse(recipientPubky).success) {
      return { ok: false, code: 'UNAUTHORIZED', message: 'Valid attachment participants are required.' };
    }
    if (actorPubky === recipientPubky) {
      return { ok: false, code: 'UNAUTHORIZED', message: 'Attachment participants must differ.' };
    }
    if (bytes.byteLength === 0 || bytes.byteLength > 5 * 1024 * 1024 || !hasImageSignature(mimeType, bytes)) {
      return { ok: false, code: 'INVALID_ATTACHMENT', message: 'Attachment must be a valid JPEG, PNG, or WebP.' };
    }
    const attachment: MarketplaceStoredAttachment = {
      id: randomUUID(),
      senderPubky: actorPubky,
      recipientPubky,
      mimeType: mimeType as MarketplaceAttachmentMetadata['mimeType'],
      byteSize: bytes.byteLength,
      contentHash: bytesToHex(blake3(bytes)),
      createdAt: this.now().toISOString(),
      bytes,
      messageId: null,
    };
    this.repository.putAttachment(attachment);
    return { ok: true, attachment: toAttachmentMetadata(attachment) };
  }

  getAttachment(actorPubky: string, attachmentId: string): MarketplaceStoredAttachment | null {
    const attachment = this.repository.getAttachment(attachmentId);
    if (!attachment) return null;
    return attachment.senderPubky === actorPubky || attachment.recipientPubky === actorPubky ? attachment : null;
  }

  getOrders(actorPubky: string): MarketplaceOrder[] {
    return this.repository.getOrdersForActor(actorPubky);
  }

  getPayment(actorPubky: string, paymentId: string): MarketplacePayment | null {
    const payment = this.repository.getPayment(paymentId);
    return payment && (payment.buyerPubky === actorPubky || payment.sellerPubky === actorPubky) ? payment : null;
  }

  getReceipt(actorPubky: string, receiptId: string): MarketplaceReceipt | null {
    const receipt = this.repository.getReceipt(receiptId);
    return receipt && (receipt.recipientPubky === actorPubky || receipt.issuerPubky === actorPubky) ? receipt : null;
  }

  async execute(actorInput: unknown, commandInput: unknown): Promise<MarketplaceCommandResult> {
    const actorResult = commercePubkySchema.safeParse(actorInput);
    const commandResult = prototypeMarketplaceCommandSchema.safeParse(commandInput);
    if (!actorResult.success || !commandResult.success) {
      const issues = [
        ...(actorResult.success
          ? []
          : actorResult.error.issues.map(({ message, path }) => ({ path: `actor.${path.join('.')}`, message }))),
        ...(commandResult.success
          ? []
          : commandResult.error.issues.map(({ message, path }) => ({ path: path.join('.'), message }))),
      ];
      return failure('INVALID_COMMAND', 'The marketplace command is invalid.', { issues });
    }

    const actorPubky = actorResult.data;
    const command = commandResult.data as PrototypeMarketplaceCommand;
    const requestHash = hashCommand(command);

    return await this.repository.transaction(() => {
      const stored = this.repository.getStoredCommand(actorPubky, command.commandId);
      if (stored) {
        return stored.requestHash === requestHash
          ? stored.result
          : failure('IDEMPOTENCY_CONFLICT', 'The command id was already used with different input.');
      }

      const result = this.dispatchCommand(actorPubky, command);

      if (result.ok) {
        this.repository.putStoredCommand(actorPubky, command.commandId, { requestHash, result });
      }
      return result;
    });
  }

  private dispatchCommand(actorPubky: string, command: PrototypeMarketplaceCommand): MarketplaceCommandResult {
    switch (command.kind) {
      case 'listing.register':
        return this.registerListing(actorPubky, command);
      case 'listing.sync':
        // The sandbox has no homeserver to fetch canonical records from —
        // service-side sync exists only on the durable service. Refuse
        // honestly rather than fabricate a registration. On the durable
        // service, sync converges only the public record (including
        // `fulfillmentMethods`); it carries no pickup details and can never
        // null the service-side sealed store (§A4).
        return failure('INVALID_COMMAND', 'Listing sync is not available on the sandbox service.');
      case 'pickup_details.set':
        return this.setPickupDetails(actorPubky, command);
      case 'digital_delivery.set':
      case 'digital_delivery.clear':
      case 'order.set_delivery_email':
      case 'fulfillment.deliver_digital':
        // The prototype seals and releases nothing: it refuses digital
        // delivery the way an unkeyed durable service does (§6 B5).
        return failure('INVALID_STATE', 'Digital delivery is unavailable on this deployment.', {
          reason: 'digital_delivery_unavailable',
        });
      case 'pickup_details.clear':
        return this.clearPickupDetails(actorPubky, command);
      case 'fulfillment.mark_ready':
        return this.markReadyForPickup(actorPubky, command);
      case 'fulfillment.confirm_pickup':
        return this.confirmPickup(actorPubky, command);
      case 'drop.sync':
      case 'drop.cancel':
      case 'drop.release_listings':
        // Drops are durable-only by design (ADR 0026): server time is the
        // feature, and the sandbox has neither a homeserver nor a real
        // clock authority. Refuse honestly rather than simulate scarcity.
        return failure('INVALID_COMMAND', 'Drops are not available on the sandbox service.');
      case 'inventory.reserve':
        return this.reserveInventory(actorPubky, command);
      case 'offer.create':
        return this.createOffer(actorPubky, command);
      case 'offer.counter':
        return this.counterOffer(actorPubky, command);
      case 'offer.accept':
        return this.acceptOffer(actorPubky, command);
      case 'offer.checkout':
        return failure('INVALID_STATE', 'Only an accepted offer can enter offer checkout.');
      case 'offer.reject':
        return this.rejectOffer(actorPubky, command);
      case 'offer.withdraw':
        return this.withdrawOffer(actorPubky, command);
      case 'auction.place_bid':
        return this.placeBid(actorPubky, command);
      case 'message.send':
        return this.sendMessage(actorPubky, command);
      case 'auction.close':
        return this.closeAuction(actorPubky, command);
      case 'notification.mark_read':
        return this.markNotificationRead(actorPubky, command);
      case 'notification.preferences.update':
        return this.updateNotificationPreferences(actorPubky, command);
      case 'checkout.create':
        return this.createCheckout(actorPubky, command);
      case 'payment.sandbox_advance':
        return this.advanceSandboxPayment(actorPubky, command);
      case 'payment.register_locks':
        // The sandbox has no Lock Server and no verification worker, so it
        // refuses the registration outright — mirroring the durable service's
        // fail-closed behavior when Locks is not configured.
        return failure('INVALID_COMMAND', 'Locks verification is not available on the sandbox service.');
      case 'order.cancel_request':
        return this.requestCancellation(actorPubky, command);
      case 'order.cancel_approve':
        return this.approveCancellation(actorPubky, command);
      case 'fulfillment.ship':
        return this.shipOrder(actorPubky, command);
      case 'fulfillment.confirm_delivery':
        return this.confirmDelivery(actorPubky, command);
      case 'return.request':
        return this.requestReturn(actorPubky, command);
      case 'return.approve':
        return this.approveReturn(actorPubky, command);
      case 'return.receive':
        return this.receiveReturn(actorPubky, command);
      case 'refund.record_external':
        return this.recordExternalRefund(actorPubky, command);
      case 'review.create':
        return this.createReview(actorPubky, command);
      case 'review.update':
        // The sandbox prototype has no review editing — the command exists
        // only on the durable service (24-hour edit window). Refuse honestly
        // rather than mutate a review this service never allowed editing.
        return failure('INVALID_COMMAND', 'The sandbox marketplace does not support review editing.');
    }
  }

  private registerListing(actorPubky: string, command: PrototypeRegisterListingCommand): MarketplaceCommandResult {
    const { payload } = command;
    if (actorPubky !== payload.sellerPubky) {
      return failure('UNAUTHORIZED', 'Only the listing seller may register inventory.');
    }
    // v1 scope (§A2): auction listings are shipping-only — pickup auctions are future work.
    if (payload.saleFormat === 'auction' && payload.fulfillmentMethods.includes('pickup')) {
      return failure('INVALID_COMMAND', 'Auction listings are shipping-only.');
    }

    const expectedAggregateId = buildMarketplaceListingAggregateId(payload.sellerPubky, payload.listingId);
    if (command.aggregateId !== expectedAggregateId) {
      return failure('INVALID_COMMAND', 'The listing aggregate id does not match its seller and listing.');
    }

    const current = this.repository.getListing(command.aggregateId);
    const currentRevision = current?.serverRevision ?? 0;
    if (command.expectedRevision !== currentRevision) {
      return failure('REVISION_CONFLICT', 'The listing revision is stale.', { currentRevision });
    }
    if (current && payload.listingRevision <= current.listingRevision) {
      return failure('REVISION_CONFLICT', 'The public listing revision must advance.', { currentRevision });
    }

    const committedQuantity = (current?.reservedQuantity ?? 0) + (current?.soldQuantity ?? 0);
    if (payload.quantity < committedQuantity) {
      return failure('INVARIANT_VIOLATION', 'Listing quantity cannot fall below committed inventory.', {
        currentRevision,
      });
    }

    const occurredAt = this.now().toISOString();
    const listing: MarketplaceListingAggregate = {
      aggregateId: command.aggregateId,
      sellerPubky: payload.sellerPubky,
      listingId: payload.listingId,
      title: payload.title,
      listingRevision: payload.listingRevision,
      contentHash: payload.contentHash,
      serverRevision: currentRevision + 1,
      state: payload.quantity === committedQuantity ? (committedQuantity > 0 ? 'reserved' : 'sold') : 'available',
      totalQuantity: payload.quantity,
      availableQuantity: payload.quantity - committedQuantity,
      reservedQuantity: current?.reservedQuantity ?? 0,
      soldQuantity: current?.soldQuantity ?? 0,
      unitPrice: payload.unitPrice,
      saleFormat: payload.saleFormat,
      fulfillmentMethods: payload.fulfillmentMethods,
      auction: payload.auctionTerms
        ? {
            ...payload.auctionTerms,
            status:
              current?.auction?.status ??
              (Date.parse(payload.auctionTerms.startsAt) > Date.parse(occurredAt) ? 'scheduled' : 'active'),
            currentPrice: current?.auction?.currentPrice ?? payload.unitPrice,
            leaderPubky: current?.auction?.leaderPubky ?? null,
            bidCount: current?.auction?.bidCount ?? 0,
          }
        : null,
      updatedAt: occurredAt,
    };
    if (payload.saleFormat === 'auction') {
      this.auctionReserves.set(command.aggregateId, payload.auctionReserve?.reservePrice ?? null);
    }
    const event = this.createEvent(actorPubky, command, listing.serverRevision, 'listing.registered', occurredAt);
    this.repository.putListing(listing);
    this.repository.appendEvent(event);
    return success(command, listing.serverRevision, event.id, { kind: 'listing', listing });
  }

  private reserveInventory(actorPubky: string, command: ReserveInventoryCommand): MarketplaceCommandResult {
    const listing = this.repository.getListing(command.aggregateId);
    if (!listing) return failure('NOT_FOUND', 'The listing is not registered.');
    if (listing.sellerPubky === actorPubky) {
      return failure('UNAUTHORIZED', 'A seller cannot reserve their own listing.');
    }
    if (command.expectedRevision !== listing.serverRevision) {
      return failure('REVISION_CONFLICT', 'The listing revision is stale.', {
        currentRevision: listing.serverRevision,
      });
    }
    if (listing.availableQuantity < command.payload.quantity) {
      return failure('INSUFFICIENT_INVENTORY', 'The requested quantity is unavailable.', {
        currentRevision: listing.serverRevision,
      });
    }

    const now = this.now();
    const occurredAt = now.toISOString();
    const reservation: MarketplaceReservation = {
      id: command.commandId,
      aggregateId: command.aggregateId,
      buyerPubky: actorPubky,
      quantity: command.payload.quantity,
      status: 'active',
      expiresAt: new Date(now.getTime() + command.payload.reservationTtlSeconds * 1_000).toISOString(),
      createdAt: occurredAt,
    };
    const updatedListing: MarketplaceListingAggregate = {
      ...listing,
      serverRevision: listing.serverRevision + 1,
      state: listing.availableQuantity === command.payload.quantity ? 'reserved' : 'available',
      availableQuantity: listing.availableQuantity - command.payload.quantity,
      reservedQuantity: listing.reservedQuantity + command.payload.quantity,
      updatedAt: occurredAt,
    };
    const event = this.createEvent(
      actorPubky,
      command,
      updatedListing.serverRevision,
      'inventory.reserved',
      occurredAt,
    );
    this.repository.putListing(updatedListing);
    this.repository.putReservation(reservation);
    this.repository.appendEvent(event);
    return success(command, updatedListing.serverRevision, event.id, {
      kind: 'reservation',
      listing: updatedListing,
      reservation,
    });
  }

  private createOffer(actorPubky: string, command: CreateOfferCommand): MarketplaceCommandResult {
    const listing = this.repository.getListing(command.aggregateId);
    if (!listing) return failure('NOT_FOUND', 'The listing is not registered.');
    if (listing.sellerPubky === actorPubky) {
      return failure('UNAUTHORIZED', 'A seller cannot make an offer on their own listing.');
    }
    if (command.expectedRevision !== listing.serverRevision) {
      return failure('REVISION_CONFLICT', 'The listing revision is stale.', {
        currentRevision: listing.serverRevision,
      });
    }
    if (listing.availableQuantity < command.payload.quantity) {
      return failure('INSUFFICIENT_INVENTORY', 'The requested offer quantity is unavailable.', {
        currentRevision: listing.serverRevision,
      });
    }
    // v1 scope (§A2): offers are shipping-only; refuse with a typed error
    // rather than silently converting the fulfillment to shipping.
    if (!listing.fulfillmentMethods.includes('shipping')) {
      return failure('INVALID_COMMAND', 'This listing does not offer shipping; offers are shipping-only.');
    }
    if (!sameAsset(listing.unitPrice, command.payload.amount)) {
      return failure('INVALID_COMMAND', 'Offer amount must use the listing asset and exponent.');
    }

    const now = this.now();
    const occurredAt = now.toISOString();
    const offer: MarketplaceOffer = {
      id: command.commandId,
      aggregateId: buildMarketplaceOfferAggregateId(command.commandId),
      listingAggregateId: listing.aggregateId,
      buyerPubky: actorPubky,
      sellerPubky: listing.sellerPubky,
      revision: 1,
      state: 'pending',
      offeredBy: actorPubky,
      amount: command.payload.amount,
      quantity: command.payload.quantity,
      message: command.payload.message,
      expiresAt: new Date(now.getTime() + command.payload.expiresInSeconds * 1_000).toISOString(),
      createdAt: occurredAt,
      updatedAt: occurredAt,
      history: [
        {
          revision: 1,
          actorPubky,
          action: 'created',
          amount: command.payload.amount,
          quantity: command.payload.quantity,
          message: command.payload.message,
          occurredAt,
        },
      ],
    };
    const event = this.createEvent(actorPubky, command, offer.revision, 'offer.created', occurredAt);
    this.repository.putOffer(offer);
    this.repository.appendEvent(event);
    this.notify(offer.sellerPubky, actorPubky, 'offer_received', offer.aggregateId, occurredAt);
    return success(command, offer.revision, event.id, { kind: 'offer', offer });
  }

  private counterOffer(actorPubky: string, command: CounterOfferCommand): MarketplaceCommandResult {
    const offer = this.getActionableOffer(actorPubky, command.payload.offerId, command.aggregateId);
    if (!offer.ok) return offer.failure;
    if (command.expectedRevision !== offer.value.revision) {
      return failure('REVISION_CONFLICT', 'The offer revision is stale.', {
        currentRevision: offer.value.revision,
      });
    }
    if (actorPubky === offer.value.offeredBy) {
      return failure('UNAUTHORIZED', 'The current offer author cannot counter their own terms.');
    }
    if (!sameAsset(offer.value.amount, command.payload.amount)) {
      return failure('INVALID_COMMAND', 'Counteroffer amount must use the original asset and exponent.');
    }
    const listing = this.repository.getListing(offer.value.listingAggregateId);
    if (!listing) return failure('NOT_FOUND', 'The offer listing is unavailable.');
    if (listing.availableQuantity < command.payload.quantity) {
      return failure('INSUFFICIENT_INVENTORY', 'The counteroffer quantity is unavailable.', {
        currentRevision: offer.value.revision,
      });
    }

    const now = this.now();
    const occurredAt = now.toISOString();
    const updated: MarketplaceOffer = {
      ...offer.value,
      revision: offer.value.revision + 1,
      state: 'countered',
      offeredBy: actorPubky,
      amount: command.payload.amount,
      quantity: command.payload.quantity,
      message: command.payload.message,
      expiresAt: new Date(now.getTime() + command.payload.expiresInSeconds * 1_000).toISOString(),
      updatedAt: occurredAt,
      history: [
        ...offer.value.history,
        {
          revision: offer.value.revision + 1,
          actorPubky,
          action: 'countered',
          amount: command.payload.amount,
          quantity: command.payload.quantity,
          message: command.payload.message,
          occurredAt,
        },
      ],
    };
    const event = this.createEvent(actorPubky, command, updated.revision, 'offer.countered', occurredAt);
    this.repository.putOffer(updated);
    this.repository.appendEvent(event);
    this.notify(
      actorPubky === updated.sellerPubky ? updated.buyerPubky : updated.sellerPubky,
      actorPubky,
      'offer_countered',
      updated.aggregateId,
      occurredAt,
    );
    return success(command, updated.revision, event.id, { kind: 'offer', offer: updated });
  }

  private acceptOffer(actorPubky: string, command: AcceptOfferCommand): MarketplaceCommandResult {
    const offer = this.getActionableOffer(actorPubky, command.payload.offerId, command.aggregateId);
    if (!offer.ok) return offer.failure;
    if (command.expectedRevision !== offer.value.revision) {
      return failure('REVISION_CONFLICT', 'The offer revision is stale.', {
        currentRevision: offer.value.revision,
      });
    }
    if (actorPubky === offer.value.offeredBy) {
      return failure('UNAUTHORIZED', 'The current offer author cannot accept their own terms.');
    }
    const listing = this.repository.getListing(offer.value.listingAggregateId);
    if (!listing) return failure('NOT_FOUND', 'The offer listing is unavailable.');
    if (listing.availableQuantity < offer.value.quantity) {
      return failure('INSUFFICIENT_INVENTORY', 'The offered quantity is no longer available.', {
        currentRevision: offer.value.revision,
      });
    }

    const now = this.now();
    const occurredAt = now.toISOString();
    const acceptedOffer = this.finishOffer(offer.value, actorPubky, 'accepted', occurredAt);
    const reservation: MarketplaceReservation = {
      id: command.commandId,
      aggregateId: listing.aggregateId,
      buyerPubky: acceptedOffer.buyerPubky,
      quantity: acceptedOffer.quantity,
      status: 'active',
      expiresAt: new Date(now.getTime() + 30 * 60 * 1_000).toISOString(),
      createdAt: occurredAt,
    };
    const updatedListing: MarketplaceListingAggregate = {
      ...listing,
      serverRevision: listing.serverRevision + 1,
      state: listing.availableQuantity === acceptedOffer.quantity ? 'reserved' : 'available',
      availableQuantity: listing.availableQuantity - acceptedOffer.quantity,
      reservedQuantity: listing.reservedQuantity + acceptedOffer.quantity,
      updatedAt: occurredAt,
    };
    const offerEvent = this.createEvent(actorPubky, command, acceptedOffer.revision, 'offer.accepted', occurredAt);
    const inventoryEvent = this.createEvent(
      actorPubky,
      command,
      updatedListing.serverRevision,
      'inventory.reserved',
      occurredAt,
      updatedListing.aggregateId,
    );
    this.repository.putOffer(acceptedOffer);
    this.repository.putListing(updatedListing);
    this.repository.putReservation(reservation);
    this.repository.appendEvent(offerEvent);
    this.repository.appendEvent(inventoryEvent);
    this.notify(
      actorPubky === acceptedOffer.sellerPubky ? acceptedOffer.buyerPubky : acceptedOffer.sellerPubky,
      actorPubky,
      'offer_accepted',
      acceptedOffer.aggregateId,
      occurredAt,
    );
    return success(command, acceptedOffer.revision, [offerEvent.id, inventoryEvent.id], {
      kind: 'accepted_offer',
      offer: acceptedOffer,
      listing: updatedListing,
      reservation,
    });
  }

  private rejectOffer(actorPubky: string, command: RejectOfferCommand): MarketplaceCommandResult {
    return this.completeOfferAction(actorPubky, command, 'rejected', 'offer.rejected');
  }

  private withdrawOffer(actorPubky: string, command: WithdrawOfferCommand): MarketplaceCommandResult {
    const offer = this.getActionableOffer(actorPubky, command.payload.offerId, command.aggregateId);
    if (!offer.ok) return offer.failure;
    if (actorPubky !== offer.value.offeredBy) {
      return failure('UNAUTHORIZED', 'Only the current offer author may withdraw it.');
    }
    return this.completeOfferAction(actorPubky, command, 'withdrawn', 'offer.withdrawn');
  }

  private completeOfferAction(
    actorPubky: string,
    command: RejectOfferCommand | WithdrawOfferCommand,
    state: 'rejected' | 'withdrawn',
    eventKind: 'offer.rejected' | 'offer.withdrawn',
  ): MarketplaceCommandResult {
    const offer = this.getActionableOffer(actorPubky, command.payload.offerId, command.aggregateId);
    if (!offer.ok) return offer.failure;
    if (command.expectedRevision !== offer.value.revision) {
      return failure('REVISION_CONFLICT', 'The offer revision is stale.', {
        currentRevision: offer.value.revision,
      });
    }
    if (state === 'rejected' && actorPubky === offer.value.offeredBy) {
      return failure('UNAUTHORIZED', 'The current offer author cannot reject their own terms.');
    }

    const occurredAt = this.now().toISOString();
    const updated = this.finishOffer(offer.value, actorPubky, state, occurredAt);
    const event = this.createEvent(actorPubky, command, updated.revision, eventKind, occurredAt);
    this.repository.putOffer(updated);
    this.repository.appendEvent(event);
    if (state === 'rejected') {
      this.notify(
        actorPubky === updated.sellerPubky ? updated.buyerPubky : updated.sellerPubky,
        actorPubky,
        'offer_rejected',
        updated.aggregateId,
        occurredAt,
      );
    }
    return success(command, updated.revision, event.id, { kind: 'offer', offer: updated });
  }

  private getActionableOffer(
    actorPubky: string,
    offerId: string,
    aggregateId: string,
  ): { ok: true; value: MarketplaceOffer } | { ok: false; failure: MarketplaceCommandFailure } {
    const offer = this.repository.getOffer(offerId);
    if (!offer) return { ok: false, failure: failure('NOT_FOUND', 'The offer was not found.') };
    if (aggregateId !== offer.aggregateId) {
      return { ok: false, failure: failure('INVALID_COMMAND', 'The offer aggregate id is invalid.') };
    }
    if (actorPubky !== offer.buyerPubky && actorPubky !== offer.sellerPubky) {
      return { ok: false, failure: failure('UNAUTHORIZED', 'Only offer participants may act on it.') };
    }
    if (offer.state !== 'pending' && offer.state !== 'countered') {
      return { ok: false, failure: failure('INVALID_STATE', 'The offer is no longer actionable.') };
    }
    if (Date.parse(offer.expiresAt) <= this.now().getTime()) {
      return { ok: false, failure: failure('OFFER_EXPIRED', 'The offer has expired.') };
    }
    return { ok: true, value: offer };
  }

  private finishOffer(
    offer: MarketplaceOffer,
    actorPubky: string,
    state: 'accepted' | 'rejected' | 'withdrawn',
    occurredAt: string,
  ): MarketplaceOffer {
    const revision = offer.revision + 1;
    return {
      ...offer,
      revision,
      state,
      updatedAt: occurredAt,
      history: [
        ...offer.history,
        {
          revision,
          actorPubky,
          action: state,
          amount: offer.amount,
          quantity: offer.quantity,
          message: '',
          occurredAt,
        },
      ],
    };
  }

  private placeBid(actorPubky: string, command: PlaceBidCommand): MarketplaceCommandResult {
    const listing = this.repository.getListing(command.aggregateId);
    if (!listing) return failure('NOT_FOUND', 'The auction listing is not registered.');
    if (listing.sellerPubky === actorPubky) {
      return failure('UNAUTHORIZED', 'A seller cannot bid on their own auction.');
    }
    if (listing.saleFormat !== 'auction' || !listing.auction) {
      return failure('INVALID_STATE', 'This listing is not an auction.');
    }
    if (listing.auction.status !== 'active') {
      return failure('AUCTION_CLOSED', 'The auction is not open for bidding.');
    }
    if (command.expectedRevision !== listing.serverRevision) {
      return failure('REVISION_CONFLICT', 'The auction revision is stale.', {
        currentRevision: listing.serverRevision,
      });
    }
    const now = this.now();
    const nowMs = now.getTime();
    if (nowMs < Date.parse(listing.auction.startsAt) || nowMs >= Date.parse(listing.auction.endsAt)) {
      return failure('AUCTION_CLOSED', 'The auction is not open for bidding.');
    }
    if (!sameAsset(listing.unitPrice, command.payload.maximumAmount)) {
      return failure('INVALID_COMMAND', 'Bid maximum must use the auction asset and exponent.');
    }
    if (command.payload.maximumAmount.amountMinor <= listing.auction.currentPrice.amountMinor) {
      return failure('BID_TOO_LOW', 'Bid maximum must exceed the current visible price.', {
        currentRevision: listing.serverRevision,
      });
    }

    const previousBids = this.repository.getBidsForListing(listing.aggregateId);
    const bidderPreviousMaximum = previousBids
      .filter((bid) => bid.bidderPubky === actorPubky)
      .reduce((maximum, bid) => Math.max(maximum, bid.maximumAmount.amountMinor), 0);
    if (command.payload.maximumAmount.amountMinor <= bidderPreviousMaximum) {
      return failure('BID_TOO_LOW', 'A new proxy maximum must exceed the bidder previous maximum.', {
        currentRevision: listing.serverRevision,
      });
    }

    const occurredAt = now.toISOString();
    const bid: MarketplaceBid = {
      id: command.commandId,
      listingAggregateId: listing.aggregateId,
      bidderPubky: actorPubky,
      maximumAmount: command.payload.maximumAmount,
      sequence: listing.auction.bidCount + 1,
      createdAt: occurredAt,
    };
    const bidderMaximums = latestBidderMaximums([...previousBids, bid]);
    const ranked = [...bidderMaximums.values()].sort(
      (left, right) =>
        right.maximumAmount.amountMinor - left.maximumAmount.amountMinor || left.sequence - right.sequence,
    );
    const leader = ranked[0];
    const runnerUp = ranked[1];
    const visibleAmount = runnerUp
      ? Math.min(
          leader.maximumAmount.amountMinor,
          runnerUp.maximumAmount.amountMinor + listing.auction.minimumIncrement.amountMinor,
        )
      : listing.unitPrice.amountMinor;
    const remainingMs = Date.parse(listing.auction.endsAt) - nowMs;
    const shouldExtend =
      listing.auction.antiSnipingWindowSeconds > 0 && remainingMs <= listing.auction.antiSnipingWindowSeconds * 1_000;
    const endsAt = shouldExtend
      ? new Date(nowMs + listing.auction.antiSnipingExtensionSeconds * 1_000).toISOString()
      : listing.auction.endsAt;
    const currentPrice = { ...listing.unitPrice, amountMinor: visibleAmount };
    const updatedListing: MarketplaceListingAggregate = {
      ...listing,
      serverRevision: listing.serverRevision + 1,
      auction: {
        ...listing.auction,
        endsAt,
        currentPrice,
        leaderPubky: leader.bidderPubky,
        bidCount: listing.auction.bidCount + 1,
      },
      updatedAt: occurredAt,
    };
    const event = this.createEvent(
      actorPubky,
      command,
      updatedListing.serverRevision,
      'auction.bid_placed',
      occurredAt,
    );
    this.repository.putBid(bid);
    this.repository.putListing(updatedListing);
    this.repository.appendEvent(event);
    if (
      listing.auction.leaderPubky &&
      listing.auction.leaderPubky !== updatedListing.auction?.leaderPubky &&
      listing.auction.leaderPubky !== actorPubky
    ) {
      this.notify(listing.auction.leaderPubky, actorPubky, 'outbid', listing.aggregateId, occurredAt);
    }
    return success(command, updatedListing.serverRevision, event.id, {
      kind: 'bid',
      listing: updatedListing,
      bid,
    });
  }

  private closeAuction(actorPubky: string, command: CloseAuctionCommand): MarketplaceCommandResult {
    const listing = this.repository.getListing(command.aggregateId);
    if (!listing) return failure('NOT_FOUND', 'The auction listing is not registered.');
    if (listing.sellerPubky !== actorPubky) {
      return failure('UNAUTHORIZED', 'Only the seller may close this sandbox auction.');
    }
    if (!listing.auction || listing.saleFormat !== 'auction' || listing.auction.status !== 'active') {
      return failure('INVALID_STATE', 'The auction is not active.');
    }
    if (command.expectedRevision !== listing.serverRevision) {
      return failure('REVISION_CONFLICT', 'The auction revision is stale.', {
        currentRevision: listing.serverRevision,
      });
    }
    const now = this.now();
    if (now.getTime() < Date.parse(listing.auction.endsAt)) {
      return failure('AUCTION_CLOSED', 'The auction has not ended yet.');
    }

    const reserve = this.auctionReserves.get(command.aggregateId) ?? null;
    const sold = Boolean(
      listing.auction.leaderPubky && (!reserve || listing.auction.currentPrice.amountMinor >= reserve.amountMinor),
    );
    const occurredAt = now.toISOString();
    const reservation: MarketplaceReservation | null =
      sold && listing.auction.leaderPubky
        ? {
            id: command.commandId,
            aggregateId: listing.aggregateId,
            buyerPubky: listing.auction.leaderPubky,
            quantity: 1,
            status: 'active',
            expiresAt: new Date(now.getTime() + 30 * 60 * 1_000).toISOString(),
            createdAt: occurredAt,
          }
        : null;
    const updatedListing: MarketplaceListingAggregate = {
      ...listing,
      serverRevision: listing.serverRevision + 1,
      state: sold ? 'reserved' : 'available',
      availableQuantity: sold ? listing.availableQuantity - 1 : listing.availableQuantity,
      reservedQuantity: sold ? listing.reservedQuantity + 1 : listing.reservedQuantity,
      auction: {
        ...listing.auction,
        status: sold ? 'sold' : 'unsold',
      },
      updatedAt: occurredAt,
    };
    const event = this.createEvent(
      actorPubky,
      command,
      updatedListing.serverRevision,
      sold ? 'auction.closed_sold' : 'auction.closed_unsold',
      occurredAt,
    );
    this.repository.putListing(updatedListing);
    if (reservation) this.repository.putReservation(reservation);
    this.repository.appendEvent(event);
    if (reservation) {
      this.notify(reservation.buyerPubky, actorPubky, 'auction_won', listing.aggregateId, occurredAt);
    }
    return success(command, updatedListing.serverRevision, event.id, {
      kind: 'auction_result',
      outcome: sold ? 'sold' : 'unsold',
      winnerPubky: reservation?.buyerPubky ?? null,
      listing: updatedListing,
      reservation,
    });
  }

  private sendMessage(actorPubky: string, command: SendMarketplaceMessageCommand): MarketplaceCommandResult {
    const listing = this.repository.getListing(command.payload.listingAggregateId);
    if (!listing) return failure('NOT_FOUND', 'The message listing is unavailable.');
    const actorIsSeller = actorPubky === listing.sellerPubky;
    if (!actorIsSeller && command.payload.recipientPubky !== listing.sellerPubky) {
      return failure('UNAUTHORIZED', 'A buyer may message only the listing seller.');
    }
    if (actorIsSeller && command.payload.recipientPubky === listing.sellerPubky) {
      return failure('UNAUTHORIZED', 'A seller cannot message themselves.');
    }

    const buyerPubky = actorIsSeller ? command.payload.recipientPubky : actorPubky;
    const expectedConversationId = buildMarketplaceConversationAggregateId(
      listing.sellerPubky,
      buyerPubky,
      listing.listingId,
    );
    if (command.aggregateId !== expectedConversationId) {
      return failure('INVALID_COMMAND', 'The conversation aggregate id is invalid.');
    }
    const current = this.repository.getConversation(command.aggregateId);
    const currentRevision = current?.revision ?? 0;
    if (command.expectedRevision !== currentRevision) {
      return failure('REVISION_CONFLICT', 'The conversation revision is stale.', { currentRevision });
    }
    const attachments = command.payload.attachmentIds.map((id) => this.repository.getAttachment(id));
    if (
      attachments.some(
        (attachment) =>
          !attachment ||
          attachment.senderPubky !== actorPubky ||
          attachment.recipientPubky !== command.payload.recipientPubky ||
          attachment.messageId !== null,
      )
    ) {
      return failure('INVALID_COMMAND', 'Message attachments are invalid, reused, or owned by another participant.');
    }

    const occurredAt = this.now().toISOString();
    const message: MarketplaceMessage = {
      id: command.commandId,
      conversationId: command.aggregateId,
      listingAggregateId: listing.aggregateId,
      senderPubky: actorPubky,
      recipientPubky: command.payload.recipientPubky,
      text: command.payload.text,
      attachments: attachments.map((attachment) => toAttachmentMetadata(attachment!)),
      createdAt: occurredAt,
    };
    const conversation: MarketplaceConversation = {
      id: command.aggregateId,
      listingAggregateId: listing.aggregateId,
      sellerPubky: listing.sellerPubky,
      buyerPubky,
      revision: currentRevision + 1,
      lastMessageAt: occurredAt,
      messages: [...(current?.messages ?? []), message],
    };
    const event = this.createEvent(actorPubky, command, conversation.revision, 'message.sent', occurredAt);
    this.repository.putConversation(conversation);
    for (const attachment of attachments) {
      this.repository.putAttachment({ ...attachment!, messageId: message.id });
    }
    this.repository.appendEvent(event);
    this.notify(message.recipientPubky, actorPubky, 'message_received', conversation.id, occurredAt);
    return success(command, conversation.revision, event.id, { kind: 'message', conversation, message });
  }

  private markNotificationRead(
    actorPubky: string,
    command: MarkMarketplaceNotificationReadCommand,
  ): MarketplaceCommandResult {
    const notification = this.repository.getNotification(command.payload.notificationId);
    if (!notification) return failure('NOT_FOUND', 'The notification was not found.');
    if (notification.recipientPubky !== actorPubky) {
      return failure('UNAUTHORIZED', 'Only the notification recipient may mark it read.');
    }
    if (command.aggregateId !== `notification:${notification.id}`) {
      return failure('INVALID_COMMAND', 'The notification aggregate id is invalid.');
    }
    if (command.expectedRevision !== notification.revision) {
      return failure('REVISION_CONFLICT', 'The notification revision is stale.', {
        currentRevision: notification.revision,
      });
    }
    if (notification.readAt) return failure('INVALID_STATE', 'The notification is already read.');

    const occurredAt = this.now().toISOString();
    const updated: MarketplaceNotification = {
      ...notification,
      revision: notification.revision + 1,
      readAt: occurredAt,
    };
    const event = this.createEvent(actorPubky, command, updated.revision, 'notification.read', occurredAt);
    this.repository.putNotification(updated);
    this.repository.appendEvent(event);
    return success(command, updated.revision, event.id, { kind: 'notification', notification: updated });
  }

  private updateNotificationPreferences(
    actorPubky: string,
    command: UpdateMarketplaceNotificationPreferencesCommand,
  ): MarketplaceCommandResult {
    if (command.aggregateId !== `notification_preferences:${actorPubky}`) {
      return failure('INVALID_COMMAND', 'The notification preferences aggregate id is invalid.');
    }
    const current = this.repository.getNotificationPreferences(actorPubky);
    const currentRevision = current?.revision ?? 0;
    if (command.expectedRevision !== currentRevision) {
      return failure('REVISION_CONFLICT', 'The notification preferences revision is stale.', { currentRevision });
    }
    const occurredAt = this.now().toISOString();
    const preferences: MarketplaceNotificationPreferences = {
      ownerPubky: actorPubky,
      revision: currentRevision + 1,
      ...command.payload,
      updatedAt: occurredAt,
    };
    const event = this.createEvent(
      actorPubky,
      command,
      preferences.revision,
      'notification.preferences_updated',
      occurredAt,
    );
    this.repository.putNotificationPreferences(preferences);
    this.repository.appendEvent(event);
    return success(command, preferences.revision, event.id, { kind: 'notification_preferences', preferences });
  }

  private createCheckout(actorPubky: string, command: PrototypeCheckoutCommand): MarketplaceCommandResult {
    if (
      command.aggregateId !== buildMarketplaceCheckoutAggregateId(command.commandId) ||
      command.expectedRevision !== 0
    ) {
      return failure('INVALID_COMMAND', 'Checkout aggregate identity or revision is invalid.');
    }
    const resolved = command.payload.lines.map((line) => ({
      requested: line,
      listing: this.repository.getListing(line.listingAggregateId),
    }));
    if (resolved.some(({ listing }) => !listing)) {
      return failure('NOT_FOUND', 'A checkout listing is unavailable.');
    }
    for (const { requested, listing } of resolved) {
      if (!listing) continue;
      if (listing.sellerPubky === actorPubky) {
        return failure('UNAUTHORIZED', 'A buyer cannot purchase their own listing.');
      }
      if (listing.saleFormat !== 'fixed_price' || listing.state !== 'available') {
        return failure('INVALID_STATE', 'Only available fixed-price listings can enter checkout.');
      }
      if (requested.expectedRevision !== listing.serverRevision) {
        return failure('REVISION_CONFLICT', 'A checkout listing revision is stale.', {
          currentRevision: listing.serverRevision,
        });
      }
      if (requested.quantity > listing.availableQuantity) {
        return failure('INSUFFICIENT_INVENTORY', 'Checkout quantity is unavailable.', {
          currentRevision: listing.serverRevision,
        });
      }
      // The buyer's choice is never rewritten (§A2): a fulfillment the
      // listing does not publish is a typed refusal, never a silent fallback
      // to shipping (the prior art's `?? 'shipping'`).
      if (!listing.fulfillmentMethods.includes(requested.fulfillment)) {
        return failure('INVALID_COMMAND', 'A checkout line chooses a fulfillment its listing does not publish.');
      }
    }
    const listings = resolved.map(({ listing }) => listing!);
    const asset = listings[0].unitPrice;
    if (listings.some((listing) => !sameAsset(asset, listing.unitPrice))) {
      return failure('INVALID_COMMAND', 'One checkout may contain only one asset and exponent.');
    }

    // Address policy (§A2): required when any group ships (stored only on the
    // shipped orders); a pickup-only checkout that PRESENTS one is rejected —
    // a buggy or malicious client cannot smuggle an address into storage.
    const anyShipped = resolved.some(({ requested }) => requested.fulfillment === 'shipping');
    if (anyShipped && !command.payload.deliveryAddress) {
      return failure('INVALID_COMMAND', 'A checkout with shipped orders requires a delivery address.');
    }
    if (!anyShipped && command.payload.deliveryAddress) {
      return failure('INVALID_COMMAND', 'A pickup-only checkout must not carry a delivery address.');
    }

    const now = this.now();
    const occurredAt = now.toISOString();
    // One order per (seller, fulfillment) — Wave 7 has no location_key, so
    // several pickup lines from one seller share one pickup order and the
    // reveal is per order line (§A2).
    const sellerGroups = new Map<
      string,
      {
        sellerPubky: string;
        fulfillment: MarketplaceFulfillmentMethod;
        items: Array<{ requested: (typeof resolved)[number]['requested']; listing: MarketplaceListingAggregate }>;
      }
    >();
    for (const item of resolved) {
      const listing = item.listing!;
      // Explicit separator: never concatenate a pubky and a fulfillment
      // into an ambiguous compound key.
      const key = `${listing.sellerPubky}:${item.requested.fulfillment}`;
      const group = sellerGroups.get(key) ?? {
        sellerPubky: listing.sellerPubky,
        fulfillment: item.requested.fulfillment,
        items: [],
      };
      group.items.push({ requested: item.requested, listing });
      sellerGroups.set(key, group);
    }

    const orders: MarketplaceOrder[] = [];
    const payments: MarketplacePayment[] = [];
    const eventIds: string[] = [];
    for (const { sellerPubky, fulfillment, items } of sellerGroups.values()) {
      const lines: MarketplaceOrderLine[] = items.map(({ requested, listing }) => ({
        listingAggregateId: listing.aggregateId,
        listingRevision: listing.listingRevision,
        contentHash: listing.contentHash,
        title: listing.title,
        quantity: requested.quantity,
        unitPrice: listing.unitPrice,
        subtotal: { ...listing.unitPrice, amountMinor: listing.unitPrice.amountMinor * requested.quantity },
        // Echo the buyer's variant snapshot verbatim, matching the durable
        // service: display data validated for shape only.
        ...(requested.variantId ? { variantId: requested.variantId } : {}),
        ...(requested.variantOptions ? { variantOptions: requested.variantOptions } : {}),
        fulfillment: requested.fulfillment,
      }));
      const subtotalMinor = lines.reduce((total, line) => total + line.subtotal.amountMinor, 0);
      // Pickup charges no shipping (§A2): the seller-signed flat rate applies
      // only to shipped orders — never charge and refund later.
      const shippingMinor = fulfillment === 'pickup' ? 0 : 1_200;
      const orderId = randomUUID();
      const paymentId = randomUUID();
      const order: MarketplaceOrder = {
        id: orderId,
        buyerPubky: actorPubky,
        sellerPubky,
        revision: 1,
        state: 'pending_payment',
        lines,
        fulfillment,
        deliveryAddress: fulfillment === 'shipping' ? command.payload.deliveryAddress! : null,
        firstRevealedAt: null,
        revealRevokedAt: null,
        handover: null,
        subtotal: { ...asset, amountMinor: subtotalMinor },
        shipping: { ...asset, amountMinor: shippingMinor },
        total: { ...asset, amountMinor: subtotalMinor + shippingMinor },
        guaranteePolicyVersion: command.payload.guaranteePolicyVersion,
        paymentId,
        receiptId: null,
        cancellationReason: null,
        shipment: null,
        returnRequest: null,
        externalRefund: null,
        reviews: [],
        createdAt: occurredAt,
        updatedAt: occurredAt,
      };
      const payment: MarketplacePayment = {
        id: paymentId,
        orderId,
        buyerPubky: actorPubky,
        sellerPubky,
        revision: 1,
        adapter: 'sandbox',
        state: 'awaiting_entitlement',
        confirmations: 0,
        locksBundleId: randomUUID(),
        amount: order.total,
        createdAt: occurredAt,
        updatedAt: occurredAt,
      };
      this.repository.putOrder(order);
      this.repository.putPayment(payment);
      orders.push(order);
      payments.push(payment);
      const event = this.createEvent(actorPubky, command, 1, 'order.created', occurredAt, `order:${orderId}`);
      this.repository.appendEvent(event);
      eventIds.push(event.id);
      this.notify(sellerPubky, actorPubky, 'order_created', `order:${orderId}`, occurredAt);
    }

    for (const { requested, listing } of resolved) {
      this.repository.putListing({
        ...listing!,
        serverRevision: listing!.serverRevision + 1,
        state: listing!.availableQuantity === requested.quantity ? 'reserved' : 'available',
        availableQuantity: listing!.availableQuantity - requested.quantity,
        reservedQuantity: listing!.reservedQuantity + requested.quantity,
        updatedAt: occurredAt,
      });
    }
    return success(command, 1, eventIds, { kind: 'checkout', orders, payments });
  }

  private advanceSandboxPayment(actorPubky: string, command: AdvanceSandboxPaymentCommand): MarketplaceCommandResult {
    if (!this.sandboxPaymentsEnabled) {
      return failure('INVALID_COMMAND', 'Sandbox payments are disabled on this deployment.');
    }
    const payment = this.repository.getPayment(command.payload.paymentId);
    if (!payment) return failure('NOT_FOUND', 'The sandbox payment was not found.');
    if (payment.buyerPubky !== actorPubky) {
      return failure('UNAUTHORIZED', 'Only the buyer may advance a sandbox payment.');
    }
    if (command.aggregateId !== buildMarketplacePaymentAggregateId(payment.id)) {
      return failure('INVALID_COMMAND', 'The payment aggregate id is invalid.');
    }
    if (command.expectedRevision !== payment.revision) {
      return failure('REVISION_CONFLICT', 'The payment revision is stale.', { currentRevision: payment.revision });
    }
    const allowed =
      payment.state === 'awaiting_entitlement'
        ? ['detected', 'confirmed', 'expired', 'manual_review']
        : payment.state === 'detected'
          ? ['confirmed', 'manual_review']
          : [];
    if (!allowed.includes(command.payload.target)) {
      return failure('INVALID_STATE', 'The sandbox payment transition is invalid.');
    }
    if (command.payload.target === 'confirmed' && command.payload.confirmations < 1) {
      return failure('INVALID_COMMAND', 'Confirmed payment requires at least one confirmation.');
    }

    const order = this.repository.getOrder(payment.orderId);
    if (!order) return failure('INVARIANT_VIOLATION', 'Payment order is missing.');
    const occurredAt = this.now().toISOString();
    const updatedPayment: MarketplacePayment = {
      ...payment,
      revision: payment.revision + 1,
      state: command.payload.target,
      confirmations: command.payload.confirmations,
      updatedAt: occurredAt,
    };
    const eventKind = `payment.${command.payload.target}` as MarketplaceEvent['kind'];
    const paymentEvent = this.createEvent(actorPubky, command, updatedPayment.revision, eventKind, occurredAt);
    if (updatedPayment.state === 'confirmed') {
      this.repository.putPayment(updatedPayment);
      this.repository.appendEvent(paymentEvent);
      return this.confirmOrder(actorPubky, command, updatedPayment, 'sandbox_advance', occurredAt, [paymentEvent.id]);
    }
    this.repository.putPayment(updatedPayment);
    this.repository.appendEvent(paymentEvent);
    return success(command, updatedPayment.revision, paymentEvent.id, {
      kind: 'payment',
      payment: updatedPayment,
      order,
      receipt: null,
    });
  }

  /**
   * The verification worker's confirmation path (§A3): durable deployments
   * with sandbox payments disabled confirm payments through the worker's
   * independent verification, never through `payment.sandbox_advance`. The
   * prototype exposes it as a service method (workers are not command
   * actors); it shares the one exactly-once `confirmOrder` writer with the
   * sandbox path, so worker confirmations pin pickup snapshots exactly like
   * sandbox ones.
   */
  async confirmPaymentAsWorker(paymentId: string): Promise<MarketplaceWorkerConfirmationResult> {
    if (this.sandboxPaymentsEnabled) {
      return {
        ok: false,
        error: { code: 'INVALID_COMMAND', message: 'Sandbox-payments deployments run no verification worker.' },
      };
    }
    return await this.repository.transaction(() => {
      const payment = this.repository.getPayment(paymentId);
      if (!payment) {
        return { ok: false as const, error: { code: 'NOT_FOUND' as const, message: 'The payment was not found.' } };
      }
      if (payment.state !== 'awaiting_entitlement' && payment.state !== 'detected') {
        return {
          ok: false as const,
          error: { code: 'INVALID_STATE' as const, message: 'The payment is not awaiting verification.' },
        };
      }
      const occurredAt = this.now().toISOString();
      const updatedPayment: MarketplacePayment = {
        ...payment,
        revision: payment.revision + 1,
        state: 'confirmed',
        confirmations: Math.max(1, payment.confirmations),
        updatedAt: occurredAt,
      };
      const commandRef = {
        commandId: `worker:${payment.id}`,
        aggregateId: buildMarketplacePaymentAggregateId(payment.id),
      };
      const paymentEvent = this.createEvent(
        SERVER_ACTOR_PUBKY,
        commandRef,
        updatedPayment.revision,
        'payment.confirmed',
        occurredAt,
      );
      this.repository.putPayment(updatedPayment);
      this.repository.appendEvent(paymentEvent);
      const result = this.confirmOrder(
        SERVER_ACTOR_PUBKY,
        commandRef,
        updatedPayment,
        'locks_verification',
        occurredAt,
        [paymentEvent.id],
      );
      if (!result.ok || result.result.kind !== 'payment' || !result.result.receipt) {
        return {
          ok: false as const,
          error: { code: 'INVARIANT_VIOLATION' as const, message: 'Worker confirmation failed.' },
        };
      }
      return {
        ok: true as const,
        payment: result.result.payment,
        order: result.result.order,
        receipt: result.result.receipt,
      };
    });
  }

  /**
   * The one exactly-once confirmation writer (§A3), shared by
   * `payment.sandbox_advance` and the verification worker: moves the order to
   * `paid`, issues the receipt, and pins — per pickup line, in the same
   * transaction as the receipt — the details version (`version_at_payment`),
   * a snapshot of the terms as shown at payment bound to
   * (order id ‖ line index ‖ version), and the confirming adapter.
   */
  private confirmOrder(
    actorPubky: string,
    command: { commandId: string; aggregateId: string },
    payment: MarketplacePayment,
    adapter: 'sandbox_advance' | 'locks_verification',
    occurredAt: string,
    eventIds: string[],
  ): MarketplaceCommandResult {
    const order = this.repository.getOrder(payment.orderId);
    if (!order) return failure('INVARIANT_VIOLATION', 'Payment order is missing.');
    const receiptId = randomUUID();
    let updatedOrder: MarketplaceOrder = {
      ...order,
      revision: order.revision + 1,
      state: 'paid',
      receiptId,
      updatedAt: occurredAt,
    };
    const receiptPayload = JSON.stringify({
      orderId: order.id,
      paymentId: payment.id,
      total: order.total,
      issuedAt: occurredAt,
    });
    const receipt: MarketplaceReceipt = {
      id: receiptId,
      orderId: order.id,
      paymentId: payment.id,
      issuerPubky: order.sellerPubky,
      recipientPubky: order.buyerPubky,
      total: order.total,
      contentHash: bytesToHex(blake3(new TextEncoder().encode(receiptPayload))),
      issuedAt: occurredAt,
    };
    const receiptEvent = this.createEvent(
      actorPubky,
      command,
      updatedOrder.revision,
      'receipt.issued',
      occurredAt,
      `order:${order.id}`,
    );
    eventIds.push(receiptEvent.id);
    updatedOrder = this.pinPickupSnapshots(updatedOrder, adapter, occurredAt);
    this.repository.putReceipt(receipt);
    this.repository.appendEvent(receiptEvent);
    this.repository.putOrder(updatedOrder);
    this.notify(order.sellerPubky, actorPubky, 'payment_confirmed', `order:${order.id}`, occurredAt);
    return success(command, payment.revision, eventIds, {
      kind: 'payment',
      payment,
      order: updatedOrder,
      receipt,
    });
  }

  /**
   * Pinning (§A3): per pickup line, record `version_at_payment` on the line
   * and the snapshot in the sealed snapshot store — bound to
   * (order id ‖ line index ‖ version), so a snapshot cannot be transplanted
   * across orders, lines, or versions. A listing with no details at payment
   * pins `null` (the line's `version_at_payment` key stays absent).
   */
  private pinPickupSnapshots(
    order: MarketplaceOrder,
    adapter: 'sandbox_advance' | 'locks_verification',
    occurredAt: string,
  ): MarketplaceOrder {
    if (order.fulfillment !== 'pickup') return order;
    const lines = order.lines.map((line, lineIndex) => {
      if (line.fulfillment !== 'pickup') return line;
      const current = this.repository.getCurrentPickupDetails(line.listingAggregateId);
      this.repository.putPickupSnapshot({
        orderId: order.id,
        lineIndex,
        version: current?.version ?? null,
        terms: current?.terms ?? null,
        pinnedAdapter: adapter,
        pinnedAt: occurredAt,
      });
      return current ? { ...line, versionAtPayment: current.version } : line;
    });
    return { ...order, lines };
  }

  private requestCancellation(actorPubky: string, command: RequestOrderCancellationCommand): MarketplaceCommandResult {
    const resolved = this.getOrderAction(actorPubky, command.payload.orderId, command);
    if (!resolved.ok) return resolved.failure;
    const order = resolved.order;
    if (order.buyerPubky !== actorPubky) return failure('UNAUTHORIZED', 'Only the buyer may request cancellation.');
    if (!['pending_payment', 'paid', 'processing', 'ready_for_pickup'].includes(order.state)) {
      return failure('INVALID_STATE', 'This order can no longer be cancelled.');
    }
    const occurredAt = this.now().toISOString();
    const immediate = order.state === 'pending_payment';
    // Unilateral exits (§A3): no seller approval while (a) a post-payment
    // pickup-terms change exists (version bump or clear), or (b) the bounded
    // post-reveal withdrawal window is open (`first_revealed_at` stamped, no
    // handover confirm yet — `mark_ready` does NOT close it). Outside those
    // conditions — including a cancel that races `mark_ready` before the
    // first reveal — the command degrades to the ordinary `cancel_requested`.
    const unilateral =
      (order.state === 'paid' || order.state === 'ready_for_pickup') &&
      (this.hasUnresolvedTermsChange(order) || order.firstRevealedAt !== null);
    const cancelled = immediate || unilateral;
    const updated: MarketplaceOrder = {
      ...order,
      revision: order.revision + 1,
      state: cancelled ? 'cancelled' : 'cancel_requested',
      cancellationReason: command.payload.reason,
      // Cancellation ENDS the reveal on every cancel path (§A3).
      revealRevokedAt: cancelled ? occurredAt : order.revealRevokedAt,
      updatedAt: occurredAt,
    };
    // The unilateral exits release inventory exactly like an approved cancel.
    if (cancelled) this.releaseOrderInventory(order, occurredAt);
    return this.persistOrderAction(
      actorPubky,
      command,
      updated,
      unilateral ? 'order.cancelled_terms_change' : immediate ? 'order.cancelled' : 'order.cancel_requested',
      order.sellerPubky,
      'order_cancelled',
      occurredAt,
    );
  }

  /**
   * A post-payment pickup-terms change (§A3) exists when, for any pickup
   * line, the listing's version counter advanced past `version_at_payment`,
   * or the details were cleared after a version was pinned. Both are only
   * meaningful AGAINST a pinned version: a listing whose details were
   * cleared (or never set) BEFORE checkout pins nothing
   * (`version_at_payment` absent), so there is no post-payment terms change
   * to resolve.
   */
  private hasUnresolvedTermsChange(order: MarketplaceOrder): boolean {
    if (order.fulfillment !== 'pickup') return false;
    return order.lines.some((line) => {
      if (line.fulfillment !== 'pickup') return false;
      if (line.versionAtPayment == null) return false;
      const counter = this.repository.getPickupVersionCounter(line.listingAggregateId);
      const cleared = !this.repository.getCurrentPickupDetails(line.listingAggregateId);
      return cleared || counter > line.versionAtPayment;
    });
  }

  private approveCancellation(actorPubky: string, command: ApproveOrderCancellationCommand): MarketplaceCommandResult {
    const resolved = this.getOrderAction(actorPubky, command.payload.orderId, command);
    if (!resolved.ok) return resolved.failure;
    const order = resolved.order;
    if (order.sellerPubky !== actorPubky) return failure('UNAUTHORIZED', 'Only the seller may approve cancellation.');
    if (order.state !== 'cancel_requested') return failure('INVALID_STATE', 'No cancellation is pending.');
    const occurredAt = this.now().toISOString();
    const updated = {
      ...order,
      revision: order.revision + 1,
      state: 'cancelled' as const,
      // Cancellation ENDS the reveal on every cancel path (§A3).
      revealRevokedAt: occurredAt,
      updatedAt: occurredAt,
    };
    this.releaseOrderInventory(order, occurredAt);
    return this.persistOrderAction(
      actorPubky,
      command,
      updated,
      'order.cancelled',
      order.buyerPubky,
      'order_cancelled',
      occurredAt,
    );
  }

  private shipOrder(actorPubky: string, command: ShipOrderCommand): MarketplaceCommandResult {
    const resolved = this.getOrderAction(actorPubky, command.payload.orderId, command);
    if (!resolved.ok) return resolved.failure;
    const order = resolved.order;
    if (order.sellerPubky !== actorPubky) return failure('UNAUTHORIZED', 'Only the seller may ship this order.');
    // Pickup orders are never shipped (§A6): typed refusal, no silent conversion.
    if (order.fulfillment === 'pickup') return failure('INVALID_STATE', 'A pickup order cannot be shipped.');
    if (!['paid', 'processing'].includes(order.state))
      return failure('INVALID_STATE', 'The order is not ready to ship.');
    const occurredAt = this.now().toISOString();
    const updated: MarketplaceOrder = {
      ...order,
      revision: order.revision + 1,
      state: 'shipped',
      shipment: {
        carrier: command.payload.carrier,
        trackingNumber: command.payload.trackingNumber,
        state: 'shipped',
        shippedAt: occurredAt,
        deliveredAt: null,
      },
      updatedAt: occurredAt,
    };
    return this.persistOrderAction(
      actorPubky,
      command,
      updated,
      'fulfillment.shipped',
      order.buyerPubky,
      'order_shipped',
      occurredAt,
    );
  }

  private confirmDelivery(actorPubky: string, command: ConfirmOrderDeliveryCommand): MarketplaceCommandResult {
    const resolved = this.getOrderAction(actorPubky, command.payload.orderId, command);
    if (!resolved.ok) return resolved.failure;
    const order = resolved.order;
    if (order.buyerPubky !== actorPubky) return failure('UNAUTHORIZED', 'Only the buyer may confirm delivery.');
    if (order.state !== 'shipped' || !order.shipment) {
      return failure('INVALID_STATE', 'The order is not awaiting delivery confirmation.');
    }
    const occurredAt = this.now().toISOString();
    const updated: MarketplaceOrder = {
      ...order,
      revision: order.revision + 1,
      state: 'delivered',
      shipment: { ...order.shipment, state: 'delivered', deliveredAt: occurredAt },
      updatedAt: occurredAt,
    };
    return this.persistOrderAction(
      actorPubky,
      command,
      updated,
      'fulfillment.delivered',
      order.sellerPubky,
      'order_delivered',
      occurredAt,
    );
  }

  private requestReturn(actorPubky: string, command: RequestReturnCommand): MarketplaceCommandResult {
    const resolved = this.getOrderAction(actorPubky, command.payload.orderId, command);
    if (!resolved.ok) return resolved.failure;
    const order = resolved.order;
    if (order.buyerPubky !== actorPubky) return failure('UNAUTHORIZED', 'Only the buyer may request a return.');
    if (
      !['delivered', 'completed'].includes(order.state) ||
      command.payload.requestedAmountMinor > order.total.amountMinor
    ) {
      return failure('INVALID_STATE', 'The order is not eligible for this return amount.');
    }
    const occurredAt = this.now().toISOString();
    const updated: MarketplaceOrder = {
      ...order,
      revision: order.revision + 1,
      state: 'return_requested',
      returnRequest: {
        state: 'requested',
        reason: command.payload.reason,
        requestedAmountMinor: command.payload.requestedAmountMinor,
        requestedAt: occurredAt,
        updatedAt: occurredAt,
      },
      updatedAt: occurredAt,
    };
    return this.persistOrderAction(
      actorPubky,
      command,
      updated,
      'return.requested',
      order.sellerPubky,
      'return_updated',
      occurredAt,
    );
  }

  private approveReturn(actorPubky: string, command: ApproveReturnCommand): MarketplaceCommandResult {
    const resolved = this.getOrderAction(actorPubky, command.payload.orderId, command);
    if (!resolved.ok) return resolved.failure;
    const order = resolved.order;
    if (order.sellerPubky !== actorPubky) return failure('UNAUTHORIZED', 'Only the seller may approve this return.');
    if (order.state !== 'return_requested' || !order.returnRequest) {
      return failure('INVALID_STATE', 'No return is pending approval.');
    }
    const occurredAt = this.now().toISOString();
    const updated: MarketplaceOrder = {
      ...order,
      revision: order.revision + 1,
      state: 'return_approved',
      returnRequest: { ...order.returnRequest, state: 'approved', updatedAt: occurredAt },
      updatedAt: occurredAt,
    };
    return this.persistOrderAction(
      actorPubky,
      command,
      updated,
      'return.approved',
      order.buyerPubky,
      'return_updated',
      occurredAt,
    );
  }

  private receiveReturn(actorPubky: string, command: ReceiveReturnCommand): MarketplaceCommandResult {
    const resolved = this.getOrderAction(actorPubky, command.payload.orderId, command);
    if (!resolved.ok) return resolved.failure;
    const order = resolved.order;
    if (order.sellerPubky !== actorPubky) return failure('UNAUTHORIZED', 'Only the seller may receive this return.');
    if (order.state !== 'return_approved' || !order.returnRequest) {
      return failure('INVALID_STATE', 'The return is not approved.');
    }
    const occurredAt = this.now().toISOString();
    const updated: MarketplaceOrder = {
      ...order,
      revision: order.revision + 1,
      state: 'return_received',
      returnRequest: { ...order.returnRequest, state: 'received', updatedAt: occurredAt },
      updatedAt: occurredAt,
    };
    return this.persistOrderAction(
      actorPubky,
      command,
      updated,
      'return.received',
      order.buyerPubky,
      'return_updated',
      occurredAt,
    );
  }

  private recordExternalRefund(actorPubky: string, command: RecordExternalRefundCommand): MarketplaceCommandResult {
    const resolved = this.getOrderAction(actorPubky, command.payload.orderId, command);
    if (!resolved.ok) return resolved.failure;
    const order = resolved.order;
    if (order.sellerPubky !== actorPubky) return failure('UNAUTHORIZED', 'Only the seller may record a refund.');
    if (
      !['return_received', 'cancelled'].includes(order.state) ||
      command.payload.amountMinor > order.total.amountMinor ||
      order.externalRefund
    ) {
      return failure('INVALID_STATE', 'The external refund cannot be recorded.');
    }
    const occurredAt = this.now().toISOString();
    const updated: MarketplaceOrder = {
      ...order,
      revision: order.revision + 1,
      state: 'refunded_external',
      externalRefund: {
        amountMinor: command.payload.amountMinor,
        transactionId: command.payload.transactionId,
        recordedAt: occurredAt,
      },
      returnRequest: order.returnRequest
        ? { ...order.returnRequest, state: 'refunded', updatedAt: occurredAt }
        : order.returnRequest,
      updatedAt: occurredAt,
    };
    return this.persistOrderAction(
      actorPubky,
      command,
      updated,
      'refund.recorded_external',
      order.buyerPubky,
      'refund_recorded',
      occurredAt,
    );
  }

  private setPickupDetails(actorPubky: string, command: SetPickupDetailsCommand): MarketplaceCommandResult {
    // Deployment boundary (§A7/§A8): refused whenever sandbox payments are
    // enabled, so no real meeting point is stored against fake money.
    if (this.sandboxPaymentsEnabled) {
      return failure('INVALID_COMMAND', 'Pickup details cannot be stored on a sandbox-payments deployment.');
    }
    const listing = this.repository.getListing(command.aggregateId);
    if (!listing) return failure('NOT_FOUND', 'The listing is not registered.');
    if (listing.sellerPubky !== actorPubky) {
      return failure('UNAUTHORIZED', 'Only the listing seller may set pickup details.');
    }
    if (!listing.fulfillmentMethods.includes('pickup')) {
      return failure('INVALID_COMMAND', 'The listing does not offer pickup.');
    }
    // CAS against the per-listing version COUNTER row (§A3) — never against
    // the listing's server revision; post-clear the next set continues the
    // sequence against the surviving counter.
    const counter = this.repository.getPickupVersionCounter(listing.aggregateId);
    if (command.expectedRevision !== counter) {
      return failure('REVISION_CONFLICT', 'The pickup details version is stale.', { currentRevision: counter });
    }

    const occurredAt = this.now().toISOString();
    const details: MarketplacePickupDetailsVersion = {
      listingAggregateId: listing.aggregateId,
      version: counter + 1,
      terms: command.payload.details,
      updatedAt: occurredAt,
    };
    const event = this.createEvent(actorPubky, command, details.version, 'pickup_details.updated', occurredAt);
    this.repository.putCurrentPickupDetails(details);
    this.repository.putPickupDetailsVersion(details);
    this.repository.putPickupVersionCounter(listing.aggregateId, details.version);
    this.repository.appendEvent(event);
    this.notifyPaidPickupBuyers(listing.aggregateId, actorPubky, 'pickup_details_updated', occurredAt);
    return success(command, details.version, event.id, {
      kind: 'pickup_details',
      listingAggregateId: listing.aggregateId,
      version: details.version,
      details,
    });
  }

  private clearPickupDetails(actorPubky: string, command: ClearPickupDetailsCommand): MarketplaceCommandResult {
    if (this.sandboxPaymentsEnabled) {
      return failure('INVALID_COMMAND', 'Pickup details cannot be cleared on a sandbox-payments deployment.');
    }
    const listing = this.repository.getListing(command.aggregateId);
    if (!listing) return failure('NOT_FOUND', 'The listing is not registered.');
    if (listing.sellerPubky !== actorPubky) {
      return failure('UNAUTHORIZED', 'Only the listing seller may clear pickup details.');
    }
    const counter = this.repository.getPickupVersionCounter(listing.aggregateId);
    if (command.expectedRevision !== counter) {
      return failure('REVISION_CONFLICT', 'The pickup details version is stale.', { currentRevision: counter });
    }

    const occurredAt = this.now().toISOString();
    this.repository.deleteCurrentPickupDetails(listing.aggregateId);
    // Retention (§A3): hard-delete every version NOT referenced as
    // `version_at_payment` by a paid, non-terminal order; the per-listing
    // version counter row survives, so versions never restart.
    for (const version of this.repository.getPickupDetailsVersions(listing.aggregateId)) {
      if (!this.isPickupVersionReferenced(version)) {
        this.repository.deletePickupDetailsVersion(version);
      }
    }
    const event = this.createEvent(actorPubky, command, counter, 'pickup_details.cleared', occurredAt);
    this.repository.appendEvent(event);
    this.notifyPaidPickupBuyers(listing.aggregateId, actorPubky, 'pickup_details_cleared', occurredAt);
    return success(command, counter, event.id, {
      kind: 'pickup_details',
      listingAggregateId: listing.aggregateId,
      version: counter,
      details: null,
    });
  }

  private markReadyForPickup(actorPubky: string, command: MarkReadyForPickupCommand): MarketplaceCommandResult {
    const resolved = this.getOrderAction(actorPubky, command.payload.orderId, command);
    if (!resolved.ok) return resolved.failure;
    const order = resolved.order;
    if (order.sellerPubky !== actorPubky) {
      return failure('UNAUTHORIZED', 'Only the seller may mark the order ready for pickup.');
    }
    // Guarded the other way for shipped orders (§A6): typed refusal.
    if (order.fulfillment !== 'pickup') {
      return failure('INVALID_STATE', 'Only a pickup order can be marked ready for pickup.');
    }
    if (order.state !== 'paid') {
      return failure('INVALID_STATE', 'The order is not awaiting pickup readiness.');
    }
    const occurredAt = this.now().toISOString();
    const updated: MarketplaceOrder = {
      ...order,
      revision: order.revision + 1,
      state: 'ready_for_pickup',
      updatedAt: occurredAt,
    };
    return this.persistOrderAction(
      actorPubky,
      command,
      updated,
      'fulfillment.ready_for_pickup',
      order.buyerPubky,
      'pickup_ready',
      occurredAt,
    );
  }

  private confirmPickup(actorPubky: string, command: ConfirmPickupCommand): MarketplaceCommandResult {
    const resolved = this.getOrderAction(actorPubky, command.payload.orderId, command);
    if (!resolved.ok) return resolved.failure;
    const order = resolved.order;
    if (order.fulfillment !== 'pickup') {
      return failure('INVALID_STATE', 'Only a pickup order confirms a pickup handover.');
    }
    if (order.state !== 'paid' && order.state !== 'ready_for_pickup') {
      return failure('INVALID_STATE', 'The order is not awaiting a pickup handover.');
    }
    // The seller cannot self-confirm away the buyer's exit (§A6): a
    // seller-actor confirm is refused while a post-payment terms change is
    // unresolved; the buyer's own confirm stays allowed.
    if (actorPubky === order.sellerPubky && this.hasUnresolvedTermsChange(order)) {
      return failure('INVALID_STATE', 'The seller cannot confirm the handover while a terms change is unresolved.');
    }
    const occurredAt = this.now().toISOString();
    // One handover per order (PK on the order id, §A6): who confirmed and the
    // server instant. A seller-only confirm is seller-attested, never
    // reputation-positive on its own.
    const handover: MarketplacePickupHandover = {
      orderId: order.id,
      confirmedBy: actorPubky,
      attestation: actorPubky === order.buyerPubky ? 'buyer_confirmed' : 'seller_attested',
      confirmedAt: occurredAt,
    };
    const updated: MarketplaceOrder = {
      ...order,
      revision: order.revision + 1,
      state: 'delivered',
      handover,
      updatedAt: occurredAt,
    };
    this.repository.putHandover(handover);
    return this.persistOrderAction(
      actorPubky,
      command,
      updated,
      // The same delivery fact a shipped order's confirm emits (§A6).
      'fulfillment.delivered',
      actorPubky === order.buyerPubky ? order.sellerPubky : order.buyerPubky,
      'order_delivered',
      occurredAt,
    );
  }

  /**
   * The buyer-only reveal read (§A3): serves the PINNED per-line snapshots —
   * never the listing's current details — with read-only availability
   * windows. Entitlement = the durable payment fact (`receipt_id` set by the
   * exactly-once confirmation path), re-evaluated on every read, ending at
   * the terminal transition (cancel on any path included). Refused outright
   * on sandbox-payments deployments, and for any order whose pin recorded
   * `sandbox_advance` as the confirming adapter — checked against the pin on
   * every read, independent of the deployment's current flag. The first
   * successful read stamps `first_revealed_at`, opening the bounded
   * withdrawal window.
   */
  revealPickupDetails(actorPubky: string, orderId: string): MarketplacePickupRevealResult {
    const refuse = (
      code: MarketplaceCommandFailure['error']['code'],
      message: string,
    ): MarketplacePickupRevealResult => ({
      ok: false,
      error: { code, message },
    });
    if (this.sandboxPaymentsEnabled) {
      return refuse('INVALID_COMMAND', 'The pickup reveal is unavailable on a sandbox-payments deployment.');
    }
    const order = this.repository.getOrder(orderId);
    if (!order) return refuse('NOT_FOUND', 'The order was not found.');
    if (order.buyerPubky !== actorPubky) {
      return refuse('UNAUTHORIZED', 'Only the order buyer may reveal pickup details.');
    }
    if (order.fulfillment !== 'pickup') {
      return refuse('INVALID_STATE', 'The order is not a pickup order.');
    }
    if (!order.receiptId) {
      return refuse('INVALID_STATE', 'The order carries no durable payment fact.');
    }
    if (order.revealRevokedAt || order.state === 'completed' || order.state === 'closed') {
      return refuse('INVALID_STATE', 'The pickup reveal entitlement has ended.');
    }
    const pickupLines = order.lines
      .map((line, lineIndex) => ({ line, lineIndex }))
      .filter(({ line }) => line.fulfillment === 'pickup');
    const snapshots = pickupLines.map(({ line, lineIndex }) => ({
      line,
      lineIndex,
      snapshot: this.repository.getPickupSnapshot(order.id, lineIndex),
    }));
    if (snapshots.some(({ snapshot }) => snapshot?.pinnedAdapter === 'sandbox_advance')) {
      return refuse(
        'INVALID_STATE',
        'The order was confirmed under sandbox_advance; its meeting point is never revealed.',
      );
    }
    // Binding assertion (§A3): the snapshot served for a line must be the
    // one pinned FOR that line — bound to (order id ‖ line index ‖
    // version), its version must equal the line's `version_at_payment`. A
    // transplanted or mismatched snapshot is refused, never served.
    if (
      snapshots.some(
        ({ line, lineIndex, snapshot }) =>
          snapshot !== undefined &&
          (snapshot.orderId !== order.id ||
            snapshot.lineIndex !== lineIndex ||
            snapshot.version !== (line.versionAtPayment ?? null)),
      )
    ) {
      return refuse('INVARIANT_VIOLATION', 'A pinned pickup snapshot does not match the order line it was pinned for.');
    }

    const occurredAt = this.now().toISOString();
    if (!order.firstRevealedAt) {
      this.repository.putOrder({ ...order, firstRevealedAt: occurredAt });
    }
    const lines: MarketplacePickupRevealLine[] = snapshots.map(({ line, lineIndex, snapshot }) => {
      const pinnedVersion = snapshot?.version ?? null;
      const counter = this.repository.getPickupVersionCounter(line.listingAggregateId);
      const current = this.repository.getCurrentPickupDetails(line.listingAggregateId);
      return {
        lineIndex,
        listingAggregateId: line.listingAggregateId,
        version: pinnedVersion,
        terms: snapshot?.terms ?? null,
        currentVersion: counter,
        updatedSincePayment: pinnedVersion !== null && counter > pinnedVersion,
        // "Withdrawn" is only meaningful against a pinned version: details
        // cleared BEFORE checkout pin nothing, so there is nothing this
        // order was shown that could have been withdrawn.
        withdrawnBySeller: pinnedVersion !== null && !current,
      };
    });
    return { ok: true, orderId: order.id, firstRevealedAt: order.firstRevealedAt ?? occurredAt, lines };
  }

  /**
   * The seller's owner read (§A4): their own details, or — after a
   * `pickup_details.clear` — "no details" ALONGSIDE the surviving version
   * counter, so the next `pickup_details.set` can CAS against the counter
   * without a hidden second read (§A3).
   */
  getSellerPickupDetails(actorPubky: string, listingAggregateId: string): MarketplaceSellerPickupDetailsResult {
    const listing = this.repository.getListing(listingAggregateId);
    if (!listing) {
      return { ok: false, error: { code: 'NOT_FOUND', message: 'The listing is not registered.' } };
    }
    if (listing.sellerPubky !== actorPubky) {
      return {
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Only the listing seller may read its pickup details.' },
      };
    }
    const current = this.repository.getCurrentPickupDetails(listingAggregateId);
    return {
      ok: true,
      listingAggregateId,
      version: this.repository.getPickupVersionCounter(listingAggregateId),
      details: current?.terms ?? null,
    };
  }

  /**
   * §A6 `next_actor()`: `'buyer' | 'seller'` only. For a pickup order in
   * `paid` the seller is armed (mark ready, or confirm the handover); in
   * `ready_for_pickup` the buyer is armed (confirm on receipt). Shipped
   * orders keep the existing mapping.
   */
  getNextActor(order: MarketplaceOrder): 'buyer' | 'seller' | null {
    switch (order.state) {
      case 'pending_payment':
        return 'buyer';
      case 'paid':
      case 'processing':
        return 'seller';
      case 'ready_for_pickup':
        return 'buyer';
      case 'shipped':
      case 'delivered':
      case 'completed':
        return 'buyer';
      case 'cancel_requested':
      case 'cancelled':
      case 'return_requested':
      case 'return_approved':
      case 'return_received':
        return 'seller';
      case 'refunded_external':
      case 'closed':
        return null;
    }
  }

  /**
   * The auto-complete sweep (§A6): completes `delivered` orders on one
   * deadline, coalescing the delivery instant — the handover record's server
   * instant for pickup orders, `shipment.deliveredAt` for shipped ones — so
   * pickup orders auto-complete exactly like shipped ones instead of being
   * warn-and-skipped forever.
   */
  completeDueDeliveredOrders(): MarketplaceOrder[] {
    const nowMs = this.now().getTime();
    const occurredAt = this.now().toISOString();
    const completed: MarketplaceOrder[] = [];
    for (const order of this.repository.getAllOrders()) {
      if (order.state !== 'delivered') continue;
      const deliveredAt = order.fulfillment === 'pickup' ? order.handover?.confirmedAt : order.shipment?.deliveredAt;
      if (!deliveredAt) continue;
      if (nowMs - Date.parse(deliveredAt) < ORDER_AUTO_COMPLETE_AFTER_MS) continue;
      const updated: MarketplaceOrder = {
        ...order,
        revision: order.revision + 1,
        state: 'completed',
        updatedAt: occurredAt,
      };
      this.repository.putOrder(updated);
      this.repository.appendEvent(
        this.createEvent(
          SERVER_ACTOR_PUBKY,
          { commandId: `sweep:${order.id}`, aggregateId: buildMarketplaceOrderAggregateId(order.id) },
          updated.revision,
          'order.completed',
          occurredAt,
        ),
      );
      this.runPickupRetentionSweep([updated]);
      completed.push(updated);
    }
    return completed;
  }

  /** Every paid, non-terminal pickup order referencing the listing gets the terms-change notification (§A3). */
  private notifyPaidPickupBuyers(
    listingAggregateId: string,
    actorPubky: string,
    type: 'pickup_details_updated' | 'pickup_details_cleared',
    occurredAt: string,
  ): void {
    for (const order of this.repository.getAllOrders()) {
      if (order.fulfillment !== 'pickup' || !order.receiptId || isTerminalForPickupRetention(order)) continue;
      if (
        !order.lines.some((line) => line.fulfillment === 'pickup' && line.listingAggregateId === listingAggregateId)
      ) {
        continue;
      }
      this.notify(order.buyerPubky, actorPubky, type, `order:${order.id}`, occurredAt);
    }
  }

  /** A version row survives `pickup_details.clear` only while a paid, non-terminal order pins it (§A3). */
  private isPickupVersionReferenced(version: MarketplacePickupDetailsVersion): boolean {
    return this.repository
      .getAllOrders()
      .some(
        (order) =>
          order.receiptId !== null &&
          !isTerminalForPickupRetention(order) &&
          order.lines.some(
            (line) =>
              line.listingAggregateId === version.listingAggregateId && line.versionAtPayment === version.version,
          ),
      );
  }

  /**
   * The terminal-order purge (§A3): hard-delete version rows whose referencing
   * orders all went terminal, and purge pinned snapshots — immediately on
   * `completed`, and on `refund.record_external` for a cancelled-after-payment
   * order (the snapshot outlives the cancel only as dispute evidence, until
   * the seller's refund evidence lands). The version-row walk is SCOPED to
   * the listings referenced by the order(s) that just went terminal — an
   * unrelated order going terminal can never purge another listing's
   * version history — and a listing's CURRENT row (the live details, not
   * purgeable history) is never deleted.
   */
  private runPickupRetentionSweep(terminalOrders: MarketplaceOrder[]): void {
    for (const order of this.repository.getAllOrders()) {
      if (order.state === 'completed' || order.state === 'closed') {
        this.repository.deletePickupSnapshotsForOrder(order.id);
      }
      if (order.state === 'refunded_external' && order.revealRevokedAt) {
        this.repository.deletePickupSnapshotsForOrder(order.id);
      }
    }
    const affectedListings = new Set(
      terminalOrders.flatMap((order) =>
        order.lines.filter((line) => line.fulfillment === 'pickup').map((line) => line.listingAggregateId),
      ),
    );
    for (const listingAggregateId of affectedListings) {
      const current = this.repository.getCurrentPickupDetails(listingAggregateId);
      for (const version of this.repository.getPickupDetailsVersions(listingAggregateId)) {
        if (current?.version === version.version) continue;
        if (!this.isPickupVersionReferenced(version)) {
          this.repository.deletePickupDetailsVersion(version);
        }
      }
    }
  }

  private createReview(actorPubky: string, command: CreateReviewCommand): MarketplaceCommandResult {
    const resolved = this.getOrderAction(actorPubky, command.payload.orderId, command);
    if (!resolved.ok) return resolved.failure;
    const order = resolved.order;
    if (!['delivered', 'completed', 'closed'].includes(order.state)) {
      return failure('INVALID_STATE', 'The order is not eligible for review.');
    }
    if (order.reviews.some(({ reviewerPubky }) => reviewerPubky === actorPubky)) {
      return failure('INVALID_STATE', 'This participant already reviewed the order.');
    }
    const occurredAt = this.now().toISOString();
    const review: MarketplaceReview = {
      id: command.commandId,
      reviewerPubky: actorPubky,
      subjectPubky: actorPubky === order.buyerPubky ? order.sellerPubky : order.buyerPubky,
      rating: command.payload.rating,
      text: command.payload.text,
      createdAt: occurredAt,
    };
    const updated: MarketplaceOrder = {
      ...order,
      revision: order.revision + 1,
      state: order.state === 'delivered' ? 'completed' : order.state,
      reviews: [...order.reviews, review],
      updatedAt: occurredAt,
    };
    this.repository.putOrder(updated);
    if (updated.state === 'completed') this.runPickupRetentionSweep([updated]);
    const event = this.createEvent(actorPubky, command, updated.revision, 'review.created', occurredAt);
    this.repository.appendEvent(event);
    this.notify(review.subjectPubky, actorPubky, 'review_received', `order:${order.id}`, occurredAt);
    return success(command, updated.revision, event.id, { kind: 'review', order: updated, review });
  }

  private getOrderAction(
    actorPubky: string,
    orderId: string,
    command: PrototypeMarketplaceCommand,
  ): { ok: true; order: MarketplaceOrder } | { ok: false; failure: MarketplaceCommandFailure } {
    const order = this.repository.getOrder(orderId);
    if (!order) return { ok: false, failure: failure('NOT_FOUND', 'The order was not found.') };
    if (actorPubky !== order.buyerPubky && actorPubky !== order.sellerPubky) {
      return { ok: false, failure: failure('UNAUTHORIZED', 'Only order participants may act on it.') };
    }
    if (command.aggregateId !== buildMarketplaceOrderAggregateId(order.id)) {
      return { ok: false, failure: failure('INVALID_COMMAND', 'The order aggregate id is invalid.') };
    }
    if (command.expectedRevision !== order.revision) {
      return {
        ok: false,
        failure: failure('REVISION_CONFLICT', 'The order revision is stale.', { currentRevision: order.revision }),
      };
    }
    return { ok: true, order };
  }

  private persistOrderAction(
    actorPubky: string,
    command: PrototypeMarketplaceCommand,
    order: MarketplaceOrder,
    eventKind: MarketplaceEvent['kind'],
    notificationRecipient: string,
    notificationType: MarketplaceNotification['type'],
    occurredAt: string,
  ): MarketplaceCommandResult {
    this.repository.putOrder(order);
    if (['cancelled', 'completed', 'closed', 'refunded_external'].includes(order.state)) {
      this.runPickupRetentionSweep([order]);
    }
    const event = this.createEvent(
      actorPubky,
      command,
      order.revision,
      eventKind,
      occurredAt,
      buildMarketplaceOrderAggregateId(order.id),
    );
    this.repository.appendEvent(event);
    this.notify(notificationRecipient, actorPubky, notificationType, `order:${order.id}`, occurredAt);
    return success(command, order.revision, event.id, { kind: 'order', order });
  }

  private releaseOrderInventory(order: MarketplaceOrder, occurredAt: string): void {
    for (const line of order.lines) {
      const listing = this.repository.getListing(line.listingAggregateId);
      if (!listing) continue;
      this.repository.putListing({
        ...listing,
        serverRevision: listing.serverRevision + 1,
        state: 'available',
        availableQuantity: listing.availableQuantity + line.quantity,
        reservedQuantity: Math.max(0, listing.reservedQuantity - line.quantity),
        updatedAt: occurredAt,
      });
    }
  }

  private notify(
    recipientPubky: string,
    actorPubky: string,
    type: MarketplaceNotification['type'],
    aggregateId: string,
    createdAt: string,
  ): void {
    const preferences = this.getNotificationPreferences(recipientPubky);
    const enabled = [
      'order_created',
      'payment_confirmed',
      'order_cancelled',
      'order_shipped',
      'order_delivered',
      'return_updated',
      'refund_recorded',
      'review_received',
      'pickup_details_updated',
      'pickup_details_cleared',
      'pickup_ready',
    ].includes(type)
      ? true
      : type === 'message_received'
        ? preferences.messages
        : type === 'outbid'
          ? preferences.bids
          : type === 'auction_won' || type === 'auction_ended'
            ? preferences.auctions
            : preferences.offers;
    if (!enabled) return;
    this.repository.appendNotification({
      id: randomUUID(),
      revision: 1,
      recipientPubky,
      actorPubky,
      type,
      aggregateId,
      createdAt,
      readAt: null,
    });
  }

  private createEvent(
    actorPubky: string,
    command: { commandId: string; aggregateId: string },
    revision: number,
    kind: MarketplaceEvent['kind'],
    occurredAt: string,
    aggregateId = command.aggregateId,
  ): MarketplaceEvent {
    return {
      id: randomUUID(),
      commandId: command.commandId,
      aggregateId,
      revision,
      actorPubky,
      kind,
      occurredAt,
    };
  }
}

/**
 * The auto-complete deadline (§A6), mirrored from the durable service's
 * `complete_due_delivered_orders_batch` sweep: a `delivered` order with no
 * return completes this long after its delivery instant.
 */
export const ORDER_AUTO_COMPLETE_AFTER_MS = 3 * 24 * 60 * 60 * 1_000;

/**
 * Terminal for pickup retention and the reveal cutoff (§A3): `cancelled` (any
 * path — stamped via `revealRevokedAt`), `completed`, `closed`, and the
 * cancelled-then-refunded leg. The entitlement stays true through
 * `cancel_requested`, returns, and refunds that passed through payment.
 */
function isTerminalForPickupRetention(order: MarketplaceOrder): boolean {
  return (
    order.state === 'cancelled' ||
    order.state === 'completed' ||
    order.state === 'closed' ||
    (order.state === 'refunded_external' && order.revealRevokedAt !== null)
  );
}

function success(
  command: { commandId: string; aggregateId: string },
  revision: number,
  eventIds: string | string[],
  result: MarketplaceCommandSuccess['result'],
): MarketplaceCommandSuccess {
  return {
    ok: true,
    version: 1,
    commandId: command.commandId,
    aggregateId: command.aggregateId,
    revision,
    eventIds: Array.isArray(eventIds) ? eventIds : [eventIds],
    result,
  };
}

function failure(
  code: MarketplaceCommandFailure['error']['code'],
  message: string,
  details: Pick<MarketplaceCommandFailure['error'], 'currentRevision' | 'issues' | 'reason'> = {},
): MarketplaceCommandFailure {
  return { ok: false, error: { code, message, ...details } };
}

function hashCommand(command: PrototypeMarketplaceCommand): string {
  return createHash('sha256').update(JSON.stringify(command)).digest('hex');
}

function sameAsset(
  left: MarketplaceListingAggregate['unitPrice'],
  right: MarketplaceListingAggregate['unitPrice'],
): boolean {
  return left.currency === right.currency && left.exponent === right.exponent;
}

function latestBidderMaximums(bids: MarketplaceBid[]): Map<string, MarketplaceBid> {
  const latest = new Map<string, MarketplaceBid>();
  for (const bid of bids) {
    const current = latest.get(bid.bidderPubky);
    if (
      !current ||
      bid.maximumAmount.amountMinor > current.maximumAmount.amountMinor ||
      (bid.maximumAmount.amountMinor === current.maximumAmount.amountMinor && bid.sequence < current.sequence)
    ) {
      latest.set(bid.bidderPubky, bid);
    }
  }
  return latest;
}

function hasImageSignature(mimeType: string, bytes: Uint8Array): boolean {
  if (mimeType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (mimeType === 'image/png') {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
  }
  if (mimeType === 'image/webp') {
    return (
      bytes.length >= 12 &&
      String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
    );
  }
  return false;
}

function toAttachmentMetadata(attachment: MarketplaceStoredAttachment): MarketplaceAttachmentMetadata {
  return {
    id: attachment.id,
    senderPubky: attachment.senderPubky,
    recipientPubky: attachment.recipientPubky,
    mimeType: attachment.mimeType,
    byteSize: attachment.byteSize,
    contentHash: attachment.contentHash,
    createdAt: attachment.createdAt,
  };
}

// ---------------------------------------------------------------------------
// The emitted state-machine document (slice 7.0 gate, §A8): the Wave 7 Part A
// machine contract, diffed in the contract test against the checked-in
// `services/marketplace/contracts/expected-state-machines.wave7.json`. Once
// the durable service vendors its artifact in 7.1, the same document is
// diffed against that artifact. `contract_version` stays 1 (additive), the
// aggregate count stays 8 (`pickup_schedule` is a Wave 7b aggregate), and the
// format deliberately matches the service's `state-machines.json`.
// ---------------------------------------------------------------------------

type MachineVia = { trigger: 'command' | 'server'; name: string };
type MachineTransition = { from: string; to: string; via: MachineVia[] };
type AggregateMachine = {
  aggregate: string;
  states: string[];
  initial: string;
  transitions: MachineTransition[];
  commands: string[];
  unreachable_states: string[];
};

const command = (name: string): MachineVia => ({ trigger: 'command', name });
const server = (name: string): MachineVia => ({ trigger: 'server', name });

export function buildPrototypeStateMachineDocument(): {
  contract_version: 1;
  source: string;
  aggregates: AggregateMachine[];
} {
  return {
    contract_version: 1,
    source: 'marketplace-domain::state_machines',
    aggregates: [
      {
        aggregate: 'listing',
        states: ['available', 'reserved', 'sold'],
        initial: 'available',
        transitions: [
          {
            from: 'available',
            to: 'reserved',
            via: [
              command('inventory.reserve'),
              command('checkout.create'),
              command('offer.accept'),
              command('auction.close'),
            ],
          },
          {
            from: 'reserved',
            to: 'available',
            via: [server('reservation_expiry'), command('order.cancel_request'), command('order.cancel_approve')],
          },
          {
            from: 'reserved',
            to: 'sold',
            via: [command('payment.sandbox_advance'), server('payment_confirmation')],
          },
          {
            from: 'sold',
            to: 'available',
            // The unilateral buyer exits release inventory through approve's
            // path (§A6/§A8), so `order.cancel_request` joins this edge.
            via: [command('order.cancel_request'), command('order.cancel_approve')],
          },
        ],
        commands: [
          'listing.register',
          'listing.sync',
          'inventory.reserve',
          'checkout.create',
          'offer.accept',
          'auction.close',
        ],
        unreachable_states: [],
      },
      {
        aggregate: 'reservation',
        states: ['active', 'converted', 'released', 'expired'],
        initial: 'active',
        transitions: [
          { from: 'active', to: 'expired', via: [server('reservation_expiry')] },
          { from: 'active', to: 'released', via: [command('order.cancel_request'), command('order.cancel_approve')] },
          {
            from: 'active',
            to: 'converted',
            via: [command('payment.sandbox_advance'), server('payment_confirmation')],
          },
        ],
        commands: ['inventory.reserve'],
        unreachable_states: [],
      },
      {
        aggregate: 'offer',
        states: ['pending', 'countered', 'accepted', 'rejected', 'withdrawn', 'expired'],
        initial: 'pending',
        transitions: [
          { from: 'pending', to: 'countered', via: [command('offer.counter')] },
          { from: 'pending', to: 'accepted', via: [command('offer.accept')] },
          { from: 'pending', to: 'rejected', via: [command('offer.reject')] },
          { from: 'pending', to: 'withdrawn', via: [command('offer.withdraw')] },
          { from: 'pending', to: 'expired', via: [server('offer_expiry')] },
          { from: 'countered', to: 'countered', via: [command('offer.counter')] },
          { from: 'countered', to: 'accepted', via: [command('offer.accept')] },
          { from: 'countered', to: 'rejected', via: [command('offer.reject')] },
          { from: 'countered', to: 'withdrawn', via: [command('offer.withdraw')] },
          { from: 'countered', to: 'expired', via: [server('offer_expiry')] },
        ],
        commands: ['offer.create', 'offer.counter', 'offer.accept', 'offer.reject', 'offer.withdraw'],
        unreachable_states: [],
      },
      {
        aggregate: 'auction',
        states: ['scheduled', 'active', 'sold', 'unsold', 'cancelled'],
        initial: 'scheduled',
        transitions: [
          { from: 'scheduled', to: 'active', via: [server('auction_start')] },
          { from: 'active', to: 'sold', via: [command('auction.close'), server('auction_close')] },
          { from: 'active', to: 'unsold', via: [command('auction.close'), server('auction_close')] },
        ],
        commands: ['listing.register', 'auction.place_bid', 'auction.close'],
        unreachable_states: ['cancelled'],
      },
      {
        aggregate: 'order',
        states: [
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
        ],
        initial: 'pending_payment',
        transitions: [
          {
            from: 'pending_payment',
            to: 'paid',
            via: [command('payment.sandbox_advance'), server('payment_confirmation')],
          },
          {
            from: 'pending_payment',
            to: 'cancelled',
            via: [command('order.cancel_request'), server('payment_window')],
          },
          { from: 'paid', to: 'shipped', via: [command('fulfillment.ship')] },
          // Wave 7 pickup path (§A6): everything below this row is additive;
          // the shipped-order edges behave exactly as before.
          { from: 'paid', to: 'ready_for_pickup', via: [command('fulfillment.mark_ready')] },
          { from: 'paid', to: 'delivered', via: [command('fulfillment.confirm_pickup')] },
          { from: 'paid', to: 'cancel_requested', via: [command('order.cancel_request')] },
          // Unilateral: post-payment terms change, or the bounded post-reveal
          // withdrawal window (§A3).
          { from: 'paid', to: 'cancelled', via: [command('order.cancel_request')] },
          { from: 'processing', to: 'shipped', via: [command('fulfillment.ship')] },
          { from: 'processing', to: 'cancel_requested', via: [command('order.cancel_request')] },
          { from: 'ready_for_pickup', to: 'delivered', via: [command('fulfillment.confirm_pickup')] },
          { from: 'ready_for_pickup', to: 'cancel_requested', via: [command('order.cancel_request')] },
          { from: 'ready_for_pickup', to: 'cancelled', via: [command('order.cancel_request')] },
          { from: 'cancel_requested', to: 'cancelled', via: [command('order.cancel_approve')] },
          { from: 'shipped', to: 'delivered', via: [command('fulfillment.confirm_delivery')] },
          { from: 'delivered', to: 'return_requested', via: [command('return.request')] },
          { from: 'delivered', to: 'completed', via: [command('review.create')] },
          { from: 'completed', to: 'return_requested', via: [command('return.request')] },
          { from: 'return_requested', to: 'return_approved', via: [command('return.approve')] },
          { from: 'return_approved', to: 'return_received', via: [command('return.receive')] },
          { from: 'return_received', to: 'refunded_external', via: [command('refund.record_external')] },
          { from: 'cancelled', to: 'refunded_external', via: [command('refund.record_external')] },
        ],
        commands: [
          'checkout.create',
          'payment.sandbox_advance',
          'order.cancel_request',
          'order.cancel_approve',
          'fulfillment.ship',
          'fulfillment.confirm_delivery',
          'fulfillment.mark_ready',
          'fulfillment.confirm_pickup',
          'return.request',
          'return.approve',
          'return.receive',
          'refund.record_external',
          'review.create',
          'review.update',
        ],
        unreachable_states: ['processing', 'closed'],
      },
      {
        aggregate: 'payment',
        states: ['awaiting_entitlement', 'detected', 'confirmed', 'expired', 'manual_review'],
        initial: 'awaiting_entitlement',
        transitions: [
          { from: 'awaiting_entitlement', to: 'detected', via: [command('payment.sandbox_advance')] },
          {
            from: 'awaiting_entitlement',
            to: 'confirmed',
            via: [command('payment.sandbox_advance'), server('locks_verification')],
          },
          {
            from: 'awaiting_entitlement',
            to: 'expired',
            via: [command('payment.sandbox_advance'), server('payment_window')],
          },
          {
            from: 'awaiting_entitlement',
            to: 'manual_review',
            via: [command('payment.sandbox_advance'), server('locks_verification')],
          },
          { from: 'detected', to: 'confirmed', via: [command('payment.sandbox_advance')] },
          { from: 'detected', to: 'manual_review', via: [command('payment.sandbox_advance')] },
          { from: 'expired', to: 'manual_review', via: [server('locks_late_completion')] },
        ],
        commands: ['payment.sandbox_advance', 'payment.register_locks'],
        unreachable_states: [],
      },
      {
        aggregate: 'return',
        states: ['requested', 'approved', 'received', 'refunded'],
        initial: 'requested',
        transitions: [
          { from: 'requested', to: 'approved', via: [command('return.approve')] },
          { from: 'approved', to: 'received', via: [command('return.receive')] },
          { from: 'received', to: 'refunded', via: [command('refund.record_external')] },
        ],
        commands: ['return.request', 'return.approve', 'return.receive', 'refund.record_external'],
        unreachable_states: [],
      },
      {
        aggregate: 'drop',
        states: ['announced', 'live', 'ended_sold_out', 'ended_closed', 'ended_cancelled'],
        initial: 'announced',
        transitions: [
          {
            from: 'announced',
            to: 'live',
            via: [command('inventory.reserve'), command('checkout.create'), server('drop_start')],
          },
          { from: 'announced', to: 'ended_closed', via: [server('drop_end')] },
          { from: 'live', to: 'ended_closed', via: [server('drop_end')] },
          {
            from: 'live',
            to: 'ended_sold_out',
            via: [command('payment.sandbox_advance'), server('payment_confirmation')],
          },
          { from: 'announced', to: 'ended_cancelled', via: [command('drop.cancel')] },
          { from: 'live', to: 'ended_cancelled', via: [command('drop.cancel')] },
        ],
        commands: ['drop.sync', 'drop.cancel', 'drop.release_listings', 'inventory.reserve', 'checkout.create'],
        unreachable_states: [],
      },
    ],
  };
}
