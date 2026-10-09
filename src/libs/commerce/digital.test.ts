import { describe, expect, it } from 'vitest';
import { marketplaceListingProjectionSchema } from '@/core/services/marketplace/marketplace-projections';
import { serviceListingProjectionWire as serviceListingSample } from '@/test/fixtures/commerce/listing-projection.wire';
import {
  bindOrderDigitalLine,
  classifyDeliveryEmailChangeRefusal,
  classifyDigitalCheckoutRefusal,
  classifyDigitalDeliverRefusal,
  classifyDigitalDeliverySetupRefusal,
  classifyDigitalReadRefusal,
  DELIVERY_EMAIL_CHANGE_COPY,
  DELIVERY_EMAIL_MAX_CHARS,
  DIGITAL_CHECKOUT_COPY,
  DIGITAL_CHECKOUT_REFUSAL_COPY,
  DIGITAL_DELIVER_REFUSAL_COPY,
  DIGITAL_DELIVERY_COPY,
  DIGITAL_DELIVERY_SETUP_COPY,
  DIGITAL_FILE_OPEN_FAILURE_COPY,
  DIGITAL_ORDER_COPY,
  DIGITAL_SELLER_COPY,
  digitalCheckoutLineLabel,
  digitalContentTypeLabel,
  digitalDeliveryBadgeLabel,
  digitalDeliveryCurrentSummary,
  digitalDeliverySetSchema,
  digitalDeliveryVersionLine,
  digitalEvidenceLines,
  digitalFileTooLargeCopy,
  digitalOrderEmailLine,
  digitalOrderManualChannels,
  digitalPaymentTakenBack,
  formatDigitalFileSize,
  isDigitalDeliveryLink,
  isDigitalOrderEnded,
  isInstantDigitalDeliveryKind,
  isWellFormedDeliveryEmail,
  marketplaceListingDigitalDeliveryFieldSchema,
  marketplaceOrderDeliveryEmailSchema,
  marketplaceOrderDigitalDeliverySchema,
  marketplaceOrderDigitalEvidenceSchema,
  marketplaceSellerDigitalDeliverySchema,
  sellerDeliveryEmailReadCopy,
} from './digital';
import { marketplaceHealthSchema } from './pickup';
import { toCamelCaseWire } from './wire-casing';

describe('digital delivery listing projection (§7 input inventory)', () => {
  it('parses the file facts the service projects (model.rs digital_delivery_projection)', () => {
    const wire = {
      ...serviceListingSample(),
      fulfillment_methods: ['digital'],
      digital_delivery: { kind: 'file', content_type: 'application/pdf', size_bytes: 12_582_912 },
    };
    const parsed = marketplaceListingProjectionSchema.parse(toCamelCaseWire(wire));
    expect(parsed.fulfillmentMethods).toEqual(['digital']);
    expect(parsed.digitalDelivery).toEqual({ kind: 'file', contentType: 'application/pdf', sizeBytes: 12_582_912 });
  });

  it('reads the committed service sample (delivery not set) as null', () => {
    const parsed = marketplaceListingProjectionSchema.parse(toCamelCaseWire(serviceListingSample()));
    expect(parsed.digitalDelivery ?? null).toBeNull();
  });

  it('reads a service predating digital delivery (no field) as absent', () => {
    const wire = { ...serviceListingSample() };
    delete wire.digital_delivery;
    const parsed = marketplaceListingProjectionSchema.parse(toCamelCaseWire(wire));
    expect(parsed.digitalDelivery ?? null).toBeNull();
  });

  it('drops a malformed sub-object instead of failing the listing', () => {
    for (const malformed of [{ kind: 'bundle' }, { kind: 'file', size_bytes: -1 }, 'file', 7]) {
      const wire = { ...serviceListingSample(), digital_delivery: malformed };
      const parsed = marketplaceListingProjectionSchema.parse(toCamelCaseWire(wire));
      expect(parsed.digitalDelivery, JSON.stringify(malformed)).toBeNull();
    }
    expect(marketplaceListingDigitalDeliveryFieldSchema.parse({ kind: 'email' })).toEqual({ kind: 'email' });
  });
});

describe('digital delivery capability (/health, §6 B5)', () => {
  it('reads the flags the service reports', () => {
    const health = marketplaceHealthSchema.parse(
      toCamelCaseWire({ status: 'ok', digital_delivery_available: true, digital_delivery_max_bytes: 52_428_800 }),
    );
    expect(health.digitalDeliveryAvailable).toBe(true);
    expect(health.digitalDeliveryMaxBytes).toBe(52_428_800);
  });

  it('shop_absent_capability_is_false', () => {
    const health = marketplaceHealthSchema.parse({ status: 'ok' });
    expect(health.digitalDeliveryAvailable).toBe(false);
    expect(health.digitalDeliveryMaxBytes).toBeUndefined();
  });

  it('treats a malformed flag as off without failing the health read', () => {
    const health = marketplaceHealthSchema.parse({
      status: 'ok',
      pickupAvailable: true,
      digitalDeliveryAvailable: 'yes',
      digitalDeliveryMaxBytes: -5,
    });
    expect(health.pickupAvailable).toBe(true);
    expect(health.digitalDeliveryAvailable).toBe(false);
    expect(health.digitalDeliveryMaxBytes).toBeUndefined();
  });
});

describe('digital delivery listing badge (§3)', () => {
  it('describes a file by type and size', () => {
    expect(digitalDeliveryBadgeLabel({ kind: 'file', contentType: 'application/pdf', sizeBytes: 12_582_912 })).toBe(
      'Instant download · PDF · 12 MB',
    );
    expect(digitalDeliveryBadgeLabel({ kind: 'file', sizeBytes: 4_404_019 })).toBe('Instant download · 4.2 MB');
    expect(digitalDeliveryBadgeLabel({ kind: 'file' })).toBe('Instant download');
  });

  it('never echoes a seller-supplied content type', () => {
    expect(digitalContentTypeLabel('application/x-anything-the-seller-typed')).toBeNull();
    expect(digitalDeliveryBadgeLabel({ kind: 'file', contentType: 'text/html; <script>' })).toBe('Instant download');
  });

  it('labels the other kinds', () => {
    expect(digitalDeliveryBadgeLabel({ kind: 'link' })).toBe(DIGITAL_DELIVERY_COPY.instantAccess);
    expect(digitalDeliveryBadgeLabel({ kind: 'text' })).toBe(DIGITAL_DELIVERY_COPY.instantAccess);
    expect(digitalDeliveryBadgeLabel({ kind: 'email' })).toBe('Emailed by the seller after payment');
    expect(digitalDeliveryBadgeLabel({ kind: 'message' })).toBe(DIGITAL_DELIVERY_COPY.messaged);
    expect(digitalDeliveryBadgeLabel(null)).toBe('Digital delivery');
  });

  it('formats sizes the way buyers read them', () => {
    expect(formatDigitalFileSize(300)).toBe('1 KB');
    expect(formatDigitalFileSize(839_680)).toBe('820 KB');
    expect(formatDigitalFileSize(52_428_800)).toBe('50 MB');
  });

  it('releases file, link and text at confirmation; email and message are manual', () => {
    expect(['file', 'link', 'text'].every((kind) => isInstantDigitalDeliveryKind(kind as never))).toBe(true);
    expect(isInstantDigitalDeliveryKind('email')).toBe(false);
    expect(isInstantDigitalDeliveryKind('message')).toBe(false);
  });
});

describe('digital delivery seller setup contract (§2, §6 C1–C5)', () => {
  const file = {
    kind: 'file' as const,
    deliverableId: 'a'.repeat(32),
    version: 1,
    key: 'b'.repeat(64),
    iv: 'c'.repeat(24),
    ciphertextBlake3: 'd'.repeat(64),
    plaintextBlake3: 'e'.repeat(64),
    sizeBytes: 1024,
    contentType: 'application/pdf',
    fileName: 'Field Guide.pdf',
  };

  it('accepts each kind the service accepts', () => {
    for (const delivery of [
      file,
      { kind: 'link', url: 'https://example.com/course' },
      { kind: 'text', text: 'LICENCE-1234' },
      { kind: 'email' },
      { kind: 'message' },
    ]) {
      expect(digitalDeliverySetSchema.safeParse(delivery).success, delivery.kind).toBe(true);
    }
  });

  it('refuses what the service refuses', () => {
    for (const bad of [
      { ...file, deliverableId: 'A'.repeat(32) },
      { ...file, key: 'b'.repeat(63) },
      { ...file, iv: 'c'.repeat(32) },
      { ...file, fileName: '../guide.pdf' },
      { ...file, fileName: ' guide.pdf' },
      { ...file, extra: true },
      { kind: 'link', url: 'http://example.com' },
      { kind: 'link', url: 'https://exa mple.com' },
      { kind: 'link', url: `https://example.com/${'a'.repeat(2050)}` },
      { kind: 'text', text: '   ' },
      { kind: 'text', text: 'x'.repeat(4001) },
      { kind: 'text', text: 'a\0b' },
      { kind: 'email', url: 'https://example.com' },
      { kind: 'bundle' },
    ]) {
      expect(digitalDeliverySetSchema.safeParse(bad).success, JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
    expect(isDigitalDeliveryLink('https://example.com')).toBe(true);
    expect(isDigitalDeliveryLink('ftp://example.com')).toBe(false);
  });

  it('parses the owner read the service serves (handlers/digital.rs get_listing_digital_delivery)', () => {
    const wire = {
      listing_aggregate_id: `listing:${'s'.repeat(52)}_guide_01`,
      current: {
        kind: 'file',
        deliverable_id: 'a'.repeat(32),
        version: 2,
        created_at: '2026-09-25T10:00:00.000Z',
        content_type: 'application/pdf',
        size_bytes: 12_582_912,
        file_name: 'Field Guide.pdf',
      },
      last_version: 2,
      pinned_versions: [
        { version: 1, live_orders: 3 },
        { version: 2, live_orders: 1 },
      ],
    };
    const parsed = marketplaceSellerDigitalDeliverySchema.parse(toCamelCaseWire(wire));
    expect(parsed.lastVersion).toBe(2);
    expect(parsed.current?.fileName).toBe('Field Guide.pdf');
    expect(digitalDeliveryVersionLine(parsed)).toBe('Version 2 is live. 3 buyers still download version 1.');
    expect(digitalDeliveryCurrentSummary(parsed.current)).toBe(
      'Buyers download Field Guide.pdf (12 MB) after payment.',
    );
  });

  it('reads an unset delivery', () => {
    const parsed = marketplaceSellerDigitalDeliverySchema.parse(
      toCamelCaseWire({ listing_aggregate_id: 'listing:x_y', current: null, last_version: 0, pinned_versions: [] }),
    );
    expect(digitalDeliveryVersionLine(parsed)).toBeNull();
    expect(digitalDeliveryCurrentSummary(null)).toMatch(/^Not set yet/);
  });

  it('writes one version line per older pinned version', () => {
    const delivery = {
      listingAggregateId: 'listing:x_y',
      current: { kind: 'text' as const, deliverableId: 'f'.repeat(32), version: 3, createdAt: '' },
      lastVersion: 3,
      pinnedVersions: [
        { version: 1, liveOrders: 1 },
        { version: 2, liveOrders: 0 },
        { version: 3, liveOrders: 4 },
      ],
    };
    expect(digitalDeliveryVersionLine(delivery)).toBe('Version 3 is live. 1 buyer still downloads version 1.');
  });

  it('classifies setup refusals from the reason, then the code', () => {
    expect(classifyDigitalDeliverySetupRefusal({ code: 'INVALID_STATE', reason: 'digital_delivery_in_use' })).toBe(
      'in_use',
    );
    expect(classifyDigitalDeliverySetupRefusal({ code: 'INVALID_STATE', reason: 'deliverable_unverifiable' })).toBe(
      'unverifiable',
    );
    expect(
      classifyDigitalDeliverySetupRefusal({ code: 'UPSTREAM_UNAVAILABLE', reason: 'deliverable_unverifiable' }),
    ).toBe('upstream_unavailable');
    expect(classifyDigitalDeliverySetupRefusal({ code: 'INVALID_COMMAND', reason: 'deliverable_too_large' })).toBe(
      'too_large',
    );
    expect(classifyDigitalDeliverySetupRefusal({ code: 'INVALID_STATE', reason: 'digital_delivery_unavailable' })).toBe(
      'unavailable',
    );
    expect(classifyDigitalDeliverySetupRefusal({ code: 'UNAUTHORIZED' })).toBe('not_seller');
    expect(classifyDigitalDeliverySetupRefusal({ code: 'NOT_FOUND' })).toBe('not_found');
    expect(classifyDigitalDeliverySetupRefusal({ code: 'REVISION_CONFLICT' })).toBe('changed');
    expect(classifyDigitalDeliverySetupRefusal({ code: 'INVALID_STATE' })).toBe('not_published');
    expect(classifyDigitalDeliverySetupRefusal({ code: 'INTERNAL' })).toBeNull();
  });

  it('carries the design copy (C1, C2, C4)', () => {
    expect(DIGITAL_DELIVERY_SETUP_COPY.not_seller).toBe('Only the seller can set delivery.');
    expect(DIGITAL_DELIVERY_SETUP_COPY.unverifiable).toBe(
      "We couldn't read your file back from your homeserver. Upload it again.",
    );
    expect(DIGITAL_DELIVERY_SETUP_COPY.in_use).toBe(
      'Buyers are paying for or still downloading this. Pause the listing to stop new sales.',
    );
    expect(digitalFileTooLargeCopy(null)).toBe('Files can be up to 50 MB for now.');
    expect(digitalFileTooLargeCopy(52_428_800)).toBe('Files can be up to 50 MB for now.');
  });

  it('classifies only the fixed read refusals', () => {
    expect(classifyDigitalReadRefusal('not_paid')).toBe('not_paid');
    expect(classifyDigitalReadRefusal('payment_reversed')).toBe('payment_reversed');
    expect(classifyDigitalReadRefusal('payment_refunded')).toBe('payment_refunded');
    expect(classifyDigitalReadRefusal('something_else')).toBeNull();
    expect(classifyDigitalReadRefusal(7)).toBeNull();
  });
});

describe('digital checkout contract (§3 "Checkout", §6 B4, B5, F1–F3)', () => {
  it('accepts what DeliveryEmail::is_well_formed accepts', () => {
    expect(isWellFormedDeliveryEmail('buyer@example.com')).toBe(true);
    expect(isWellFormedDeliveryEmail('a@b')).toBe(true);
    expect(isWellFormedDeliveryEmail(`${'a'.repeat(DELIVERY_EMAIL_MAX_CHARS - 2)}@b`)).toBe(true);
  });

  it('refuses what DeliveryEmail::is_well_formed refuses', () => {
    for (const value of [
      '',
      'buyer',
      '@example.com',
      'buyer@',
      'a@b@c',
      'buyer @example.com',
      'buyer@example.com\n',
      'buyer\u0007@example.com',
      `${'a'.repeat(DELIVERY_EMAIL_MAX_CHARS - 1)}@b`,
    ]) {
      expect(isWellFormedDeliveryEmail(value), value).toBe(false);
    }
  });

  it('classifies checkout refusals from the reason only', () => {
    expect(classifyDigitalCheckoutRefusal({ code: 'INVALID_STATE', reason: 'digital_delivery_not_ready' })).toBe(
      'not_ready',
    );
    expect(classifyDigitalCheckoutRefusal({ code: 'INVALID_STATE', reason: 'digital_delivery_unavailable' })).toBe(
      'unavailable',
    );
    expect(classifyDigitalCheckoutRefusal({ code: 'INVALID_COMMAND', reason: 'delivery_email_required' })).toBe(
      'email_required',
    );
    expect(classifyDigitalCheckoutRefusal({ code: 'INVALID_COMMAND', reason: 'invalid_delivery_email' })).toBe(
      'invalid_email',
    );
    expect(classifyDigitalCheckoutRefusal({ code: 'INVALID_COMMAND', reason: 'delivery_email_not_needed' })).toBe(
      'email_not_needed',
    );
    expect(classifyDigitalCheckoutRefusal({ code: 'INVALID_STATE', reason: 'fulfillment_not_published' })).toBe(
      'fulfillment_not_published',
    );
    expect(classifyDigitalCheckoutRefusal({ code: 'INVALID_STATE', reason: 'pickup_unavailable' })).toBeNull();
    expect(classifyDigitalCheckoutRefusal({ code: 'INVALID_STATE' })).toBeNull();
  });

  it('carries the design copy (B4, B5, F1, F3)', () => {
    expect(DIGITAL_CHECKOUT_REFUSAL_COPY.not_ready).toBe(
      "The seller hasn't finished setting up delivery for this item.",
    );
    expect(DIGITAL_CHECKOUT_REFUSAL_COPY.unavailable).toBe("Digital delivery isn't available on this deployment.");
    expect(DIGITAL_CHECKOUT_REFUSAL_COPY.email_required).toBe(
      'Enter the email the seller should send your purchase to.',
    );
    expect(DIGITAL_CHECKOUT_REFUSAL_COPY.invalid_email).toBe('Check the email address.');
  });
});

describe('digital checkout lines (§3 "Checkout")', () => {
  it('says how each kind arrives, and when a line cannot be bought yet', () => {
    expect(digitalCheckoutLineLabel('file')).toBe('Digital delivery · Instant download');
    expect(digitalCheckoutLineLabel('link')).toBe('Digital delivery · Instant access');
    expect(digitalCheckoutLineLabel('text')).toBe('Digital delivery · Instant access');
    expect(digitalCheckoutLineLabel('email')).toBe('Digital delivery · Emailed by the seller after payment');
    expect(digitalCheckoutLineLabel('message')).toBe('Digital delivery · Sent by the seller in messages after payment');
    expect(digitalCheckoutLineLabel(null)).toBe("The seller hasn't finished setting up delivery for this item.");
    expect(digitalCheckoutLineLabel(undefined)).toBe('Digital delivery');
  });

  it('carries the design copy for the email field and consent lines', () => {
    expect(DIGITAL_CHECKOUT_COPY.emailHeading).toBe('Email for delivery');
    expect(DIGITAL_CHECKOUT_COPY.emailDisclosure).toBe(
      "The seller of this item sees this after your payment is confirmed, to send your order. It isn't used for anything else.",
    );
    expect(DIGITAL_CHECKOUT_COPY.consentInstant).toBe(
      "Delivery starts as soon as payment is confirmed. Digital orders can't be cancelled once delivered; message the seller about a refund.",
    );
    expect(DIGITAL_CHECKOUT_COPY.consentManual).toBe('You can ask to cancel until the seller marks it delivered.');
  });
});

describe('buyer order reads (§4.2, §4.3, §6 D5, F5, F11, F12)', () => {
  const seller = 'y'.repeat(52);
  const file = {
    lineIndex: 0,
    listingAggregateId: `listing:${seller}_guide`,
    kind: 'file',
    sellerPubky: seller,
    deliverableId: 'a'.repeat(32),
    version: 2,
    key: 'c'.repeat(64),
    iv: 'd'.repeat(24),
    ciphertextBlake3: 'e'.repeat(64),
    plaintextBlake3: 'f'.repeat(64),
    contentType: 'application/pdf',
    fileName: 'Field Guide.pdf',
    sizeBytes: 12_582_912,
  };
  const read = (lines: unknown[]) =>
    marketplaceOrderDigitalDeliverySchema.safeParse({ orderId: '018f47d2-6a27-7c23-a62f-000000000901', lines });

  it('parses the payload handlers/digital_orders.rs serves for each instant kind', () => {
    const parsed = read([
      file,
      { ...file, lineIndex: 1, kind: 'link', url: 'https://example.com/course' },
      { ...file, lineIndex: 2, kind: 'text', text: 'Licence ABC-123' },
    ]);
    expect(parsed.success).toBe(true);
    expect(parsed.data?.lines.map((line) => line.kind)).toEqual(['file', 'link', 'text']);
    expect(parsed.data?.lines[1]).not.toHaveProperty('key');
  });

  it('refuses file facts that could not open the pinned file, or reach another path', () => {
    for (const bad of [
      { ...file, key: 'c'.repeat(63) },
      { ...file, iv: 'D'.repeat(24) },
      { ...file, deliverableId: '../other' },
      { ...file, sellerPubky: 'not-a-pubky' },
      { ...file, version: 0 },
      { ...file, fileName: '../Field Guide.pdf' },
    ]) {
      expect(read([bad]).success).toBe(false);
    }
    expect(read([{ ...file, kind: 'link', url: 'http://example.com' }]).success).toBe(false);
  });

  it('takes the file type only in the form the service accepts at set time', () => {
    expect(read([{ ...file, contentType: 'Application/PDF' }]).success).toBe(true);
    expect(read([{ ...file, contentType: 'application/vnd.ms-excel' }]).success).toBe(true);
    for (const contentType of [
      'text/html; charset=utf-8',
      'text/html\u0000',
      'application/pdf/x',
      'pdf',
      'text/ html',
      `application/${'x'.repeat(116)}`,
    ]) {
      expect(read([{ ...file, contentType }]).success, contentType).toBe(false);
    }
  });

  it('parses the delivery email read', () => {
    expect(
      marketplaceOrderDeliveryEmailSchema.parse({
        orderId: '018f47d2-6a27-7c23-a62f-000000000901',
        deliveryEmail: 'buyer@example.com',
        emailedAt: '2026-09-26T08:00:00.000Z',
      }).emailedAt,
    ).toBe('2026-09-26T08:00:00.000Z');
  });

  it('classifies delivery email change refusals and carries the design copy (F11, F12)', () => {
    expect(classifyDeliveryEmailChangeRefusal({ code: 'INVALID_STATE', reason: 'already_emailed' })).toBe(
      'already_emailed',
    );
    expect(classifyDeliveryEmailChangeRefusal({ code: 'INVALID_COMMAND', reason: 'invalid_delivery_email' })).toBe(
      'invalid_email',
    );
    expect(classifyDeliveryEmailChangeRefusal({ code: 'UNAUTHORIZED' })).toBe('not_buyer');
    expect(classifyDeliveryEmailChangeRefusal({ code: 'REVISION_CONFLICT' })).toBe('changed');
    expect(classifyDeliveryEmailChangeRefusal({ code: 'INVALID_STATE' })).toBe('closed');
    expect(classifyDeliveryEmailChangeRefusal({ code: 'INTERNAL' })).toBeNull();
    expect(DELIVERY_EMAIL_CHANGE_COPY.saved).toBe('Saved. The seller will use this address.');
    expect(DELIVERY_EMAIL_CHANGE_COPY.already_emailed).toBe(
      "The seller already emailed your purchase. Message them if it didn't arrive.",
    );
    expect(Object.keys(DIGITAL_FILE_OPEN_FAILURE_COPY).sort()).toEqual([
      'ciphertext_mismatch',
      'decrypt_failed',
      'fetch_failed',
      'plaintext_mismatch',
    ]);
  });
});

describe('buyer order panel copy (§3 "After payment", §6 D1, E4, F9)', () => {
  it('ends access on the states the service ends it on, and not on completed (D10)', () => {
    for (const state of ['cancelled', 'refunded_external', 'refunded_partial', 'closed']) {
      expect(isDigitalOrderEnded(state), state).toBe(true);
    }
    for (const state of ['paid', 'delivered', 'completed', 'cancel_requested']) {
      expect(isDigitalOrderEnded(state), state).toBe(false);
    }
  });

  it('writes the email line before and after the seller marks it emailed', () => {
    expect(digitalOrderEmailLine('buyer@example.com', null)).toBe('The seller will email this to buyer@example.com');
    expect(digitalOrderEmailLine('buyer@example.com', '2026-09-26T12:00:00.000Z')).toBe(
      'Emailed to buyer@example.com on Sep 26, 2026. Check your spam folder, or message the seller.',
    );
  });

  it('carries the design copy', () => {
    expect(DIGITAL_ORDER_COPY.readyToDownload).toBe('Delivered · ready to download');
    expect(DIGITAL_ORDER_COPY.noReturn).toBe("Digital purchases can't be returned. Message the seller about a refund.");
    expect(DIGITAL_ORDER_COPY.emailMissing).toBe('Enter your email so the seller can deliver.');
  });
});

describe('bindOrderDigitalLine (review P2: the released line is the opened line of this order)', () => {
  const seller = 'y'.repeat(52);
  const orderId = '018f47d2-6a27-7c23-a62f-000000000901';
  const order = {
    id: orderId,
    sellerPubky: seller,
    lines: [
      { listingAggregateId: `listing:${seller}_guide`, digitalKind: 'file' as const },
      { listingAggregateId: `listing:${seller}_licence`, digitalKind: 'text' as const },
    ],
  };
  const text = {
    lineIndex: 1,
    listingAggregateId: `listing:${seller}_licence`,
    kind: 'text' as const,
    sellerPubky: seller,
    deliverableId: 'a'.repeat(32),
    version: 1,
    text: 'Licence ABC-123',
  };

  it('returns the line when order, index, listing, seller and kind all match', () => {
    expect(bindOrderDigitalLine(order, 1, { orderId, lines: [text] })).toBe(text);
  });

  it.each([
    ['order id', { orderId: '018f47d2-6a27-7c23-a62f-00000000ffff', lines: [text] }],
    ['line count', { orderId, lines: [text, { ...text, lineIndex: 0 }] }],
    ['line index', { orderId, lines: [{ ...text, lineIndex: 0 }] }],
    ['listing', { orderId, lines: [{ ...text, listingAggregateId: `listing:${seller}_other` }] }],
    ['seller', { orderId, lines: [{ ...text, sellerPubky: 'b'.repeat(52) }] }],
    ['kind', { orderId, lines: [{ ...text, kind: 'link' as const, url: 'https://example.com' }] }],
  ])('refuses a release whose %s does not match', (_field, release) => {
    expect(bindOrderDigitalLine(order, 1, release)).toBeNull();
  });

  it('refuses an index the order does not have', () => {
    expect(bindOrderDigitalLine(order, 5, { orderId, lines: [{ ...text, lineIndex: 5 }] })).toBeNull();
  });
});

describe('seller delivery actions (§3 "Seller\u2019s orders", §4.3, §6 E8, E9, F6–F15)', () => {
  it('classifies deliver_digital refusals from the reason, then the code and order state', () => {
    const paid = { orderState: 'paid', channel: 'email' } as const;
    expect(classifyDigitalDeliverRefusal({ code: 'INVALID_STATE', reason: 'wrong_delivery_channel' }, paid)).toBe(
      'wrong_channel',
    );
    expect(classifyDigitalDeliverRefusal({ code: 'INVALID_STATE', reason: 'email_missing' }, paid)).toBe(
      'email_missing',
    );
    expect(classifyDigitalDeliverRefusal({ code: 'INVALID_STATE', reason: 'already_emailed' }, paid)).toBe(
      'already_marked',
    );
    expect(classifyDigitalDeliverRefusal({ code: 'UNAUTHORIZED' }, paid)).toBe('not_seller');
    expect(classifyDigitalDeliverRefusal({ code: 'REVISION_CONFLICT' }, paid)).toBe('changed');
    expect(
      classifyDigitalDeliverRefusal({ code: 'INVALID_STATE' }, { orderState: 'cancel_requested', channel: 'email' }),
    ).toBe('cancel_requested');
    expect(classifyDigitalDeliverRefusal({ code: 'INVALID_STATE' }, { orderState: 'paid', channel: 'message' })).toBe(
      'already_marked',
    );
    expect(
      classifyDigitalDeliverRefusal({ code: 'INVALID_STATE' }, { orderState: 'delivered', channel: 'email' }),
    ).toBe('not_awaiting');
    expect(classifyDigitalDeliverRefusal({ code: 'INTERNAL' }, paid)).toBeNull();
  });

  it('carries the design copy (§4.3, E8, E9, F7, F9, F14, F15)', () => {
    expect(DIGITAL_SELLER_COPY.emailDisclosure).toBe(
      'Use this address only to deliver this order. Keep your sent email as your record: Shop deletes this address 30 days after the order ends, and PayPal disputes can come later.',
    );
    expect(DIGITAL_SELLER_COPY.openedStaySold).toBe('Opened files stay counted as sold.');
    expect(DIGITAL_SELLER_COPY.refundNote).toBe(
      "Refund recorded. The buyer can no longer download. An email already sent can't be recalled.",
    );
    expect(DIGITAL_DELIVER_REFUSAL_COPY.not_seller).toBe('Only the seller can mark this delivered.');
    expect(DIGITAL_DELIVER_REFUSAL_COPY.cancel_requested).toBe(
      'This order has a cancellation request. Approve or decline it first.',
    );
    expect(DIGITAL_DELIVER_REFUSAL_COPY.changed).toBe('This order changed. Refresh to see the latest.');
    expect(sellerDeliveryEmailReadCopy('not_paid')).toBe("The buyer's email appears once payment is confirmed.");
    expect(sellerDeliveryEmailReadCopy('email_missing')).toBe("Waiting for the buyer's email.");
    expect(sellerDeliveryEmailReadCopy('payment_reversed')).toBe(
      "The payment was reversed, so the buyer's email is no longer available.",
    );
    expect(sellerDeliveryEmailReadCopy('payment_refunded')).toBe(
      "PayPal refunded this payment, so the buyer's email is no longer available.",
    );
    expect(sellerDeliveryEmailReadCopy('delivery_ended')).toBe('This order was cancelled or refunded.');
  });

  it('lists the manual channels an order needs', () => {
    expect(digitalOrderManualChannels([{ digitalKind: 'file' }, { digitalKind: 'message' }])).toEqual(['message']);
    expect(digitalOrderManualChannels([{ digitalKind: 'email' }, { digitalKind: 'message' }])).toEqual([
      'email',
      'message',
    ]);
    expect(digitalOrderManualChannels([{}])).toEqual([]);
  });
});

describe('seller delivery evidence (§3 "Seller\u2019s orders")', () => {
  const none = {
    orderId: '018f47d2-6a27-7c23-a62f-000000000901',
    deliveredAt: null,
    firstOpenedAt: null,
    openCount: 0,
    emailedAt: null,
    messageDeliveredAt: null,
  };

  it('parses the service read', () => {
    expect(
      marketplaceOrderDigitalEvidenceSchema.parse({ ...none, firstOpenedAt: '2026-09-26T13:02:00.000Z', openCount: 3 })
        .openCount,
    ).toBe(3);
    expect(marketplaceOrderDigitalEvidenceSchema.safeParse({ ...none, openCount: -1 }).success).toBe(false);
  });

  it('writes the instant line, then each manual mark', () => {
    const at = '2026-09-26T13:02:00.000Z';
    expect(digitalEvidenceLines(none, [{ digitalKind: 'file' }])).toEqual(['Delivered automatically · not opened yet']);
    expect(digitalEvidenceLines({ ...none, firstOpenedAt: at, openCount: 1 }, [{ digitalKind: 'text' }])).toEqual([
      expect.stringMatching(/^Delivered automatically · first opened Sep 26, \d\d:\d\d · opened 1 time$/),
    ]);
    expect(
      digitalEvidenceLines({ ...none, emailedAt: at, messageDeliveredAt: at }, [
        { digitalKind: 'email' },
        { digitalKind: 'message' },
      ]),
    ).toEqual([
      expect.stringMatching(/^Marked emailed Sep 26, \d\d:\d\d$/),
      expect.stringMatching(/^Marked delivered Sep 26, \d\d:\d\d$/),
    ]);
    expect(digitalEvidenceLines(none, [{ digitalKind: 'email' }])).toEqual([]);
  });
});

describe('digitalPaymentTakenBack (DD3, mirrors the service)', () => {
  const refund = { amountMinor: 4_000, transactionId: 'a'.repeat(17), recordedAt: '2026-09-27T10:00:00.000Z' };

  it('flags an outstanding reversal in any state', () => {
    for (const state of ['paid', 'delivered', 'completed', 'refunded_external']) {
      expect(digitalPaymentTakenBack({ state, paymentReversedAt: '2026-09-27T10:00:00.000Z' }), state).toBe(
        'payment_reversed',
      );
    }
  });

  it('flags a PayPal refund only while the order has not ended', () => {
    expect(digitalPaymentTakenBack({ state: 'delivered', externalRefund: refund })).toBe('payment_refunded');
    expect(digitalPaymentTakenBack({ state: 'refunded_external', externalRefund: refund })).toBeNull();
  });

  it('flags nothing on an untouched order or after a canceled reversal', () => {
    expect(digitalPaymentTakenBack({ state: 'delivered' })).toBeNull();
    expect(digitalPaymentTakenBack({ state: 'delivered', paymentReversedAt: null, externalRefund: null })).toBeNull();
  });
});
