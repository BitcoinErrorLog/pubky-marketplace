import { CHECKOUT_HOLD_COPY } from '@/libs/commerce/checkout-hold';
import { isAppError } from '@/libs/error/error';
import { ValidationErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory } from '@/libs/error/error.types';

/** Client-owned copy for marketplace command and service failures. */
export const MARKETPLACE_FAILURE_MESSAGES = {
  offer: 'Could not update this offer.',
  offerChanged: 'This offer changed since you loaded it. The latest state was reloaded — retry from there.',
  offerCheckoutUnavailable: 'Checkout for this offer is unavailable.',
  offerExpired: 'This accepted offer expired before checkout. Nothing was reserved.',
  offerAlreadyConverted: 'This accepted offer has already been converted.',
  sendOffer: 'Could not send this offer.',
  offerShippingOnly: 'This listing is local pickup only. Offers are available only on listings that ship.',
  counterOffer: 'Could not send this counteroffer.',
  bid: 'Could not place this bid.',
  bidTooLow: 'Your new maximum must be higher than your previous maximum and the current visible price.',
  bidUnauthorized: 'You cannot bid on your own auction.',
  bidStale: 'The auction changed since you loaded it. Reload the latest price and try again.',
  bidClosed: 'This auction is no longer open for bidding.',
  message: 'Could not send this message.',
  notifications: 'Could not update commerce notifications.',
  order: 'Could not update this order.',
  orderChanged: 'This order changed since you loaded it. The latest state was reloaded — retry from there.',
  orderReversedMeanwhile:
    'PayPal reversed the payment for this order while you were working on it. The latest state was reloaded.',
  orderRefundedMeanwhile:
    'This order was refunded while you were working on it, so there is nothing left to do here. The latest state was reloaded.',
  orderRefundRecordedMeanwhile:
    'A refund was recorded on this order while you were working on it. The latest state was reloaded — check it and retry.',
  paymentChanged: 'This payment changed since you loaded it. The latest state was reloaded — retry from there.',
  checkout: 'Checkout could not be completed.',
  claim: 'The claim could not be submitted. Check your connection and try again.',
  claimAddress: 'Save a delivery address first — the claim sends it with the checkout.',
  claimListingUnavailable: 'This listing could not be prepared for checkout. It may have been removed by the seller.',
  listingRemoved: 'This listing was removed.',
  claimRefusal: 'The claim could not be completed.',
  drop: 'The transaction service could not be reached.',
  dropRefusal: 'The drop action could not be completed.',
  locksPayment: 'The payment request could not be created. Nothing was charged; you can retry.',
  session: 'Your marketplace session expired. Reconnect and try again.',
  sessionTimeout: 'The approval expired before it was completed. Try again.',
  sessionStart: 'Could not start the marketplace session.',
  sessionGrantUnexpected:
    'That approval did not match the marketplace permissions Shop asked for. Your current session is unchanged. Try again.',
  sessionGrantNarrower:
    'That approval covered less than your current marketplace session, so Shop kept the current session.',
  sessionMissing: 'Connect a marketplace session to continue. This is a new session, not an expired approval.',
  sessionCookieExpired:
    'This marketplace session is no longer valid. Connect a new session. This is not an expired signer approval.',
  soldOut: 'This drop is sold out.',
  listingSoldOut: 'This listing has sold out.',
  dropNotStarted: "This drop hasn't started yet.",
  dropEnded: 'This drop has ended.',
  dropPerBuyerLimit: "You have reached this drop's per-buyer limit.",
  shippingRates: 'Shipping rates are unavailable.',
  shippingLabel: 'The shipping label could not be purchased.',
  paymentSettings: 'Payment settings are unavailable.',
  bitcoinOfferUnavailable: 'Bitcoin is temporarily unavailable. Other payment methods are unaffected.',
  stripeKeyRemoval: 'The stored payment key could not be removed.',
  messagingStart: 'Could not start marketplace messaging.',
  messagingStorage: 'Messaging paused: storage protection unavailable',
  sandboxPayment: 'Could not advance the sandbox payment.',
  offersUnavailable: 'Marketplace offers are unavailable.',
  notificationsUnavailable: 'Commerce notifications are unavailable.',
  notificationsReadUnavailable: 'The durable marketplace service does not store read state yet.',
  notificationsReadFailed: 'Could not mark commerce notifications read.',
  notificationPreferencesUnavailable: 'The durable marketplace service does not store notification preferences yet.',
  notificationPreferencesFailed: 'Could not update commerce notification preferences.',
  ordersUnavailable: 'Marketplace orders are unavailable.',
  unavailable: 'The marketplace service is temporarily unavailable.',
  shopSettings: 'Could not save shop settings.',
  savedSearch: 'Could not save this search.',
  savedSearchDelete: 'Could not delete this saved search.',
  shippingSettings: 'The shipping settings could not be saved.',
  watchOnlyClaimInvalid: 'That does not look like an account xpub. Export the BIP84 account key from your wallet.',
  watchOnlyClaimStart: 'The watch-only claim could not be started.',
  watchOnlyClaimComplete: 'The watch-only claim could not be completed.',
  paymentSettingsSave: 'The payment settings could not be saved.',
} as const;

type MarketplaceFailureCode = string | null | undefined;

const CODE_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['INVALID_RESPONSE', MARKETPLACE_FAILURE_MESSAGES.unavailable],
  ['SESSION_EXPIRED', MARKETPLACE_FAILURE_MESSAGES.session],
  ['UNAUTHORIZED', MARKETPLACE_FAILURE_MESSAGES.session],
  ['shop_session_missing', MARKETPLACE_FAILURE_MESSAGES.sessionMissing],
  ['shop_session_expired', MARKETPLACE_FAILURE_MESSAGES.sessionCookieExpired],
  ['flow_expired', MARKETPLACE_FAILURE_MESSAGES.sessionTimeout],
]);

const DROP_REFUSAL_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['INVALID_STATE:The drop has not started.', MARKETPLACE_FAILURE_MESSAGES.dropNotStarted],
  ['INVALID_STATE:The drop has ended.', MARKETPLACE_FAILURE_MESSAGES.dropEnded],
  ['INSUFFICIENT_INVENTORY:The drop is sold out.', MARKETPLACE_FAILURE_MESSAGES.soldOut],
  ["INVALID_STATE:You have reached this drop's per-buyer limit.", MARKETPLACE_FAILURE_MESSAGES.dropPerBuyerLimit],
]);

const CHECKOUT_REFUSAL_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['INSUFFICIENT_INVENTORY:Checkout quantity is unavailable.', MARKETPLACE_FAILURE_MESSAGES.listingSoldOut],
  [
    'INVALID_COMMAND:Checkout aggregate identity or revision is invalid.',
    'Checkout could not be started. Review your cart and try again.',
  ],
  ['NOT_FOUND:A checkout listing is unavailable.', 'A listing in your cart is no longer available.'],
  ['UNAUTHORIZED:A buyer cannot purchase their own listing.', 'You cannot purchase your own listing.'],
  [
    'INVALID_STATE:Only fixed-price listings can enter checkout.',
    'Only fixed-price listings can be purchased through checkout.',
  ],
  [
    "INVALID_STATE:Another buyer's payment is holding this item. If it isn't completed in time, the item restocks.",
    'Another buyer is currently paying for this item. If payment does not complete, it will become available again.',
  ],
  ['INVALID_STATE:This listing has sold out.', MARKETPLACE_FAILURE_MESSAGES.listingSoldOut],
  [
    'INVALID_STATE:Only available fixed-price listings can enter checkout.',
    'This listing is not available for checkout.',
  ],
]);

/**
 * Copy for the grant purchase bootstrap (Bitkit or Pubky Passport sign-in).
 * `shop_session_expired` here means the grant sign-in itself ended (its
 * homeserver write was refused), not a marketplace cookie, so it must not use
 * the reconnect copy. Codes that send the user back to the signer name it
 * (see {@link marketplaceBootstrapFailureMessage}).
 */
export const BOOTSTRAP_APPROVAL_EXPIRED = 'This approval expired. Start again.';
const BOOTSTRAP_OTHER_TAB = 'This approval belongs to another tab. Start again here.';

export const MARKETPLACE_BOOTSTRAP_CODE_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['origin_denied', 'This request did not come from the Shop. Reload and try again.'],
  ['invalid_request', 'Something went wrong. Try again.'],
  ['retry_later', 'Too many attempts. Wait a minute and try again.'],
  ['challenge_not_found', BOOTSTRAP_APPROVAL_EXPIRED],
  ['challenge_consumed', 'This approval was already used. Start again.'],
  ['homeserver_proof_invalid', 'Your homeserver could not confirm this sign-in. Start again.'],
  ['flow_expired', BOOTSTRAP_APPROVAL_EXPIRED],
  ['flow_cancelled', 'Approval cancelled.'],
  ['result_denied', 'This approval could not be completed. Start again.'],
  ['identity_mismatch', "This approval came from a different account. Approve with the account you're signed in with."],
  ['flow_binding_missing', BOOTSTRAP_OTHER_TAB],
  ['flow_binding_denied', BOOTSTRAP_OTHER_TAB],
  ['flow_not_found', BOOTSTRAP_APPROVAL_EXPIRED],
  ['claim_in_progress', 'Finishing your approval…'],
  ['shop_session_expired', 'Your Shop session ended. Sign in again.'],
]);

/**
 * The signer a bootstrap message names: whichever approved the Shop sign-in,
 * or either phone signer for a Pubky Ring (cookie) sign-in.
 */
export type BootstrapSignerName = 'Bitkit' | 'Pubky Passport' | 'Pubky Ring or Bitkit';

function signerBootstrapMessage(code: string, signer: BootstrapSignerName): string | undefined {
  switch (code) {
    case 'grant_unavailable':
      return `${signer} approvals are unavailable right now. Try again later.`;
    case 'fresh_approval_required':
      return `Approve again in ${signer}.`;
    case 'approval_invalid':
      return `That approval could not be verified. Approve again in ${signer}.`;
    default:
      return undefined;
  }
}

export function marketplaceBootstrapFailureMessage(
  code: MarketplaceFailureCode,
  signer: BootstrapSignerName = 'Bitkit',
): string {
  return (
    (code && (signerBootstrapMessage(code, signer) ?? MARKETPLACE_BOOTSTRAP_CODE_MESSAGES.get(code))) ||
    marketplaceFailureMessage(code, MARKETPLACE_FAILURE_MESSAGES.sessionStart)
  );
}

export function marketplaceCheckoutRefusalMessage(code: MarketplaceFailureCode, message: unknown): string | null {
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  return CHECKOUT_REFUSAL_MESSAGES.get(`${code}:${message}`) ?? null;
}

export function marketplaceDropRefusalMessage(code: MarketplaceFailureCode, message: unknown): string | null {
  if (typeof code !== 'string' || typeof message !== 'string') return null;
  return DROP_REFUSAL_MESSAGES.get(`${code}:${message}`) ?? null;
}

const OFFER_HOLD_MESSAGES = new Set([
  "Another buyer's payment is holding this item. If it isn't completed in time, the item restocks.",
  CHECKOUT_HOLD_COPY.listingReserved,
]);

/** Service `offer.create` refusal for a listing that does not publish shipping (`handlers/offers.rs`). */
export const OFFER_SHIPPING_ONLY_REFUSAL = 'Offers are available only on listings that ship.';

/**
 * Offer.create failures must never use drop copy. `INSUFFICIENT_INVENTORY` on
 * a listing is sold-out or held inventory, not "this drop is sold out."
 */
export function marketplaceOfferFailureMessage(code: MarketplaceFailureCode, message?: unknown): string {
  if (code === 'INSUFFICIENT_INVENTORY') return MARKETPLACE_FAILURE_MESSAGES.listingSoldOut;
  if (code === 'INVALID_STATE' && typeof message === 'string' && OFFER_HOLD_MESSAGES.has(message)) {
    return CHECKOUT_HOLD_COPY.heldWhileAnotherPays;
  }
  if (code === 'INVALID_STATE' && message === OFFER_SHIPPING_ONLY_REFUSAL) {
    return MARKETPLACE_FAILURE_MESSAGES.offerShippingOnly;
  }
  return marketplaceFailureMessage(code, MARKETPLACE_FAILURE_MESSAGES.sendOffer);
}

export function marketplaceFailureMessage(code: MarketplaceFailureCode, fallback: string, error?: unknown): string {
  if (
    isAppError(error) &&
    error.category === ErrorCategory.Validation &&
    Object.values(ValidationErrorCode).includes(error.code as ValidationErrorCode)
  ) {
    return error.message;
  }
  return (code && CODE_MESSAGES.get(code)) || fallback;
}

/**
 * Static copy for durable payment-method refusals. Keys are service
 * `error.reason` values and, for families that ship `code` with no `reason`
 * (`capability_required`, CAS `REVISION_CONFLICT`), the wire `error.code`.
 * Never copy the service `error.message` — it can echo a rejected Stripe key.
 */
export const MARKETPLACE_PAYMENT_METHOD_REASON_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['bitcoin_unavailable', 'Bitcoin payments are not available for this seller.'],
  [
    'buyer_paykit_wallet_required',
    'Connect Bitkit to pay with Bitcoin: this account has no Paykit wallet that can receive a payment request.',
  ],
  ['capability_required', 'This payment needs a marketplace grant. Approve access on your signer and try again.'],
  ['currency_unsupported', 'This payment method does not support the checkout currency.'],
  ['held', CHECKOUT_HOLD_COPY.listingReserved],
  ['hold_unavailable', 'The inventory hold for this checkout is no longer available.'],
  ['INTERNAL', MARKETPLACE_FAILURE_MESSAGES.unavailable],
  ['invalid_method', 'That payment method is not valid for this checkout.'],
  ['invalid_payment_link', 'The payment link is not valid.'],
  ['invalid_paypal_email', 'The PayPal merchant email is not valid.'],
  ['invalid_pubky', 'The seller identity on this payment configuration is not valid.'],
  ['invalid_restricted_key', 'The payment key is not valid.'],
  ['invalid_sats', 'The Bitcoin amount must be a positive satoshi amount.'],
  ['invalid_transaction_ref', 'The payment reference is not valid.'],
  ['INVALID_RESPONSE', MARKETPLACE_FAILURE_MESSAGES.unavailable],
  ['locks_managed', 'A Locks-correlated payment advances only by server-side verification.'],
  ['method_mismatch', 'The payment method does not match this checkout.'],
  ['method_unavailable', 'The seller has not configured this payment method.'],
  ['not_buyer', 'Only the buyer may bind the payment method.'],
  ['not_participant', 'Only a participant on this checkout can continue.'],
  ['not_seller', 'Only the seller can continue this payment step.'],
  ['order_not_found', 'The order was not found.'],
  ['order_not_pending', 'Only a checkout pending payment can bind a payment method.'],
  ['paykit_expiry_inconsistent', 'The Paykit payment window does not match this checkout.'],
  ['paykit_rejected', 'The Paykit server rejected the payment request.'],
  ['paykit_total_inconsistent', 'The Paykit amount does not match this checkout.'],
  ['paykit_unavailable', 'The Paykit server is unavailable. Try again shortly.'],
  ['payment_method_already_bound', 'A payment method is already bound to this checkout.'],
  ['payment_not_awaiting', 'The payment is no longer awaiting a method.'],
  ['payments_disabled', 'Payments are disabled on this marketplace.'],
  ['REVISION_CONFLICT', MARKETPLACE_FAILURE_MESSAGES.paymentChanged],
  ['revision_conflict', MARKETPLACE_FAILURE_MESSAGES.paymentChanged],
  ['seller_account_unclaimed', 'The seller has not claimed a Bitcoin account yet.'],
  ['sold_out', 'This listing no longer has enough inventory.'],
  ['stripe_key_invalid', 'The seller payment key was rejected. The seller must update their payment settings.'],
  ['stripe_key_missing', 'This seller has not finished payment setup.'],
  ['stripe_unavailable', 'Payment verification could not be reached. Try again shortly.'],
  ['unavailable', 'The payment method request was refused.'],
  ['UPSTREAM_UNAVAILABLE', MARKETPLACE_FAILURE_MESSAGES.unavailable],
]);

function paymentMethodRefusalLookupKeys(error: unknown): string[] {
  if (!isAppError(error)) return [];
  const keys: string[] = [];
  const reason = error.context?.reason;
  const serviceCode = error.context?.serviceCode;
  if (typeof reason === 'string' && reason.length > 0) keys.push(reason);
  if (typeof serviceCode === 'string' && serviceCode.length > 0) keys.push(serviceCode);
  if (typeof error.code === 'string' && error.code.length > 0) keys.push(error.code);
  return keys;
}

export function marketplacePaymentMethodReasonMessage(reason: string | null | undefined): string {
  if (typeof reason !== 'string' || reason.length === 0) {
    return MARKETPLACE_PAYMENT_METHOD_REASON_MESSAGES.get('unavailable') ?? 'The payment method request was refused.';
  }
  return (
    MARKETPLACE_PAYMENT_METHOD_REASON_MESSAGES.get(reason) ??
    MARKETPLACE_PAYMENT_METHOD_REASON_MESSAGES.get('unavailable') ??
    'The payment method request was refused.'
  );
}

/** Buyer/seller payment-action toast: map reason or family code, never a wire message. */
export function marketplacePaymentMethodFailureMessage(error: unknown, fallback: string): string {
  for (const key of paymentMethodRefusalLookupKeys(error)) {
    const mapped = MARKETPLACE_PAYMENT_METHOD_REASON_MESSAGES.get(key);
    if (mapped) return mapped;
  }
  return marketplaceFailureMessage(marketplaceErrorCode(error), fallback, error);
}

export function marketplaceBidFailureMessage(code: MarketplaceFailureCode): string {
  if (code === 'BID_TOO_LOW') return MARKETPLACE_FAILURE_MESSAGES.bidTooLow;
  if (code === 'UNAUTHORIZED') return MARKETPLACE_FAILURE_MESSAGES.bidUnauthorized;
  if (code === 'REVISION_CONFLICT') return MARKETPLACE_FAILURE_MESSAGES.bidStale;
  if (code === 'INVALID_STATE') return MARKETPLACE_FAILURE_MESSAGES.bidClosed;
  return MARKETPLACE_FAILURE_MESSAGES.bid;
}

export function marketplaceOfferCheckoutFailureMessage(code: MarketplaceFailureCode): string {
  if (code === 'AWARD_EXPIRED') return MARKETPLACE_FAILURE_MESSAGES.offerExpired;
  if (code === 'AWARD_ALREADY_CONVERTED' || code === 'REVISION_CONFLICT') {
    return MARKETPLACE_FAILURE_MESSAGES.offerAlreadyConverted;
  }
  if (code === 'AWARD_QUANTITY_MISMATCH') return 'The checkout quantity does not match the accepted offer.';
  if (code === 'AWARD_VARIANT_MISMATCH') return 'The checkout variant does not match the accepted offer.';
  if (code === 'AWARD_LISTING_CHANGED') return 'The listing snapshot does not match the offer terms.';
  if (code === 'AWARD_HOLD_MISSING') return 'The inventory reserved for this accepted offer is no longer held.';
  if (code === 'INVALID_STATE') return 'Only an accepted offer can enter offer checkout.';
  return MARKETPLACE_FAILURE_MESSAGES.checkout;
}

export function marketplaceErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}
