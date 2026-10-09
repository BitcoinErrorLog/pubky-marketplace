/**
 * The buyer-facing reading of a Lock Server verification lifecycle
 * (`POST /verification-task-lookups`). With durable invoice admission
 * (pubky/locks#72) a payment submit returns `pending` at once and the invoice
 * is admitted in the background: the buyer polls the same task and never
 * resubmits. While the reader's Paykit wallet is still being set up the
 * pending task carries `status_message: "Reader wallet setup needed"`; an
 * admission that cannot succeed ends `failed` with a closed message, and a
 * pending task past its `admission_deadline_at` reads as stalled.
 *
 * Only these closed values are recognised. Any other `status_message`,
 * `failure_message` or `terminal_reason` is never rendered: an unknown
 * failure reads as a generic failure, an unknown status message as plain
 * pending, an unknown terminal reason as settled. A Lock Server that omits a
 * field (v0.1.0-rc8 has no `status_message` or `admission_deadline_at`) reads
 * exactly as before.
 */
export const LOCKS_READER_WALLET_SETUP_STATUS = 'Reader wallet setup needed';
export const LOCKS_FAILURE_READER_NOT_PAYABLE = 'reader is not payable';
export const LOCKS_FAILURE_ADMISSION_DEADLINE = 'invoice admission deadline exceeded';
export const LOCKS_FAILURE_INVOICE_CONFLICT = 'paykit invoice conflict';
export const LOCKS_FAILURE_ADMISSION_FAILED = 'paykit invoice admission failed';

/**
 * How long past `admission_deadline_at` a task may stay pending before the
 * buyer is offered "Check again". Locks enforces the deadline on its own
 * clock and lets a claim taken just before it finish its Paykit call, so a
 * margin keeps browser clock skew and that last attempt from reading as a
 * stall. pubky-app (#2788) uses the same three minutes.
 */
export const LOCKS_STALLED_GRACE_MS = 3 * 60 * 1_000;

export type LocksAdmissionFailure =
  | 'reader_not_payable'
  | 'admission_deadline_exceeded'
  | 'invoice_conflict'
  | 'admission_failed'
  | 'failed';

export const LOCKS_TERMINAL_REASONS = [
  'payment_request_rejected',
  'payment_request_canceled',
  'proposal_expired',
  'payment_deadline_expired',
] as const;

export type LocksTerminalReason = (typeof LOCKS_TERMINAL_REASONS)[number];

export type LocksAdmissionView =
  | { kind: 'in_flight'; readerWalletSetupNeeded: boolean; stalled: boolean }
  | { kind: 'failed'; failure: LocksAdmissionFailure }
  | { kind: 'expired'; reason: LocksTerminalReason }
  | { kind: 'settled' };

export const LOCKS_ADMISSION_COPY = {
  walletSetupTitle: 'Reader wallet setup needed',
  walletSetupBody:
    'Finish setting up Bitkit (or another Paykit wallet) for this pubky. This page keeps checking, so you don’t need to request the payment again.',
  stalledTitle: 'Still waiting on the payment request',
  stalledBody:
    'This is taking longer than expected. This page keeps checking, or you can check now. If it doesn’t clear, try again in a few minutes.',
  stalledAction: 'Check again',
  readerNotPayable:
    'Your wallet can’t receive this payment request. Connect Bitkit (or another Paykit wallet) for this pubky to pay with Bitcoin. Nothing was charged.',
  admissionDeadlineExceeded:
    'The payment request wasn’t ready in time, so this attempt ended. If a payment request for this order reached your wallet, don’t pay it. Finish setting up your wallet, then check out again.',
  invoiceConflict:
    'The payment request for this order conflicted with an earlier one, so it was stopped. Don’t pay any request you see for this order. Check out again to get a new one.',
  admissionFailed:
    'The payment request couldn’t be created, so this attempt ended. Try checking out again later, or contact the seller if it keeps happening.',
  failed: 'Payment verification failed. Check your wallet and order status before trying another payment.',
} as const;

export const LOCKS_TERMINAL_REASON_COPY: Readonly<Record<LocksTerminalReason, string>> = {
  payment_request_rejected:
    'This payment request was declined in the wallet, so this checkout was not completed. Check out again to get a new request.',
  payment_request_canceled:
    'This payment request was canceled, so this checkout was not completed. Check out again to get a new request.',
  proposal_expired:
    'This payment request expired before it was accepted in the wallet, so this checkout was not completed. Check out again to get a new request.',
  payment_deadline_expired:
    'The payment window ended before a payment was verified. If you already sent one, contact the seller. Otherwise, check out again.',
};

function isLocksTerminalReason(value: string | null | undefined): value is LocksTerminalReason {
  return (LOCKS_TERMINAL_REASONS as readonly (string | null | undefined)[]).includes(value);
}

function failureFor(message: string | null): LocksAdmissionFailure {
  switch (message) {
    case LOCKS_FAILURE_READER_NOT_PAYABLE:
      return 'reader_not_payable';
    case LOCKS_FAILURE_ADMISSION_DEADLINE:
      return 'admission_deadline_exceeded';
    case LOCKS_FAILURE_INVOICE_CONFLICT:
      return 'invoice_conflict';
    case LOCKS_FAILURE_ADMISSION_FAILED:
      return 'admission_failed';
    default:
      return 'failed';
  }
}

function isPastStallGrace(deadline: string | null | undefined, nowMs: number): boolean {
  if (!deadline) return false;
  const deadlineMs = Date.parse(deadline);
  return Number.isFinite(deadlineMs) && nowMs > deadlineMs + LOCKS_STALLED_GRACE_MS;
}

export function locksAdmissionView(
  lifecycle: {
    status: string;
    failure_message: string | null;
    status_message?: string | null;
    admission_deadline_at?: string | null;
    terminal_reason?: string | null;
  },
  nowMs: number = Date.now(),
): LocksAdmissionView {
  if (lifecycle.status === 'pending' || lifecycle.status === 'in_progress') {
    const pending = lifecycle.status === 'pending';
    return {
      kind: 'in_flight',
      readerWalletSetupNeeded: pending && lifecycle.status_message === LOCKS_READER_WALLET_SETUP_STATUS,
      stalled: pending && isPastStallGrace(lifecycle.admission_deadline_at, nowMs),
    };
  }
  if (lifecycle.status === 'failed') {
    return { kind: 'failed', failure: failureFor(lifecycle.failure_message) };
  }
  if (lifecycle.status === 'expired' && isLocksTerminalReason(lifecycle.terminal_reason)) {
    return { kind: 'expired', reason: lifecycle.terminal_reason };
  }
  return { kind: 'settled' };
}

export function locksAdmissionFailureCopy(failure: LocksAdmissionFailure): string {
  switch (failure) {
    case 'reader_not_payable':
      return LOCKS_ADMISSION_COPY.readerNotPayable;
    case 'admission_deadline_exceeded':
      return LOCKS_ADMISSION_COPY.admissionDeadlineExceeded;
    case 'invoice_conflict':
      return LOCKS_ADMISSION_COPY.invoiceConflict;
    case 'admission_failed':
      return LOCKS_ADMISSION_COPY.admissionFailed;
    case 'failed':
      return LOCKS_ADMISSION_COPY.failed;
  }
}

export function locksTerminalReasonCopy(reason: LocksTerminalReason): string {
  return LOCKS_TERMINAL_REASON_COPY[reason];
}
