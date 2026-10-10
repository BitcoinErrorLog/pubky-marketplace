/**
 * The seller's own payment configuration (`GET /v0/sellers/me/payment-config`)
 * while the marketplace service's USDT flag is on, as docs/ecommerce/usdt-payments.md
 * (plan section 2.3) specifies it. Wire keys are snake_case. The USDT fields are
 * `usdt_enabled`, `usdt_setup` (`ready | setup_required | unavailable`) and
 * `usdt_setup_action` (`setup | reconnect | null`).
 *
 * These mirror the service's contract; they were not captured from a running
 * service (its readiness slice is built in parallel). Replace them with a
 * capture when that slice is deployed.
 */
const BASE_PAYMENT_CONFIG = {
  bitcoin_enabled: true,
  stripe_payment_link: null,
  paypal_merchant_email: 'seller@example.com',
  stripe_restricted_key_set: false,
  updated_at: '2026-10-09T12:00:00.000Z',
} as const;

/** The seller has a Paykit account and approved a USDT address in Bitkit. */
export const USDT_SELLER_CONFIG_READY_WIRE = {
  payment_config: {
    ...BASE_PAYMENT_CONFIG,
    usdt_enabled: true,
    usdt_setup: 'ready',
    usdt_setup_action: null,
  },
} as const;

/** The seller has a Paykit account but never shared a USDT address (reconnect adds it). */
export const USDT_SELLER_CONFIG_RECONNECT_WIRE = {
  payment_config: {
    ...BASE_PAYMENT_CONFIG,
    usdt_enabled: false,
    usdt_setup: 'setup_required',
    usdt_setup_action: 'reconnect',
  },
} as const;

/** The seller has no Paykit account yet (setup requests the Bitcoin account and the USDT address). */
export const USDT_SELLER_CONFIG_SETUP_WIRE = {
  payment_config: {
    ...BASE_PAYMENT_CONFIG,
    bitcoin_enabled: false,
    usdt_enabled: false,
    usdt_setup: 'setup_required',
    usdt_setup_action: 'setup',
  },
} as const;

/** Paykit could not be asked; the status is `unavailable` and no flow is offered. */
export const USDT_SELLER_CONFIG_UNAVAILABLE_WIRE = {
  payment_config: {
    ...BASE_PAYMENT_CONFIG,
    usdt_enabled: false,
    usdt_setup: 'unavailable',
    usdt_setup_action: null,
  },
} as const;

/** The same configuration while the service's USDT flag is off: none of the USDT keys appear. */
export const USDT_SELLER_CONFIG_FLAG_OFF_WIRE = {
  payment_config: BASE_PAYMENT_CONFIG,
} as const;
