import { z } from 'zod';
import { commerceDeliveryAddressValueSchema } from './postal-address';

// -----------------------------------------------------------------------------
// Local pickup — Wave 7 safe subset (docs/ecommerce/local-pickup-design.md
// PART A; Part B is deferred and deliberately not built here).
//
// The Marketplace Transaction Service is the source of truth for these
// shapes: `crates/domain/src/commands.rs` (payloads and validators),
// `crates/service/src/handlers/pickup.rs` (command results and the two
// entitled reveal reads), and `crates/service/src/http.rs` (the /health
// capability). Schemas here are camelCase — the wire-casing layer converts
// at the transport boundary, as with every marketplace contract.
// -----------------------------------------------------------------------------

/**
 * How an order reaches the buyer (§A2; digital delivery design §6 A1–A4).
 * Distinct from the listing's item type.
 */
export const marketplaceFulfillmentMethodSchema = z.enum(['shipping', 'pickup', 'digital']);
export type MarketplaceFulfillmentMethod = z.infer<typeof marketplaceFulfillmentMethodSchema>;

/**
 * The fulfillment methods a listing publishes (`fulfillmentMethods`, §A1).
 * Public catalog data, echoed to the service at `listing.register` /
 * `listing.sync`. Validation mirrors the service's
 * `validate_register_listing_payload`: non-empty, known values, deduped.
 * Defaults to shipping-only so records and clients predating pickup are
 * unaffected.
 */
export const marketplaceFulfillmentMethodsSchema = z
  .array(marketplaceFulfillmentMethodSchema)
  .min(1, 'Expected at least one fulfillment method')
  .max(3)
  .refine((methods) => new Set(methods).size === methods.length, {
    message: 'Fulfillment methods must be unique',
  })
  .default(['shipping']);

/** Rejects control characters, mirroring the service's `validate_printable` (single-line display strings). */
const printableSchema = (schema: z.ZodString) =>
  schema.refine((value) => !/[\u0000-\u001F\u007F-\u009F]/.test(value), {
    message: 'Expected printable characters only',
  });

/** 24-hour `HH:MM` local wall-clock time, mirroring the service's `hhmm_regex`. */
const pickupWallClockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected a 24-hour HH:MM wall-clock time');

/**
 * One recurring weekly availability window, authored in the pickup
 * location's local wall clock. Wave 7 serves windows READ-ONLY to the
 * paying buyer — there is no propose path (§A3; scheduling is Wave 7b).
 * Weekday vocabulary mirrors the service's `WEEKDAYS`.
 */
export const pickupAvailabilityWindowSchema = z
  .object({
    day: z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
    start: pickupWallClockSchema,
    end: pickupWallClockSchema,
  })
  .strict()
  .superRefine((window, context) => {
    if (window.start >= window.end) {
      context.addIssue({ code: 'custom', path: ['end'], message: 'Window end must follow start' });
    }
  });

/** The seller's availability: recurring weekly windows with the pickup location's IANA zone, or arrange-after-payment when `windows` is absent. */
export const pickupAvailabilitySchema = z
  .object({
    windows: z.array(pickupAvailabilityWindowSchema).min(1).max(14).optional(),
    /** IANA timezone the windows are authored in (e.g. `Europe/Berlin`). */
    zone: printableSchema(z.string().trim().min(3).max(64)).refine((zone) => zone.includes('/'), {
      message: 'Expected an IANA timezone (Area/City)',
    }),
  })
  .strict();

/** A full pickup address; field limits follow the shared postal-address table. */
export const pickupAddressSchema = commerceDeliveryAddressValueSchema;

/**
 * The seller-authored pickup details (§A1): a full address OR a free-text
 * pickup spot (spot-first — the seller never has to publish their home),
 * instructions, and availability. This is restricted personal data: sealed
 * at rest in the service, revealed only to the seller and the paying buyer.
 * Validation mirrors the service's `validate_pickup_details`, including the
 * kind pairing rules.
 */
export const pickupDetailsSchema = z
  .object({
    kind: z.enum(['address', 'spot']),
    address: pickupAddressSchema.optional(),
    /** The free-text meeting point (e.g. "Central Station, north entrance"). */
    spot: printableSchema(z.string().trim().min(1).max(200)).optional(),
    instructions: printableSchema(z.string().trim().max(1_000)).default(''),
    availability: pickupAvailabilitySchema,
  })
  .strict()
  .superRefine((details, context) => {
    if (details.kind === 'address') {
      if (details.address === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['address'],
          message: 'Address-kind pickup details require an address',
        });
      }
      if (details.spot !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['spot'],
          message: 'Address-kind pickup details cannot carry a spot',
        });
      }
    } else {
      if (details.spot === undefined) {
        context.addIssue({
          code: 'custom',
          path: ['spot'],
          message: 'Spot-kind pickup details require a meeting point',
        });
      }
      if (details.address !== undefined) {
        context.addIssue({
          code: 'custom',
          path: ['address'],
          message: 'Spot-kind pickup details cannot carry an address',
        });
      }
    }
  });

export type MarketplacePickupAddress = z.infer<typeof pickupAddressSchema>;
export type MarketplacePickupAvailabilityWindow = z.infer<typeof pickupAvailabilityWindowSchema>;
export type MarketplacePickupAvailability = z.infer<typeof pickupAvailabilitySchema>;
export type MarketplacePickupDetails = z.infer<typeof pickupDetailsSchema>;

// -----------------------------------------------------------------------------
// Telemetry masking (§A1, the client counterpart of the service's redacted
// Debug impls).
// -----------------------------------------------------------------------------

/** Placeholder serialized wherever pickup details meet a log, telemetry, or JSON boundary. */
export const PICKUP_DETAILS_REDACTED = '[redacted: pickup details]';

/**
 * Revealed pickup details are restricted personal data. The buyer's revealed
 * copy is held IN MEMORY ONLY — it is never persisted to Dexie, a store, or
 * any storage (§A1; the reveal read is re-issued on each view) — and it must
 * never reach logs, analytics, or Sentry.
 *
 * This wrapper makes the masking structural instead of conventional: the
 * plaintext lives in a private field (invisible to object walkers, spreads,
 * and `structuredClone`), and every serialization path (`JSON.stringify`,
 * `String()`, template interpolation) emits only the redaction placeholder.
 * The entitled UI surface reads the plaintext explicitly via {@link value}
 * and must never pass the unwrapped value to a log or telemetry helper.
 */
export class MaskedPickupDetails {
  readonly #details: MarketplacePickupDetails;

  private constructor(details: MarketplacePickupDetails) {
    this.#details = details;
  }

  static wrap(details: MarketplacePickupDetails): MaskedPickupDetails {
    return new MaskedPickupDetails(details);
  }

  /** The plaintext, for the entitled render surface only — never log, persist, or serialize it. */
  get value(): MarketplacePickupDetails {
    return this.#details;
  }

  toJSON(): string {
    return PICKUP_DETAILS_REDACTED;
  }

  toString(): string {
    return PICKUP_DETAILS_REDACTED;
  }
}

/** Parses pickup details straight into their self-redacting wrapper. */
export const maskedPickupDetailsSchema = pickupDetailsSchema.transform((details) => MaskedPickupDetails.wrap(details));

// -----------------------------------------------------------------------------
// Reveal reads (§A3/§A4). Both are `Cache-Control: no-store` on the service
// and re-evaluate the entitlement on every read.
// -----------------------------------------------------------------------------

/**
 * One line of the paying buyer's reveal (`GET /v1/orders/{id}/pickup-details`):
 * the PINNED snapshot recorded at payment — never the listing's current
 * details — with the terms-change and withdrawn-by-seller flags the service
 * computes against the current version.
 */
export const marketplacePickupRevealLineSchema = z
  .object({
    lineIndex: z.number().int().nonnegative(),
    listingAggregateId: z.string().min(1),
    /** The pinned `version_at_payment`. */
    version: z.number().int().positive(),
    /** The listing's current details version; null after a `pickup_details.clear`. */
    currentVersion: z.number().int().positive().nullable(),
    updatedSincePayment: z.boolean(),
    withdrawnBySeller: z.boolean(),
    updatedAt: z.string(),
    details: maskedPickupDetailsSchema,
  })
  .strict();

/**
 * The buyer's per-line pickup reveal response. The first successful read
 * stamps `firstRevealedAt` service-side (the bounded withdrawal window, §A3).
 */
export const marketplacePickupRevealSchema = z
  .object({
    orderId: z.uuid(),
    firstRevealedAt: z.string(),
    lines: z.array(marketplacePickupRevealLineSchema).min(1),
  })
  .strict();

/**
 * The seller's owner read (`GET /v1/listings/{aggregate_id}/pickup-details`,
 * §A4): their own current details alongside the surviving version counter,
 * so the next `pickup_details.set` can compare-and-swap without a hidden
 * second read. After a clear, `current` is null and the counter still answers.
 */
export const marketplaceSellerPickupDetailsSchema = z
  .object({
    listingAggregateId: z.string().min(1),
    current: z
      .object({
        details: maskedPickupDetailsSchema,
        version: z.number().int().positive(),
        updatedAt: z.string(),
      })
      .strict()
      .nullable(),
    lastVersion: z.number().int().nonnegative(),
  })
  .strict();

/**
 * The public health/capability surface (`GET /health`): `pickupAvailable` is
 * on iff the deployment has the pickup sealing key configured AND sandbox
 * payments are disabled (§A7). The client hides the pickup option everywhere
 * when it is off. `digitalDeliveryAvailable` is on iff the digital sealing
 * key is configured (digital delivery design §6 B5); absent reads as off,
 * and `digitalDeliveryMaxBytes` is the file cap the service enforces.
 */
export const marketplaceHealthSchema = z
  .object({
    status: z.string(),
    // The health endpoint may add capability telemetry without changing this client contract.
    pickupAvailable: z.boolean().default(false),
    digitalDeliveryAvailable: z.boolean().catch(false).default(false),
    digitalDeliveryMaxBytes: z.number().int().positive().optional().catch(undefined),
  })
  .passthrough();

export type MarketplacePickupRevealLine = z.infer<typeof marketplacePickupRevealLineSchema>;
export type MarketplacePickupReveal = z.infer<typeof marketplacePickupRevealSchema>;
export type MarketplaceSellerPickupDetails = z.infer<typeof marketplaceSellerPickupDetailsSchema>;
export type MarketplaceHealth = z.infer<typeof marketplaceHealthSchema>;

// -----------------------------------------------------------------------------
// Typed refusals (§A3/§A6/§A7). The service answers every pickup refusal with
// the wire code INVALID_STATE and a stable message; the message is the only
// discriminator the wire carries, so classification keys off the exact
// service strings (captured in `crates/service/tests/pickup_test.rs`).
// -----------------------------------------------------------------------------

export type MarketplacePickupRefusal =
  /** Key-absent or sandbox-payments deployment (the §A8 deployment boundary — one message covers both). */
  | 'pickup_unavailable'
  /** `pickup_details.set` on a listing whose record does not publish pickup. */
  | 'pickup_not_published'
  /** Reveal on an order with no durable payment fact (`receipt_id IS NULL`). */
  | 'payment_unconfirmed'
  /** Reveal after the order went terminal — the entitlement ended at the transition (§A3). */
  | 'order_terminal'
  /** Reveal/pickup-path command on a shipped order. */
  | 'not_pickup_order'
  /** Reveal of a snapshot pinned under `payment.sandbox_advance` — refused regardless of the current sandbox flag. */
  | 'sandbox_confirmed'
  /** Empty reveal: the order pinned nothing (details never set, or cleared before checkout). */
  | 'no_pinned_details'
  /** Seller-actor `fulfillment.confirm_pickup` while a post-payment terms change is unresolved (§A6). */
  | 'terms_change_unresolved';

const PICKUP_REFUSAL_MESSAGES: ReadonlyMap<string, MarketplacePickupRefusal> = new Map([
  ['Pickup is unavailable on this deployment.', 'pickup_unavailable'],
  ['The listing does not publish pickup.', 'pickup_not_published'],
  ['The order carries no payment confirmation.', 'payment_unconfirmed'],
  ['The order is terminal; the pickup details are no longer revealed.', 'order_terminal'],
  ['Only pickup orders carry pickup details.', 'not_pickup_order'],
  ['This command applies only to pickup orders.', 'not_pickup_order'],
  ['This order was confirmed by a sandbox payment; its pickup details are never revealed.', 'sandbox_confirmed'],
  ['This order carries no pinned pickup details.', 'no_pinned_details'],
  [
    'The pickup terms changed after payment; the seller cannot confirm the handover until the buyer has seen the change.',
    'terms_change_unresolved',
  ],
]);

/**
 * Classifies a service INVALID_STATE message into its typed pickup refusal,
 * or null when the message is not a known pickup refusal (callers fall back
 * to generic error mapping).
 */
export function classifyMarketplacePickupRefusal(message: string): MarketplacePickupRefusal | null {
  return PICKUP_REFUSAL_MESSAGES.get(message) ?? null;
}

/**
 * Client-owned copy for pickup refusals. Map a classified reason to this
 * table — never copy a server `error.message`, which can echo request
 * content or sealed pickup details into logs and the reporter.
 */
export const PICKUP_REFUSAL_FAILURE_MESSAGES: Record<string, string> = {
  pickup_unavailable: 'Pickup is unavailable on this deployment.',
  pickup_not_published: 'The listing does not publish pickup.',
  payment_unconfirmed: 'The order carries no payment confirmation.',
  order_terminal: 'The order is terminal; the pickup details are no longer revealed.',
  not_pickup_order: 'Only pickup orders carry pickup details.',
  sandbox_confirmed: 'This order was confirmed by a sandbox payment; its pickup details are never revealed.',
  no_pinned_details: 'This order carries no pinned pickup details.',
  terms_change_unresolved:
    'The pickup terms changed after payment; the seller cannot confirm the handover until the buyer has seen the change.',
  not_found: 'The pickup details were not found.',
  forbidden: 'You are not allowed to read these pickup details.',
  unavailable: 'The pickup request was refused.',
};

export function pickupRefusalFailureMessage(refusal: MarketplacePickupRefusal | null | undefined): string {
  return PICKUP_REFUSAL_FAILURE_MESSAGES[refusal ?? ''] ?? PICKUP_REFUSAL_FAILURE_MESSAGES.unavailable;
}

/** Client-owned toast copy for a pickup command envelope: classify, never interpolate the server string. */
export function pickupRefusalToastDescription(serverMessage: string): string {
  return pickupRefusalFailureMessage(classifyMarketplacePickupRefusal(serverMessage));
}

export const PICKUP_LISTING_GONE_TOAST = 'This listing is gone. Refresh the page.';
export const PICKUP_SESSION_EXPIRED_TOAST = 'Your session expired. Sign in and try again.';
export const PICKUP_NOTHING_PUBLISHED_TOAST =
  'The meeting point could not be saved, so the listing was not published as pickup.';
export const PICKUP_REVERT_FAILED_TOAST =
  'The meeting point could not be saved. Refresh the listing and check that pickup is not still offered.';

/** Envelope-level pickup command toasts: `NOT_FOUND` / `UNAUTHORIZED` are not INVALID_STATE refusals. */
export function pickupCommandEnvelopeToastDescription(code: string, serverMessage: string): string {
  if (code === 'NOT_FOUND') return PICKUP_LISTING_GONE_TOAST;
  if (code === 'UNAUTHORIZED') return PICKUP_SESSION_EXPIRED_TOAST;
  return pickupRefusalToastDescription(serverMessage);
}

const KNOWN_PICKUP_REFUSALS: ReadonlySet<string> = new Set(PICKUP_REFUSAL_MESSAGES.values());

/**
 * Classifies a thrown pickup command error from `context.refusal` (the shape
 * `throwIfPickupCommandRefusal` produces) or from a known service message.
 */
export function pickupRefusalFromUnknown(error: unknown): MarketplacePickupRefusal | null {
  if (!error || typeof error !== 'object') return null;
  const context = 'context' in error ? error.context : undefined;
  if (context && typeof context === 'object' && 'refusal' in context && typeof context.refusal === 'string') {
    if (KNOWN_PICKUP_REFUSALS.has(context.refusal)) return context.refusal as MarketplacePickupRefusal;
  }
  if ('message' in error && typeof error.message === 'string') {
    return classifyMarketplacePickupRefusal(error.message);
  }
  return null;
}

/**
 * Seller-facing copy for a thrown pickup *command* refusal. `pickup_not_published`
 * is the listing-form race (details saved before the listing publishes pickup),
 * so the toast names that next step instead of the service's internal state.
 */
export function pickupCommandToastDescription(refusal: MarketplacePickupRefusal | null | undefined): string {
  if (refusal === 'pickup_not_published') {
    return 'Save the listing as pickup first (Save changes), then save the meeting point.';
  }
  if (refusal) return pickupRefusalFailureMessage(refusal);
  return 'The pickup details could not be saved.';
}

// -----------------------------------------------------------------------------
// Checkout fulfillment plumbing (§A2): one `fulfillmentChoice` per seller
// group, applied to every line of the group that does not carry its own
// (a digital line does: digital delivery design §3). The service splits one order
// per (seller, fulfillment) and re-validates the choice against what each
// line's listing publishes — the client mirrors that validation up front so
// a disallowed choice is refused locally, never silently rewritten to
// shipping (the prior art's `?? 'shipping'` defect).
// -----------------------------------------------------------------------------

export type MarketplaceCheckoutFulfillmentLine = {
  listingAggregateId: string;
  sellerPubky: string;
  /** The methods the line's listing actually publishes (its `fulfillmentMethods`). */
  publishedFulfillmentMethods: readonly MarketplaceFulfillmentMethod[];
  /** The line's own method, overriding its seller group's choice. */
  fulfillmentChoice?: MarketplaceFulfillmentMethod;
};

export type MarketplaceCheckoutFulfillmentPlan =
  | {
      ok: true;
      /** Per input line, in order: the group's choice, ready to ride `checkout.create` as the line's `fulfillment`. */
      lineFulfillments: MarketplaceFulfillmentMethod[];
      /** True only when a line ships: pickup and digital lines carry no address (§A2). */
      requiresDeliveryAddress: boolean;
    }
  | {
      ok: false;
      reason: 'fulfillment_not_published';
      sellerPubky: string;
      fulfillment: MarketplaceFulfillmentMethod;
      listingAggregateId: string;
    };

/**
 * Resolves the buyer's per-seller-group fulfillment choices onto the checkout
 * lines. A line's own choice wins; otherwise a group with no recorded choice
 * defaults to `shipping`. Every line must publish the method it resolves to.
 */
export function resolveCheckoutFulfillment(
  lines: readonly MarketplaceCheckoutFulfillmentLine[],
  choiceBySeller: Readonly<Record<string, MarketplaceFulfillmentMethod | undefined>>,
): MarketplaceCheckoutFulfillmentPlan {
  const lineFulfillments: MarketplaceFulfillmentMethod[] = [];
  for (const line of lines) {
    const choice = line.fulfillmentChoice ?? choiceBySeller[line.sellerPubky] ?? 'shipping';
    if (!line.publishedFulfillmentMethods.includes(choice)) {
      return {
        ok: false,
        reason: 'fulfillment_not_published',
        sellerPubky: line.sellerPubky,
        fulfillment: choice,
        listingAggregateId: line.listingAggregateId,
      };
    }
    lineFulfillments.push(choice);
  }
  return {
    ok: true,
    lineFulfillments,
    requiresDeliveryAddress: lineFulfillments.includes('shipping'),
  };
}
