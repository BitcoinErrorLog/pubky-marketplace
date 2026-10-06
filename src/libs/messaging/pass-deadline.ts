import { TimeoutErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';

/** Longest one messaging sync pass may hold its slot (its lock, or the in-flight entry other callers join). */
export const MESSAGING_SYNC_PASS_TIMEOUT_MS = 60_000;

/**
 * Longest the session resume at the start of a background pass may take.
 * It runs inside the pass's provisioning hold, so bounding it bounds how
 * long a hung resume can keep the hold on.
 */
export const MESSAGING_SYNC_RESUME_TIMEOUT_MS = 20_000;

/**
 * Longest a messaging surface waits for the status read (session resume,
 * receiver check) before it shows the delay. The read itself keeps going,
 * and the next one joins it.
 */
export const MESSAGING_STATUS_TIMEOUT_MS = 20_000;

const PASS_TIMEOUT_MESSAGE = 'Syncing private messages took too long. The next pass retries.';

/**
 * Settles like `work`, or rejects with a timeout once `timeoutMs` passed,
 * after calling `onExpire`. Nothing can cancel `work` itself: `onExpire` is
 * where the caller tells it to stop at its next check.
 */
export async function withPassDeadline<T>(
  work: Promise<T>,
  options: { timeoutMs: number; operation: string; onExpire: () => void; message?: string },
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      options.onExpire();
      reject(
        Err.timeout(TimeoutErrorCode.REQUEST_TIMEOUT, options.message ?? PASS_TIMEOUT_MESSAGE, {
          service: ErrorService.Paykit,
          operation: options.operation,
          context: { timeoutMs: options.timeoutMs },
        }),
      );
    }, options.timeoutMs);
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
