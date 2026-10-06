import { describe, expect, it } from 'vitest';
import { scrubSensitiveData } from '@/libs/observability/sentry.utils';
import { asOpaque } from '@/test-utils/type-assertions';
import {
  classifyMarketplacePickupRefusal,
  marketplaceFulfillmentMethodsSchema,
  marketplaceHealthSchema,
  marketplacePickupRevealSchema,
  marketplaceSellerPickupDetailsSchema,
  MaskedPickupDetails,
  PICKUP_DETAILS_REDACTED,
  PICKUP_LISTING_GONE_TOAST,
  PICKUP_NOTHING_PUBLISHED_TOAST,
  PICKUP_SESSION_EXPIRED_TOAST,
  pickupCommandEnvelopeToastDescription,
  pickupCommandToastDescription,
  pickupDetailsSchema,
  pickupRefusalFailureMessage,
  pickupRefusalFromUnknown,
  pickupRefusalToastDescription,
  resolveCheckoutFulfillment,
} from './pickup';

const SPOT = 'Central Station, north entrance';
const INSTRUCTIONS = 'Ask for the blue backpack.';

const spotDetails = {
  kind: 'spot',
  spot: SPOT,
  instructions: INSTRUCTIONS,
  availability: {
    windows: [{ day: 'sat', start: '10:00', end: '14:00' }],
    zone: 'Europe/Berlin',
  },
} as const;

const addressDetails = {
  kind: 'address',
  address: {
    name: 'Alice Seller',
    line1: '1 Market Street',
    line2: '',
    city: 'New York',
    region: 'NY',
    postalCode: '10001',
    countryCode: 'US',
  },
  instructions: '',
  availability: { zone: 'America/New_York' },
} as const;

describe('pickupDetailsSchema (mirrors the service validate_pickup_details)', () => {
  it('accepts spot-kind details with availability windows', () => {
    const parsed = pickupDetailsSchema.parse(spotDetails);
    expect(parsed.kind).toBe('spot');
    expect(parsed.spot).toBe(SPOT);
    expect(parsed.instructions).toBe(INSTRUCTIONS);
    expect(parsed.availability.zone).toBe('Europe/Berlin');
  });

  it('accepts address-kind details and defaults instructions to empty (arrange-after-payment: no windows)', () => {
    const parsed = pickupDetailsSchema.parse(addressDetails);
    expect(parsed.kind).toBe('address');
    expect(parsed.instructions).toBe('');
    expect(parsed.availability.windows).toBeUndefined();
  });

  it('enforces the kind pairing: spot-kind requires a spot and rejects an address', () => {
    expect(pickupDetailsSchema.safeParse({ ...spotDetails, spot: undefined }).success).toBe(false);
    expect(pickupDetailsSchema.safeParse({ ...spotDetails, address: addressDetails.address }).success).toBe(false);
  });

  it('enforces the kind pairing: address-kind requires an address and rejects a spot', () => {
    expect(pickupDetailsSchema.safeParse({ ...addressDetails, address: undefined }).success).toBe(false);
    expect(pickupDetailsSchema.safeParse({ ...addressDetails, spot: SPOT }).success).toBe(false);
  });

  it('rejects unknown payload fields, mirroring the service deny_unknown_fields', () => {
    expect(pickupDetailsSchema.safeParse({ ...spotDetails, meetingPoint: SPOT }).success).toBe(false);
  });

  it('rejects control characters in single-line display fields', () => {
    expect(pickupDetailsSchema.safeParse({ ...spotDetails, spot: `Platform 9\nTrack 3` }).success).toBe(false);
    expect(pickupDetailsSchema.safeParse({ ...spotDetails, instructions: 'Ring\ttwice' }).success).toBe(false);
  });

  it('bounds the spot, instructions, and zone like the service', () => {
    expect(pickupDetailsSchema.safeParse({ ...spotDetails, spot: 'x'.repeat(201) }).success).toBe(false);
    expect(pickupDetailsSchema.safeParse({ ...spotDetails, instructions: 'x'.repeat(1_001) }).success).toBe(false);
    expect(pickupDetailsSchema.safeParse({ ...spotDetails, availability: { zone: 'Berlin' } }).success).toBe(false);
    expect(pickupDetailsSchema.safeParse({ ...spotDetails, availability: { zone: 'EU' } }).success).toBe(false);
  });

  it('validates availability windows: weekday vocabulary, HH:MM, end after start, 1–14 windows', () => {
    const withWindows = (windows: unknown) => ({
      ...spotDetails,
      availability: { windows, zone: 'Europe/Berlin' },
    });
    expect(pickupDetailsSchema.safeParse(withWindows([])).success).toBe(false);
    expect(
      pickupDetailsSchema.safeParse(
        withWindows(Array.from({ length: 15 }, () => ({ day: 'mon', start: '09:00', end: '10:00' }))),
      ).success,
    ).toBe(false);
    expect(
      pickupDetailsSchema.safeParse(withWindows([{ day: 'saturday', start: '10:00', end: '14:00' }])).success,
    ).toBe(false);
    expect(pickupDetailsSchema.safeParse(withWindows([{ day: 'sat', start: '24:00', end: '14:00' }])).success).toBe(
      false,
    );
    expect(pickupDetailsSchema.safeParse(withWindows([{ day: 'sat', start: '14:00', end: '10:00' }])).success).toBe(
      false,
    );
    expect(pickupDetailsSchema.safeParse(withWindows([{ day: 'sat', start: '10:00', end: '10:00' }])).success).toBe(
      false,
    );
  });
});

describe('marketplaceFulfillmentMethodsSchema (mirrors the service register validation)', () => {
  it('defaults to shipping-only when absent', () => {
    expect(marketplaceFulfillmentMethodsSchema.parse(undefined)).toEqual(['shipping']);
  });

  it('accepts both methods and rejects empties, repeats, and unknown values', () => {
    expect(marketplaceFulfillmentMethodsSchema.parse(['shipping', 'pickup'])).toEqual(['shipping', 'pickup']);
    expect(marketplaceFulfillmentMethodsSchema.safeParse([]).success).toBe(false);
    expect(marketplaceFulfillmentMethodsSchema.safeParse(['pickup', 'pickup']).success).toBe(false);
    expect(marketplaceFulfillmentMethodsSchema.safeParse(['drone']).success).toBe(false);
  });
});

describe('MaskedPickupDetails telemetry masking', () => {
  const masked = MaskedPickupDetails.wrap(pickupDetailsSchema.parse(spotDetails));

  it('exposes the plaintext only through the explicit value accessor', () => {
    expect(masked.value.spot).toBe(SPOT);
    expect(masked.value.instructions).toBe(INSTRUCTIONS);
  });

  it('serializes to the redaction placeholder under JSON.stringify', () => {
    const serialized = JSON.stringify({ details: masked, note: 'reveal fetched' });
    expect(serialized).toContain(PICKUP_DETAILS_REDACTED);
    expect(serialized).not.toContain(SPOT);
    expect(serialized).not.toContain(INSTRUCTIONS);
    expect(serialized).not.toContain('Europe/Berlin');
  });

  it('masks under string coercion and template interpolation', () => {
    expect(String(masked)).toBe(PICKUP_DETAILS_REDACTED);
    expect(`details: ${masked}`).toBe(`details: ${PICKUP_DETAILS_REDACTED}`);
    expect(masked.toJSON()).toBe(PICKUP_DETAILS_REDACTED);
  });

  it('keeps the plaintext unreachable to object walkers, spreads, and key enumeration', () => {
    // Sentry's scrubber and analytics walkers enumerate own enumerable
    // properties; the plaintext lives in a private field, so a walked or
    // spread copy carries nothing to scrub.
    expect(JSON.stringify(Object.keys(masked))).toBe('[]');
    const spread = { ...masked };
    expect('value' in spread).toBe(false);
    expect(JSON.stringify(spread)).not.toContain(SPOT);
  });

  it('survives the Sentry telemetry pipeline without leaking the plaintext', () => {
    // A reveal payload that slips into a Sentry event (extra/context) must
    // emit nothing the scrubber could miss: the walker reaches no plaintext,
    // and the final event serialization carries only the redaction marker.
    const event = scrubSensitiveData(
      asOpaque<Parameters<typeof scrubSensitiveData>[0]>({
        message: 'pickup reveal failed',
        extra: { details: masked, orderId: 'order-1' },
        contexts: { 'error.context': { details: masked } },
      }),
    );
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain(SPOT);
    expect(serialized).not.toContain(INSTRUCTIONS);
    expect(serialized).not.toContain('Europe/Berlin');
    // The unsanitized boundary (Logger titles, JSON.stringify at capture
    // call sites) still emits the explicit redaction marker via toJSON.
    expect(JSON.stringify({ extra: { details: masked } })).toContain(PICKUP_DETAILS_REDACTED);
  });

  it('negative control: the UNWRAPPED details DO leak through the same scrub call', () => {
    // Proves the masking test above is not vacuous: the scrubber's patterns
    // (pubky/email/phone, keyed denylist) do not catch pickup details, so
    // only the wrapper keeps the plaintext out of telemetry.
    const event = scrubSensitiveData(
      asOpaque<Parameters<typeof scrubSensitiveData>[0]>({
        message: 'pickup reveal failed',
        extra: { details: pickupDetailsSchema.parse(spotDetails), orderId: 'order-1' },
      }),
    );
    const serialized = JSON.stringify(event);
    expect(serialized).toContain(SPOT);
    expect(serialized).toContain(INSTRUCTIONS);
  });
});

describe('reveal and owner-read schemas (captured shapes from crates/service/tests/pickup_test.rs)', () => {
  const revealBody = {
    orderId: '018f47d2-6a27-7c23-a62f-000000000730',
    firstRevealedAt: '2026-08-19T22:05:00.000Z',
    lines: [
      {
        lineIndex: 0,
        listingAggregateId: `listing:${'s'.repeat(52)}_boots_01`,
        version: 1,
        currentVersion: 2,
        updatedSincePayment: true,
        withdrawnBySeller: false,
        updatedAt: '2026-08-19T22:00:00.000Z',
        details: spotDetails,
      },
      {
        lineIndex: 1,
        listingAggregateId: `listing:${'s'.repeat(52)}_lamp_02`,
        version: 3,
        currentVersion: null,
        updatedSincePayment: false,
        withdrawnBySeller: true,
        updatedAt: '2026-08-19T22:01:00.000Z',
        details: addressDetails,
      },
    ],
  };

  it('parses the per-line pinned reveal with the terms-change and withdrawn flags', () => {
    const reveal = marketplacePickupRevealSchema.parse(revealBody);
    expect(reveal.orderId).toBe(revealBody.orderId);
    expect(reveal.lines).toHaveLength(2);
    const [first, second] = reveal.lines;
    expect(first.updatedSincePayment).toBe(true);
    expect(first.withdrawnBySeller).toBe(false);
    expect(first.currentVersion).toBe(2);
    expect(first.details.value.spot).toBe(SPOT);
    expect(second.withdrawnBySeller).toBe(true);
    expect(second.currentVersion).toBeNull();
    expect(second.details.value.address?.city).toBe('New York');
  });

  it('keeps the revealed details masked inside the parsed response', () => {
    const reveal = marketplacePickupRevealSchema.parse(revealBody);
    const serialized = JSON.stringify(reveal);
    expect(serialized).not.toContain(SPOT);
    expect(serialized).not.toContain('Market Street');
    expect(serialized).toContain(PICKUP_DETAILS_REDACTED);
  });

  it('parses the seller owner read with current details and the surviving counter', () => {
    const read = marketplaceSellerPickupDetailsSchema.parse({
      listingAggregateId: `listing:${'s'.repeat(52)}_boots_01`,
      current: { details: spotDetails, version: 4, updatedAt: '2026-08-19T22:02:00.000Z' },
      lastVersion: 4,
    });
    expect(read.current?.version).toBe(4);
    expect(read.current?.details.value.spot).toBe(SPOT);
    expect(read.lastVersion).toBe(4);
  });

  it('parses the post-clear owner read: no current details, counter survives', () => {
    const read = marketplaceSellerPickupDetailsSchema.parse({
      listingAggregateId: `listing:${'s'.repeat(52)}_boots_01`,
      current: null,
      lastVersion: 4,
    });
    expect(read.current).toBeNull();
    expect(read.lastVersion).toBe(4);
  });

  it('masks the owner-read details in serialization too', () => {
    const read = marketplaceSellerPickupDetailsSchema.parse({
      listingAggregateId: `listing:${'s'.repeat(52)}_boots_01`,
      current: { details: spotDetails, version: 1, updatedAt: '2026-08-19T22:00:00.000Z' },
      lastVersion: 1,
    });
    expect(JSON.stringify(read)).not.toContain(SPOT);
  });

  it('parses the /health capability surface', () => {
    expect(marketplaceHealthSchema.parse({ status: 'ok', pickupAvailable: true }).pickupAvailable).toBe(true);
    expect(marketplaceHealthSchema.parse({ status: 'ok', pickupAvailable: false }).pickupAvailable).toBe(false);
    expect(marketplaceHealthSchema.parse({ status: 'ok' }).pickupAvailable).toBe(false);
  });
});

describe('classifyMarketplacePickupRefusal (the service INVALID_STATE vocabulary)', () => {
  it.each([
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
  ] as const)('classifies %s', (message, reason) => {
    expect(classifyMarketplacePickupRefusal(message)).toBe(reason);
  });

  it('returns null for messages outside the pickup refusal vocabulary', () => {
    expect(classifyMarketplacePickupRefusal('The order is not awaiting pickup readiness.')).toBeNull();
    expect(classifyMarketplacePickupRefusal('The aggregate changed.')).toBeNull();
  });

  it('maps an unrecognized envelope message to static copy, never an echoed meeting address', () => {
    const echoed = 'Meet at 14 Oak Lane after 6pm; ask for the red jacket.';
    expect(pickupRefusalToastDescription(echoed)).toBe(pickupRefusalFailureMessage(null));
    expect(pickupRefusalToastDescription(echoed)).not.toContain('14 Oak Lane');
    expect(pickupRefusalToastDescription('The listing does not publish pickup.')).toBe(
      pickupRefusalFailureMessage('pickup_not_published'),
    );
  });
});

describe('pickup command toast classification (issue 51)', () => {
  it('reads context.refusal from a thrown command error', () => {
    expect(
      pickupRefusalFromUnknown({
        message: 'The listing does not publish pickup.',
        context: { refusal: 'pickup_not_published' },
      }),
    ).toBe('pickup_not_published');
  });

  it('falls back to the service message when context is absent', () => {
    expect(pickupRefusalFromUnknown({ message: 'Pickup is unavailable on this deployment.' })).toBe(
      'pickup_unavailable',
    );
    expect(pickupRefusalFromUnknown({ message: 'Meet at 14 Oak Lane.' })).toBeNull();
  });

  it('names the listing-save step for pickup_not_published instead of a generic save failure', () => {
    expect(pickupCommandToastDescription('pickup_not_published')).toBe(
      'Save the listing as pickup first (Save changes), then save the meeting point.',
    );
    expect(pickupCommandToastDescription(null)).toBe('The pickup details could not be saved.');
    expect(pickupCommandToastDescription('pickup_unavailable')).toBe('Pickup is unavailable on this deployment.');
  });

  it('maps NOT_FOUND and UNAUTHORIZED envelopes to sign-in / refresh copy', () => {
    expect(pickupCommandEnvelopeToastDescription('NOT_FOUND', 'The listing was not found.')).toBe(
      PICKUP_LISTING_GONE_TOAST,
    );
    expect(
      pickupCommandEnvelopeToastDescription('UNAUTHORIZED', 'Only the listing seller may set pickup details.'),
    ).toBe(PICKUP_SESSION_EXPIRED_TOAST);
    expect(pickupCommandEnvelopeToastDescription('INVALID_STATE', 'The listing does not publish pickup.')).toBe(
      pickupRefusalFailureMessage('pickup_not_published'),
    );
    expect(PICKUP_NOTHING_PUBLISHED_TOAST).toMatch(/not published as pickup/);
  });
});

describe('resolveCheckoutFulfillment (§A2 per-(seller, fulfillment) choices)', () => {
  const sellerA = 'a'.repeat(52);
  const sellerB = 'b'.repeat(52);
  const lineA1 = {
    listingAggregateId: `listing:${sellerA}_boots`,
    sellerPubky: sellerA,
    publishedFulfillmentMethods: ['shipping', 'pickup'],
  } as const;
  const lineA2 = {
    listingAggregateId: `listing:${sellerA}_lamp`,
    sellerPubky: sellerA,
    publishedFulfillmentMethods: ['shipping'],
  } as const;
  const lineB1 = {
    listingAggregateId: `listing:${sellerB}_chair`,
    sellerPubky: sellerB,
    publishedFulfillmentMethods: ['shipping', 'pickup'],
  } as const;

  it('defaults every group to shipping and requires a delivery address', () => {
    const plan = resolveCheckoutFulfillment([lineA1, lineB1], {});
    expect(plan).toEqual({ ok: true, lineFulfillments: ['shipping', 'shipping'], requiresDeliveryAddress: true });
  });

  it('applies one choice to every line of the seller group, independently per seller', () => {
    const plan = resolveCheckoutFulfillment([lineA1, lineA2, lineB1], { [sellerA]: 'pickup' });
    expect(plan.ok).toBe(false); // lineA2 does not publish pickup — see the dedicated test below
    const shippingPlan = resolveCheckoutFulfillment([lineA1, lineB1], { [sellerA]: 'pickup' });
    expect(shippingPlan).toEqual({
      ok: true,
      lineFulfillments: ['pickup', 'shipping'],
      requiresDeliveryAddress: true,
    });
  });

  it('marks a pickup-only checkout as address-free', () => {
    const plan = resolveCheckoutFulfillment([lineA1, lineB1], { [sellerA]: 'pickup', [sellerB]: 'pickup' });
    expect(plan).toEqual({ ok: true, lineFulfillments: ['pickup', 'pickup'], requiresDeliveryAddress: false });
  });

  it('refuses a choice a line does not publish — never a silent fallback to shipping', () => {
    const plan = resolveCheckoutFulfillment([lineA1, lineA2], { [sellerA]: 'pickup' });
    expect(plan).toEqual({
      ok: false,
      reason: 'fulfillment_not_published',
      sellerPubky: sellerA,
      fulfillment: 'pickup',
      listingAggregateId: lineA2.listingAggregateId,
    });
  });

  it('treats an undefined group entry as the shipping default', () => {
    const plan = resolveCheckoutFulfillment([lineB1], { [sellerB]: undefined });
    expect(plan).toEqual({ ok: true, lineFulfillments: ['shipping'], requiresDeliveryAddress: true });
  });

  // Digital delivery design §3 "Mixed carts", §6 B2, B3.
  const digitalA = {
    listingAggregateId: `listing:${sellerA}_guide`,
    sellerPubky: sellerA,
    publishedFulfillmentMethods: ['digital'],
    fulfillmentChoice: 'digital',
  } as const;

  it('lets a digital line keep its own method beside its seller group’s shipped lines', () => {
    const plan = resolveCheckoutFulfillment([lineA2, digitalA], { [sellerA]: 'shipping' });
    expect(plan).toEqual({ ok: true, lineFulfillments: ['shipping', 'digital'], requiresDeliveryAddress: true });
  });

  it('marks an all-digital checkout as address-free', () => {
    const plan = resolveCheckoutFulfillment([digitalA], {});
    expect(plan).toEqual({ ok: true, lineFulfillments: ['digital'], requiresDeliveryAddress: false });
  });

  it('refuses a line’s own choice its listing does not publish', () => {
    const plan = resolveCheckoutFulfillment([{ ...lineA2, fulfillmentChoice: 'digital' }], {});
    expect(plan).toEqual({
      ok: false,
      reason: 'fulfillment_not_published',
      sellerPubky: sellerA,
      fulfillment: 'digital',
      listingAggregateId: lineA2.listingAggregateId,
    });
  });
});
