import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SpanJSON, TransactionEvent } from '@sentry/core';
import * as Sentry from '@sentry/nextjs';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/libs/error/error';
import { AuthErrorCode, ClientErrorCode, ServerErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { HttpStatusCode } from '@/libs/http/http.types';
import { RUNTIME_CONFIG_WINDOW_KEY } from '@/libs/runtime-config/runtime-config';
import { NETWORK_RUNTIME_DEFAULTS } from '@/libs/runtime-config/runtime-config.schema';
import { asOpaque } from '@/test-utils/type-assertions';
import { getSentryInitBase } from './sentry';
import {
  SENTRY_LIMIT_REDACTED,
  SENTRY_REDACTION_MAX_DEPTH,
  SENTRY_REDACTION_MAX_NODES,
  SENTRY_REDACTION_MAX_STRING_LENGTH,
} from './sentry.constants';
import { shouldDropAppErrorFromSentry } from './sentry.utils';

const TEST_PUBKY = 'ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy';

const TEST_DSN = 'https://public@example.com/1';
const SENTRY_ATTACHMENT_SAFE_POLICY_MARKER = 'sentry-attachment-safe-policy';
const SENTRY_ATTACHMENT_PATTERNS = [
  /\bSentry\.addAttachment\s*\(/,
  /\bscope\.addAttachment\s*\(/,
  /\baddAttachment\s*\(/,
  /\b(?:captureException|captureEvent|captureMessage)\s*\([\s\S]*?,\s*\{[\s\S]*?\battachments\s*:/,
] as const;

function getProductionSourceFiles(): string[] {
  const sourceRoot = join(process.cwd(), 'src');
  return readdirSync(sourceRoot, { recursive: true })
    .filter(
      (path): path is string =>
        typeof path === 'string' && /\.(?:ts|tsx)$/.test(path) && !/\.test\.[tj]sx?$/.test(path),
    )
    .map((path) => join(sourceRoot, path));
}

function hasUnallowlistedAttachmentProducer(source: string): boolean {
  return (
    SENTRY_ATTACHMENT_PATTERNS.some((pattern) => pattern.test(source)) &&
    !source.includes(SENTRY_ATTACHMENT_SAFE_POLICY_MARKER)
  );
}

/**
 * Inject a window runtime config (the client-side source the sentry gates read).
 * Returns a cleanup that removes the injection again.
 */
function injectRuntimeConfig(overrides: Record<string, unknown> = {}): () => void {
  window[RUNTIME_CONFIG_WINDOW_KEY] = {
    ...NETWORK_RUNTIME_DEFAULTS,
    testnet: false,
    sentryDsn: TEST_DSN,
    sentryEnvironment: 'production',
    sentryTracesSampleRate: 0,
    ...overrides,
  };
  return () => {
    delete window[RUNTIME_CONFIG_WINDOW_KEY];
  };
}

function runBeforeSend(event: Sentry.ErrorEvent, hint: Sentry.EventHint = {}): Sentry.ErrorEvent {
  const beforeSend = getSentryInitBase().beforeSend;

  expect(beforeSend).toBeTypeOf('function');

  const result = beforeSend!(event, hint);

  expect(result).not.toBeNull();
  return result as Sentry.ErrorEvent;
}

function runBeforeSendDroppable(event: Sentry.ErrorEvent, hint: Sentry.EventHint = {}): Sentry.ErrorEvent | null {
  const beforeSend = getSentryInitBase().beforeSend;

  expect(beforeSend).toBeTypeOf('function');
  return beforeSend!(event, hint) as Sentry.ErrorEvent | null;
}

function runBeforeBreadcrumb(breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb {
  const beforeBreadcrumb = getSentryInitBase().beforeBreadcrumb;

  expect(beforeBreadcrumb).toBeTypeOf('function');

  const result = beforeBreadcrumb!(breadcrumb);

  expect(result).not.toBeNull();
  return result as Sentry.Breadcrumb;
}

function runBeforeSendTransaction(event: TransactionEvent): TransactionEvent {
  const beforeSendTransaction = getSentryInitBase().beforeSendTransaction;

  expect(beforeSendTransaction).toBeTypeOf('function');

  const result = beforeSendTransaction!(event, {} as Sentry.EventHint);

  expect(result).not.toBeNull();
  return result as TransactionEvent;
}

function runBeforeSendSpan(span: SpanJSON): SpanJSON {
  const beforeSendSpan = getSentryInitBase().beforeSendSpan;

  expect(beforeSendSpan).toBeTypeOf('function');

  return beforeSendSpan!(span);
}

async function withEnabledSentryCapture(
  run: (params: {
    captureAppError: (error: AppError) => void;
    captureException: ReturnType<typeof vi.fn>;
    capturedEvents: Sentry.ErrorEvent[];
  }) => void,
) {
  vi.resetModules();

  const capturedEvents: Sentry.ErrorEvent[] = [];
  type MockScope = {
    setTag: ReturnType<typeof vi.fn>;
    setContext: ReturnType<typeof vi.fn>;
  };
  const scope = {
    setTag: vi.fn(),
    setContext: vi.fn(),
  } satisfies MockScope;
  const withScope = vi.fn((callback: (scope: MockScope) => void) => callback(scope));
  const captureException = vi.fn(() => {
    const capturedEvent = runBeforeSend(
      asOpaque<Sentry.ErrorEvent>({
        breadcrumbs: [
          { message: 'Packing slip rendered', data: { deliveryAddress: '1 Market Street / New York / 10001' } },
        ],
        extra: { deliveryAddress: { line1: '1 Market Street / New York / 10001' } },
        contexts: { 'error.context': scope.setContext.mock.calls[0]?.[1] },
      }),
    );
    capturedEvents.push(capturedEvent);
  });

  vi.doMock('@sentry/nextjs', () => ({
    withScope,
    captureException,
  }));
  vi.doMock('@/libs/env/env', () => ({
    Env: {
      NODE_ENV: 'production',
      VITEST: undefined,
      NEXT_PUBLIC_APP_VERSION: 'test',
    },
  }));
  // DSN + testnet gates read the runtime config (fresh module after resetModules).
  const removeRuntimeConfig = injectRuntimeConfig();

  try {
    const { captureAppError } = await import('./sentry');
    run({ captureAppError, captureException, capturedEvents });
  } finally {
    removeRuntimeConfig();
    vi.doUnmock('@sentry/nextjs');
    vi.doUnmock('@/libs/env/env');
    vi.resetModules();
  }
}

function createCapturedAppError({
  code,
  statusCode,
  endpoint,
  service = ErrorService.Nexus,
  operation = 'fetchNexus',
}: {
  code: ClientErrorCode;
  statusCode: number;
  endpoint: string;
  service?: ErrorService;
  operation?: string;
}): AppError {
  return new AppError({
    category: ErrorCategory.Client,
    code,
    message: 'Not Found',
    service,
    operation,
    context: { endpoint, statusCode },
  });
}

/**
 * Import a fresh ./sentry with Env mocked to a deployed shape (NODE_ENV=production, not Vitest)
 * so the runtime-config gates are actually exercised instead of short-circuiting on test guards.
 */
async function withProdEnvSentry(run: (mod: typeof import('./sentry')) => void | Promise<void>): Promise<void> {
  vi.resetModules();
  vi.doMock('@/libs/env/env', () => ({
    Env: {
      NODE_ENV: 'production',
      VITEST: undefined,
      NEXT_PUBLIC_APP_VERSION: 'test',
    },
  }));

  try {
    const mod = await import('./sentry');
    await run(mod);
  } finally {
    vi.doUnmock('@/libs/env/env');
    vi.resetModules();
  }
}

describe('shouldEnableSentry', () => {
  it('is disabled when the runtime config sets testnet=true (single image switched at runtime)', async () => {
    const removeRuntimeConfig = injectRuntimeConfig({ testnet: true });
    try {
      await withProdEnvSentry(({ shouldEnableSentry }) => {
        expect(shouldEnableSentry()).toBe(false);
      });
    } finally {
      removeRuntimeConfig();
    }
  });

  it('is disabled when no runtime DSN is configured', async () => {
    const removeRuntimeConfig = injectRuntimeConfig({ sentryDsn: undefined });
    try {
      await withProdEnvSentry(({ shouldEnableSentry }) => {
        expect(shouldEnableSentry()).toBe(false);
      });
    } finally {
      removeRuntimeConfig();
    }
  });

  it('is enabled when a runtime DSN is configured and testnet is false', async () => {
    const removeRuntimeConfig = injectRuntimeConfig();
    try {
      await withProdEnvSentry(({ shouldEnableSentry, getSentryInitBase: initBase }) => {
        expect(shouldEnableSentry()).toBe(true);
        expect(initBase().dsn).toBe(TEST_DSN);
        expect(initBase().environment).toBe('production');
      });
    } finally {
      removeRuntimeConfig();
    }
  });

  it('returns false instead of throwing when the runtime config cannot be resolved', async () => {
    // Deployed/required mode with neither a window injection nor PUBKY_RUNTIME_* set:
    // config resolution throws, and the capture funnel must swallow that (never mask the
    // original boot error with its own).
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITEST', '');
    try {
      await withProdEnvSentry(({ shouldEnableSentry }) => {
        expect(() => shouldEnableSentry()).not.toThrow();
        expect(shouldEnableSentry()).toBe(false);
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('delivery address telemetry protection', () => {
  it('removes distinctive addresses from captured error events', async () => {
    const distinctiveAddress = '1 Market Street / New York / 10001';

    await withEnabledSentryCapture(({ captureAppError, captureException, capturedEvents }) => {
      captureAppError(
        new AppError({
          category: ErrorCategory.Client,
          code: ClientErrorCode.BAD_REQUEST,
          message: 'Packing slip failed',
          service: ErrorService.Marketplace,
          operation: 'renderPackingSlip',
          context: { deliveryAddress: distinctiveAddress },
        }),
      );

      expect(captureException).toHaveBeenCalledTimes(1);
      expect(capturedEvents).toHaveLength(1);
      expect(JSON.stringify(capturedEvents[0])).not.toContain(distinctiveAddress);
    });
  });

  it('rejects unallowlisted production Sentry attachment producers', () => {
    const productionSources = getProductionSourceFiles();
    const rejectedAttachmentFixture = 'scope.addAttachment(file)';

    expect(hasUnallowlistedAttachmentProducer(rejectedAttachmentFixture)).toBe(true);
    expect(productionSources).not.toHaveLength(0);
    expect(productionSources.filter((path) => hasUnallowlistedAttachmentProducer(readFileSync(path, 'utf8')))).toEqual(
      [],
    );
  });
});

describe('captureAppError filtering', () => {
  it('keeps OG metadata fetch errors reportable unless handled before Err creation', async () => {
    await withEnabledSentryCapture(({ captureAppError, captureException }) => {
      const error = new AppError({
        category: ErrorCategory.Server,
        code: ServerErrorCode.UNKNOWN_ERROR,
        message: 'OG metadata failed',
        service: ErrorService.NextJsServer,
        operation: 'fetchOgMetadata',
        context: { statusCode: HttpStatusCode.INTERNAL_SERVER_ERROR },
      });

      captureAppError(error);

      expect(shouldDropAppErrorFromSentry(error)).toBe(false);
      expect(captureException).toHaveBeenCalledWith(error);
    });
  });

  it('keeps OG metadata SSRF guard errors reportable', async () => {
    await withEnabledSentryCapture(({ captureAppError, captureException }) => {
      const error = new AppError({
        category: ErrorCategory.Auth,
        code: AuthErrorCode.FORBIDDEN,
        message: 'Blocked IP range',
        service: ErrorService.NextJsServer,
        operation: 'checkDnsSafety',
        context: { hostname: '169.254.169.254', statusCode: HttpStatusCode.FORBIDDEN },
      });

      captureAppError(error);

      expect(shouldDropAppErrorFromSentry(error)).toBe(false);
      expect(captureException).toHaveBeenCalledWith(error);
    });
  });

  it('drops Nexus fetchNexus post-tags 404 errors', async () => {
    await withEnabledSentryCapture(({ captureAppError, captureException }) => {
      const error = createCapturedAppError({
        code: ClientErrorCode.NOT_FOUND,
        statusCode: HttpStatusCode.NOT_FOUND,
        endpoint: `https://nexus.pubky.app/v0/post/${TEST_PUBKY}/003544WKXXGQG/tags?skip_tags=0&limit_tags=3`,
      });

      captureAppError(error);

      expect(shouldDropAppErrorFromSentry(error)).toBe(true);
      expect(captureException).not.toHaveBeenCalled();
    });
  });

  it('keeps full post 404 errors reportable', async () => {
    await withEnabledSentryCapture(({ captureAppError, captureException }) => {
      const error = createCapturedAppError({
        code: ClientErrorCode.NOT_FOUND,
        statusCode: HttpStatusCode.NOT_FOUND,
        endpoint: `https://nexus.pubky.app/v0/post/${TEST_PUBKY}/003544WKXXGQG`,
      });

      captureAppError(error);

      expect(shouldDropAppErrorFromSentry(error)).toBe(false);
      expect(captureException).toHaveBeenCalledWith(error);
    });
  });

  it('does not drop post-tags bad requests', async () => {
    await withEnabledSentryCapture(({ captureAppError, captureException }) => {
      const error = createCapturedAppError({
        code: ClientErrorCode.BAD_REQUEST,
        statusCode: HttpStatusCode.BAD_REQUEST,
        endpoint: `https://nexus.pubky.app/v0/post/${TEST_PUBKY}/003544WKXXGQG/tags?skip_tags=-1`,
      });

      captureAppError(error);

      expect(shouldDropAppErrorFromSentry(error)).toBe(false);
      expect(captureException).toHaveBeenCalledWith(error);
    });
  });

  it('does not drop non-Nexus post-tags 404 errors', () => {
    const error = createCapturedAppError({
      code: ClientErrorCode.NOT_FOUND,
      statusCode: HttpStatusCode.NOT_FOUND,
      endpoint: `https://nexus.pubky.app/v0/post/${TEST_PUBKY}/003544WKXXGQG/tags`,
      service: ErrorService.Homeserver,
    });

    expect(shouldDropAppErrorFromSentry(error)).toBe(false);
  });

  it('does not drop non-fetchNexus post-tags 404 errors', () => {
    const error = createCapturedAppError({
      code: ClientErrorCode.NOT_FOUND,
      statusCode: HttpStatusCode.NOT_FOUND,
      endpoint: `https://nexus.pubky.app/v0/post/${TEST_PUBKY}/003544WKXXGQG/tags`,
      operation: 'fetchNexusWithExpectedStatus',
    });

    expect(shouldDropAppErrorFromSentry(error)).toBe(false);
  });
});

describe('Sentry PII scrubbing', () => {
  it('strips every sensitive field from EventHint data carriers before sending', () => {
    const sensitiveFields = {
      accessToken: 'access-token',
      apiKey: 'api-key',
      auth: 'basic secret',
      authorization: 'Bearer access-token',
      avatar: 'avatar.png',
      bio: 'private bio',
      clientSecret: 'client-secret',
      cookie: 'session=value',
      credential: 'credential',
      credentials: 'credentials',
      displayName: 'Alice',
      email: 'alice@example.com',
      file: 'passport.png',
      firstName: 'Alice',
      image: 'avatar.png',
      key: 'private-key',
      lastName: 'Example',
      name: 'Alice Example',
      passwd: 'password',
      password: 'password',
      phone: '+1 555-123-4567',
      phoneNumber: '+1 555-123-4567',
      privateKey: 'private-key',
      publicKey: TEST_PUBKY,
      pubky: TEST_PUBKY,
      refreshToken: 'refresh-token',
      secret: 'secret',
      secretKey: 'secret-key',
      sessionToken: 'session-token',
      setCookie: 'session=value',
      signature: 'signature',
      token: 'token',
      user: 'alice',
      userId: TEST_PUBKY,
      username: 'alice',
      'X-Api-Key': 'api-key',
      author: TEST_PUBKY,
      authorId: TEST_PUBKY,
      followee: TEST_PUBKY,
      follower: TEST_PUBKY,
      mutee: TEST_PUBKY,
      muter: TEST_PUBKY,
      taggerId: TEST_PUBKY,
    };
    const redactedFields = Object.fromEntries(
      Object.keys(sensitiveFields).map((key) => [key, '[redacted: sensitive field]']),
    );
    const hint = asOpaque<Sentry.EventHint>({
      data: { ...sensitiveFields },
      captureContext: { extra: { ...sensitiveFields } },
      originalException: { ...sensitiveFields },
      attachments: [
        { filename: 'alice@example.com.txt', data: '{"token":"secret"}' },
        { filename: 'opaque.bin', data: new Uint8Array([1, 2, 3]) },
      ],
      syntheticException: new Error('Bearer secret-token'),
    });

    runBeforeSend(asOpaque<Sentry.ErrorEvent>({ message: 'safe error' }), hint);

    expect(hint.data).toEqual(redactedFields);
    expect(hint.captureContext).toEqual({ extra: redactedFields });
    expect(hint.originalException).toEqual(redactedFields);
    expect(hint.attachments).toEqual([]);
    expect(hint.syntheticException).toBeNull();
  });

  it('preserves benign EventHint fields', () => {
    const benignFields = {
      operation: 'profile.fetch',
      requestId: 'req_123',
      retryable: false,
      statusCode: 503,
    };
    const hint = asOpaque<Sentry.EventHint>({
      data: { ...benignFields },
      captureContext: { extra: { ...benignFields } },
      originalException: { ...benignFields },
    });

    runBeforeSend(asOpaque<Sentry.ErrorEvent>({ message: 'safe error' }), hint);

    expect(hint.data).toEqual(benignFields);
    expect(hint.captureContext).toEqual({ extra: benignFields });
    expect(hint.originalException).toEqual(benignFields);
  });

  it('redacts nested case-variant keys inside stringified JSON on event and hint fields', () => {
    const hint = asOpaque<Sentry.EventHint>({
      data: '{"outer":{"ToKeN":"hint-secret"},"statusCode":200}',
      originalException: 'Failed for hint@example.com',
    });
    const event = runBeforeSend(
      asOpaque<Sentry.ErrorEvent>({
        extra: {
          payload: '{"nested":{"AUTHORIZATION":"Bearer event-secret"},"retryable":true}',
        },
      }),
      hint,
    );

    expect(hint.data).toBe('{"outer":{"ToKeN":"[redacted: sensitive field]"},"statusCode":200}');
    expect(hint.originalException).toBe('Failed for [redacted: email]');
    expect(event.extra?.payload).toBe('{"nested":{"AUTHORIZATION":"[redacted: sensitive field]"},"retryable":true}');
  });

  it('redacts sensitive key aliases that are not protocol identifier fields', () => {
    const event = runBeforeSend(
      asOpaque<Sentry.ErrorEvent>({
        extra: {
          auth: 'basic secret',
          Credentials: 'credential secret',
          PASSWD: 'password secret',
          'X-Api-Key': 'api secret',
        },
      }),
    );

    expect(event.extra).toEqual({
      auth: '[redacted: sensitive field]',
      Credentials: '[redacted: sensitive field]',
      PASSWD: '[redacted: sensitive field]',
      'X-Api-Key': '[redacted: sensitive field]',
    });
  });

  it('fails closed for unknown non-plain and function-valued event and hint shapes', () => {
    class UnsupportedPayload {
      token = 'class-secret';
    }

    const hint = asOpaque<Sentry.EventHint>({
      data: () => 'function-secret',
      captureContext: new UnsupportedPayload(),
      originalException: new Error('error-secret', { cause: new Error('cause-secret') }),
    });
    const event = runBeforeSend(
      asOpaque<Sentry.ErrorEvent>({
        extra: {
          date: new Date('2026-09-19T00:00:00.000Z'),
          instance: new UnsupportedPayload(),
        },
      }),
      hint,
    );

    expect(hint.data).toBe('[redacted: sensitive field]');
    expect(hint.captureContext).toBe('[redacted: sensitive field]');
    expect(hint.originalException).toBe('[redacted: sensitive field]');
    expect(event.extra).toEqual({
      date: '[redacted: sensitive field]',
      instance: '[redacted: sensitive field]',
    });
  });

  it('bounds depth, node count, and string length with fail-closed limit markers', () => {
    let deeplyNested: unknown = { token: 'deep-secret' };
    for (let depth = 0; depth <= SENTRY_REDACTION_MAX_DEPTH; depth += 1) {
      deeplyNested = { child: deeplyNested };
    }

    const widePayload = Array.from({ length: SENTRY_REDACTION_MAX_NODES + 10 }, (_, index) => `node-${index}`);
    const oversizedString = 'x'.repeat(SENTRY_REDACTION_MAX_STRING_LENGTH + 1);

    const depthEvent = runBeforeSend(asOpaque<Sentry.ErrorEvent>({ extra: { deeplyNested } }));
    const nodeEvent = runBeforeSend(asOpaque<Sentry.ErrorEvent>({ extra: { widePayload } }));
    const stringEvent = runBeforeSend(asOpaque<Sentry.ErrorEvent>({ extra: { oversizedString } }));

    expect(JSON.stringify(depthEvent.extra)).toContain(SENTRY_LIMIT_REDACTED);
    expect(JSON.stringify(depthEvent.extra)).not.toContain('deep-secret');
    expect(nodeEvent.extra?.widePayload).toBe(SENTRY_LIMIT_REDACTED);
    expect(stringEvent.extra?.oversizedString).toBe(SENTRY_LIMIT_REDACTED);
  });

  it('drops events when getters or proxies throw during sanitization', () => {
    const throwingGetter = {
      get safe(): string {
        throw new Error('getter probe');
      },
    };
    const throwingProxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('proxy probe');
        },
      },
    );

    expect(() => runBeforeSendDroppable(asOpaque<Sentry.ErrorEvent>({ extra: throwingGetter }))).not.toThrow();
    expect(runBeforeSendDroppable(asOpaque<Sentry.ErrorEvent>({ extra: throwingGetter }))).toBeNull();
    expect(() => runBeforeSendDroppable(asOpaque<Sentry.ErrorEvent>({ extra: throwingProxy }))).not.toThrow();
    expect(runBeforeSendDroppable(asOpaque<Sentry.ErrorEvent>({ extra: throwingProxy }))).toBeNull();
  });

  it('redacts NFKC, zero-width, combining-mark, and Cyrillic homoglyph key bypasses', () => {
    const event = runBeforeSend(
      asOpaque<Sentry.ErrorEvent>({
        extra: {
          ｔｏｋｅｎ: 'fullwidth-secret',
          'to\u200bken': 'zero-width-secret',
          'to\u0301ken': 'combining-secret',
          tоken: 'cyrillic-secret',
        },
      }),
    );

    expect(event.extra).toEqual({
      ｔｏｋｅｎ: '[redacted: sensitive field]',
      'to\u200bken': '[redacted: sensitive field]',
      'to\u0301ken': '[redacted: sensitive field]',
      tоken: '[redacted: sensitive field]',
    });
  });

  it('handles circular event payloads without throwing or retaining the cycle', () => {
    const circular: Record<string, unknown> = { token: 'cycle-secret' };
    circular.self = circular;

    const event = runBeforeSend(asOpaque<Sentry.ErrorEvent>({ extra: circular }));

    expect(event.extra?.token).toBe('[redacted: sensitive field]');
    expect(event.extra?.self).toBe('[redacted: circular reference]');
  });

  it('covers every event carrier with a sensitive value while preserving SDK contexts', () => {
    const event = runBeforeSend(
      asOpaque<Sentry.ErrorEvent>({
        message: 'Contact event@example.com',
        exception: { values: [{ type: 'Error', value: `Failed for ${TEST_PUBKY}` }] },
        breadcrumbs: [{ data: { ToKeN: 'breadcrumb-secret' } }],
        contexts: {
          browser: { name: 'Chrome', version: '123' },
          custom: { AuThOrIzAtIoN: 'Bearer context-secret' },
        },
        extra: { SeCrEt: 'extra-secret' },
        request: { headers: { AUTHORIZATION: 'Bearer request-secret' } },
        user: { email: 'user@example.com' },
      }),
    );

    expect(event.message).toBe('Contact [redacted: email]');
    expect(event.exception?.values?.[0]?.value).toBe('Failed for [redacted: pubky identifier]');
    expect(event.breadcrumbs?.[0]?.data?.ToKeN).toBe('[redacted: sensitive field]');
    expect(event.contexts?.custom?.AuThOrIzAtIoN).toBe('[redacted: sensitive field]');
    expect(event.contexts?.browser).toEqual({ name: 'Chrome', version: '123' });
    expect(event.extra?.SeCrEt).toBe('[redacted: sensitive field]');
    expect(event.request?.headers?.AUTHORIZATION).toBe('[redacted: sensitive field]');
    expect(event.user?.email).toBe('[redacted: sensitive field]');
  });

  it.each([
    [
      'tags',
      { token: 'tag-secret', 'error.category': 'network' },
      { token: '[redacted: sensitive field]', 'error.category': 'network' },
    ],
    ['fingerprint', ['user@example.com', '{{ default }}'], ['[redacted: email]', '{{ default }}']],
    [
      'threads',
      { values: [{ name: 'user@example.com', current: true }] },
      { values: [{ name: '[redacted: sensitive field]', current: true }] },
    ],
    [
      'measurements',
      { custom: { value: `pubky://${TEST_PUBKY}/pub/profile.json`, unit: 'none' } },
      { custom: { value: '[redacted: pubky identifier]', unit: 'none' } },
    ],
  ])('walks the %s event carrier', (carrier, raw, expected) => {
    const event = runBeforeSend(asOpaque<Sentry.ErrorEvent>({ [carrier]: raw }));
    expect(asOpaque<Record<string, unknown>>(event)[carrier]).toEqual(expected);
  });

  it('treats cookies plural as a sensitive key', () => {
    const event = runBeforeSend(
      asOpaque<Sentry.ErrorEvent>({
        extra: { cookies: 'session=private', nested: { Cookies: { session: 'private' } }, statusCode: 200 },
        request: { cookies: { session: 'private' }, method: 'GET' },
      }),
    );

    expect(event.extra).toEqual({
      cookies: '[redacted: sensitive field]',
      nested: { Cookies: '[redacted: sensitive field]' },
      statusCode: 200,
    });
    expect(event.request).toEqual({
      cookies: '[redacted: sensitive field]',
      method: 'GET',
    });
  });

  it('redacts identifiers from messages, exception values, and breadcrumb messages', () => {
    const event = runBeforeSend(
      asOpaque<Sentry.ErrorEvent>({
        message: `Failed for pubky://${TEST_PUBKY}/pub/profile.json, john@example.com, +1 555-123-4567`,
        exception: {
          values: [
            {
              type: 'Error',
              value: `Homeserver failed for ${TEST_PUBKY}`,
            },
          ],
        },
        breadcrumbs: [
          {
            message: `Contact john@example.com about pubky://${TEST_PUBKY}/pub/file`,
          },
        ],
      }),
    );

    expect(event.message).toContain('[redacted: pubky identifier]');
    expect(event.message).toContain('[redacted: email]');
    expect(event.message).toContain('[redacted: phone]');
    expect(event.message).not.toContain(TEST_PUBKY);
    expect(event.message).not.toContain('john@example.com');
    expect(event.message).not.toContain('555-123-4567');

    expect(event.exception?.values?.[0]?.value).toBe('Homeserver failed for [redacted: pubky identifier]');
    expect(event.breadcrumbs?.[0]?.message).toContain('[redacted: email]');
    expect(event.breadcrumbs?.[0]?.message).toContain('[redacted: pubky identifier]');
  });

  it('redacts app-controlled error context while preserving safe operational fields', () => {
    const event = runBeforeSend(
      asOpaque<Sentry.ErrorEvent>({
        contexts: {
          browser: {
            name: 'Chrome',
            version: '123',
          },
          'error.context': {
            statusCode: 422,
            user: {
              name: 'Alice',
              bio: 'Private bio',
              image: 'avatar.png',
            },
            file: {
              name: 'passport.png',
              size: 12345,
            },
            pubky: TEST_PUBKY,
            email: 'alice@example.com',
            phoneNumber: '+1 555-123-4567',
            endpoint: `https://_pubky.${TEST_PUBKY}/pub/pubky.app/profile.json`,
            copyrightEmailField: {
              field: 'email',
              value: 'alice@example.com',
            },
          },
        },
      }),
    );

    const browserContext = event.contexts?.browser as Record<string, unknown>;
    const errorContext = event.contexts?.['error.context'] as Record<string, unknown>;

    expect(browserContext.name).toBe('Chrome');
    expect(errorContext.statusCode).toBe(422);
    expect(errorContext.user).toBe('[redacted: sensitive field]');
    expect(errorContext.file).toBe('[redacted: sensitive field]');
    expect(errorContext.pubky).toBe('[redacted: sensitive field]');
    expect(errorContext.email).toBe('[redacted: sensitive field]');
    expect(errorContext.phoneNumber).toBe('[redacted: sensitive field]');
    expect(errorContext.endpoint).toBe('[redacted: pubky identifier]');
    expect(errorContext.copyrightEmailField).toEqual({
      field: 'email',
      value: '[redacted: sensitive field]',
    });
  });

  it('redacts sensitive keys inside breadcrumb data and extra payloads', () => {
    const event = runBeforeSend(
      asOpaque<Sentry.ErrorEvent>({
        breadcrumbs: [
          {
            message: 'Logger details',
            data: {
              email: 'chatwoot-contact@example.com',
              userId: TEST_PUBKY,
              statusCode: 500,
            },
          },
        ],
        extra: {
          displayName: 'Alice',
          url: `pubky://${TEST_PUBKY}/pub/pubky.app/posts/post-id`,
        },
        request: {
          url: `https://example.com/profile/${TEST_PUBKY}`,
        },
        user: {
          id: TEST_PUBKY,
          email: 'alice@example.com',
        },
      }),
    );

    expect(event.breadcrumbs?.[0]?.data).toEqual({
      email: '[redacted: sensitive field]',
      userId: '[redacted: sensitive field]',
      statusCode: 500,
    });
    expect(event.extra).toEqual({
      displayName: '[redacted: sensitive field]',
      url: '[redacted: pubky identifier]',
    });
    expect(event.request?.url).toBe('https://example.com/profile/[redacted: pubky identifier]');
    expect(event.user).toEqual({
      id: '[redacted: pubky identifier]',
      email: '[redacted: sensitive field]',
    });
  });

  it('strips Wave A conversation= ids and redacts underscore-glued z32 pubkys', () => {
    const seller = TEST_PUBKY;
    const buyer = 'o'.repeat(52);
    const listingId = '0033GVVN22HJ0FYQGZZS8R2BFC';
    const conversationId = `conversation:${seller}_${buyer}_${listingId}`;
    const href = `https://shop.pubky.app/marketplace/messages?conversation=${encodeURIComponent(conversationId)}`;

    const event = runBeforeSend(
      asOpaque<Sentry.ErrorEvent>({
        message: conversationId,
        request: {
          url: href,
          query_string: `conversation=${encodeURIComponent(conversationId)}`,
        },
      }),
    );

    const serialized = JSON.stringify(event);
    expect(event.request?.url).toBe('https://shop.pubky.app/marketplace/messages');
    expect(event.request?.query_string).toBe('');
    expect(event.message).not.toContain(seller);
    expect(event.message).not.toContain(buyer);
    expect(event.message).toContain('[redacted: pubky identifier]');
    expect(serialized).not.toContain('conversation=');
    expect(serialized).not.toContain(seller);
    expect(serialized).not.toContain(buyer);
    expect(serialized).not.toContain(conversationId);
  });
});

describe('Sentry tracing hooks wired into init base', () => {
  it('exposes beforeBreadcrumb as a function on getSentryInitBase()', () => {
    expect(getSentryInitBase().beforeBreadcrumb).toBeTypeOf('function');
  });

  it('exposes beforeSendTransaction as a function on getSentryInitBase()', () => {
    expect(getSentryInitBase().beforeSendTransaction).toBeTypeOf('function');
  });

  it('exposes beforeSendSpan as a function on getSentryInitBase()', () => {
    expect(getSentryInitBase().beforeSendSpan).toBeTypeOf('function');
  });
});

describe('Sentry breadcrumb ingress scrubbing', () => {
  it('redacts breadcrumb messages, nested data, and stringified JSON before storage', () => {
    const breadcrumb = runBeforeBreadcrumb({
      category: 'request',
      message: 'Contact breadcrumb@example.com',
      data: {
        nested: { ReFrEsH_ToKeN: 'breadcrumb-secret' },
        payload: '{"ApiKey":"json-secret","statusCode":200}',
      },
    });

    expect(breadcrumb).toEqual({
      category: 'request',
      message: 'Contact [redacted: email]',
      data: {
        nested: { ReFrEsH_ToKeN: '[redacted: sensitive field]' },
        payload: '{"ApiKey":"[redacted: sensitive field]","statusCode":200}',
      },
    });
  });

  it('preserves benign breadcrumb fields', () => {
    const breadcrumb = {
      category: 'navigation',
      message: 'Opened settings',
      data: { operation: 'settings.open', statusCode: 200, retryable: false },
      level: 'info' as const,
    };

    expect(runBeforeBreadcrumb(breadcrumb)).toEqual(breadcrumb);
  });

  it('drops breadcrumbs when getters or proxies throw during sanitization', () => {
    const beforeBreadcrumb = getSentryInitBase().beforeBreadcrumb;
    const throwingGetter = asOpaque<Sentry.Breadcrumb>({
      category: 'request',
      data: {
        get safe(): string {
          throw new Error('getter probe');
        },
      },
    });
    const throwingProxy = asOpaque<Sentry.Breadcrumb>(
      new Proxy(
        {},
        {
          ownKeys() {
            throw new Error('proxy probe');
          },
        },
      ),
    );

    expect(beforeBreadcrumb).toBeTypeOf('function');
    expect(() => beforeBreadcrumb!(throwingGetter)).not.toThrow();
    expect(beforeBreadcrumb!(throwingGetter)).toBeNull();
    expect(() => beforeBreadcrumb!(throwingProxy)).not.toThrow();
    expect(beforeBreadcrumb!(throwingProxy)).toBeNull();
  });
});

describe('Sentry transaction PII scrubbing', () => {
  it.each([
    [
      'tags',
      { token: 'tag-secret', 'error.category': 'network' },
      { token: '[redacted: sensitive field]', 'error.category': 'network' },
    ],
    ['fingerprint', ['user@example.com', '{{ default }}'], ['[redacted: email]', '{{ default }}']],
    [
      'threads',
      { values: [{ name: 'user@example.com', current: true }] },
      { values: [{ name: '[redacted: sensitive field]', current: true }] },
    ],
    [
      'measurements',
      { custom: { value: `pubky://${TEST_PUBKY}/pub/profile.json`, unit: 'none' } },
      { custom: { value: '[redacted: pubky identifier]', unit: 'none' } },
    ],
  ])('walks the %s event carrier on transaction events', (carrier, raw, expected) => {
    const event = runBeforeSendTransaction(asOpaque<TransactionEvent>({ type: 'transaction', [carrier]: raw }));
    expect(asOpaque<Record<string, unknown>>(event)[carrier]).toEqual(expected);
  });

  it('redacts request.cookies on transaction events while preserving method', () => {
    const event = runBeforeSendTransaction(
      asOpaque<TransactionEvent>({
        type: 'transaction',
        request: { cookies: { session: 'private' }, method: 'GET' },
      }),
    );

    expect(event.request).toEqual({
      cookies: '[redacted: sensitive field]',
      method: 'GET',
    });
  });

  it('redacts pubky-bearing transaction names, request fields, header values, and trace.data URL fields while preserving structural names', () => {
    const event = runBeforeSendTransaction(
      asOpaque<TransactionEvent>({
        type: 'transaction',
        transaction: `GET /profile/${TEST_PUBKY}`,
        request: {
          url: `https://example.com/profile/${TEST_PUBKY}`,
          method: 'GET',
          query_string: `ref=pubky://${TEST_PUBKY}/pub/post`,
          headers: {
            Authorization: 'Bearer transaction-secret',
            'X-Custom-Identity': `bearer ${TEST_PUBKY}`,
            Accept: 'application/json',
          },
        },
        contexts: {
          trace: {
            trace_id: 'abc123',
            span_id: 'def456',
            op: 'pageload',
            status: 'ok',
            data: {
              authorization: 'Bearer trace-secret',
              'url.full': `https://app.pubky.app/profile/${TEST_PUBKY}`,
              'http.url': `https://_pubky.${TEST_PUBKY}/pub/profile.json`,
              'http.response_code': 200,
            },
          },
          browser: { name: 'Chrome', version: '123' },
          runtime: { name: 'node', version: '24' },
          custom: { credentials: 'context-secret' },
        },
        breadcrumbs: [{ message: `Viewed pubky://${TEST_PUBKY}/pub/post`, data: { token: 'crumb-secret' } }],
      }),
    );

    expect(event.transaction).toBe('GET /profile/[redacted: pubky identifier]');

    expect(event.request?.url).toBe('https://example.com/profile/[redacted: pubky identifier]');
    expect(event.request?.method).toBe('GET');
    expect(event.request?.query_string).toBe('ref=[redacted: pubky identifier]');
    expect(event.request?.headers?.['Authorization']).toBe('[redacted: sensitive field]');
    expect(event.request?.headers?.['X-Custom-Identity']).toContain('[redacted: pubky identifier]');
    expect(event.request?.headers?.['Accept']).toBe('application/json');

    const traceCtx = event.contexts?.trace as Record<string, unknown>;
    const traceData = traceCtx?.data as Record<string, unknown>;
    expect(traceData.authorization).toBe('[redacted: sensitive field]');
    expect(traceData['url.full']).toBe('https://app.pubky.app/profile/[redacted: pubky identifier]');
    // PUBKY_HTTP_HOST_PATTERN matches the entire `https://_pubky.<key>/...` URL up to whitespace
    // / quotes / angle brackets, so the path is consumed alongside the host. This is intentional —
    // homeserver URLs are PII end-to-end, not just at the host segment.
    expect(traceData['http.url']).toBe('[redacted: pubky identifier]');
    expect(traceData['http.response_code']).toBe(200);

    expect(traceCtx.trace_id).toBe('abc123');
    expect(traceCtx.span_id).toBe('def456');
    expect(traceCtx.op).toBe('pageload');
    expect(traceCtx.status).toBe('ok');

    const browserCtx = event.contexts?.browser as Record<string, unknown>;
    const runtimeCtx = event.contexts?.runtime as Record<string, unknown>;
    expect(browserCtx.name).toBe('Chrome');
    expect(browserCtx.version).toBe('123');
    expect(runtimeCtx.name).toBe('node');
    expect(runtimeCtx.version).toBe('24');
    expect(event.contexts?.custom?.credentials).toBe('[redacted: sensitive field]');
    expect(event.breadcrumbs?.[0]?.message).toBe('Viewed [redacted: pubky identifier]');
    expect(event.breadcrumbs?.[0]?.data?.token).toBe('[redacted: sensitive field]');
  });

  it('scrubs string-array values inside an opaque runtime query_string payload (defensive — not the typed Sentry contract)', () => {
    // QueryParams in @sentry/core v10.51 is `string | Record<string, string> | Array<[string, string]>`.
    // It does NOT include `Record<string, string[]>`. We use asOpaque to exercise the walker against
    // a runtime payload shape that diverges from the published TS type, since runtime serializers
    // sometimes emit array values for repeated query keys.
    const event = runBeforeSendTransaction(
      asOpaque<TransactionEvent>({
        type: 'transaction',
        request: {
          query_string: { tags: [`pubky://${TEST_PUBKY}/a`, 'safe-tag', `pubky://${TEST_PUBKY}/b`] },
        },
      }),
    );

    const queryArray = asOpaque<{ tags: string[] }>(event.request?.query_string).tags;
    expect(queryArray[0]).toBe('[redacted: pubky identifier]');
    expect(queryArray[1]).toBe('safe-tag');
    expect(queryArray[2]).toBe('[redacted: pubky identifier]');
  });

  it('applies keyed redaction to extra, user, and contexts.error.context when present', () => {
    const event = runBeforeSendTransaction(
      asOpaque<TransactionEvent>({
        type: 'transaction',
        extra: {
          displayName: 'Alice',
          url: `pubky://${TEST_PUBKY}/pub/profile.json`,
        },
        user: {
          id: TEST_PUBKY,
          email: 'alice@example.com',
        },
        contexts: {
          'error.context': {
            statusCode: 500,
            email: 'bob@example.com',
            user: { displayName: 'Bob' },
          },
        },
      }),
    );

    expect(event.extra).toEqual({
      displayName: '[redacted: sensitive field]',
      url: '[redacted: pubky identifier]',
    });
    expect(event.user).toEqual({
      id: '[redacted: pubky identifier]',
      email: '[redacted: sensitive field]',
    });

    const errorContext = event.contexts?.['error.context'] as Record<string, unknown>;
    expect(errorContext.statusCode).toBe(500);
    expect(errorContext.email).toBe('[redacted: sensitive field]');
    expect(errorContext.user).toBe('[redacted: sensitive field]');
  });

  it('does not create absent request, extra, user, or contexts fields', () => {
    const event = runBeforeSendTransaction(
      asOpaque<TransactionEvent>({ type: 'transaction', transaction: 'GET /home' }),
    );

    expect(event.request).toBeUndefined();
    expect(event.extra).toBeUndefined();
    expect(event.user).toBeUndefined();
    expect(event.contexts).toBeUndefined();
  });

  it('does not mutate event.spans (per-span scrubbing is delegated to beforeSendSpan)', () => {
    const childSpan = asOpaque<SpanJSON>({
      trace_id: 't',
      span_id: 's1',
      start_timestamp: 1,
      data: {},
      description: `pubky://${TEST_PUBKY}/pub/x`,
    });
    const event = asOpaque<TransactionEvent>({
      type: 'transaction',
      spans: [childSpan],
    });

    const result = runBeforeSendTransaction(event);

    expect(result.spans).toBe(event.spans);
    expect(result.spans?.[0]).toBe(childSpan);
    expect(childSpan.description).toBe(`pubky://${TEST_PUBKY}/pub/x`);
  });

  it('returns the same event object reference', () => {
    const event = asOpaque<TransactionEvent>({ type: 'transaction', transaction: 'GET /home' });
    expect(runBeforeSendTransaction(event)).toBe(event);
  });
});

describe('Sentry span PII scrubbing', () => {
  it('redacts pubky-bearing description and span.data string fields while preserving structural values', () => {
    const span = runBeforeSendSpan(
      asOpaque<SpanJSON>({
        trace_id: 't',
        span_id: 's',
        start_timestamp: 1,
        description: `GET pubky://${TEST_PUBKY}/pub/post`,
        data: {
          token: 'span-secret',
          'X-Api-Key': 'span-api-secret',
          url: `pubky://${TEST_PUBKY}/pub/x`,
          'http.url': `https://_pubky.${TEST_PUBKY}/pub/x`,
          'http.query': `?author=${TEST_PUBKY}`,
          'http.fragment': `#${TEST_PUBKY}`,
          'http.target': `/profile/${TEST_PUBKY}`,
          'db.statement': `SELECT * FROM posts WHERE author = '${TEST_PUBKY}'`,
          'http.method': 'GET',
          'http.response_code': 200,
          is_segment: true,
        },
      }),
    );

    expect(span.description).toBe('GET [redacted: pubky identifier]');
    const data = span.data as Record<string, unknown>;
    expect(data.token).toBe('[redacted: sensitive field]');
    expect(data['X-Api-Key']).toBe('[redacted: sensitive field]');
    expect(data.url).toBe('[redacted: pubky identifier]');
    // `https://_pubky.<key>/pub/x` is fully consumed by PUBKY_HTTP_HOST_PATTERN — see comment in
    // the transaction test for `http.url`. Path segments after the host are still PII.
    expect(data['http.url']).toBe('[redacted: pubky identifier]');
    expect(data['http.query']).toBe('?author=[redacted: pubky identifier]');
    expect(data['http.fragment']).toBe('#[redacted: pubky identifier]');
    expect(data['http.target']).toBe('/profile/[redacted: pubky identifier]');
    expect(data['db.statement']).toBe("SELECT * FROM posts WHERE author = '[redacted: pubky identifier]'");
    expect(data['http.method']).toBe('GET');
    expect(data['http.response_code']).toBe(200);
    expect(data.is_segment).toBe(true);
  });

  it('scrubs string arrays inside span.data element-by-element', () => {
    const span = runBeforeSendSpan(
      asOpaque<SpanJSON>({
        trace_id: 't',
        span_id: 's',
        start_timestamp: 1,
        data: {
          urls: [`pubky://${TEST_PUBKY}/a`, 'https://example.com/safe', `pubky://${TEST_PUBKY}/b`],
        },
      }),
    );

    const urls = (span.data as { urls: string[] }).urls;
    expect(urls[0]).toBe('[redacted: pubky identifier]');
    expect(urls[1]).toBe('https://example.com/safe');
    expect(urls[2]).toBe('[redacted: pubky identifier]');
  });

  it('preserves object identity for aliased data subtrees and applies first-pass scrub via shared mutation', () => {
    const aliased = { url: `pubky://${TEST_PUBKY}/profile.json` };
    const span = runBeforeSendSpan(
      asOpaque<SpanJSON>({
        trace_id: 't',
        span_id: 's',
        start_timestamp: 1,
        data: { first: aliased, second: aliased },
      }),
    );

    const data = asOpaque<{ first: { url: string }; second: { url: string } }>(span.data);
    expect(data.first).toBe(data.second);
    expect(data.first.url).toBe('[redacted: pubky identifier]');
  });

  it('does not throw on circular references inside span.data and still scrubs reachable strings', () => {
    const cycle: Record<string, unknown> = { url: `pubky://${TEST_PUBKY}/a` };
    cycle.self = cycle;
    const span = asOpaque<SpanJSON>({
      trace_id: 't',
      span_id: 's',
      start_timestamp: 1,
      data: cycle,
    });

    expect(() => runBeforeSendSpan(span)).not.toThrow();
    expect(span.data.url).toBe('[redacted: pubky identifier]');
    expect(span.data.self).toBe('[redacted: circular reference]');
  });

  it('returns the same span object reference', () => {
    const span = asOpaque<SpanJSON>({ trace_id: 't', span_id: 's', start_timestamp: 1, data: {} });
    expect(runBeforeSendSpan(span)).toBe(span);
  });
});
