import { Pulse } from '@synonymdev/pubky-pulse-web';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@/libs/logger/logger';
import { AppError } from './error';
import { ServerErrorCode } from './error.codes';
import { Err } from './error.factories';
import { ErrorCategory, ErrorService } from './error.types';

// Fresh module registry so the SDK mock below reaches error.factories, already imported by env.ts.
vi.hoisted(() => vi.resetModules());
vi.mock('@synonymdev/pubky-pulse-web', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@synonymdev/pubky-pulse-web')>()),
  Pulse: { captureException: vi.fn() },
}));

describe('Err factories', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(Pulse.captureException).mockReset();
  });

  it('still returns the AppError when Pulse.captureException throws', () => {
    const pulseError = new Error('pulse sdk exploded');
    vi.mocked(Pulse.captureException).mockImplementation(() => {
      throw pulseError;
    });
    vi.spyOn(Logger, 'error').mockImplementation(() => {});
    const loggerWarnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    const error = Err.server(ServerErrorCode.SERVICE_UNAVAILABLE, 'Service unavailable', {
      service: ErrorService.Marketplace,
      operation: 'pulseGuard',
    });

    expect(error).toBeInstanceOf(AppError);
    expect(error.category).toBe(ErrorCategory.Server);
    expect(error.code).toBe(ServerErrorCode.SERVICE_UNAVAILABLE);
    expect(Pulse.captureException).toHaveBeenCalledWith(error);
    expect(loggerWarnSpy).toHaveBeenCalledWith('[Err.factory] Pulse.captureException failed', pulseError);
  });
});
