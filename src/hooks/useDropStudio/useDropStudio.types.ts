import { z } from 'zod';

/**
 * Record-contract bounds mirrored client-side (specs `0.6.2-marketplace.8`,
 * `commerceDropRecordSchema`). The vendored specs builder remains the FINAL
 * validator at publish time — these exist so the composer can explain a
 * violation next to the field instead of after the submit round-trip.
 */
export const DROP_TITLE_MAX_CHARS = 120;
export const DROP_DESCRIPTION_MAX_CHARS = 2_000;
export const DROP_MAX_LISTINGS = 20;
export const DROP_MAX_TOTAL_QUANTITY = 1_000_000;
export const DROP_MAX_PER_BUYER_LIMIT = 100;
export const DROP_MAX_TEASER_MEDIA = 10;

export const DROP_STUDIO_FIELDS = {
  TITLE: 'title',
  DESCRIPTION: 'description',
  LISTING_IDS: 'listingIds',
  STARTS_AT: 'startsAtLocal',
  ENDS_AT: 'endsAtLocal',
  TOTAL_QUANTITY: 'totalQuantity',
  PER_BUYER_LIMIT: 'perBuyerLimit',
  STOCK_DISPLAY: 'stockDisplay',
} as const;

const wholeNumberSchema = (message: string) =>
  z
    .string()
    .trim()
    .regex(/^[1-9]\d*$/, message);

const localDateTimeSchema = (label: string, optional: boolean) =>
  z
    .string()
    .trim()
    .refine((value) => optional || value !== '', `Set a ${label.toLowerCase()}.`)
    .refine((value) => (optional && value === '') || isValidLocalDateTime(value), `${label} is not a valid date.`);

function isValidLocalDateTime(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return false;
  const [, year, month, day, hour, minute, second = '0'] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  return (
    date.getFullYear() === Number(year) &&
    date.getMonth() === Number(month) - 1 &&
    date.getDate() === Number(day) &&
    date.getHours() === Number(hour) &&
    date.getMinutes() === Number(minute) &&
    date.getSeconds() === Number(second)
  );
}

export const dropStudioSchema = z
  .object({
    title: z
      .string()
      .trim()
      .min(1, 'Give the drop a title.')
      .max(DROP_TITLE_MAX_CHARS, `Keep the title to ${DROP_TITLE_MAX_CHARS} characters.`),
    description: z
      .string()
      .trim()
      .max(
        DROP_DESCRIPTION_MAX_CHARS,
        `Keep the description to ${DROP_DESCRIPTION_MAX_CHARS.toLocaleString('en-US')} characters.`,
      ),
    listingIds: z
      .array(z.string().min(1))
      .min(1, 'Pick at least one listing.')
      .max(DROP_MAX_LISTINGS, `A drop bundles at most ${DROP_MAX_LISTINGS} listings.`),
    startsAtLocal: localDateTimeSchema('Launch time', false),
    /** Empty string means "no scheduled end" — the drop runs until sell-out or cancellation. */
    endsAtLocal: localDateTimeSchema('End time', true),
    totalQuantity: z
      .string()
      .trim()
      .min(1, 'Total quantity is required.')
      .regex(/^[1-9]\d*$/, 'Total quantity must be a positive whole number.')
      .refine(
        (value) => Number(value) <= DROP_MAX_TOTAL_QUANTITY,
        `Total quantity can be at most ${DROP_MAX_TOTAL_QUANTITY.toLocaleString('en-US')}.`,
      ),
    perBuyerLimit: wholeNumberSchema('Per-buyer limit must be a positive whole number.').refine(
      (value) => Number(value) <= DROP_MAX_PER_BUYER_LIMIT,
      `Per-buyer limit can be at most ${DROP_MAX_PER_BUYER_LIMIT}.`,
    ),
    stockDisplay: z.enum(['exact', 'bands', 'hidden']),
  })
  .superRefine((data, context) => {
    const startsAtMs = Date.parse(data.startsAtLocal);
    if (!Number.isNaN(startsAtMs) && data.endsAtLocal !== '') {
      const endsAtMs = Date.parse(data.endsAtLocal);
      if (!Number.isNaN(endsAtMs) && endsAtMs <= startsAtMs) {
        context.addIssue({
          code: 'custom',
          path: [DROP_STUDIO_FIELDS.ENDS_AT],
          message: 'The end time must be after the launch time.',
        });
      }
    }
    if (
      /^[1-9]\d*$/.test(data.totalQuantity) &&
      /^[1-9]\d*$/.test(data.perBuyerLimit) &&
      Number(data.perBuyerLimit) > Number(data.totalQuantity)
    ) {
      context.addIssue({
        code: 'custom',
        path: [DROP_STUDIO_FIELDS.PER_BUYER_LIMIT],
        message: 'The per-buyer limit cannot exceed the total quantity.',
      });
    }
  });

export type DropStudioData = z.infer<typeof dropStudioSchema>;

export const dropStudioDefaults: DropStudioData = {
  title: '',
  description: '',
  listingIds: [],
  startsAtLocal: '',
  endsAtLocal: '',
  totalQuantity: '',
  perBuyerLimit: '1',
  stockDisplay: 'exact',
};

/**
 * Registration state of one selected listing on the transaction service.
 * `unknown` means the projection read itself failed (usually a missing
 * marketplace session) — honestly not knowable, never assumed registered.
 */
export type DropStudioListingRegistration = 'checking' | 'registered' | 'unregistered' | 'unknown';

/**
 * The two-truth publish state machine: the homeserver record PUT and the
 * service registration (`drop.sync`) are separate facts the studio reports
 * separately — a record can land while registration fails, and the retry
 * affordance re-runs only the sync.
 */
export type DropPublishStatus = {
  record: 'idle' | 'publishing' | 'ok' | 'failed';
  sync: 'idle' | 'syncing' | 'ok' | 'failed';
};
