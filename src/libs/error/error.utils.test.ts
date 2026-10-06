import { afterEach, describe, expect, it } from 'vitest';
import { resetRuntimeConfigForTests } from '@/libs/runtime-config/runtime-config';
import { PUBKY_RUNTIME_ENV_NAMES } from '@/libs/runtime-config/runtime-config.schema';
import { AppError } from './error';
import { AuthErrorCode } from './error.codes';
import { ErrorCategory, ErrorService } from './error.types';
import { getWrongEnvironmentHomeserverMessage, isMarketplaceSessionRequiredError } from './error.utils';

describe('getWrongEnvironmentHomeserverMessage', () => {
  afterEach(() => {
    delete process.env[PUBKY_RUNTIME_ENV_NAMES.deployEnv];
    resetRuntimeConfigForTests();
  });

  it('names the staging account requirement when the deploy is staging', () => {
    process.env[PUBKY_RUNTIME_ENV_NAMES.deployEnv] = 'staging';
    resetRuntimeConfigForTests();

    expect(getWrongEnvironmentHomeserverMessage()).toBe(
      'This key is linked to a different homeserver. Use a staging account on this site.',
    );
  });

  it('names the production account requirement when the deploy is production', () => {
    process.env[PUBKY_RUNTIME_ENV_NAMES.deployEnv] = 'production';
    resetRuntimeConfigForTests();

    expect(getWrongEnvironmentHomeserverMessage()).toBe(
      'This key is linked to a different homeserver. Use a production account on this site.',
    );
  });
});

describe('isMarketplaceSessionRequiredError', () => {
  it('matches marketplace SESSION_EXPIRED, UNAUTHORIZED, and HTTP 401', () => {
    const expired = new AppError({
      category: ErrorCategory.Auth,
      code: AuthErrorCode.SESSION_EXPIRED,
      message: 'expired',
      service: ErrorService.Marketplace,
      operation: 'getDrop',
    });
    const unauthorized = new AppError({
      category: ErrorCategory.Auth,
      code: AuthErrorCode.UNAUTHORIZED,
      message: 'unauthorized',
      service: ErrorService.Marketplace,
      operation: 'getDrop',
      context: { statusCode: 401 },
    });
    const http401 = new AppError({
      category: ErrorCategory.Auth,
      code: AuthErrorCode.FORBIDDEN,
      message: 'rejected',
      service: ErrorService.Marketplace,
      operation: 'getDrop',
      context: { statusCode: 401 },
    });

    expect(isMarketplaceSessionRequiredError(expired)).toBe(true);
    expect(isMarketplaceSessionRequiredError(unauthorized)).toBe(true);
    expect(isMarketplaceSessionRequiredError(http401)).toBe(true);
  });

  it('does not match homeserver auth errors or marketplace 404', () => {
    const homeserver = new AppError({
      category: ErrorCategory.Auth,
      code: AuthErrorCode.UNAUTHORIZED,
      message: 'sign-in failed',
      service: ErrorService.Homeserver,
      operation: 'signin',
    });
    const forbidden = new AppError({
      category: ErrorCategory.Auth,
      code: AuthErrorCode.FORBIDDEN,
      message: 'wrong pubky',
      service: ErrorService.Marketplace,
      operation: 'getDrop',
      context: { statusCode: 403 },
    });

    expect(isMarketplaceSessionRequiredError(homeserver)).toBe(false);
    expect(isMarketplaceSessionRequiredError(forbidden)).toBe(false);
    expect(isMarketplaceSessionRequiredError(new Error('network'))).toBe(false);
  });
});
