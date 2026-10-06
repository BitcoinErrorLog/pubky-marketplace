import { describe, expect, it } from 'vitest';
import { CHECKOUT_HOLD_COPY } from '@/libs/commerce/checkout-hold';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode, ServerErrorCode, ValidationErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import {
  isReaderWalletSetupNeeded,
  MARKETPLACE_FAILURE_MESSAGES,
  marketplaceBootstrapFailureMessage,
  marketplaceCheckoutRefusalMessage,
  marketplaceDropRefusalMessage,
  marketplaceFailureMessage,
  marketplaceOfferCheckoutFailureMessage,
  marketplaceOfferFailureMessage,
  marketplacePaymentMethodFailureMessage,
  marketplacePaymentMethodReasonMessage,
} from './failure-messages';

describe('marketplaceFailureMessage', () => {
  it('keeps action-specific fallbacks for ordinary refusal codes', () => {
    for (const code of ['BAD_REQUEST', 'CONFLICT', 'FORBIDDEN', 'INVALID_COMMAND', 'INVALID_STATE', 'NOT_FOUND']) {
      const result = marketplaceFailureMessage(code, 'SPECIFIC');
      expect(result).toBe('SPECIFIC');
    }
  });

  it('maps grant BFF session-missing codes to connect copy, not expiry copy', () => {
    expect(marketplaceFailureMessage('shop_session_missing', MARKETPLACE_FAILURE_MESSAGES.sessionStart)).toBe(
      MARKETPLACE_FAILURE_MESSAGES.sessionMissing,
    );
    expect(marketplaceFailureMessage('shop_session_expired', MARKETPLACE_FAILURE_MESSAGES.sessionStart)).toBe(
      MARKETPLACE_FAILURE_MESSAGES.sessionCookieExpired,
    );
    expect(MARKETPLACE_FAILURE_MESSAGES.sessionCookieExpired).not.toBe(MARKETPLACE_FAILURE_MESSAGES.sessionMissing);
    expect(MARKETPLACE_FAILURE_MESSAGES.sessionCookieExpired).not.toBe(MARKETPLACE_FAILURE_MESSAGES.sessionTimeout);
    expect(marketplaceFailureMessage('flow_expired', MARKETPLACE_FAILURE_MESSAGES.sessionStart)).toBe(
      MARKETPLACE_FAILURE_MESSAGES.sessionTimeout,
    );
  });

  it('does not expose prototype properties as messages', () => {
    for (const code of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(marketplaceFailureMessage(code, 'F')).toBe('F');
      expect(typeof marketplaceFailureMessage(code, 'F')).toBe('string');
    }
  });

  it('preserves client-authored validation errors but not wire messages', () => {
    const validationError = new AppError({
      category: ErrorCategory.Validation,
      code: ValidationErrorCode.INVALID_INPUT,
      message: 'A checkout group chooses a fulfillment its listing does not publish.',
      service: ErrorService.Marketplace,
      operation: 'checkout',
    });
    expect(marketplaceFailureMessage('INVALID_INPUT', 'Checkout failed.', validationError)).toBe(
      validationError.message,
    );
    expect(
      marketplaceFailureMessage('INVALID_INPUT', 'Checkout failed.', {
        code: 'INVALID_INPUT',
        message: validationError.message,
      }),
    ).toBe('Checkout failed.');

    const serverError = new AppError({
      category: ErrorCategory.Server,
      code: ServerErrorCode.INTERNAL_ERROR,
      message: 'SENTINEL_SERVER_TEXT_failure_messages',
      service: ErrorService.Marketplace,
      operation: 'checkout',
    });
    const clientError = new AppError({
      category: ErrorCategory.Client,
      code: ClientErrorCode.CONFLICT,
      message: 'SENTINEL_CLIENT_TEXT_failure_messages',
      service: ErrorService.Marketplace,
      operation: 'checkout',
    });
    expect(marketplaceFailureMessage('INTERNAL_ERROR', 'Checkout failed.', serverError)).toBe('Checkout failed.');
    expect(marketplaceFailureMessage('CONFLICT', 'Checkout failed.', clientError)).toBe('Checkout failed.');
    expect(marketplaceFailureMessage('INVALID_INPUT', 'Checkout failed.', validationError)).toBe(
      validationError.message,
    );
  });
});

describe('marketplaceCheckoutRefusalMessage', () => {
  const mappedRefusals = [
    [
      'INVALID_COMMAND',
      'Checkout aggregate identity or revision is invalid.',
      'Checkout could not be started. Review your cart and try again.',
    ],
    ['NOT_FOUND', 'A checkout listing is unavailable.', 'A listing in your cart is no longer available.'],
    ['UNAUTHORIZED', 'A buyer cannot purchase their own listing.', 'You cannot purchase your own listing.'],
    [
      'INVALID_STATE',
      'Only fixed-price listings can enter checkout.',
      'Only fixed-price listings can be purchased through checkout.',
    ],
    [
      'INVALID_STATE',
      "Another buyer's payment is holding this item. If it isn't completed in time, the item restocks.",
      'Another buyer is currently paying for this item. If payment does not complete, it will become available again.',
    ],
    ['INVALID_STATE', 'This listing has sold out.', MARKETPLACE_FAILURE_MESSAGES.listingSoldOut],
    ['INSUFFICIENT_INVENTORY', 'Checkout quantity is unavailable.', MARKETPLACE_FAILURE_MESSAGES.listingSoldOut],
    [
      'INVALID_STATE',
      'Only available fixed-price listings can enter checkout.',
      'This listing is not available for checkout.',
    ],
  ] as const;

  it.each(mappedRefusals)('maps %s refusal %s to static copy', (code, message, expected) => {
    expect(marketplaceCheckoutRefusalMessage(code, message)).toBe(expected);
  });

  it('returns null for unmapped and non-string inputs', () => {
    expect(marketplaceCheckoutRefusalMessage('INVALID_STATE', 'Unknown refusal')).toBeNull();
    expect(marketplaceCheckoutRefusalMessage(null, 'This listing has sold out.')).toBeNull();
    expect(marketplaceCheckoutRefusalMessage('INVALID_STATE', null)).toBeNull();
    expect(marketplaceCheckoutRefusalMessage(undefined, 42)).toBeNull();
  });

  it('does not use the session copy for an own-listing refusal', () => {
    expect(marketplaceCheckoutRefusalMessage('UNAUTHORIZED', 'A buyer cannot purchase their own listing.')).not.toBe(
      MARKETPLACE_FAILURE_MESSAGES.session,
    );
  });
});

describe('marketplacePaymentMethodFailureMessage', () => {
  it('maps a capability_required family from the service code', () => {
    const error = new AppError({
      category: ErrorCategory.Client,
      code: ClientErrorCode.BAD_REQUEST,
      message: 'SENTINEL_PAYMENT_METHOD_WIRE',
      service: ErrorService.Marketplace,
      operation: 'bindPaymentMethod',
      context: { statusCode: 403, serviceCode: 'capability_required' },
    });
    expect(marketplacePaymentMethodFailureMessage(error, 'The payment action could not be completed.')).toBe(
      'This payment needs a marketplace grant. Approve access on your signer and try again.',
    );
    expect(marketplacePaymentMethodFailureMessage(error, 'fallback')).not.toContain('SENTINEL');
  });

  it('maps a CAS 409 revision conflict from the wire code', () => {
    const error = new AppError({
      category: ErrorCategory.Client,
      code: ClientErrorCode.CONFLICT,
      message: 'SENTINEL_PAYMENT_METHOD_WIRE',
      service: ErrorService.Marketplace,
      operation: 'bindPaymentMethod',
      context: { statusCode: 409, serviceCode: 'REVISION_CONFLICT' },
    });
    expect(marketplacePaymentMethodFailureMessage(error, 'fallback')).toBe(MARKETPLACE_FAILURE_MESSAGES.paymentChanged);
  });

  it('maps a missing payment method without copying the wire message', () => {
    const error = new AppError({
      category: ErrorCategory.Client,
      code: ClientErrorCode.BAD_REQUEST,
      message: 'SENTINEL_PAYMENT_METHOD_WIRE',
      service: ErrorService.Marketplace,
      operation: 'bindPaymentMethod',
      context: { statusCode: 409, reason: 'method_unavailable' },
    });
    expect(marketplacePaymentMethodFailureMessage(error, 'fallback')).toBe(
      'The seller has not configured this payment method.',
    );
  });

  it('maps seller-not-configured and service-unavailable families', () => {
    const seller = new AppError({
      category: ErrorCategory.Client,
      code: ClientErrorCode.BAD_REQUEST,
      message: 'SENTINEL',
      service: ErrorService.Marketplace,
      operation: 'bindPaymentMethod',
      context: { statusCode: 409, reason: 'stripe_key_missing' },
    });
    const unavailable = new AppError({
      category: ErrorCategory.Client,
      code: ClientErrorCode.BAD_REQUEST,
      message: 'SENTINEL',
      service: ErrorService.Marketplace,
      operation: 'bindPaymentMethod',
      context: { statusCode: 503, reason: 'paykit_unavailable' },
    });
    expect(marketplacePaymentMethodFailureMessage(seller, 'fallback')).toBe(
      'This seller has not finished payment setup.',
    );
    expect(marketplacePaymentMethodFailureMessage(unavailable, 'fallback')).toBe(
      'The Paykit server is unavailable. Try again shortly.',
    );
  });

  it('tells a buyer without a Paykit wallet to connect Bitkit, never that Paykit is down', () => {
    const error = new AppError({
      category: ErrorCategory.Client,
      code: ClientErrorCode.CONFLICT,
      message: 'SENTINEL',
      service: ErrorService.Marketplace,
      operation: 'bindPaymentMethod',
      context: { statusCode: 409, reason: 'buyer_paykit_wallet_required' },
    });
    expect(marketplacePaymentMethodFailureMessage(error, 'fallback')).toBe(
      'Connect Bitkit to pay with Bitcoin: this account has no Paykit wallet that can receive a payment request.',
    );
  });

  it('names the reader wallet setup refusal (service#84), never a Paykit outage', () => {
    const error = new AppError({
      category: ErrorCategory.Client,
      code: ClientErrorCode.BAD_REQUEST,
      message: 'SENTINEL',
      service: ErrorService.Marketplace,
      operation: 'bindPaymentMethod',
      context: { statusCode: 409, reason: 'buyer_paykit_wallet_setup_needed', serviceCode: 'INVALID_STATE' },
    });
    expect(marketplacePaymentMethodFailureMessage(error, 'fallback')).toBe(
      'Reader wallet setup needed. Finish setting up Bitkit (or another Paykit wallet) for this pubky, then try again.',
    );
    expect(isReaderWalletSetupNeeded(error)).toBe(true);
    const required = new AppError({
      category: ErrorCategory.Client,
      code: ClientErrorCode.CONFLICT,
      message: 'SENTINEL',
      service: ErrorService.Marketplace,
      operation: 'bindPaymentMethod',
      context: { statusCode: 409, reason: 'buyer_paykit_wallet_required' },
    });
    expect(isReaderWalletSetupNeeded(required)).toBe(false);
    expect(isReaderWalletSetupNeeded(new Error('buyer_paykit_wallet_setup_needed'))).toBe(false);
  });

  it('keeps the action fallback when no payment-method reason is present', () => {
    const error = new AppError({
      category: ErrorCategory.Client,
      code: ClientErrorCode.CONFLICT,
      message: 'SENTINEL_ORDER_PAYMENT_ACTION',
      service: ErrorService.Marketplace,
      operation: 'bindPaymentMethod',
    });
    expect(marketplacePaymentMethodFailureMessage(error, 'The payment action could not be completed.')).toBe(
      'The payment action could not be completed.',
    );
  });

  it('maps known reasons and ignores prototype keys', () => {
    expect(marketplacePaymentMethodReasonMessage('method_unavailable')).toBe(
      'The seller has not configured this payment method.',
    );
    expect(marketplacePaymentMethodReasonMessage('constructor')).toBe('The payment method request was refused.');
    expect(marketplacePaymentMethodReasonMessage(undefined)).toBe('The payment method request was refused.');
  });

  it('maps a bind hold-loser from the service 409 wire shape to listingReserved', () => {
    const wire = {
      ok: false,
      error: {
        code: 'INVALID_STATE',
        message: 'SENTINEL_HOLDING_COPY Another buyer is currently paying for this item.',
        reason: 'held',
      },
    };
    const error = new AppError({
      category: ErrorCategory.Client,
      code: ClientErrorCode.BAD_REQUEST,
      message: marketplacePaymentMethodReasonMessage(wire.error.reason),
      service: ErrorService.Marketplace,
      operation: 'bindPaymentMethod',
      context: { statusCode: 409, reason: wire.error.reason, serviceCode: wire.error.code },
    });
    expect(marketplacePaymentMethodFailureMessage(error, MARKETPLACE_FAILURE_MESSAGES.checkout)).toBe(
      CHECKOUT_HOLD_COPY.listingReserved,
    );
    expect(marketplacePaymentMethodFailureMessage(error, MARKETPLACE_FAILURE_MESSAGES.checkout)).not.toBe(
      MARKETPLACE_FAILURE_MESSAGES.checkout,
    );
    expect(error.message).not.toContain('SENTINEL');
    expect(error.message).toBe(CHECKOUT_HOLD_COPY.listingReserved);
  });
});

describe('marketplaceOfferCheckoutFailureMessage', () => {
  it.each([
    ['AWARD_EXPIRED', MARKETPLACE_FAILURE_MESSAGES.offerExpired],
    ['AWARD_ALREADY_CONVERTED', MARKETPLACE_FAILURE_MESSAGES.offerAlreadyConverted],
    ['REVISION_CONFLICT', MARKETPLACE_FAILURE_MESSAGES.offerAlreadyConverted],
    ['AWARD_QUANTITY_MISMATCH', 'The checkout quantity does not match the accepted offer.'],
    ['AWARD_VARIANT_MISMATCH', 'The checkout variant does not match the accepted offer.'],
    ['AWARD_LISTING_CHANGED', 'The listing snapshot does not match the offer terms.'],
    ['AWARD_HOLD_MISSING', 'The inventory reserved for this accepted offer is no longer held.'],
    ['INVALID_STATE', 'Only an accepted offer can enter offer checkout.'],
  ] as const)('maps %s to static copy', (code, expected) => {
    expect(marketplaceOfferCheckoutFailureMessage(code)).toBe(expected);
  });

  it('uses the static checkout fallback for unknown codes', () => {
    expect(marketplaceOfferCheckoutFailureMessage('UNEXPECTED')).toBe(MARKETPLACE_FAILURE_MESSAGES.checkout);
  });
});

describe('marketplaceOfferFailureMessage', () => {
  it('never emits drop sold-out copy for a listing inventory refusal', () => {
    expect(marketplaceOfferFailureMessage('INSUFFICIENT_INVENTORY')).toBe(MARKETPLACE_FAILURE_MESSAGES.listingSoldOut);
    expect(marketplaceOfferFailureMessage('INSUFFICIENT_INVENTORY')).not.toBe(MARKETPLACE_FAILURE_MESSAGES.soldOut);
    expect(marketplaceFailureMessage('INSUFFICIENT_INVENTORY', MARKETPLACE_FAILURE_MESSAGES.sendOffer)).not.toBe(
      MARKETPLACE_FAILURE_MESSAGES.soldOut,
    );
    expect(marketplaceDropRefusalMessage('INSUFFICIENT_INVENTORY', 'The drop is sold out.')).toBe(
      MARKETPLACE_FAILURE_MESSAGES.soldOut,
    );
  });

  it('maps a held-listing offer refusal to hold copy, not drop copy', () => {
    expect(
      marketplaceOfferFailureMessage(
        'INVALID_STATE',
        "Another buyer's payment is holding this item. If it isn't completed in time, the item restocks.",
      ),
    ).toBe(CHECKOUT_HOLD_COPY.heldWhileAnotherPays);
    expect(marketplaceOfferFailureMessage('INVALID_STATE', 'sentinel-drop-copy')).toBe(
      MARKETPLACE_FAILURE_MESSAGES.sendOffer,
    );
  });

  it('names the pickup-only refusal instead of the generic send-offer fallback', () => {
    // Refusal logged by production marketplace-service on 2026-09-25 (issue #57).
    const refused = marketplaceOfferFailureMessage('INVALID_STATE', 'Offers are available only on listings that ship.');
    expect(refused).toBe(MARKETPLACE_FAILURE_MESSAGES.offerShippingOnly);
    expect(refused).not.toBe(MARKETPLACE_FAILURE_MESSAGES.sendOffer);
    expect(marketplaceOfferFailureMessage('INVALID_COMMAND', 'Offers are available only on listings that ship.')).toBe(
      MARKETPLACE_FAILURE_MESSAGES.sendOffer,
    );
  });
});

describe('Bitkit purchase bootstrap reason codes', () => {
  it.each([
    ['origin_denied', 'This request did not come from the Shop. Reload and try again.'],
    ['invalid_request', 'Something went wrong. Try again.'],
    ['grant_unavailable', 'Bitkit approvals are unavailable right now. Try again later.'],
    ['retry_later', 'Too many attempts. Wait a minute and try again.'],
    ['challenge_not_found', 'This approval expired. Start again.'],
    ['challenge_consumed', 'This approval was already used. Start again.'],
    ['homeserver_proof_invalid', 'Your homeserver could not confirm this sign-in. Start again.'],
    ['flow_expired', 'This approval expired. Start again.'],
    ['flow_cancelled', 'Approval cancelled.'],
    ['result_denied', 'This approval could not be completed. Start again.'],
    [
      'identity_mismatch',
      "This approval came from a different account. Approve with the account you're signed in with.",
    ],
    ['fresh_approval_required', 'Approve again in Bitkit.'],
    ['flow_binding_missing', 'This approval belongs to another tab. Start again here.'],
    ['flow_binding_denied', 'This approval belongs to another tab. Start again here.'],
    ['flow_not_found', 'This approval expired. Start again.'],
    ['claim_in_progress', 'Finishing your approval…'],
    ['shop_session_expired', 'Your Shop session ended. Sign in again.'],
    ['approval_invalid', 'That approval could not be verified. Approve again in Bitkit.'],
  ])('bootstrap reason code %s maps to copy', (code, copy) => {
    expect(marketplaceBootstrapFailureMessage(code)).toBe(copy);
  });

  it('keeps the reconnect copy for shop_session_expired outside the bootstrap', () => {
    expect(marketplaceFailureMessage('shop_session_expired', MARKETPLACE_FAILURE_MESSAGES.sessionStart)).toBe(
      MARKETPLACE_FAILURE_MESSAGES.sessionCookieExpired,
    );
  });

  it.each([
    ['grant_unavailable', 'Pubky Passport approvals are unavailable right now. Try again later.'],
    ['fresh_approval_required', 'Approve again in Pubky Passport.'],
    ['approval_invalid', 'That approval could not be verified. Approve again in Pubky Passport.'],
    ['flow_cancelled', 'Approval cancelled.'],
  ])('a Pubky Passport bootstrap names Passport for %s', (code, copy) => {
    expect(marketplaceBootstrapFailureMessage(code, 'Pubky Passport')).toBe(copy);
  });

  it('an unknown bootstrap code falls back to static copy, never the code', () => {
    expect(marketplaceBootstrapFailureMessage('something_new')).toBe(MARKETPLACE_FAILURE_MESSAGES.sessionStart);
  });
});
