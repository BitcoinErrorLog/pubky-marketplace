import { z } from 'zod';
import { isDigitalContentType } from './digital-file';
import { commercePubkySchema } from './transaction-contracts';

// -----------------------------------------------------------------------------
// Digital delivery (docs: digital-delivery-design.md rev 3).
//
// The Marketplace Transaction Service is the source of truth for these
// shapes: `crates/domain/src/commands.rs` (`DigitalDeliveryKind`,
// `DigitalDelivery`), `crates/service/src/model.rs`
// (`digital_delivery_projection`) and `crates/service/src/http.rs` (the
// /health capability). Schemas here are camelCase — the wire-casing layer
// converts at the transport boundary, as with every marketplace contract.
// -----------------------------------------------------------------------------

/** How a digital listing reaches the buyer (§2). */
export const marketplaceDigitalDeliveryKindSchema = z.enum(['file', 'link', 'text', 'email', 'message']);
export type MarketplaceDigitalDeliveryKind = z.infer<typeof marketplaceDigitalDeliveryKindSchema>;

/** File, link and text are released automatically at payment confirmation. */
export function isInstantDigitalDeliveryKind(kind: MarketplaceDigitalDeliveryKind): boolean {
  return kind === 'file' || kind === 'link' || kind === 'text';
}

/**
 * The public digital-delivery facts on the service's listing projection:
 * the kind, and for a file its content type and size. Null when the seller
 * has not set delivery yet.
 */
export const marketplaceListingDigitalDeliverySchema = z
  .object({
    kind: marketplaceDigitalDeliveryKindSchema,
    contentType: z.string().max(255).optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
  })
  .passthrough();
export type MarketplaceListingDigitalDelivery = z.infer<typeof marketplaceListingDigitalDeliverySchema>;

/**
 * The projection field, tolerant by construction: an absent field (a
 * service predating digital delivery) and a malformed one both read as
 * null, so one bad sub-object never fails the listing, and the listing is
 * then treated as not digitally purchasable (§7 input inventory).
 */
export const marketplaceListingDigitalDeliveryFieldSchema = z
  .unknown()
  .transform((value): MarketplaceListingDigitalDelivery | null => {
    const parsed = marketplaceListingDigitalDeliverySchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  });

const CONTENT_TYPE_LABELS: Readonly<Record<string, string>> = {
  'application/pdf': 'PDF',
  'application/zip': 'ZIP',
  'application/epub+zip': 'EPUB',
  'audio/mpeg': 'MP3',
  'audio/wav': 'WAV',
  'video/mp4': 'MP4',
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
  'text/plain': 'Text file',
};

/** A short label for a well-known content type, or null (never echoes an arbitrary seller string). */
export function digitalContentTypeLabel(contentType: string | undefined): string | null {
  if (!contentType) return null;
  return CONTENT_TYPE_LABELS[contentType.toLowerCase()] ?? null;
}

/** Bytes as buyers read them: `820 KB`, `4.2 MB`, `12 MB`. */
export function formatDigitalFileSize(sizeBytes: number): string {
  const kilobytes = sizeBytes / 1024;
  if (kilobytes < 1024) return `${Math.max(1, Math.round(kilobytes))} KB`;
  const megabytes = kilobytes / 1024;
  return megabytes < 10 ? `${megabytes.toFixed(1)} MB` : `${Math.round(megabytes)} MB`;
}

export const DIGITAL_DELIVERY_COPY = {
  badge: 'Digital delivery',
  instantDownload: 'Instant download',
  instantAccess: 'Instant access',
  emailed: 'Emailed by the seller after payment',
  messaged: 'Sent by the seller in messages after payment',
  offersUnavailable: "Offers aren't available on digital items yet.",
  offersBuyShipped: 'Offers buy the shipped version.',
  offersBuyPickup: 'Offers buy the pickup version.',
  paypalWarning:
    "PayPal can reverse payments after delivery and does not cover 'not as described' claims for digital items.",
  unavailable: "Digital delivery isn't available on this deployment.",
  auctionsShipOnly: 'Auctions ship only — pickup and digital delivery are available on Buy now listings.',
  atLeastOneMethod: 'Choose at least one delivery option.',
} as const;

/**
 * The listing-page badge (§3): "Instant download · PDF · 12 MB", "Instant
 * access", or the manual-delivery line. A listing whose delivery is not set
 * yet shows the plain "Digital delivery".
 */
export function digitalDeliveryBadgeLabel(delivery: MarketplaceListingDigitalDelivery | null): string {
  if (!delivery) return DIGITAL_DELIVERY_COPY.badge;
  switch (delivery.kind) {
    case 'file': {
      const parts: string[] = [DIGITAL_DELIVERY_COPY.instantDownload];
      const typeLabel = digitalContentTypeLabel(delivery.contentType);
      if (typeLabel) parts.push(typeLabel);
      if (delivery.sizeBytes !== undefined) parts.push(formatDigitalFileSize(delivery.sizeBytes));
      return parts.join(' · ');
    }
    case 'link':
    case 'text':
      return DIGITAL_DELIVERY_COPY.instantAccess;
    case 'email':
      return DIGITAL_DELIVERY_COPY.emailed;
    case 'message':
      return DIGITAL_DELIVERY_COPY.messaged;
  }
}

/** The deployment's digital delivery capability, from `/health`. */
export type MarketplaceDigitalDeliveryCapability = {
  available: boolean;
  /** The per-file cap the service enforces; null when the service does not report one. */
  maxBytes: number | null;
};

// -----------------------------------------------------------------------------
// Seller setup (§2, §6 C1–C5): the `digital_delivery.set` payload, the
// owner read, and the refusals the studio can receive. Validation mirrors
// the service's `validate_set_digital_delivery`, so a command the studio
// sends is one the service accepts.
// -----------------------------------------------------------------------------

/** Longest text a text-kind listing hands every buyer. */
export const DIGITAL_TEXT_MAX_CHARS = 4_000;
/** Longest link a link-kind listing hands every buyer. */
export const DIGITAL_LINK_MAX_CHARS = 2_048;

const lowerHex = (length: number) => z.string().regex(new RegExp(`^[0-9a-f]{${length}}$`));
const noControl = (value: string) => !/\p{Cc}/u.test(value);
const charCount = (value: string) => Array.from(value).length;

/** An `https://` link with a host and no whitespace or control characters, at most 2,048 characters. */
export function isDigitalDeliveryLink(value: string): boolean {
  if (charCount(value) > DIGITAL_LINK_MAX_CHARS || /\s/u.test(value) || !noControl(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '';
  } catch {
    return false;
  }
}

export const digitalDeliveryFileSchema = z
  .object({
    kind: z.literal('file'),
    deliverableId: lowerHex(32),
    version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    key: lowerHex(64),
    iv: lowerHex(24),
    ciphertextBlake3: lowerHex(64),
    plaintextBlake3: lowerHex(64),
    sizeBytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    contentType: z.string().refine(isDigitalContentType, { message: 'Expected a type/subtype MIME type' }),
    fileName: z
      .string()
      .min(1)
      .refine((value) => charCount(value) <= 255 && value.trim() === value && noControl(value), {
        message: 'Expected a file name of at most 255 characters',
      })
      .refine((value) => value !== '.' && value !== '..' && !/[/\\]/.test(value), {
        message: 'Expected a file name without path separators',
      }),
  })
  .strict();

export const digitalDeliverySetSchema = z.discriminatedUnion('kind', [
  digitalDeliveryFileSchema,
  z
    .object({
      kind: z.literal('link'),
      url: z.string().refine(isDigitalDeliveryLink, { message: 'Expected an https:// link' }),
    })
    .strict(),
  z
    .object({
      kind: z.literal('text'),
      text: z
        .string()
        .refine((value) => value.trim() !== '' && charCount(value) <= DIGITAL_TEXT_MAX_CHARS && !value.includes('\0'), {
          message: 'Expected 1-4000 characters of text',
        }),
    })
    .strict(),
  z.object({ kind: z.literal('email') }).strict(),
  z.object({ kind: z.literal('message') }).strict(),
]);
export type MarketplaceDigitalDeliverySet = z.infer<typeof digitalDeliverySetSchema>;

/**
 * The seller's owner read (`GET /v1/listings/{id}/digital-delivery`): the
 * current delivery as set (never the file key), the counter the next set
 * compares against, and how many live orders still pin each version.
 */
export const marketplaceSellerDigitalDeliverySchema = z
  .object({
    listingAggregateId: z.string().min(1),
    current: z
      .object({
        kind: marketplaceDigitalDeliveryKindSchema,
        deliverableId: z.string(),
        version: z.number().int().positive(),
        createdAt: z.string(),
        contentType: z.string().nullable().optional(),
        sizeBytes: z.number().int().nonnegative().nullable().optional(),
        fileName: z.string().nullable().optional(),
        url: z.string().nullable().optional(),
        text: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable(),
    lastVersion: z.number().int().nonnegative(),
    pinnedVersions: z.array(
      z.object({ version: z.number().int().positive(), liveOrders: z.number().int().nonnegative() }).passthrough(),
    ),
  })
  .passthrough();
export type MarketplaceSellerDigitalDelivery = z.infer<typeof marketplaceSellerDigitalDeliverySchema>;

/** The `result` view of a successful `digital_delivery.set` / `.clear` (mirrors `handlers/digital.rs`). */
export const digitalDeliveryCommandResultSchema = z
  .object({
    kind: z.literal('digital_delivery'),
    listingAggregateId: z.string().min(1),
    version: z.number().int().nonnegative(),
    deliveryKind: marketplaceDigitalDeliveryKindSchema.optional(),
    deliverableId: z.string().optional(),
    cleared: z.boolean().optional(),
    updatedAt: z.string(),
  })
  .passthrough();
export type DigitalDeliveryCommandResult = z.infer<typeof digitalDeliveryCommandResultSchema>;

/**
 * Why the service refused a seller's digital delivery setup (§6 C1–C5).
 * Classified from the refusal's `reason`, then its `code`; the service's
 * `message` is never shown or logged.
 */
export type DigitalDeliverySetupRefusal =
  | 'not_seller'
  | 'not_found'
  | 'not_published'
  | 'unavailable'
  | 'in_use'
  | 'unverifiable'
  | 'upstream_unavailable'
  | 'too_large'
  | 'changed';

const SETUP_REASONS: Readonly<Record<string, DigitalDeliverySetupRefusal>> = {
  digital_delivery_unavailable: 'unavailable',
  digital_delivery_in_use: 'in_use',
  deliverable_unverifiable: 'unverifiable',
  deliverable_too_large: 'too_large',
};

export function classifyDigitalDeliverySetupRefusal(error: {
  code: string;
  reason?: unknown;
}): DigitalDeliverySetupRefusal | null {
  const reason = typeof error.reason === 'string' ? SETUP_REASONS[error.reason] : undefined;
  if (reason === 'unverifiable' && error.code === 'UPSTREAM_UNAVAILABLE') return 'upstream_unavailable';
  if (reason) return reason;
  switch (error.code) {
    case 'UNAUTHORIZED':
      return 'not_seller';
    case 'NOT_FOUND':
      return 'not_found';
    case 'REVISION_CONFLICT':
      return 'changed';
    case 'INVALID_STATE':
      return 'not_published';
    default:
      return null;
  }
}

export const DIGITAL_DELIVERY_SETUP_COPY = {
  not_seller: 'Only the seller can set delivery.',
  not_found: 'This listing was not found. Reload and try again.',
  not_published: 'Save the listing with Digital delivery first, then set how buyers receive it.',
  unavailable: DIGITAL_DELIVERY_COPY.unavailable,
  in_use: 'Buyers are paying for or still downloading this. Pause the listing to stop new sales.',
  unverifiable: "We couldn't read your file back from your homeserver. Upload it again.",
  upstream_unavailable: "We couldn't reach your homeserver to check the file. Try again shortly.",
  too_large: 'Files can be up to 50 MB for now.',
  changed: 'This delivery changed. Refresh to see the latest.',
  uploadStorageFull: 'Your homeserver refused the upload: storage is full.',
  uploadFailed: 'Your homeserver refused the upload. Try again.',
  encryptFailed: "This browser couldn't encrypt the file, so nothing was uploaded. Try again, or use another browser.",
  failed: 'Delivery could not be saved. Try again.',
} as const;

/** "Files can be up to 50 MB for now.", with the deployment's cap when it reports one. */
export function digitalFileTooLargeCopy(maxBytes: number | null): string {
  if (maxBytes === null) return DIGITAL_DELIVERY_SETUP_COPY.too_large;
  return `Files can be up to ${formatDigitalFileSize(maxBytes)} for now.`;
}

/**
 * The owner read's version line (§6 C5): "Version 2 is live. 3 buyers still
 * download version 1." Counts only versions other than the live one.
 */
export function digitalDeliveryVersionLine(delivery: MarketplaceSellerDigitalDelivery): string | null {
  const current = delivery.current;
  if (!current) return null;
  const older = delivery.pinnedVersions
    .filter(({ version, liveOrders }) => version !== current.version && liveOrders > 0)
    .map(
      ({ version, liveOrders }) =>
        `${liveOrders} ${liveOrders === 1 ? 'buyer still downloads' : 'buyers still download'} version ${version}`,
    );
  const live = `Version ${current.version} is live.`;
  return older.length === 0 ? live : `${live} ${older.join('. ')}.`;
}

/** The typed refusals the digital entitled reads answer with (§6 D5–D11, F5–F10). */
export const DIGITAL_READ_REFUSALS = [
  'digital_delivery_unavailable',
  'not_paid',
  'delivery_ended',
  'sandbox_confirmed',
  'email_missing',
  'rate_limited',
] as const;
export type DigitalReadRefusal = (typeof DIGITAL_READ_REFUSALS)[number];

export function classifyDigitalReadRefusal(reason: unknown): DigitalReadRefusal | null {
  return typeof reason === 'string' && (DIGITAL_READ_REFUSALS as readonly string[]).includes(reason)
    ? (reason as DigitalReadRefusal)
    : null;
}

/** Static copy per read refusal: the service's message is never shown or logged. */
export const DIGITAL_READ_REFUSAL_COPY: Readonly<Record<DigitalReadRefusal | 'not_found' | 'failed', string>> = {
  digital_delivery_unavailable: DIGITAL_DELIVERY_COPY.unavailable,
  not_paid: 'Available as soon as payment is confirmed.',
  delivery_ended: 'This order was refunded or cancelled, so the download is no longer available.',
  sandbox_confirmed: "Sandbox orders don't deliver files.",
  email_missing: 'No delivery email is on file for this order.',
  rate_limited: 'Too many downloads in a row. Wait a minute and try again.',
  not_found: 'This was not found.',
  failed: 'This could not be loaded. Try again.',
};

/** What the studio hands the application to set: a file's bytes are encrypted there, never here. */
export type MarketplaceDigitalDeliveryInput =
  | { kind: 'file'; bytes: Uint8Array<ArrayBuffer>; fileName: string; contentType: string }
  | { kind: 'link'; url: string }
  | { kind: 'text'; text: string }
  | { kind: 'email' }
  | { kind: 'message' };

/** One line for the seller: what buyers receive now, from the owner read (never the link or text itself). */
export function digitalDeliveryCurrentSummary(current: MarketplaceSellerDigitalDelivery['current']): string {
  if (!current) return 'Not set yet. Buyers cannot check out until you choose how they receive it.';
  switch (current.kind) {
    case 'file': {
      const size = typeof current.sizeBytes === 'number' ? ` (${formatDigitalFileSize(current.sizeBytes)})` : '';
      return `Buyers download ${current.fileName ?? 'your file'}${size} after payment.`;
    }
    case 'link':
      return 'Buyers get your link after payment.';
    case 'text':
      return 'Buyers see your text after payment.';
    case 'email':
      return 'You email buyers after payment, then mark it emailed.';
    case 'message':
      return 'You send it in the order messages after payment, then mark it delivered.';
  }
}

/** The trust line beside the seller's file (§9 D2). */
export const DIGITAL_DELIVERY_TRUST_COPY =
  'Shop encrypts your file on this device and stores only the encrypted copy on your homeserver. The marketplace keeps the unlock key sealed and releases it only to a buyer whose payment is confirmed, so the marketplace operator could technically open it, the same trust as delivery addresses and pickup details.';

// -----------------------------------------------------------------------------
// Checkout (§3 "Checkout", §4.3, §6 B2–B5, F1–F3).
// -----------------------------------------------------------------------------

/** The service's `DELIVERY_EMAIL_MAX_CHARS` (`crates/domain/src/commands.rs`). */
export const DELIVERY_EMAIL_MAX_CHARS = 254;

/**
 * The service's `DeliveryEmail::is_well_formed`: at most 254 characters, one
 * `@` with text on both sides, and no whitespace or control characters. The
 * seller sends the purchase there by hand, so nothing stricter is checked.
 */
export function isWellFormedDeliveryEmail(value: string): boolean {
  const at = value.indexOf('@');
  if (at <= 0) return false;
  const domain = value.slice(at + 1);
  return (
    [...value].length <= DELIVERY_EMAIL_MAX_CHARS &&
    domain.length > 0 &&
    !domain.includes('@') &&
    !/[\s\p{Cc}]/u.test(value)
  );
}

export const marketplaceDeliveryEmailSchema = z
  .string()
  .refine(isWellFormedDeliveryEmail, { message: 'Expected a delivery email address' });

/** The typed `checkout.create` refusals digital lines add. */
export type DigitalCheckoutRefusal =
  | 'not_ready'
  | 'unavailable'
  | 'email_required'
  | 'invalid_email'
  | 'email_not_needed'
  | 'fulfillment_not_published';

const CHECKOUT_REASONS: Readonly<Record<string, DigitalCheckoutRefusal>> = {
  digital_delivery_not_ready: 'not_ready',
  digital_delivery_unavailable: 'unavailable',
  delivery_email_required: 'email_required',
  invalid_delivery_email: 'invalid_email',
  delivery_email_not_needed: 'email_not_needed',
  fulfillment_not_published: 'fulfillment_not_published',
};

/** Classifies a refused `checkout.create` from its reason only; the service message is never read. */
export function classifyDigitalCheckoutRefusal(error: {
  code: string;
  reason?: unknown;
}): DigitalCheckoutRefusal | null {
  return typeof error.reason === 'string' ? (CHECKOUT_REASONS[error.reason] ?? null) : null;
}

export const DIGITAL_CHECKOUT_REFUSAL_COPY: Readonly<Record<DigitalCheckoutRefusal, string>> = {
  not_ready: "The seller hasn't finished setting up delivery for this item.",
  unavailable: DIGITAL_DELIVERY_COPY.unavailable,
  email_required: 'Enter the email the seller should send your purchase to.',
  invalid_email: 'Check the email address.',
  // Shop sends an email only for an email-kind line, so the listing changed underneath.
  email_not_needed: 'A listing changed while you were checking out. Review your cart and try again.',
  fulfillment_not_published: "A listing in your cart changed how it's delivered. Reload Shop to check out.",
};

/** Checkout copy for digital lines (§3 "Checkout"). */
export const DIGITAL_CHECKOUT_COPY = {
  emailHeading: 'Email for delivery',
  emailDisclosure:
    "The seller of this item sees this after your payment is confirmed, to send your order. It isn't used for anything else.",
  consentInstant:
    "Delivery starts as soon as payment is confirmed. Digital orders can't be cancelled once delivered; message the seller about a refund.",
  consentManual: 'You can ask to cancel until the seller marks it delivered.',
  physicalOption: 'Physical copy',
  digitalOption: 'Digital delivery',
  noShippingDigital: 'No shipping for digital items.',
  noShippingMixed: 'No shipping for these items.',
  payReasonNotReady: "An item's seller hasn't finished setting up delivery. Remove it in the cart to continue.",
  payReasonLoading: 'Pay unlocks once delivery options load.',
} as const;

/** The line under a digital checkout item: how it arrives, or that it cannot be bought yet. */
export function digitalCheckoutLineLabel(kind: MarketplaceDigitalDeliveryKind | null | undefined): string {
  if (kind === null) return DIGITAL_CHECKOUT_REFUSAL_COPY.not_ready;
  if (kind === undefined) return DIGITAL_DELIVERY_COPY.badge;
  return `${DIGITAL_DELIVERY_COPY.badge} · ${digitalDeliveryBadgeLabel({ kind })}`;
}

// -----------------------------------------------------------------------------
// Buyer order reads (§3 "After payment", §4.2, §4.3, §6 D5–D11, F5–F12).
// -----------------------------------------------------------------------------

const orderDigitalLineFields = {
  lineIndex: z.number().int().nonnegative(),
  listingAggregateId: z.string().min(1),
  sellerPubky: commercePubkySchema,
  version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
};

/**
 * `GET /v1/orders/{id}/digital-delivery` (`handlers/digital_orders.rs`): the
 * pinned payload per instant line. A file line carries the facts that open
 * the ciphertext on the seller's homeserver; they are held in memory for one
 * open and never stored.
 */
export const marketplaceOrderDigitalDeliverySchema = z
  .object({
    orderId: z.uuid(),
    lines: z.array(
      z.discriminatedUnion('kind', [
        digitalDeliveryFileSchema.extend(orderDigitalLineFields).strip(),
        z
          .object({
            ...orderDigitalLineFields,
            kind: z.literal('link'),
            deliverableId: z.string().min(1),
            url: z.string().refine(isDigitalDeliveryLink),
          })
          .strip(),
        z
          .object({
            ...orderDigitalLineFields,
            kind: z.literal('text'),
            deliverableId: z.string().min(1),
            text: z.string().min(1),
          })
          .strip(),
      ]),
    ),
  })
  .strip();
export type MarketplaceOrderDigitalDelivery = z.infer<typeof marketplaceOrderDigitalDeliverySchema>;
export type MarketplaceOrderDigitalLine = MarketplaceOrderDigitalDelivery['lines'][number];

/** `GET /v1/orders/{id}/delivery-email`: the address on file and when the seller marked it emailed. */
export const marketplaceOrderDeliveryEmailSchema = z
  .object({
    orderId: z.uuid(),
    deliveryEmail: z.string().min(1),
    emailedAt: z.string().nullable(),
  })
  .strip();
export type MarketplaceOrderDeliveryEmail = z.infer<typeof marketplaceOrderDeliveryEmailSchema>;

/**
 * The released line, only if it is the one the buyer opened on this order:
 * the response names this order, releases exactly the requested line, and
 * that line's listing, seller and kind match the paid order's snapshot.
 * Anything else is refused whole, before any fetch, decrypt or reveal.
 */
export function bindOrderDigitalLine(
  order: {
    id: string;
    sellerPubky: string;
    lines: ReadonlyArray<{ listingAggregateId: string; digitalKind?: MarketplaceDigitalDeliveryKind }>;
  },
  lineIndex: number,
  delivery: MarketplaceOrderDigitalDelivery,
): MarketplaceOrderDigitalLine | null {
  const paid = order.lines[lineIndex];
  if (!paid || delivery.orderId !== order.id || delivery.lines.length !== 1) return null;
  const [line] = delivery.lines;
  const bound =
    line.lineIndex === lineIndex &&
    line.listingAggregateId === paid.listingAggregateId &&
    line.sellerPubky === order.sellerPubky &&
    line.kind === paid.digitalKind;
  return bound ? line : null;
}

/** A released line that is not the one opened on this order (see `bindOrderDigitalLine`). */
export const DIGITAL_ORDER_LINE_MISMATCH_COPY =
  "This download doesn't match your order. Try again, or message the seller.";

/** Why a buyer's file could not be opened after the read succeeded. */
export type DigitalFileOpenFailure = 'fetch_failed' | 'ciphertext_mismatch' | 'decrypt_failed' | 'plaintext_mismatch';

export const DIGITAL_FILE_OPEN_FAILURE_COPY: Readonly<Record<DigitalFileOpenFailure, string>> = {
  fetch_failed: "The seller's homeserver didn't return the file. Try again shortly.",
  ciphertext_mismatch: "The file on the seller's homeserver isn't the one you paid for. Message the seller.",
  decrypt_failed: "The file couldn't be unlocked. Message the seller.",
  plaintext_mismatch: "The file couldn't be verified after unlocking. Message the seller.",
};

/** The typed `order.set_delivery_email` refusals (§6 F11, F12). */
export type DeliveryEmailChangeRefusal = 'already_emailed' | 'invalid_email' | 'not_buyer' | 'closed' | 'changed';

export function classifyDeliveryEmailChangeRefusal(error: {
  code: string;
  reason?: unknown;
}): DeliveryEmailChangeRefusal | null {
  if (error.reason === 'already_emailed') return 'already_emailed';
  if (error.reason === 'invalid_delivery_email') return 'invalid_email';
  switch (error.code) {
    case 'UNAUTHORIZED':
      return 'not_buyer';
    case 'REVISION_CONFLICT':
      return 'changed';
    case 'INVALID_STATE':
      return 'closed';
    default:
      return null;
  }
}

export const DELIVERY_EMAIL_CHANGE_COPY: Readonly<Record<DeliveryEmailChangeRefusal | 'saved' | 'failed', string>> = {
  saved: 'Saved. The seller will use this address.',
  already_emailed: "The seller already emailed your purchase. Message them if it didn't arrive.",
  invalid_email: DIGITAL_CHECKOUT_REFUSAL_COPY.invalid_email,
  not_buyer: 'Only the buyer can change the delivery email.',
  closed: 'The delivery email can no longer be changed on this order.',
  changed: 'This order changed. Refresh to see the latest.',
  failed: "The email couldn't be saved. Try again.",
};

/** The buyer's order panel copy (§3 "After payment", §6 D8–D11, E4, F5, F9, F13). */
export const DIGITAL_ORDER_COPY = {
  heading: 'Your purchase',
  download: 'Download',
  downloading: 'Downloading…',
  revealText: 'Reveal text',
  showLink: 'Show link',
  openLink: 'Open link',
  hide: 'Hide',
  copy: 'Copy',
  copied: 'Copied',
  notPaid: DIGITAL_READ_REFUSAL_COPY.not_paid,
  ended: DIGITAL_READ_REFUSAL_COPY.delivery_ended,
  emailMissing: 'Enter your email so the seller can deliver.',
  emailLabel: 'Email for delivery',
  change: 'Change',
  save: 'Save',
  cancel: 'Cancel',
  messagePending: 'The seller will send this in your messages.',
  messageDelivered: 'The seller marked this delivered. Check your messages.',
  noReturn: "Digital purchases can't be returned. Message the seller about a refund.",
  readyToDownload: 'Delivered · ready to download',
} as const;

/** The order states that end a digital purchase (the service's `DIGITAL_ENDED_ORDER_STATES`, plus partial refunds). */
export function isDigitalOrderEnded(state: string): boolean {
  return ['cancelled', 'refunded_external', 'refunded_partial', 'closed'].includes(state);
}

/** "The seller will email this to …", or once marked emailed, when and what to check. */
export function digitalOrderEmailLine(address: string, emailedAt: string | null): string {
  if (!emailedAt) return `The seller will email this to ${address}`;
  const date = new Date(emailedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  return `Emailed to ${address} on ${date}. Check your spam folder, or message the seller.`;
}

// -----------------------------------------------------------------------------
// Seller delivery actions (§3 "Seller's orders", §4.3, §6 E8, E9, F6–F8, F13–F15).
// -----------------------------------------------------------------------------

export const marketplaceDigitalDeliveryChannelSchema = z.enum(['email', 'message']);
export type MarketplaceDigitalDeliveryChannel = z.infer<typeof marketplaceDigitalDeliveryChannelSchema>;

/** Why the service refused `fulfillment.deliver_digital`. */
export type DigitalDeliverRefusal =
  | 'not_seller'
  | 'wrong_channel'
  | 'email_missing'
  | 'already_marked'
  | 'cancel_requested'
  | 'not_awaiting'
  | 'changed';

/**
 * Classifies a refused `fulfillment.deliver_digital` from its reason, then
 * its code and the order's state; the service message is never read.
 */
export function classifyDigitalDeliverRefusal(
  error: { code: string; reason?: unknown },
  context: { orderState: string; channel: MarketplaceDigitalDeliveryChannel },
): DigitalDeliverRefusal | null {
  switch (error.reason) {
    case 'wrong_delivery_channel':
      return 'wrong_channel';
    case 'email_missing':
      return 'email_missing';
    case 'already_emailed':
      return 'already_marked';
  }
  switch (error.code) {
    case 'UNAUTHORIZED':
      return 'not_seller';
    case 'REVISION_CONFLICT':
      return 'changed';
    case 'INVALID_STATE':
      if (context.orderState === 'cancel_requested') return 'cancel_requested';
      return context.orderState === 'paid' && context.channel === 'message' ? 'already_marked' : 'not_awaiting';
    default:
      return null;
  }
}

export const DIGITAL_SELLER_COPY = {
  toDeliver: 'To deliver',
  showEmail: 'Show email',
  hideEmail: 'Hide email',
  markEmailed: 'Mark emailed',
  markDelivered: 'Mark delivered',
  emailDisclosure:
    'Use this address only to deliver this order. Keep your sent email as your record: Shop deletes this address 30 days after the order ends, and PayPal disputes can come later.',
  emailNotPaid: "The buyer's email appears once payment is confirmed.",
  emailEnded: 'This order was cancelled or refunded.',
  emailMissing: "Waiting for the buyer's email.",
  markedEmailed: 'Marked emailed. The buyer has been told to check their inbox.',
  markedDelivered: 'Marked delivered. The buyer has been told to check their messages.',
  openedStaySold: 'Opened files stay counted as sold.',
  refundNote: "Refund recorded. The buyer can no longer download. An email already sent can't be recalled.",
  deliverFailed: "This couldn't be marked. Try again.",
  evidenceFailed: "The delivery record couldn't be loaded.",
  evidenceRetry: 'Retry',
} as const;

export const DIGITAL_DELIVER_REFUSAL_COPY: Readonly<Record<DigitalDeliverRefusal, string>> = {
  not_seller: 'Only the seller can mark this delivered.',
  wrong_channel: 'Nothing in this order is delivered that way.',
  email_missing: DIGITAL_SELLER_COPY.emailMissing,
  already_marked: 'This was already marked.',
  cancel_requested: 'This order has a cancellation request. Approve or decline it first.',
  not_awaiting: "This order isn't waiting for delivery.",
  changed: 'This order changed. Refresh to see the latest.',
};

/** The seller's Show email refusals (§6 F7–F9), by read refusal. */
export function sellerDeliveryEmailReadCopy(refusal: string | null | undefined): string {
  switch (refusal) {
    case 'not_paid':
      return DIGITAL_SELLER_COPY.emailNotPaid;
    case 'delivery_ended':
      return DIGITAL_SELLER_COPY.emailEnded;
    case 'email_missing':
      return DIGITAL_SELLER_COPY.emailMissing;
    case 'digital_delivery_unavailable':
      return DIGITAL_DELIVERY_COPY.unavailable;
    default:
      return DIGITAL_READ_REFUSAL_COPY.failed;
  }
}

/** The manual channels an order's digital lines need: email for email-kind lines, message for message-kind. */
export function digitalOrderManualChannels(
  lines: ReadonlyArray<{ digitalKind?: MarketplaceDigitalDeliveryKind }>,
): MarketplaceDigitalDeliveryChannel[] {
  const channels: MarketplaceDigitalDeliveryChannel[] = [];
  if (lines.some((line) => line.digitalKind === 'email')) channels.push('email');
  if (lines.some((line) => line.digitalKind === 'message')) channels.push('message');
  return channels;
}

/** `GET /v1/orders/{id}/digital-evidence`: the seller's delivery evidence (timestamps and an open count only). */
export const marketplaceOrderDigitalEvidenceSchema = z
  .object({
    orderId: z.uuid(),
    deliveredAt: z.string().nullable(),
    firstOpenedAt: z.string().nullable(),
    openCount: z.number().int().nonnegative(),
    emailedAt: z.string().nullable(),
    messageDeliveredAt: z.string().nullable(),
  })
  .strip();
export type MarketplaceOrderDigitalEvidence = z.infer<typeof marketplaceOrderDigitalEvidenceSchema>;

function formatEvidenceTime(value: string): string {
  return new Date(value).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
}

/**
 * The seller's evidence lines (§3 "Seller's orders"): "Delivered
 * automatically · first opened Sep 26, 14:02 · opened 3 times" for instant
 * lines, then "Marked emailed …" and "Marked delivered …". Opens are the
 * service's logged opens, at most one per line per hour.
 */
export function digitalEvidenceLines(
  evidence: MarketplaceOrderDigitalEvidence,
  lines: ReadonlyArray<{ digitalKind?: MarketplaceDigitalDeliveryKind }>,
): string[] {
  const out: string[] = [];
  if (lines.some((line) => line.digitalKind !== undefined && isInstantDigitalDeliveryKind(line.digitalKind))) {
    out.push(
      evidence.firstOpenedAt
        ? `Delivered automatically · first opened ${formatEvidenceTime(evidence.firstOpenedAt)} · opened ${evidence.openCount} ${evidence.openCount === 1 ? 'time' : 'times'}`
        : 'Delivered automatically · not opened yet',
    );
  }
  if (evidence.emailedAt) out.push(`Marked emailed ${formatEvidenceTime(evidence.emailedAt)}`);
  if (evidence.messageDeliveredAt) out.push(`Marked delivered ${formatEvidenceTime(evidence.messageDeliveredAt)}`);
  return out;
}
