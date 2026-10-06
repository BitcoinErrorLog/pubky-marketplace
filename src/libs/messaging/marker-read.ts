/**
 * Reading a counterparty's public messaging receiver marker.
 *
 * The vendored binding resolves `undefined` when the owner has published no
 * marker at the path (the homeserver answered 404 or 410). Every other
 * outcome rejects with a plain `Error` whose message is
 * `failed to fetch receiver marker: <Paykit error>`, where the Paykit error
 * reads `transport error: ...` for anything that is not a 404/410 (an
 * unresolvable homeserver, a 5xx, a timeout, a body that fails mid-read) and
 * `invalid data: ...` or `validation: ...` when a marker was fetched but
 * cannot be interpreted. The message is the only signal the binding
 * exposes, so it is matched on its fixed prefixes.
 */

const MARKER_READ_PREFIX = 'failed to fetch receiver marker: ';

/**
 * - `unreachable`: the marker could not be read (network, resolution, 5xx).
 *   Says nothing about whether one exists; worth retrying.
 * - `unreadable`: a marker exists but its content is unusable. Retrying the
 *   same bytes cannot help, and the counterparty controls them.
 */
export type MarkerReadFailureReason = 'unreachable' | 'unreadable';

export class MarkerReadFailure extends Error {
  constructor(
    readonly reason: MarkerReadFailureReason,
    options?: { cause?: unknown },
  ) {
    super(
      reason === 'unreachable'
        ? 'The messaging setup of this account could not be reached.'
        : 'The messaging setup of this account could not be read.',
      options,
    );
    this.name = 'MarkerReadFailure';
  }
}

export function isMarkerReadFailure(error: unknown): error is MarkerReadFailure {
  return error instanceof MarkerReadFailure;
}

/**
 * True for a {@link MarkerReadFailure} or the binding's raw marker rejection.
 * Surfaces use it to show plain copy instead of the binding's own text.
 */
export function isMarkerReadError(error: unknown): boolean {
  return isMarkerReadFailure(error) || classifyMarkerReadError(error) !== null;
}

/** Maps a binding rejection to a reason, or `null` when it is not a marker read failure. */
export function classifyMarkerReadError(error: unknown): MarkerReadFailureReason | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!message.startsWith(MARKER_READ_PREFIX)) return null;
  const detail = message.slice(MARKER_READ_PREFIX.length);
  if (detail.startsWith('transport error:')) return 'unreachable';
  if (detail.startsWith('invalid data:') || detail.startsWith('validation:')) return 'unreadable';
  return null;
}

/**
 * Waits between attempts at an `unreachable` read. Bounded: at most
 * `delaysMs.length + 1` attempts, so one dead account costs a few seconds
 * once, after which the pair's link backoff keeps it off the network.
 */
export const MARKER_READ_RETRY = { delaysMs: [300, 900] } as const;

export type MarkerReadSleep = (ms: number) => Promise<void>;

export const realMarkerReadSleep: MarkerReadSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `read` and retries transient `unreachable` failures. Resolves whatever
 * `read` resolves (including `undefined` for an absent marker, which is never
 * retried). Rejects with {@link MarkerReadFailure} for a classified failure
 * and rethrows any other error unchanged.
 */
export async function readMarkerWithRetry<T>(
  read: () => Promise<T>,
  sleep: MarkerReadSleep = realMarkerReadSleep,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      const reason = classifyMarkerReadError(error);
      if (reason === null) throw error;
      const delay = MARKER_READ_RETRY.delaysMs[attempt];
      if (reason === 'unreadable' || delay === undefined) {
        throw new MarkerReadFailure(reason, { cause: error });
      }
      await sleep(delay);
    }
  }
}
