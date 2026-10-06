import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRuntimeConfigForTests, RUNTIME_CONFIG_WINDOW_KEY } from '@/libs/runtime-config/runtime-config';
import { PUBKY_RUNTIME_ENV_NAMES } from '@/libs/runtime-config/runtime-config.schema';

vi.mock('@sentry/nextjs', () => ({
  captureRouterTransitionStart: vi.fn(),
  init: vi.fn(),
  replayIntegration: vi.fn(),
}));

vi.mock('@/libs/observability/sentry', () => ({
  getSentryInitBase: vi.fn(() => ({})),
  shouldEnableSentry: vi.fn(() => false),
}));

describe('instrumentation-client runtime config warning', () => {
  beforeEach(() => {
    vi.resetModules();
    resetRuntimeConfigForTests();
    delete window[RUNTIME_CONFIG_WINDOW_KEY];
  });

  afterEach(() => {
    delete process.env[PUBKY_RUNTIME_ENV_NAMES.deployEnv];
    delete window[RUNTIME_CONFIG_WINDOW_KEY];
    resetRuntimeConfigForTests();
    vi.restoreAllMocks();
  });

  it('reports the fallback deploy defaults when runtime config is missing', async () => {
    process.env[PUBKY_RUNTIME_ENV_NAMES.deployEnv] = 'production';
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await import('./instrumentation-client');

    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('resolves to production defaults and client Sentry stays disabled'),
    );
  });
});
