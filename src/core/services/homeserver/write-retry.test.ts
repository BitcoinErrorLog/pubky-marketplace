import { describe, expect, it, vi } from 'vitest';
import { HttpMethod } from '@/libs/http/http.types';
import { HOMESERVER_WRITE_MAX_ATTEMPTS, retryHomeserverWrite } from './write-retry';

function requestError(statusCode: number, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`status ${statusCode}`), {
    name: 'RequestError',
    data: { statusCode, ...extra },
  });
}

describe('retryHomeserverWrite', () => {
  it('retries 429 and honours Retry-After delta-seconds', async () => {
    const operation = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(requestError(429, { headers: new Headers({ 'retry-after': '2' }) }))
      .mockResolvedValueOnce();
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue();

    await retryHomeserverWrite(HttpMethod.PUT, operation, { sleep, random: () => 0 });

    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it('uses jittered exponential backoff for 429 without Retry-After', async () => {
    const operation = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(requestError(429))
      .mockRejectedValueOnce(requestError(429))
      .mockResolvedValueOnce();
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue();

    await retryHomeserverWrite(HttpMethod.PUT, operation, { sleep, random: () => 0.25 });

    expect(sleep.mock.calls).toEqual([[188], [375]]);
  });

  it('retries a 500 PUT with the identical operation and then succeeds', async () => {
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(requestError(500))
      .mockResolvedValueOnce('stored');

    await expect(
      retryHomeserverWrite(HttpMethod.PUT, operation, { sleep: async () => {}, random: () => 0 }),
    ).resolves.toBe('stored');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('stops at the bounded attempt cap and preserves the final error', async () => {
    const finalError = requestError(503);
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(finalError);

    await expect(
      retryHomeserverWrite(HttpMethod.DELETE, operation, { sleep: async () => {}, random: () => 0 }),
    ).rejects.toBe(finalError);
    expect(operation).toHaveBeenCalledTimes(HOMESERVER_WRITE_MAX_ATTEMPTS);
  });

  it('makes one attempt and never sleeps with maxRetries 0, for a caller holding a lock', async () => {
    const finalError = requestError(503);
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(finalError);
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue();

    await expect(
      retryHomeserverWrite(HttpMethod.PUT, operation, { sleep, random: () => 0, maxRetries: 0 }),
    ).rejects.toBe(finalError);
    expect(operation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('clamps a pathological Retry-After to the bounded wait', async () => {
    const operation = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(requestError(429, { retryAfter: '999999' }))
      .mockResolvedValueOnce();
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue();

    await retryHomeserverWrite(HttpMethod.PUT, operation, { sleep, random: () => 0 });

    expect(operation).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(30_000);
  });

  it('revert-fail: does not sleep past a locked section total retry budget', async () => {
    const error = requestError(429, { retryAfterSeconds: 30 });
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(error);
    const sleep = vi.fn<(delayMs: number) => Promise<void>>();

    await expect(
      retryHomeserverWrite(HttpMethod.PUT, operation, {
        sleep,
        maxTotalDelayMs: 2_000,
      }),
    ).rejects.toBe(error);

    expect(operation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry a status-less paykit publish error', async () => {
    // Proven artifact: paykit-wasm `js_err` throws `Error` whose message is
    // `context: Display(PaykitError)`. Display of a transport failure does not
    // include the HTTP status, and the JS error has no `data.statusCode`.
    const error = new Error(
      'failed to publish receiver marker: transport error: publish_paykit_receiver_marker: put Paykit receiver marker',
    );
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(error);
    const sleep = vi.fn<(delayMs: number) => Promise<void>>();

    await expect(retryHomeserverWrite(HttpMethod.PUT, operation, { sleep })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('does not retry a 400', async () => {
    const error = requestError(400);
    const operation = vi.fn<() => Promise<void>>().mockRejectedValue(error);
    const sleep = vi.fn<(delayMs: number) => Promise<void>>();

    await expect(retryHomeserverWrite(HttpMethod.PUT, operation, { sleep })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a 503 DELETE response and honours Retry-After HTTP-date on 429', async () => {
    const retryAt = new Date(12_000).toUTCString();
    const operation = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': retryAt } }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const sleep = vi.fn<(delayMs: number) => Promise<void>>().mockResolvedValue();

    const response = await retryHomeserverWrite(HttpMethod.DELETE, operation, {
      sleep,
      random: () => 0,
      now: () => 10_000,
    });

    expect(response.status).toBe(204);
    expect(sleep.mock.calls).toEqual([[125], [2_000]]);
  });
});
