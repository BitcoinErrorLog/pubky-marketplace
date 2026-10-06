/**
 * Spacing for every automatic messaging retry (link recovery, handshake step
 * errors, outbox flushes, silent session resume, receiver marker publish).
 * The surfaces poll every couple of seconds; a failing operation must not
 * follow that cadence. The n-th consecutive failure waits a random delay in
 * [cap/2, cap], where cap = min(maxMs, baseMs * 2^(n-1)), so retries never
 * come closer than baseMs/2 and never further apart than maxMs.
 */
export const MESSAGING_RETRY_POLICY = { baseMs: 5_000, maxMs: 600_000 } as const;

export type RetryBackoffPolicy = { baseMs: number; maxMs: number };

type RetryEntry<T> = { failures: number; nextAttemptAt: number; value: T };

/**
 * Per-key failure schedule held in memory. `value` is what callers report
 * while an attempt is not yet due, so a waiting key costs no network.
 */
export class RetryBackoff<T> {
  private readonly entries = new Map<string, RetryEntry<T>>();

  constructor(
    private readonly policy: RetryBackoffPolicy = MESSAGING_RETRY_POLICY,
    private readonly random: () => number = () => Math.random(),
  ) {}

  /** The held value while the next attempt for `key` is not yet due; otherwise `undefined`. */
  waiting(key: string, now: number = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    return entry && now < entry.nextAttemptAt ? entry.value : undefined;
  }

  /** `none` — no recorded failure; `waiting` — failed, retry not due; `due` — failed, retry may run. */
  status(key: string, now: number = Date.now()): 'none' | 'waiting' | 'due' {
    const entry = this.entries.get(key);
    if (!entry) return 'none';
    return now < entry.nextAttemptAt ? 'waiting' : 'due';
  }

  /** True when `value` is the one the latest failure for `key` recorded. */
  holds(key: string, value: T): boolean {
    return this.entries.get(key)?.value === value;
  }

  /** Records one more consecutive failure and returns the delay until the next attempt. */
  fail(key: string, value: T, now: number = Date.now()): number {
    const failures = (this.entries.get(key)?.failures ?? 0) + 1;
    const cap = Math.min(this.policy.maxMs, this.policy.baseMs * 2 ** (failures - 1));
    const delay = Math.round(cap / 2 + this.random() * (cap / 2));
    this.entries.set(key, { failures, nextAttemptAt: now + delay, value });
    return delay;
  }

  /**
   * Replaces the value a recorded failure of `key` reports, keeping its
   * schedule and failure count. A key with no recorded failure is untouched.
   */
  replace(key: string, value: T): void {
    const entry = this.entries.get(key);
    if (entry) this.entries.set(key, { ...entry, value });
  }

  succeed(key: string): void {
    this.entries.delete(key);
  }

  /**
   * Restarts the schedule of every failed key `matches` accepts: its next
   * attempt is due at `now` and its next failure waits the first delay
   * again. A restarted key stays `due`, not `none`, so callers that keep
   * retries out of a healthy budget still do. Keys with no recorded failure
   * are untouched.
   */
  restart(matches: (key: string) => boolean, now: number = Date.now()): void {
    for (const [key, entry] of this.entries) {
      if (matches(key)) this.entries.set(key, { failures: 0, nextAttemptAt: now, value: entry.value });
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
