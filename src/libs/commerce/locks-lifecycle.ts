/**
 * The buyer-facing reading of a Lock Server verification lifecycle
 * (`POST /verification-task-lookups`). With durable invoice admission
 * (pubky/locks#72) a payment submit returns `pending` at once and the invoice
 * is admitted in the background: the buyer polls the same task and never
 * resubmits. While the reader's Paykit wallet is still being set up the
 * pending task carries `status_message: "Reader wallet setup needed"`; an
 * admission that cannot succeed ends `failed` with a closed message.
 *
 * Only these closed values are recognised. Any other `status_message` or
 * `failure_message` is never rendered: an unknown failure reads as a generic
 * failure, an unknown status message as plain pending.
 */
export const LOCKS_READER_WALLET_SETUP_STATUS = 'Reader wallet setup needed';
export const LOCKS_FAILURE_READER_NOT_PAYABLE = 'reader is not payable';
export const LOCKS_FAILURE_ADMISSION_DEADLINE = 'invoice admission deadline exceeded';

export type LocksAdmissionFailure = 'reader_not_payable' | 'admission_deadline_exceeded' | 'failed';

export type LocksAdmissionView =
  | { kind: 'in_flight'; readerWalletSetupNeeded: boolean }
  | { kind: 'failed'; failure: LocksAdmissionFailure }
  | { kind: 'settled' };

export const LOCKS_ADMISSION_COPY = {
  walletSetupTitle: 'Reader wallet setup needed',
  walletSetupBody:
    'Finish setting up Bitkit (or another Paykit wallet) for this pubky. This page keeps checking, so you don’t need to request the payment again.',
  readerNotPayable:
    'Your wallet can’t receive this payment request. Connect Bitkit (or another Paykit wallet) for this pubky to pay with Bitcoin. Nothing was charged.',
  admissionDeadlineExceeded:
    'The payment request wasn’t ready in time, so nothing was charged. Finish setting up your wallet, then check out again.',
  failed: 'Payment verification failed. Check your wallet and order status before trying another payment.',
} as const;

export function locksAdmissionView(lifecycle: {
  status: string;
  failure_message: string | null;
  status_message?: string | null;
}): LocksAdmissionView {
  if (lifecycle.status === 'pending' || lifecycle.status === 'in_progress') {
    return {
      kind: 'in_flight',
      readerWalletSetupNeeded:
        lifecycle.status === 'pending' && lifecycle.status_message === LOCKS_READER_WALLET_SETUP_STATUS,
    };
  }
  if (lifecycle.status === 'failed') {
    const failure =
      lifecycle.failure_message === LOCKS_FAILURE_READER_NOT_PAYABLE
        ? 'reader_not_payable'
        : lifecycle.failure_message === LOCKS_FAILURE_ADMISSION_DEADLINE
          ? 'admission_deadline_exceeded'
          : 'failed';
    return { kind: 'failed', failure };
  }
  return { kind: 'settled' };
}

export function locksAdmissionFailureCopy(failure: LocksAdmissionFailure): string {
  if (failure === 'reader_not_payable') return LOCKS_ADMISSION_COPY.readerNotPayable;
  if (failure === 'admission_deadline_exceeded') return LOCKS_ADMISSION_COPY.admissionDeadlineExceeded;
  return LOCKS_ADMISSION_COPY.failed;
}
