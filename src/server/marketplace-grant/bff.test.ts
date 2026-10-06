/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BffError, mapBffError, sessionPairSchema } from './bff';
import { GrantServiceError } from './service';

const legacySessionId = 'c91ac604-4109-a63d-ab8b-327fc9decd05';
const pubky = 'y'.repeat(52);

describe('session pair body', () => {
  it('revert-fail: pair body accepts a migration-0035 session id that z.uuid() rejects', () => {
    expect(z.uuid().safeParse(legacySessionId).success).toBe(false);
    expect(sessionPairSchema.safeParse({ pubky, session_id: legacySessionId }).success).toBe(true);
  });

  it.each([
    ['plain string', 'shop-session-id-plain-string-1234567'],
    ['uppercase', 'C91AC604-4109-A63D-AB8B-327FC9DECD05'],
    ['without hyphens', 'c91ac6044109a63dab8b327fc9decd05'],
    ['empty', ''],
    ['newline', 'abc\n'],
    ['nul', 'ab\u0000c'],
    ['del', 'ab\u007Fc'],
  ])('rejects a session id that is %s', (_label, sessionId) => {
    expect(sessionPairSchema.safeParse({ pubky, session_id: sessionId }).success).toBe(false);
  });
});

describe('mapBffError', () => {
  it('passes BffError status and code through unchanged', () => {
    expect(mapBffError(new BffError(401, 'shop_session_expired'))).toEqual({
      status: 401,
      code: 'shop_session_expired',
    });
  });

  it('maps a GrantServiceError 401 to HTTP 401 shop_session_expired', () => {
    expect(mapBffError(new GrantServiceError(401, 'invalid_session_pair'))).toEqual({
      status: 401,
      code: 'shop_session_expired',
    });
  });

  it('maps a GrantServiceError 403 to HTTP 401 shop_session_expired', () => {
    expect(mapBffError(new GrantServiceError(403, 'invalid_session_pair'))).toEqual({
      status: 401,
      code: 'shop_session_expired',
    });
  });

  it('maps identity_mismatch 409 through', () => {
    expect(mapBffError(new GrantServiceError(409, 'identity_mismatch'))).toEqual({
      status: 409,
      code: 'identity_mismatch',
    });
  });

  it('maps GrantServiceError 429 to retry_later', () => {
    expect(mapBffError(new GrantServiceError(429, 'slow_down'))).toEqual({
      status: 429,
      code: 'retry_later',
      retryAfterSeconds: 60,
    });
  });

  it('maps GrantServiceError 410 with the service code', () => {
    expect(mapBffError(new GrantServiceError(410, 'flow_gone'))).toEqual({
      status: 410,
      code: 'flow_gone',
    });
  });

  it('maps GrantServiceError 422 to approval_invalid', () => {
    expect(mapBffError(new GrantServiceError(422, 'bad_assertion'))).toEqual({
      status: 422,
      code: 'approval_invalid',
    });
  });

  it('maps GrantServiceError 5xx to 503 grant_unavailable', () => {
    expect(mapBffError(new GrantServiceError(502, 'bad_gateway'))).toEqual({
      status: 503,
      code: 'grant_unavailable',
    });
  });

  it('maps unreachable service failures to 503 grant_unavailable', () => {
    expect(mapBffError(new TypeError('fetch failed'))).toEqual({
      status: 503,
      code: 'grant_unavailable',
    });
  });
});
