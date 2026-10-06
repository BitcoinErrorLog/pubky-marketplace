import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withPassDeadline } from './pass-deadline';

describe('withPassDeadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('settles like the work when it finishes in time, without expiring', async () => {
    const onExpire = vi.fn();
    await expect(
      withPassDeadline(Promise.resolve('done'), { timeoutMs: 100, operation: 'test', onExpire }),
    ).resolves.toBe('done');
    await vi.advanceTimersByTimeAsync(200);
    expect(onExpire).not.toHaveBeenCalled();
  });

  it('passes the work’s own failure on', async () => {
    await expect(
      withPassDeadline(Promise.reject(new Error('boom')), { timeoutMs: 100, operation: 'test', onExpire: vi.fn() }),
    ).rejects.toThrow('boom');
  });

  it('expires and rejects with a timeout when the work never settles', async () => {
    const onExpire = vi.fn();
    const pass = withPassDeadline(new Promise(() => undefined), { timeoutMs: 100, operation: 'test', onExpire });
    const rejected = expect(pass).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', context: { timeoutMs: 100 } });
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    expect(onExpire).toHaveBeenCalledOnce();
  });
});
