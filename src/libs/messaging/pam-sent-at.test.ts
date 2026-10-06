import { describe, expect, it } from 'vitest';
import {
  PAM_SENT_AT_UNIX_MS_EMIT_MAX,
  PAM_SENT_AT_UNIX_MS_MAX,
  pamSentAtEmitSchema,
  parsePamSentAt,
} from './pam-sent-at';

describe('parsePamSentAt', () => {
  it('accepts a positive Unix-ms integer at the Date ceiling', () => {
    expect(parsePamSentAt(PAM_SENT_AT_UNIX_MS_MAX)).toBe(PAM_SENT_AT_UNIX_MS_MAX);
    expect(parsePamSentAt(1_756_742_400_000)).toBe(1_756_742_400_000);
  });

  it('rejects unbounded or imprecise Unix-ms integers', () => {
    expect(parsePamSentAt(1e30)).toBeNull();
    expect(parsePamSentAt(-1)).toBeNull();
    expect(parsePamSentAt(8.64e15 + 1)).toBeNull();
    expect(parsePamSentAt(2 ** 53 + 1)).toBeNull();
  });

  it('accepts a legacy ISO-8601 datetime and normalizes to Unix-ms', () => {
    expect(parsePamSentAt('2026-08-21T10:00:00.000Z')).toBe(Date.parse('2026-08-21T10:00:00.000Z'));
  });
});

describe('pamSentAtEmitSchema', () => {
  it('enforces the 13-digit emit range', () => {
    expect(pamSentAtEmitSchema.safeParse(PAM_SENT_AT_UNIX_MS_EMIT_MAX).success).toBe(true);
    expect(pamSentAtEmitSchema.safeParse(PAM_SENT_AT_UNIX_MS_EMIT_MAX + 1).success).toBe(false);
  });

  it('rejects integers above the Date ceiling', () => {
    expect(pamSentAtEmitSchema.safeParse(1e30).success).toBe(false);
    expect(pamSentAtEmitSchema.safeParse(8.64e15 + 1).success).toBe(false);
    expect(pamSentAtEmitSchema.safeParse(2 ** 53 + 1).success).toBe(false);
    expect(pamSentAtEmitSchema.safeParse(PAM_SENT_AT_UNIX_MS_MAX).success).toBe(false);
  });
});
