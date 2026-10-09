import { describe, expect, it } from 'vitest';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode, RateLimitErrorCode, ServerErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import {
  LOCKS_SUBMIT_RATE_LIMITED_COPY,
  LOCKS_SUBMIT_REFUSAL_CODES,
  LOCKS_SUBMIT_REFUSAL_COPY,
  locksSubmitRefusalMessage,
} from './locks-submit-refusal';

const FALLBACK = 'fallback copy';
const SENTINEL = 'SENTINEL_SERVER_TEXT';

function refusal(code: string, context: Record<string, unknown> = {}): AppError {
  return new AppError({
    category: ErrorCategory.Client,
    code: ClientErrorCode.BAD_REQUEST,
    message: SENTINEL,
    service: ErrorService.Locks,
    operation: 'postLifecycle',
    context: { statusCode: 422, locksCode: code, ...context },
  });
}

describe('locksSubmitRefusalMessage', () => {
  it.each(LOCKS_SUBMIT_REFUSAL_CODES)('maps the Lock Server code %s to its static copy', (code) => {
    const message = locksSubmitRefusalMessage(refusal(code), FALLBACK);
    expect(message).toBe(LOCKS_SUBMIT_REFUSAL_COPY[code]);
    expect(message).not.toContain(SENTINEL);
    expect(message).not.toContain(code);
  });

  it('has the two codes only Lock Servers before durable admission (rc8) answer', () => {
    expect(LOCKS_SUBMIT_REFUSAL_CODES).toEqual(
      expect.arrayContaining(['reader_pubky_unresolvable', 'paykit_invoice_creation_failed']),
    );
  });

  it('maps a rate limit by its status, with no code needed', () => {
    const limited = new AppError({
      category: ErrorCategory.RateLimit,
      code: RateLimitErrorCode.RATE_LIMITED,
      message: SENTINEL,
      service: ErrorService.Locks,
      operation: 'postLifecycle',
      context: { statusCode: 429, retryAfter: 30 },
    });
    expect(locksSubmitRefusalMessage(limited, FALLBACK)).toBe(LOCKS_SUBMIT_RATE_LIMITED_COPY);
  });

  it.each([
    ['an unknown Lock Server code', refusal('some_future_code')],
    ['a server error with no code', refusal('', { locksCode: undefined, statusCode: 500 })],
    [
      'a server fault',
      new AppError({
        category: ErrorCategory.Server,
        code: ServerErrorCode.INTERNAL_ERROR,
        message: SENTINEL,
        service: ErrorService.Locks,
        operation: 'postLifecycle',
        context: { statusCode: 500 },
      }),
    ],
    ['a thrown string', SENTINEL],
    ['a plain object', { code: 'invalid_request', message: SENTINEL }],
    ['null', null],
  ])('falls back to the generic copy for %s', (_label, error) => {
    expect(locksSubmitRefusalMessage(error, FALLBACK)).toBe(FALLBACK);
  });

  it('never carries server text into any copy', () => {
    for (const copy of [...Object.values(LOCKS_SUBMIT_REFUSAL_COPY), LOCKS_SUBMIT_RATE_LIMITED_COPY]) {
      expect(copy).not.toMatch(/[a-z]+_[a-z_]+/);
      expect(copy).not.toMatch(/Lock Server|Paykit server|HTTP|\b4\d\d\b|\b5\d\d\b/);
    }
  });
});
