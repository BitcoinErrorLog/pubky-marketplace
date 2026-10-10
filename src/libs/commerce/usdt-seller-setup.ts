import { z } from 'zod';

/**
 * Seller USDT readiness: the wire contract the Shop consumes from the
 * marketplace service's own payment configuration
 * (`GET/PUT /v0/sellers/me/payment-config`, docs/ecommerce/usdt-payments.md,
 * plan section 2.3). The fields are present only while the service's USDT
 * flag is on.
 *
 * - `usdt_enabled`: the seller's Shop-level consent (the "Accept USDT" toggle).
 * - `usdt_setup`: what the service learned from a signed Paykit
 *   `/setup/status {asset: "USDT"}`. `ready` only when the seller approved a USDT
 *   address in Bitkit. A Ring-only sign-in is never `ready`.
 * - `usdt_setup_action`: the Bitkit flow that would fix a `setup_required`
 *   seller. `setup` when the seller has no Paykit account yet; `reconnect` when
 *   the account exists and only the USDT address is missing. `null` when
 *   `ready`, and when `unavailable` (a caller must never turn `unavailable`
 *   into a new authorization flow).
 *
 * The Shop never receives or shows the USDT address: it lives in Bitkit and
 * paykit-server.
 */
export const USDT_SETUP_STATUSES = ['ready', 'setup_required', 'unavailable'] as const;
export type UsdtSetupStatus = (typeof USDT_SETUP_STATUSES)[number];

export const USDT_SETUP_ACTIONS = ['setup', 'reconnect'] as const;
export type UsdtSetupAction = (typeof USDT_SETUP_ACTIONS)[number];

/** An unrecognised value is dropped, which reads as "readiness unknown". */
export const usdtSetupStatusSchema = z.enum(USDT_SETUP_STATUSES).optional().catch(undefined);
export const usdtSetupActionSchema = z.enum(USDT_SETUP_ACTIONS).nullable().optional().catch(undefined);

/** What the seller's settings surface does about USDT. */
export type UsdtSellerReadiness = 'ready' | 'setup' | 'reconnect' | 'unavailable';

/**
 * Collapses the two wire fields into one state. Only a `ready` status from the
 * service means ready. Anything the contract does not describe fails closed to
 * `unavailable`: a missing status, an unknown value, or `setup_required`
 * without a usable action. The action is ignored unless the status is
 * `setup_required`.
 */
export function deriveUsdtSellerReadiness(input: {
  usdtSetup?: UsdtSetupStatus | undefined;
  usdtSetupAction?: UsdtSetupAction | null | undefined;
}): UsdtSellerReadiness {
  if (input.usdtSetup === 'ready') return 'ready';
  if (input.usdtSetup === 'setup_required') {
    if (input.usdtSetupAction === 'setup') return 'setup';
    if (input.usdtSetupAction === 'reconnect') return 'reconnect';
  }
  return 'unavailable';
}

/** Shown for every not-ready state (plan section 2.3). */
export const USDT_NEEDS_BITKIT_COPY = "USDT needs Bitkit. Pubky Ring can't share a USDT address.";
