import type { SellerPaymentConfigOwnView } from '@/libs/commerce/payment-methods';
import { locksCreatorMatchesShopPubky } from '@/services/locks/locks-frontend-session';

/** Plain-language setup state shown as the status pill on each method card. */
export type PaymentMethodStatus = 'not_set_up' | 'connected' | 'email_saved' | 'needs_attention';

export const PAYMENT_METHOD_STATUS_LABELS: Record<PaymentMethodStatus, string> = {
  not_set_up: 'Not set up',
  connected: 'Connected',
  email_saved: 'Email saved',
  needs_attention: 'Needs attention',
};

/** A method counts as ready for selling only when its pill is Connected or Email saved. */
export function isReadyPaymentMethodStatus(status: PaymentMethodStatus): boolean {
  return status === 'connected' || status === 'email_saved';
}

export function countReadyPaymentMethods(statuses: readonly PaymentMethodStatus[]): number {
  return statuses.filter(isReadyPaymentMethodStatus).length;
}

export function derivePaypalStatus(config: SellerPaymentConfigOwnView | null): PaymentMethodStatus {
  return config?.paypalMerchantEmail ? 'email_saved' : 'not_set_up';
}

export function deriveStripeStatus(config: SellerPaymentConfigOwnView | null): PaymentMethodStatus {
  const hasLink = Boolean(config?.stripePaymentLink);
  const hasKey = Boolean(config?.stripeRestrictedKeySet);
  if (hasLink && hasKey) return 'connected';
  // Half-configured Stripe cannot verify payments: the link without the key
  // (or a stored key without a link) needs the seller to finish the pair.
  if (hasLink || hasKey) return 'needs_attention';
  return 'not_set_up';
}

/**
 * Bitcoin is connected only when both live signals are present:
 * - Lock Server authorization: `connectedCreator` from `useMarketplaceLocksConnect`
 *   (restored from localStorage and revalidated with the Lock Server after reload)
 * - Paykit claim: `accountClaimed === true` from `useMarketplaceSellerPaymentConfig`
 */
export function deriveBitcoinStatus(args: {
  connectedCreator: string | null;
  accountPubky: string | null | undefined;
  accountClaimed: boolean | null;
  locksError: string | null;
  claimError: string | null;
}): PaymentMethodStatus {
  if (args.locksError || args.claimError) return 'needs_attention';
  const locksAuthorized = locksCreatorMatchesShopPubky(args.connectedCreator, args.accountPubky);
  const paykitClaimed = args.accountClaimed === true;
  if (locksAuthorized && paykitClaimed) return 'connected';
  if (!locksAuthorized && !paykitClaimed) return 'not_set_up';
  return 'needs_attention';
}

export function atLeastOneMethodSentence(readyCount: number): string {
  const each = 'Each method works on its own — turn on any of them, in any order, and change them whenever you like.';
  if (readyCount === 0) {
    return `Set up at least one method below to start selling. ${each}`;
  }
  if (readyCount === 1) {
    return `1 method is ready to accept payments. ${each}`;
  }
  return `${readyCount} methods are ready to accept payments. ${each}`;
}
