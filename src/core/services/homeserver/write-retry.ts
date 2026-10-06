import { HttpMethod, HttpStatusCode } from '@/libs/http/http.types';
import { parseRetryAfterHeader } from '@/libs/http/response.utils';
import { extractStatusCode } from './error.utils';

export const HOMESERVER_WRITE_MAX_RETRIES = 2;
export const HOMESERVER_WRITE_MAX_ATTEMPTS = HOMESERVER_WRITE_MAX_RETRIES + 1;

const BASE_DELAY_MS = 250;
const MAX_BACKOFF_MS = 4_000;
const MAX_RETRY_AFTER_MS = 30_000;

type RetryMetadata = {
  status: number;
  retryAfterSeconds?: number;
};

type RetryDependencies = {
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
  now?: () => number;
  beforeAttempt?: (attempt: number) => void | Promise<void>;
  maxTotalDelayMs?: number;
  /** 0 makes one attempt with no sleep, for a caller that holds a lock and backs off outside it. */
  maxRetries?: number;
};

const installedDependencies: RetryDependencies = {};

/** Test-only clock. Production callers leave this unset and keep real jitter. */
export function installHomeserverWriteRetryDependenciesForTests(dependencies: RetryDependencies | null): void {
  installedDependencies.sleep = dependencies?.sleep;
  installedDependencies.random = dependencies?.random;
  installedDependencies.now = dependencies?.now;
}

function retryableStatus(status: number): boolean {
  return (
    status === HttpStatusCode.TOO_MANY_REQUESTS ||
    status === HttpStatusCode.INTERNAL_SERVER_ERROR ||
    status === HttpStatusCode.SERVICE_UNAVAILABLE
  );
}

function retryAfterValue(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  const direct = error as {
    retryAfter?: unknown;
    retryAfterSeconds?: unknown;
    headers?: unknown;
    response?: unknown;
    data?: unknown;
  };
  const data =
    typeof direct.data === 'object' && direct.data !== null
      ? (direct.data as { retryAfter?: unknown; retryAfterSeconds?: unknown; headers?: unknown })
      : undefined;
  return (
    direct.retryAfterSeconds ??
    direct.retryAfter ??
    data?.retryAfterSeconds ??
    data?.retryAfter ??
    direct.response ??
    direct.headers ??
    data?.headers
  );
}

function retryAfterSeconds(value: unknown, nowMs: number): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined;
  if (typeof value === 'string') return parseRetryAfterHeader(value, nowMs);
  if (value instanceof Response) return parseRetryAfterHeader(value.headers.get('retry-after'), nowMs);
  if (value instanceof Headers) return parseRetryAfterHeader(value.get('retry-after'), nowMs);
  if (typeof value === 'object' && value !== null && 'get' in value) {
    const get = (value as { get?: unknown }).get;
    if (typeof get === 'function') {
      const header = get.call(value, 'retry-after');
      return typeof header === 'string' ? parseRetryAfterHeader(header, nowMs) : undefined;
    }
  }
  return undefined;
}

function errorMetadata(error: unknown, nowMs: number): RetryMetadata | undefined {
  const status = extractStatusCode(error);
  if (status === undefined) return undefined;
  return { status, retryAfterSeconds: retryAfterSeconds(retryAfterValue(error), nowMs) };
}

function responseMetadata(value: unknown, nowMs: number): RetryMetadata | undefined {
  if (!(value instanceof Response)) return undefined;
  return {
    status: value.status,
    retryAfterSeconds: parseRetryAfterHeader(value.headers.get('retry-after'), nowMs),
  };
}

function delayMs(metadata: RetryMetadata, retry: number, random: () => number): number {
  if (metadata.status === HttpStatusCode.TOO_MANY_REQUESTS && metadata.retryAfterSeconds !== undefined) {
    return Math.min(Math.max(0, metadata.retryAfterSeconds * 1_000), MAX_RETRY_AFTER_MS);
  }
  const exponential = Math.min(BASE_DELAY_MS * 2 ** retry, MAX_BACKOFF_MS);
  // Full jitter stays inside the exponential cap. random() is [0, 1).
  return Math.min(MAX_BACKOFF_MS, Math.round(exponential * (0.5 + random())));
}

/**
 * Repeats one idempotent homeserver PUT or DELETE in the caller's current
 * critical section. The operation must replay the same path and body.
 *
 * This helper does not acquire or release a lock. A caller that already holds
 * one — the watchlist Web Lock, or the messaging per-counterparty queue —
 * keeps that hold across every attempt.
 */
export async function retryHomeserverWrite<T>(
  method: HttpMethod.PUT | HttpMethod.DELETE,
  operation: () => Promise<T>,
  dependencies: RetryDependencies = {},
): Promise<T> {
  if (method !== HttpMethod.PUT && method !== HttpMethod.DELETE) return await operation();

  const sleep =
    dependencies.sleep ??
    installedDependencies.sleep ??
    ((delay: number) => new Promise<void>((resolve) => setTimeout(resolve, delay)));
  const random = dependencies.random ?? installedDependencies.random ?? Math.random;
  const now = dependencies.now ?? installedDependencies.now ?? Date.now;
  const maxTotalDelayMs = dependencies.maxTotalDelayMs ?? Number.POSITIVE_INFINITY;
  const maxRetries = dependencies.maxRetries ?? HOMESERVER_WRITE_MAX_RETRIES;
  let totalDelayMs = 0;

  for (let attempt = 0; ; attempt += 1) {
    await dependencies.beforeAttempt?.(attempt);
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      const metadata = errorMetadata(error, now());
      if (!metadata || !retryableStatus(metadata.status) || attempt >= maxRetries) throw error;
      const delay = delayMs(metadata, attempt, random);
      if (totalDelayMs + delay > maxTotalDelayMs) throw error;
      await sleep(delay);
      totalDelayMs += delay;
      continue;
    }

    const metadata = responseMetadata(result, now());
    if (!metadata || !retryableStatus(metadata.status) || attempt >= maxRetries) return result;
    const delay = delayMs(metadata, attempt, random);
    if (totalDelayMs + delay > maxTotalDelayMs) return result;
    await sleep(delay);
    totalDelayMs += delay;
  }
}
