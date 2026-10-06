import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/libs/error/error';
import { AuthErrorCode } from '@/libs/error/error.codes';
import { isAuthError, isWritePathNotAllowedError, requiresLogin } from '@/libs/error/error.utils';
import { Logger } from '@/libs/logger/logger';
import { handleError } from './error.utils';

// Captured 2026-09-24 from @synonymdev/pubky 0.11.0 `session.storage.putJson` on
// homeserver.pubky.app for a Homegate IP-signup account (grant and root cookie
// sessions alike): PUT /pub/pubky.app/profile.json.
const writePathForbidden = Object.assign(
  new Error('Request failed: Server responded with an error: 403 Forbidden - Write to this path is not allowed'),
  { name: 'RequestError', data: { statusCode: 403 } },
);

// pubky-homeserver `authorization.rs` 403 for a session whose capabilities do not cover the path.
const capabilityForbidden = Object.assign(
  new Error(
    'Request failed: Server responded with an error: 403 Forbidden - Session does not have write access to path',
  ),
  { name: 'RequestError', data: { statusCode: 403 } },
);

function mapped(error: unknown): AppError {
  vi.spyOn(Logger, 'error').mockImplementation(() => {});
  try {
    handleError({ error, additionalContext: { url: 'pubky://u/pub/pubky.app/profile.json', method: 'PUT' } });
  } catch (appError) {
    return appError as AppError;
  }
  throw new Error('handleError did not throw');
}

describe('homeserver write-path 403', () => {
  it('the account allow-list 403 maps to an auth error the profile form can name', () => {
    const error = mapped(writePathForbidden);

    expect(isAuthError(error)).toBe(true);
    expect(error.code).toBe(AuthErrorCode.FORBIDDEN);
    expect(requiresLogin(error)).toBe(false);
    expect(isWritePathNotAllowedError(error)).toBe(true);
  });

  it('a capability 403 is not reported as an account restriction', () => {
    const error = mapped(capabilityForbidden);

    expect(isAuthError(error)).toBe(true);
    expect(isWritePathNotAllowedError(error)).toBe(false);
  });
});
