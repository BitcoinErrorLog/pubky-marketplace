import { z } from 'zod';
import {
  type MarketplacePickupDetails,
  pickupAvailabilityWindowSchema,
  pickupDetailsSchema,
} from '@/libs/commerce/pickup';
import { refinePostalAddressFields } from '@/libs/commerce/postal-address';

/**
 * Seller-authored pickup details (local pickup design PART A, §A1/§A4): the
 * meeting point the service seals and reveals only to the paying buyer. The
 * details never ride the public listing record — they are authored here and
 * sent only to the transaction service via `pickup_details.set`.
 *
 * The form shape differs from the wire payload: the address-or-spot kind is a
 * radio, availability is a mode select (weekly windows or arrange after
 * payment — scheduling itself is Wave 7b, so the windows are read-only
 * information for the buyer), and every field is a string input. `toPickupDetails`
 * converts and validates against the shared contract schema, so a
 * `pickup_details.set` command always carries a payload the service accepts.
 */

export const PICKUP_DETAILS_FORM_FIELDS = {
  KIND: 'kind',
  SPOT: 'spot',
  NAME: 'name',
  LINE1: 'line1',
  LINE2: 'line2',
  CITY: 'city',
  REGION: 'region',
  POSTAL_CODE: 'postalCode',
  COUNTRY_CODE: 'countryCode',
  INSTRUCTIONS: 'instructions',
  AVAILABILITY_MODE: 'availabilityMode',
  ZONE: 'zone',
  WINDOWS: 'windows',
} as const;

const wallClockSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour HH:MM time.');

const pickupWindowFormSchema = z.object({
  day: z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']),
  start: wallClockSchema,
  end: wallClockSchema,
});

export const pickupDetailsFormSchema = z
  .object({
    // Spot-first (§A1): the seller never has to publish their home.
    kind: z.enum(['spot', 'address']),
    spot: z.string().trim().max(200, 'Keep the meeting point under 200 characters.'),
    name: z.string().trim().max(100, 'Keep the name under 100 characters.'),
    line1: z.string().trim().max(200, 'Keep the address line under 200 characters.'),
    line2: z.string().trim().max(200, 'Keep the address line under 200 characters.'),
    city: z.string().trim().max(100, 'Keep the city under 100 characters.'),
    region: z.string().trim().max(100, 'Keep the region under 100 characters.'),
    postalCode: z.string().trim().max(32, 'Keep the postal code under 32 characters.'),
    countryCode: z
      .string()
      .trim()
      .refine((value) => value === '' || /^[A-Za-z]{2}$/.test(value), 'Use a two-letter country code.'),
    instructions: z.string().trim().max(1_000, 'Keep the instructions under 1,000 characters.'),
    availabilityMode: z.enum(['arrange', 'windows']),
    zone: z
      .string()
      .trim()
      .min(3, 'Name the timezone the windows are in.')
      .max(64)
      .refine((zone) => zone.includes('/'), 'Use an IANA timezone (Area/City), e.g. Europe/Berlin.'),
    windows: z.array(pickupWindowFormSchema).max(14, 'At most two windows per day.'),
  })
  .superRefine((data, context) => {
    if (data.kind === 'spot' && !data.spot) {
      context.addIssue({ code: 'custom', path: [PICKUP_DETAILS_FORM_FIELDS.SPOT], message: 'Name the meeting point.' });
    }
    if (data.kind === 'address') {
      const required: Array<[string, string]> = [
        [PICKUP_DETAILS_FORM_FIELDS.NAME, 'Recipient or place name is required.'],
        [PICKUP_DETAILS_FORM_FIELDS.LINE1, 'Address line 1 is required.'],
        [PICKUP_DETAILS_FORM_FIELDS.CITY, 'City is required.'],
      ];
      for (const [field, message] of required) {
        if (!data[field as keyof typeof data]) {
          context.addIssue({ code: 'custom', path: [field], message });
        }
      }
      refinePostalAddressFields(data, context, {
        regionPath: [PICKUP_DETAILS_FORM_FIELDS.REGION],
        postalPath: [PICKUP_DETAILS_FORM_FIELDS.POSTAL_CODE],
      });
      if (!/^[A-Za-z]{2}$/.test(data.countryCode)) {
        context.addIssue({
          code: 'custom',
          path: [PICKUP_DETAILS_FORM_FIELDS.COUNTRY_CODE],
          message: 'Use a two-letter country code.',
        });
      }
    }
    if (data.availabilityMode === 'windows') {
      if (data.windows.length === 0) {
        context.addIssue({
          code: 'custom',
          path: [PICKUP_DETAILS_FORM_FIELDS.WINDOWS],
          message: 'Add at least one weekly window, or choose arrange after payment.',
        });
      }
      data.windows.forEach((window, index) => {
        if (window.start >= window.end) {
          context.addIssue({
            code: 'custom',
            path: [PICKUP_DETAILS_FORM_FIELDS.WINDOWS, index, 'end'],
            message: 'The window end must follow its start.',
          });
        }
      });
    }
  });

export type PickupDetailsFormData = z.infer<typeof pickupDetailsFormSchema>;

export function pickupDetailsFormDefaults(zone: string, countryCode: string): PickupDetailsFormData {
  // `Intl.DateTimeFormat().resolvedOptions().timeZone` returns the IANA link
  // "UTC" on UTC hosts (including CI), while the marketplace contract
  // requires an Area/City-shaped identifier. Canonicalize that valid device
  // timezone before it reaches the form and wire schemas.
  const contractZone = zone === 'UTC' ? 'Etc/UTC' : zone;
  return {
    kind: 'spot',
    spot: '',
    name: '',
    line1: '',
    line2: '',
    city: '',
    region: '',
    postalCode: '',
    countryCode,
    instructions: '',
    availabilityMode: 'arrange',
    zone: contractZone,
    windows: [{ day: 'sat', start: '10:00', end: '14:00' }],
  };
}

/**
 * Converts the form into the sealed payload, validated against the shared
 * contract schema (mirrors the service's `validate_pickup_details`). Throws
 * on any contract violation — the form schema should make that unreachable.
 */
export function toPickupDetails(data: PickupDetailsFormData): MarketplacePickupDetails {
  const details = {
    kind: data.kind,
    ...(data.kind === 'spot'
      ? { spot: data.spot }
      : {
          address: {
            name: data.name,
            line1: data.line1,
            line2: data.line2,
            city: data.city,
            region: data.region,
            postalCode: data.postalCode,
            countryCode: data.countryCode.toUpperCase(),
          },
        }),
    instructions: data.instructions,
    availability: {
      ...(data.availabilityMode === 'windows'
        ? { windows: data.windows.map((window) => pickupAvailabilityWindowSchema.parse(window)) }
        : {}),
      zone: data.zone,
    },
  };
  return pickupDetailsSchema.parse(details);
}

/**
 * Hydrates the editor from the seller's owner read (the current details
 * version). A spot pickup has no address; switching it to one starts in
 * `fallbackCountryCode`.
 */
export function pickupDetailsFormValuesFromDetails(
  details: MarketplacePickupDetails,
  fallbackCountryCode: string,
): PickupDetailsFormData {
  return {
    kind: details.kind,
    spot: details.spot ?? '',
    name: details.address?.name ?? '',
    line1: details.address?.line1 ?? '',
    line2: details.address?.line2 ?? '',
    city: details.address?.city ?? '',
    region: details.address?.region ?? '',
    postalCode: details.address?.postalCode ?? '',
    countryCode: details.address?.countryCode ?? fallbackCountryCode,
    instructions: details.instructions,
    availabilityMode: details.availability.windows?.length ? 'windows' : 'arrange',
    zone: details.availability.zone,
    windows: details.availability.windows?.length
      ? details.availability.windows.map((window) => ({ ...window }))
      : [{ day: 'sat', start: '10:00', end: '14:00' }],
  };
}
