import { z } from 'zod';

/**
 * 13-digit Unix-ms integer used as the serialized-envelope budget placeholder.
 * Unix milliseconds stay 13 digits from 2001-09-09 through 2286-11-20, so the
 * composer budget is stable for current wall-clock timestamps. Legacy ISO-8601
 * was 24 characters plus JSON quotes (26 bytes); this is 13 bytes with no quotes.
 */
export const PAM_SENT_AT_UNIX_MS_PLACEHOLDER = 1_756_742_400_000;

/**
 * Maximum Unix-ms timestamp emitted by messaging envelopes. Keeping this at
 * 13 digits preserves the fixed-width serialized-envelope budget.
 */
export const PAM_SENT_AT_UNIX_MS_EMIT_MAX = 9_999_999_999_999;

/**
 * ECMAScript Date range ceiling (+8.64e15). Values above this make
 * `new Date(n).toISOString()` throw RangeError. The bound also sits below
 * 2^53, so every accepted integer is a safe integer (no precision loss).
 */
export const PAM_SENT_AT_UNIX_MS_MAX = 8_640_000_000_000_000;

/** Canonical PAM `sent_at`: a positive Unix-millisecond integer. ISO strings are invalid here. */
export const pamSentAtEmitSchema = z.number().int().positive().max(PAM_SENT_AT_UNIX_MS_EMIT_MAX);

const legacyIsoSentAtSchema = z.iso.datetime();

/**
 * Inbound compatibility parse for PAM `sent_at`. Accepts a Unix-ms integer or a
 * legacy ISO-8601 datetime string and returns a Unix-ms number. Rejects every
 * other type (numeric strings, unix-seconds-as-strings, objects, null).
 */
export function parsePamSentAt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= PAM_SENT_AT_UNIX_MS_MAX) {
    return value;
  }
  if (typeof value === 'string') {
    const iso = legacyIsoSentAtSchema.safeParse(value);
    if (!iso.success) return null;
    const ms = Date.parse(iso.data);
    if (Number.isInteger(ms) && ms > 0) return ms;
  }
  return null;
}
