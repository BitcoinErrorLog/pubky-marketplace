import { describe, expect, it } from 'vitest';
import {
  asDigitalDeliveryCommandResult,
  asPickupDetailsCommandResult,
  clearDigitalDeliveryCommandSchema,
  clearPickupDetailsCommandSchema,
  confirmPickupCommandSchema,
  createMarketplaceCheckoutCommandSchema,
  createReviewCommandSchema,
  deliverDigitalCommandSchema,
  isListingDeletedResponse,
  isListingRecordNotFoundResponse,
  isMarketplaceRevisionConflict,
  isSuccessfulListingRegistrationResponse,
  marketplaceCommandResponseSchema,
  marketplaceCommandSchema,
  markReadyForPickupCommandSchema,
  offerCheckoutCommandSchema,
  registerListingCommandSchema,
  setDeliveryEmailCommandSchema,
  setDigitalDeliveryCommandSchema,
  setPickupDetailsCommandSchema,
  updateReviewCommandSchema,
} from './transaction-commands';
import { toSnakeCaseWire } from './wire-casing';

const ORDER_ID = '018f47d2-6a27-7c23-a62f-000000000720';

function reviewCommand(kind: 'review.create' | 'review.update', payload: Record<string, unknown> = {}) {
  return {
    version: 1,
    commandId: '018f47d2-6a27-7c23-a62f-000000000721',
    aggregateId: `order:${ORDER_ID}`,
    expectedRevision: 3,
    issuedAt: '2026-08-20T12:00:00.000Z',
    kind,
    payload: { orderId: ORDER_ID, rating: 4, text: 'Solid transaction, fast shipping.', ...payload },
  };
}

// `review.create` and `review.update` share the service's single
// ReviewTermsPayload validator, so both kinds are exercised against the same
// bounds: integer rating 1–5 and trimmed text of 1–5,000 characters.
describe.each([
  ['review.create', createReviewCommandSchema],
  ['review.update', updateReviewCommandSchema],
] as const)('%s command contract', (kind, schema) => {
  it('accepts a payload matching the service validator', () => {
    const parsed = schema.parse(reviewCommand(kind));

    expect(parsed.kind).toBe(kind);
    expect(parsed.payload).toEqual({ orderId: ORDER_ID, rating: 4, text: 'Solid transaction, fast shipping.' });
  });

  it('is a member of the marketplace command union', () => {
    expect(marketplaceCommandSchema.parse(reviewCommand(kind)).kind).toBe(kind);
  });

  it.each([0, 6, 3.5])('rejects the out-of-bounds rating %s', (rating) => {
    expect(schema.safeParse(reviewCommand(kind, { rating })).success).toBe(false);
  });

  it('rejects empty and whitespace-only text', () => {
    expect(schema.safeParse(reviewCommand(kind, { text: '' })).success).toBe(false);
    expect(schema.safeParse(reviewCommand(kind, { text: '   ' })).success).toBe(false);
  });

  it('accepts text at the 5,000-character bound and rejects one character more', () => {
    expect(schema.safeParse(reviewCommand(kind, { text: 'a'.repeat(5_000) })).success).toBe(true);
    expect(schema.safeParse(reviewCommand(kind, { text: 'a'.repeat(5_001) })).success).toBe(false);
  });

  it('rejects unknown payload fields, mirroring the service deny_unknown_fields', () => {
    expect(schema.safeParse(reviewCommand(kind, { deliveryAddress: 'leak' })).success).toBe(false);
  });

  it('rejects a non-uuid order id', () => {
    expect(schema.safeParse(reviewCommand(kind, { orderId: 'not-a-uuid' })).success).toBe(false);
  });
});

describe('review.update revision conflict handling', () => {
  it('classifies the 409 REVISION_CONFLICT answer for the refetch-and-retry pattern', () => {
    expect(
      isMarketplaceRevisionConflict({
        ok: false,
        error: { code: 'REVISION_CONFLICT', message: 'The order revision is stale.', currentRevision: 4 },
      }),
    ).toBe(true);
  });

  it('does not classify the closed-window INVALID_STATE answer as retriable', () => {
    expect(
      isMarketplaceRevisionConflict({
        ok: false,
        error: { code: 'INVALID_STATE', message: 'The review edit window has closed.' },
      }),
    ).toBe(false);
  });
});

describe('listing registration response correlation', () => {
  const aggregateId = `listing:${'s'.repeat(52)}_boots_01`;
  const response = {
    ok: true as const,
    version: 1 as const,
    commandId: '018f47d2-6a27-7c23-a62f-000000000740',
    aggregateId,
    revision: 1,
    eventIds: [],
    result: { kind: 'listing' as const },
  };

  it('rejects a successful response for a different aggregate', () => {
    expect(isSuccessfulListingRegistrationResponse(response, 'listing:other', response.commandId)).toBe(false);
  });

  it('rejects a successful response for a different command', () => {
    expect(isSuccessfulListingRegistrationResponse(response, aggregateId, '018f47d2-6a27-7c23-a62f-000000000741')).toBe(
      false,
    );
  });

  it('accepts a successful response for the expected aggregate and command', () => {
    expect(isSuccessfulListingRegistrationResponse(response, aggregateId, response.commandId)).toBe(true);
  });

  it.each(['NOT_MODIFIED', 'NOOP'])('requires service proof for benign refusal code %s', (code) => {
    expect(
      isSuccessfulListingRegistrationResponse(
        {
          ok: false,
          error: { code, message: 'Already converged.' },
        },
        aggregateId,
        response.commandId,
      ),
    ).toBe(false);
    expect(
      isSuccessfulListingRegistrationResponse(
        {
          ok: false,
          error: { code, message: 'Already converged.' },
        },
        aggregateId,
        response.commandId,
        true,
      ),
    ).toBe(true);
  });

  it('rejects a benign refusal with a mismatched aggregate', () => {
    expect(
      isSuccessfulListingRegistrationResponse(
        {
          ok: false,
          aggregateId: 'listing:other',
          error: { code: 'NO_OP', message: 'Already converged.' },
        } as never,
        aggregateId,
        response.commandId,
        true,
      ),
    ).toBe(false);
  });

  it('rejects a successful response missing correlation ids', () => {
    expect(
      isSuccessfulListingRegistrationResponse(
        {
          ...response,
          aggregateId: undefined,
          commandId: undefined,
        } as never,
        aggregateId,
        response.commandId,
      ),
    ).toBe(false);
  });
});

describe('listing registration refused for a missing homeserver record', () => {
  const aggregateId = `listing:${'s'.repeat(52)}_boots_01`;
  const commandId = '018f47d2-6a27-7c23-a62f-000000000742';
  const notFound = {
    ok: false as const,
    error: { code: 'NOT_FOUND', message: "The seller's homeserver has no such listing record." },
  };

  it('classifies the uncorrelated NOT_FOUND refusal the service sends', () => {
    expect(isListingRecordNotFoundResponse(notFound, aggregateId, commandId)).toBe(true);
  });

  it('rejects a NOT_FOUND refusal correlated to another aggregate or command', () => {
    expect(
      isListingRecordNotFoundResponse({ ...notFound, aggregateId: 'listing:other' } as never, aggregateId, commandId),
    ).toBe(false);
    expect(
      isListingRecordNotFoundResponse(
        { ...notFound, commandId: '018f47d2-6a27-7c23-a62f-000000000743' } as never,
        aggregateId,
        commandId,
      ),
    ).toBe(false);
  });

  it.each([
    { ok: false as const, error: { code: 'INVALID_STATE', message: 'This listing was deleted.' } },
    { ok: false as const, error: { code: 'UPSTREAM_UNAVAILABLE', message: 'The homeserver is unavailable.' } },
  ])('does not classify $error.code as a missing record', (response) => {
    expect(isListingRecordNotFoundResponse(response, aggregateId, commandId)).toBe(false);
  });

  it('does not classify a success', () => {
    expect(
      isListingRecordNotFoundResponse(
        {
          ok: true,
          version: 1,
          commandId,
          aggregateId,
          revision: 1,
          eventIds: [],
          result: { kind: 'listing' },
        },
        aggregateId,
        commandId,
      ),
    ).toBe(false);
  });
});

describe('listing.sync on a listing the seller deleted', () => {
  const aggregateId = `listing:${'s'.repeat(52)}_boots_01`;
  const commandId = '018f47d2-6a27-7c23-a62f-000000000744';
  // pubky-marketplace-service `sync_listing.rs` `deleted_success`, after wire camel-casing.
  const tombstone = {
    ok: true as const,
    version: 1 as const,
    commandId,
    aggregateId,
    revision: 2,
    eventIds: ['018f47d2-6a27-7c23-a62f-000000000745'],
    result: {
      kind: 'listing_deleted' as const,
      listing: {
        aggregateId,
        sellerPubky: 's'.repeat(52),
        listingId: 'boots_01',
        serverRevision: 2,
        deletedAt: '2026-09-30T12:00:00.000Z',
      },
    },
  };

  it('is a success the response schema accepts', () => {
    const parsed = marketplaceCommandResponseSchema.parse(tombstone);

    expect(parsed).toMatchObject({ ok: true, result: { kind: 'listing_deleted' } });
  });

  it('still rejects a result kind the service does not send', () => {
    expect(
      marketplaceCommandResponseSchema.safeParse({ ...tombstone, result: { kind: 'listing_removed' } }).success,
    ).toBe(false);
  });

  it('is classified for the synced aggregate', () => {
    expect(isListingDeletedResponse(tombstone, aggregateId)).toBe(true);
  });

  it('is not classified for another aggregate', () => {
    expect(isListingDeletedResponse(tombstone, `listing:${'s'.repeat(52)}_other`)).toBe(false);
  });

  it('is not registration success, so a seller-side register or sync never treats a tombstone as registered', () => {
    expect(isSuccessfulListingRegistrationResponse(tombstone, aggregateId, commandId)).toBe(false);
    expect(isSuccessfulListingRegistrationResponse(tombstone, aggregateId, commandId, true)).toBe(false);
  });

  it.each([
    { ...tombstone, result: { kind: 'listing' as const } },
    { ok: false as const, error: { code: 'NOT_FOUND', message: 'The listing was not found.' } },
  ])('does not classify %j', (response) => {
    expect(isListingDeletedResponse(response, aggregateId)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Local pickup (Wave 7 safe subset) — shapes mirror the durable service
// (crates/domain/src/commands.rs, crates/service/tests/pickup_test.rs).
// -----------------------------------------------------------------------------

const SELLER = 's'.repeat(52);
const LISTING_AGGREGATE_ID = `listing:${SELLER}_boots_01`;

function pickupCommand(kind: string, payload: Record<string, unknown>, aggregateId = LISTING_AGGREGATE_ID) {
  return {
    version: 1,
    commandId: '018f47d2-6a27-7c23-a62f-000000000731',
    aggregateId,
    expectedRevision: 0,
    issuedAt: '2026-08-19T22:00:00.000Z',
    kind,
    payload,
  };
}

const spotDetails = {
  kind: 'spot',
  spot: 'Central Station, north entrance',
  instructions: 'Ask for the blue backpack.',
  availability: {
    windows: [{ day: 'sat', start: '10:00', end: '14:00' }],
    zone: 'Europe/Berlin',
  },
};

describe('pickup_details.set command contract', () => {
  it('accepts the payload captured from the service tests (CAS on the details version)', () => {
    // The service test fixture sends `expected_version` snake_case on the
    // wire; the wire-casing layer camelCases at the transport boundary, so
    // this schema validates the camelCase form.
    const parsed = setPickupDetailsCommandSchema.parse(
      pickupCommand('pickup_details.set', { expectedVersion: 0, details: spotDetails }),
    );
    expect(parsed.payload.expectedVersion).toBe(0);
    expect(parsed.payload.details.spot).toBe('Central Station, north entrance');
    expect(parsed.payload.details.instructions).toBe('Ask for the blue backpack.');
  });

  it('is a member of the marketplace command union', () => {
    expect(
      marketplaceCommandSchema.parse(pickupCommand('pickup_details.set', { expectedVersion: 2, details: spotDetails }))
        .kind,
    ).toBe('pickup_details.set');
  });

  it('rejects a negative expected version and unknown payload fields', () => {
    expect(
      setPickupDetailsCommandSchema.safeParse(
        pickupCommand('pickup_details.set', { expectedVersion: -1, details: spotDetails }),
      ).success,
    ).toBe(false);
    expect(
      setPickupDetailsCommandSchema.safeParse(
        pickupCommand('pickup_details.set', { expectedVersion: 0, details: spotDetails, note: 'x' }),
      ).success,
    ).toBe(false);
  });
});

describe('pickup_details.clear command contract', () => {
  it('accepts the expected_version CAS payload', () => {
    const parsed = clearPickupDetailsCommandSchema.parse(pickupCommand('pickup_details.clear', { expectedVersion: 4 }));
    expect(parsed.payload.expectedVersion).toBe(4);
  });

  it('is a member of the marketplace command union', () => {
    expect(marketplaceCommandSchema.parse(pickupCommand('pickup_details.clear', { expectedVersion: 0 })).kind).toBe(
      'pickup_details.clear',
    );
  });
});

describe('fulfillment.mark_ready / fulfillment.confirm_pickup command contracts', () => {
  it.each([
    ['fulfillment.mark_ready', markReadyForPickupCommandSchema],
    ['fulfillment.confirm_pickup', confirmPickupCommandSchema],
  ] as const)('%s targets the order aggregate with the order id payload', (kind, schema) => {
    const command = pickupCommand(kind, { orderId: ORDER_ID }, `order:${ORDER_ID}`);
    expect(schema.parse(command).payload.orderId).toBe(ORDER_ID);
    expect(marketplaceCommandSchema.parse(command).kind).toBe(kind);
  });

  it.each([
    ['fulfillment.mark_ready', markReadyForPickupCommandSchema],
    ['fulfillment.confirm_pickup', confirmPickupCommandSchema],
  ] as const)('%s rejects a non-uuid order id', (kind, schema) => {
    expect(schema.safeParse(pickupCommand(kind, { orderId: 'nope' }, `order:${ORDER_ID}`)).success).toBe(false);
  });
});

describe('pickup_details command result narrowing', () => {
  const response = {
    ok: true as const,
    version: 1 as const,
    commandId: '018f47d2-6a27-7c23-a62f-000000000731',
    aggregateId: LISTING_AGGREGATE_ID,
    revision: 3,
    eventIds: ['018f47d2-6a27-7c23-a62f-000000000732'],
  };

  it('narrows the set result to the new details version', () => {
    const result = asPickupDetailsCommandResult({
      ...response,
      result: {
        kind: 'pickup_details',
        listingAggregateId: LISTING_AGGREGATE_ID,
        version: 3,
        updatedAt: '2026-08-19T22:00:00.000Z',
      },
    });
    expect(result).toMatchObject({ kind: 'pickup_details', version: 3, listingAggregateId: LISTING_AGGREGATE_ID });
  });

  it('narrows the clear result with the surviving version and the cleared flag', () => {
    const result = asPickupDetailsCommandResult({
      ...response,
      result: {
        kind: 'pickup_details',
        listingAggregateId: LISTING_AGGREGATE_ID,
        version: 4,
        cleared: true,
        updatedAt: '2026-08-19T22:05:00.000Z',
      },
    });
    expect(result).toMatchObject({ version: 4, cleared: true });
  });

  it('returns null for a refusal or another command kind', () => {
    expect(
      asPickupDetailsCommandResult({
        ok: false,
        error: { code: 'INVALID_STATE', message: 'The listing does not publish pickup.' },
      }),
    ).toBeNull();
    expect(asPickupDetailsCommandResult({ ...response, result: { kind: 'order', state: 'paid' } })).toBeNull();
  });
});

describe('listing.register fulfillment methods (mirrors the service register validation)', () => {
  const registerPayload = {
    sellerPubky: SELLER,
    listingId: 'boots_01',
    listingRevision: 1,
    contentHash: 'a'.repeat(64),
    quantity: 5,
    unitPrice: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
  };

  function registerCommand(payload: Record<string, unknown>) {
    return {
      version: 1,
      commandId: '018f47d2-6a27-7c23-a62f-000000000733',
      aggregateId: LISTING_AGGREGATE_ID,
      expectedRevision: 0,
      issuedAt: '2026-08-19T22:00:00.000Z',
      kind: 'listing.register',
      payload: { ...registerPayload, ...payload },
    };
  }

  it('defaults to shipping-only when the payload omits the methods (pre-pickup clients)', () => {
    expect(registerListingCommandSchema.parse(registerCommand({})).payload.fulfillmentMethods).toEqual(['shipping']);
  });

  it('accepts shipping+pickup and rejects empties, repeats, and unknown methods', () => {
    expect(
      registerListingCommandSchema.parse(registerCommand({ fulfillmentMethods: ['shipping', 'pickup'] })).payload
        .fulfillmentMethods,
    ).toEqual(['shipping', 'pickup']);
    expect(registerListingCommandSchema.safeParse(registerCommand({ fulfillmentMethods: [] })).success).toBe(false);
    expect(
      registerListingCommandSchema.safeParse(registerCommand({ fulfillmentMethods: ['pickup', 'pickup'] })).success,
    ).toBe(false);
    expect(registerListingCommandSchema.safeParse(registerCommand({ fulfillmentMethods: ['drone'] })).success).toBe(
      false,
    );
  });

  it('refuses non-shipping methods on auction listings (auctions are shipping-only, §A2)', () => {
    const auction = {
      saleFormat: 'auction',
      auctionTerms: {
        startsAt: '2026-08-19T22:00:00.000Z',
        endsAt: '2026-08-20T22:00:00.000Z',
        minimumIncrement: { amountMinor: 100, currency: 'USD', exponent: 2 },
        antiSnipingWindowSeconds: 300,
        antiSnipingExtensionSeconds: 300,
      },
      auctionReserve: {
        expectedRecordRevision: 0,
        recordRevision: 1,
        reservePrice: { amountMinor: 15_000, currency: 'USD', exponent: 2 },
      },
    };
    expect(
      registerListingCommandSchema.safeParse(registerCommand({ ...auction, fulfillmentMethods: ['shipping'] })).success,
    ).toBe(true);
    expect(
      registerListingCommandSchema.safeParse(registerCommand({ ...auction, fulfillmentMethods: ['pickup'] })).success,
    ).toBe(false);
    expect(
      registerListingCommandSchema.safeParse(
        registerCommand({ ...auction, fulfillmentMethods: ['shipping', 'pickup'] }),
      ).success,
    ).toBe(false);
    expect(
      registerListingCommandSchema.safeParse(
        registerCommand({
          ...auction,
          auctionTerms: { ...auction.auctionTerms, reservePrice: auction.auctionReserve.reservePrice },
          fulfillmentMethods: ['shipping'],
        }),
      ).success,
    ).toBe(false);
  });
});

describe('checkout.create fulfillment and address rules (§A2)', () => {
  const address = {
    name: 'Alice Buyer',
    line1: '1 Market Street',
    line2: '',
    city: 'New York',
    region: 'NY',
    postalCode: '10001',
    countryCode: 'US',
  };

  function checkoutCommand(lines: Record<string, unknown>[], withAddress: boolean) {
    return {
      version: 1,
      commandId: '018f47d2-6a27-7c23-a62f-000000000734',
      aggregateId: 'checkout:018f47d2-6a27-7c23-a62f-000000000734',
      expectedRevision: 0,
      issuedAt: '2026-08-19T22:00:00.000Z',
      kind: 'checkout.create',
      payload: {
        lines,
        ...(withAddress ? { deliveryAddress: address } : {}),
        guaranteePolicyVersion: 1,
      },
    };
  }

  const pickupLine = {
    listingAggregateId: LISTING_AGGREGATE_ID,
    expectedRevision: 1,
    quantity: 1,
    fulfillment: 'pickup',
  };
  const shippingLine = { listingAggregateId: `listing:${SELLER}_lamp_02`, expectedRevision: 2, quantity: 1 };

  it('accepts a pickup-only checkout with NO delivery address', () => {
    const parsed = createMarketplaceCheckoutCommandSchema.parse(checkoutCommand([pickupLine], false));
    expect(parsed.payload.deliveryAddress).toBeUndefined();
    expect(parsed.payload.lines[0].fulfillment).toBe('pickup');
  });

  it('rejects a pickup-only checkout that PRESENTS a delivery address', () => {
    expect(createMarketplaceCheckoutCommandSchema.safeParse(checkoutCommand([pickupLine], true)).success).toBe(false);
  });

  it('requires a delivery address when any line ships (absent fulfillment means shipping)', () => {
    expect(
      createMarketplaceCheckoutCommandSchema.safeParse(checkoutCommand([pickupLine, shippingLine], false)).success,
    ).toBe(false);
    expect(
      createMarketplaceCheckoutCommandSchema.safeParse(checkoutCommand([pickupLine, shippingLine], true)).success,
    ).toBe(true);
  });

  it('keeps legacy checkouts valid: no line fulfillment plus an address', () => {
    expect(createMarketplaceCheckoutCommandSchema.safeParse(checkoutCommand([shippingLine], true)).success).toBe(true);
  });

  it('requires a US state and accepts a GB address with no region', () => {
    const withoutState = checkoutCommand([shippingLine], true);
    withoutState.payload.deliveryAddress = { ...address, region: '' };
    expect(createMarketplaceCheckoutCommandSchema.safeParse(withoutState).success).toBe(false);

    const gb = checkoutCommand([shippingLine], true);
    gb.payload.deliveryAddress = {
      name: 'Ada',
      line1: '10 Downing Street',
      line2: '',
      city: 'London',
      region: '',
      postalCode: 'SW1A 2AA',
      countryCode: 'GB',
    };
    expect(createMarketplaceCheckoutCommandSchema.safeParse(gb).success).toBe(true);
  });

  // Digital delivery design §3 "Checkout", §6 B2, B3, F1–F3 (`digital_only_checkout_rejects_address`,
  // `mixed_cart_splits_digital_into_own_order`, `delivery_email_validation`).
  const digitalLine = {
    listingAggregateId: `listing:${SELLER}_guide_03`,
    expectedRevision: 3,
    quantity: 1,
    fulfillment: 'digital',
  };

  it('accepts an all-digital checkout with no address and refuses one that presents it', () => {
    const parsed = createMarketplaceCheckoutCommandSchema.parse(checkoutCommand([digitalLine], false));
    expect(parsed.payload.deliveryAddress).toBeUndefined();
    expect(parsed.payload.lines[0].fulfillment).toBe('digital');
    const withAddress = createMarketplaceCheckoutCommandSchema.safeParse(checkoutCommand([digitalLine], true));
    expect(withAddress.error?.issues.map(({ message }) => message)).toEqual([
      'A checkout with no shipped line must not carry a delivery address.',
    ]);
    expect(
      createMarketplaceCheckoutCommandSchema.safeParse(checkoutCommand([digitalLine, pickupLine], false)).success,
    ).toBe(true);
  });

  it('requires the address when a digital line shares the checkout with a shipped one', () => {
    expect(
      createMarketplaceCheckoutCommandSchema.safeParse(checkoutCommand([digitalLine, shippingLine], false)).success,
    ).toBe(false);
    expect(
      createMarketplaceCheckoutCommandSchema.safeParse(checkoutCommand([digitalLine, shippingLine], true)).success,
    ).toBe(true);
  });

  it('carries a well-formed delivery email only beside a digital line', () => {
    const withEmail = (lines: Record<string, unknown>[], deliveryEmail: string) => {
      const command = checkoutCommand(lines, false);
      return { ...command, payload: { ...command.payload, deliveryEmail } };
    };
    const parsed = createMarketplaceCheckoutCommandSchema.parse(withEmail([digitalLine], 'buyer@example.com'));
    expect(parsed.payload.deliveryEmail).toBe('buyer@example.com');
    for (const malformed of [
      'buyer',
      '@example.com',
      'buyer@',
      'a@b@c',
      'buyer @example.com',
      `${'a'.repeat(250)}@b.co`,
    ]) {
      expect(createMarketplaceCheckoutCommandSchema.safeParse(withEmail([digitalLine], malformed)).success).toBe(false);
    }
    expect(createMarketplaceCheckoutCommandSchema.safeParse(withEmail([pickupLine], 'buyer@example.com')).success).toBe(
      false,
    );
  });
});

describe('digital_delivery.set / .clear command contract (digital delivery design §2, §6 C1–C5)', () => {
  const file = {
    kind: 'file',
    deliverableId: 'a'.repeat(32),
    version: 3,
    key: 'b'.repeat(64),
    iv: 'c'.repeat(24),
    ciphertextBlake3: 'd'.repeat(64),
    plaintextBlake3: 'e'.repeat(64),
    sizeBytes: 1024,
    contentType: 'application/pdf',
    fileName: 'Field Guide.pdf',
  };
  const command = (kind: 'digital_delivery.set' | 'digital_delivery.clear', payload: Record<string, unknown>) =>
    pickupCommand(kind, payload);

  it('accepts a file as the next version and puts it on the wire in the service shape', () => {
    const parsed = setDigitalDeliveryCommandSchema.parse(
      command('digital_delivery.set', { expectedVersion: 2, delivery: file }),
    );
    expect(marketplaceCommandSchema.parse(parsed).kind).toBe('digital_delivery.set');
    const wire = toSnakeCaseWire(parsed) as {
      payload: { expected_version: number; delivery: Record<string, unknown> };
    };
    expect(wire.payload.expected_version).toBe(2);
    expect(Object.keys(wire.payload.delivery).sort()).toEqual(
      [
        'ciphertext_blake3',
        'content_type',
        'deliverable_id',
        'file_name',
        'iv',
        'key',
        'kind',
        'plaintext_blake3',
        'size_bytes',
        'version',
      ].sort(),
    );
  });

  it('refuses a file that is not the next version', () => {
    expect(
      setDigitalDeliveryCommandSchema.safeParse(command('digital_delivery.set', { expectedVersion: 3, delivery: file }))
        .success,
    ).toBe(false);
  });

  it('accepts the manual kinds and refuses unknown payload fields', () => {
    for (const delivery of [{ kind: 'email' }, { kind: 'message' }, { kind: 'text', text: 'KEY' }]) {
      expect(
        setDigitalDeliveryCommandSchema.safeParse(command('digital_delivery.set', { expectedVersion: 0, delivery }))
          .success,
      ).toBe(true);
    }
    expect(
      setDigitalDeliveryCommandSchema.safeParse(
        command('digital_delivery.set', { expectedVersion: 0, delivery: { kind: 'email' }, note: 'x' }),
      ).success,
    ).toBe(false);
    expect(
      clearDigitalDeliveryCommandSchema.safeParse(command('digital_delivery.clear', { expectedVersion: 4 })).success,
    ).toBe(true);
  });

  it('parses and narrows the service result (handlers/digital.rs)', () => {
    const response = marketplaceCommandResponseSchema.parse({
      ok: true,
      version: 1,
      commandId: '018f47d2-6a27-7c23-a62f-000000000741',
      aggregateId: LISTING_AGGREGATE_ID,
      revision: 1,
      eventIds: ['018f47d2-6a27-7c23-a62f-000000000742'],
      result: {
        kind: 'digital_delivery',
        listingAggregateId: LISTING_AGGREGATE_ID,
        deliveryKind: 'file',
        deliverableId: 'a'.repeat(32),
        version: 3,
        updatedAt: '2026-09-25T10:00:00.000Z',
      },
    });
    expect(asDigitalDeliveryCommandResult(response)).toMatchObject({ version: 3, deliveryKind: 'file' });
    expect(asPickupDetailsCommandResult(response)).toBeNull();
  });
});

describe('order.set_delivery_email command contract (digital delivery design §6 F11)', () => {
  const command = (payload: Record<string, unknown>) => ({
    version: 1,
    commandId: '018f47d2-6a27-7c23-a62f-000000000911',
    aggregateId: 'order:018f47d2-6a27-7c23-a62f-000000000901',
    expectedRevision: 3,
    issuedAt: '2026-09-26T08:00:00.000Z',
    kind: 'order.set_delivery_email',
    payload,
  });
  const orderId = '018f47d2-6a27-7c23-a62f-000000000901';

  it('carries the order and a well-formed address', () => {
    expect(
      setDeliveryEmailCommandSchema.parse(command({ orderId, deliveryEmail: 'buyer@example.com' })).payload,
    ).toEqual({ orderId, deliveryEmail: 'buyer@example.com' });
  });

  it('refuses a malformed address and unknown fields', () => {
    expect(setDeliveryEmailCommandSchema.safeParse(command({ orderId, deliveryEmail: 'buyer' })).success).toBe(false);
    expect(setDeliveryEmailCommandSchema.safeParse(command({ orderId, deliveryEmail: 'a@b', note: 'x' })).success).toBe(
      false,
    );
  });
});

describe('fulfillment.deliver_digital command contract (digital delivery design §6 F13)', () => {
  const orderId = '018f47d2-6a27-7c23-a62f-000000000901';
  const command = (payload: Record<string, unknown>) => ({
    version: 1,
    commandId: '018f47d2-6a27-7c23-a62f-000000000951',
    aggregateId: `order:${orderId}`,
    expectedRevision: 3,
    issuedAt: '2026-09-26T08:00:00.000Z',
    kind: 'fulfillment.deliver_digital',
    payload,
  });

  it('carries the order and the email or message channel', () => {
    for (const channel of ['email', 'message']) {
      expect(deliverDigitalCommandSchema.parse(command({ orderId, channel })).payload).toEqual({ orderId, channel });
    }
  });

  it('refuses another channel and unknown fields', () => {
    expect(deliverDigitalCommandSchema.safeParse(command({ orderId, channel: 'sms' })).success).toBe(false);
    expect(deliverDigitalCommandSchema.safeParse(command({ orderId, channel: 'email', note: 'x' })).success).toBe(
      false,
    );
  });
});

describe('offer.checkout fulfillment and address rules (mirrors the service validator)', () => {
  const address = {
    name: 'Alice Buyer',
    line1: '1 Market Street',
    line2: '',
    city: 'New York',
    region: 'NY',
    postalCode: '10001',
    countryCode: 'US',
  };

  function offerCheckout(extra: Record<string, unknown>) {
    return {
      version: 1,
      commandId: '018f47d2-6a27-7c23-a62f-000000000740',
      aggregateId: 'offer:018f47d2-6a27-7c23-a62f-000000000741',
      expectedRevision: 2,
      issuedAt: '2026-08-19T22:00:00.000Z',
      kind: 'offer.checkout',
      payload: {
        offerId: '018f47d2-6a27-7c23-a62f-000000000741',
        awardId: '018f47d2-6a27-7c23-a62f-000000000742',
        listingAggregateId: LISTING_AGGREGATE_ID,
        listingRevision: 1,
        listingRecordSha256: 'a'.repeat(64),
        variantId: 'variant_01',
        quantity: 1,
        guaranteePolicyVersion: 1,
        ...extra,
      },
    };
  }

  it('accepts a pickup award with no delivery address', () => {
    const parsed = offerCheckoutCommandSchema.parse(offerCheckout({ fulfillment: 'pickup' }));
    expect(parsed.payload.fulfillment).toBe('pickup');
    expect(parsed.payload.deliveryAddress).toBeUndefined();
  });

  it('keeps a shipped award as before: address required, no fulfillment field', () => {
    expect(offerCheckoutCommandSchema.safeParse(offerCheckout({ deliveryAddress: address })).success).toBe(true);
    expect(offerCheckoutCommandSchema.safeParse(offerCheckout({})).success).toBe(false);
  });

  it('rejects a pickup award that presents an address', () => {
    expect(
      offerCheckoutCommandSchema.safeParse(offerCheckout({ fulfillment: 'pickup', deliveryAddress: address })).success,
    ).toBe(false);
  });
});
