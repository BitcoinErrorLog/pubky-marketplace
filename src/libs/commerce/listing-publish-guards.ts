import { availablePaymentMethods, type SellerPaymentConfig } from '@/libs/commerce/payment-methods';

/**
 * Durable-mode publish preconditions that live outside the listing Zod schema.
 * Create (`useCreateMarketplaceListing.submit` + `MarketplaceSell.submit`) and
 * edit (`useEditMarketplaceListing.submit`) share this taxonomy so the Review
 * step cannot read Complete while a handler would still early-return.
 *
 * Payment-method setup is also an entrance gate on Create listing. The
 * no-method reason still exists here as defence in depth for a method removed
 * while a draft or published listing is open.
 */
export const LISTING_PUBLISH_BLOCK_REASONS = ['unsigned', 'session', 'no-method', 'unverified'] as const;

export type ListingPublishBlockReason = (typeof LISTING_PUBLISH_BLOCK_REASONS)[number];

export const LISTING_PUBLISH_GUARD_CHECKING = 'Checking payment settings…';

export const LISTING_COMPOSER_PAYMENT_COPY = {
  title: 'Set up how you get paid first',
  body: 'Buyers cannot pay you otherwise. Add at least one payment method, then return here to create the listing.',
} as const;

export const LISTING_COMPOSER_RETURN_INTENT_KEY = 'pubky.marketplace.listingComposerReturnTo';

export const LISTING_PUBLISH_BLOCK_COPY: Record<
  ListingPublishBlockReason,
  { title: string; body: string; checklist: string }
> = {
  unsigned: {
    title: 'Sign in before publishing',
    body: 'Publishing needs the Pubky that will own this listing.',
    checklist: 'Sign in',
  },
  session: {
    title: 'Connect a marketplace session before publishing',
    body: 'This is a new session, not an expired approval. Connect a marketplace session, then submit these changes again.',
    checklist: 'Marketplace session',
  },
  'no-method': {
    title: 'Configure a payment method before publishing',
    body: 'Buyers cannot pay for a published listing until you add at least one payment method.',
    checklist: 'Payment method',
  },
  unverified: {
    title: 'We could not verify your payment settings. Reconnect your session and try again.',
    body: 'Your payment settings could not be checked against the marketplace service.',
    checklist: 'Payment settings',
  },
};

export type SellerPaymentMethodGateReason = 'unsigned' | 'no-method' | 'unverified';

export function listingPublishBlockToast(reason: ListingPublishBlockReason): {
  variant: 'error';
  description: string;
} {
  return { variant: 'error', description: LISTING_PUBLISH_BLOCK_COPY[reason].title };
}

export async function evaluateSellerPaymentMethodGate(input: {
  ownerPubky: string | null;
  loadPaymentConfig: (ownerPubky: string) => Promise<SellerPaymentConfig>;
}): Promise<SellerPaymentMethodGateReason | null> {
  if (!input.ownerPubky) return 'unsigned';
  try {
    const config = await input.loadPaymentConfig(input.ownerPubky);
    return availablePaymentMethods(config).length === 0 ? 'no-method' : null;
  } catch {
    return 'unverified';
  }
}

export async function evaluateDurableListingPublishGuards(input: {
  ownerPubky: string | null;
  hasMarketplaceSession: boolean;
  loadPaymentConfig: (ownerPubky: string) => Promise<SellerPaymentConfig>;
}): Promise<ListingPublishBlockReason | null> {
  if (!input.ownerPubky) return 'unsigned';
  if (!input.hasMarketplaceSession) return 'session';
  return evaluateSellerPaymentMethodGate(input);
}

export function rememberListingComposerReturnTo(path: string): void {
  if (typeof sessionStorage === 'undefined') return;
  sessionStorage.setItem(LISTING_COMPOSER_RETURN_INTENT_KEY, path);
}

export function peekListingComposerReturnTo(): string | null {
  if (typeof sessionStorage === 'undefined') return null;
  return sessionStorage.getItem(LISTING_COMPOSER_RETURN_INTENT_KEY);
}

export function consumeListingComposerReturnTo(): string | null {
  const stored = peekListingComposerReturnTo();
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.removeItem(LISTING_COMPOSER_RETURN_INTENT_KEY);
  }
  return stored;
}
