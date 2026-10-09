import { isAppError } from '@/libs/error/error';
import { RateLimitErrorCode } from '@/libs/error/error.codes';

/**
 * Lock Server refusals of `POST /proof-bundles` the buyer can act on. Keys are
 * the server's stable `error.code` values, the only part of the response the
 * Shop reads: its message text is never shown.
 *
 * - `reader_pubky_unresolvable` and `paykit_invoice_creation_failed` come from
 *   Lock Servers before durable invoice admission (v0.1.0-rc8) and are gone
 *   from rc9 on, where the invoice is created in the background and failures
 *   arrive on the lifecycle instead (see `locks-lifecycle.ts`).
 * - The rest are returned by every Lock Server version.
 */
export const LOCKS_SUBMIT_REFUSAL_COPY = {
  reader_pubky_unresolvable:
    'Your Pubky account couldn’t be looked up, so no payment request was created. Try again in a moment.',
  paykit_invoice_creation_failed: 'The payment request couldn’t be created right now. Try again in a moment.',
  content_lock_not_found:
    'The seller’s content lock couldn’t be found, so this payment can’t be requested. Contact the seller.',
  task_state_conflict:
    'This payment request doesn’t match the one already created for this order. Reload the page and try again.',
  paykit_not_configured: 'This payment method isn’t available right now. Try again later, or contact the seller.',
  unsupported_verifier_type: 'This payment method isn’t available right now. Try again later, or contact the seller.',
  invalid_request: 'The payment request wasn’t accepted. Reload the page and try again.',
} as const;

export type LocksSubmitRefusalCode = keyof typeof LOCKS_SUBMIT_REFUSAL_COPY;

export const LOCKS_SUBMIT_REFUSAL_CODES = Object.keys(LOCKS_SUBMIT_REFUSAL_COPY) as readonly LocksSubmitRefusalCode[];

export const LOCKS_SUBMIT_RATE_LIMITED_COPY = 'Too many payment requests. Wait a minute, then try again.';

/**
 * Buyer copy for a failed proof-bundle submit, or `fallback` for any refusal
 * the Shop has no specific copy for (network failures, 5xx, unknown codes).
 */
export function locksSubmitRefusalMessage(error: unknown, fallback: string): string {
  if (!isAppError(error)) return fallback;
  const code = error.context?.locksCode;
  const known = LOCKS_SUBMIT_REFUSAL_CODES.find((candidate) => candidate === code);
  if (known) return LOCKS_SUBMIT_REFUSAL_COPY[known];
  if (error.code === RateLimitErrorCode.RATE_LIMITED) return LOCKS_SUBMIT_RATE_LIMITED_COPY;
  return fallback;
}
