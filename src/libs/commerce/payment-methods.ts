import { z } from 'zod';

/**
 * Seller-configurable payment methods (docs/ecommerce/fiat-rails-phase1.md,
 * "seller-direct" custody decision): the seller owns every processor
 * relationship. This marketplace never receives funds on any rail —
 * bitcoin settles to the seller's own claimed watch-only account via
 * Paykit, and fiat settles into the seller's own Stripe/PayPal account.
 * The service only verifies (Stripe, via a seller-supplied restricted
 * read-only key) or records attestations (PayPal, buyer-reported and
 * seller-confirmed).
 */
export type PaymentMethodKind = 'bitcoin' | 'stripe' | 'paypal';

/**
 * Public view of one seller's payment rails, served unauthenticated so buyers
 * can see the available methods before committing. Booleans only: the
 * seller's PayPal email, Stripe link, and restricted key never enter this
 * view. PayPal checkout opens the `fiatCheckoutUrl` the service returns on the
 * buyer's own bound order.
 *
 * A service that still sends `paypal_merchant_email` instead of
 * `paypal_available` is read for presence only; the address is dropped here
 * and never reaches the caller.
 */
export const sellerPaymentConfigSchema = z
  .object({
    bitcoinAvailable: z.boolean(),
    bitcoinOfferAvailable: z.boolean().optional().default(true),
    paypalAvailable: z.boolean().optional(),
    paypalMerchantEmail: z.string().nullable().optional(),
  })
  .transform(({ bitcoinAvailable, bitcoinOfferAvailable, paypalAvailable, paypalMerchantEmail }) => ({
    bitcoinAvailable,
    bitcoinOfferAvailable,
    paypalAvailable: paypalAvailable ?? Boolean(paypalMerchantEmail),
  }));

export type SellerPaymentConfig = z.infer<typeof sellerPaymentConfigSchema>;

/**
 * Methods the buyer can actually choose, in the order the UI renders them.
 * Card payments are paused: a stored Stripe link is kept on the service and
 * is never offered.
 */
export function availablePaymentMethods(config: SellerPaymentConfig): PaymentMethodKind[] {
  const methods: PaymentMethodKind[] = [];
  if (config.bitcoinAvailable && config.bitcoinOfferAvailable) methods.push('bitcoin');
  if (config.paypalAvailable) methods.push('paypal');
  return methods;
}

/**
 * Stripe Payment Links are the seller-direct checkout surface: the seller
 * creates the link in their own Stripe dashboard, so only Stripe-hosted
 * link hosts are accepted — anything else could smuggle an arbitrary
 * redirect into the buyer flow.
 */
const STRIPE_PAYMENT_LINK_HOSTS = new Set(['buy.stripe.com', 'book.stripe.com']);

export function isStripePaymentLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && STRIPE_PAYMENT_LINK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * The seller's own view when editing the configuration. Mirrors the
 * service's `payment_config` response: the Stripe restricted key is
 * write-only, so only its presence flag ever comes back.
 */
export const sellerPaymentConfigOwnViewSchema = z.object({
  bitcoinEnabled: z.boolean(),
  stripePaymentLink: z.url().nullable(),
  paypalMerchantEmail: z.email().nullable(),
  stripeRestrictedKeySet: z.boolean(),
  updatedAt: z.string(),
});

export type SellerPaymentConfigOwnView = z.infer<typeof sellerPaymentConfigOwnViewSchema>;

/**
 * Seller-supplied Stripe restricted keys start with `rk_`; secret `sk_`
 * keys are refused by the service, and this mirror check keeps a pasted
 * secret key from ever leaving the browser.
 */
export function isStripeRestrictedKey(value: string): boolean {
  return /^rk_(test|live)_[0-9A-Za-z]{8,}$/.test(value.trim());
}

/**
 * Client-side sanity check for a pasted BIP84 account key before it is sent
 * to the claim endpoint (which performs the authoritative parse). Accepts
 * the mainnet and testnet/regtest account-xpub encodings a wallet exports
 * for native-segwit accounts, plus the raw xpub/tpub forms some tools emit.
 */
const ACCOUNT_XPUB_PREFIXES = ['zpub', 'vpub', 'xpub', 'tpub'];
const BASE58_CHARS = /^[1-9A-HJ-NP-Za-km-z]+$/;

export function isPlausibleAccountXpub(value: string): boolean {
  const trimmed = value.trim();
  const prefix = ACCOUNT_XPUB_PREFIXES.find((candidate) => trimmed.startsWith(candidate));
  if (!prefix) return false;
  // Serialized extended keys are 111-112 base58 characters.
  if (trimmed.length < 100 || trimmed.length > 120) return false;
  return BASE58_CHARS.test(trimmed);
}
