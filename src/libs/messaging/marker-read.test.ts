import { describe, expect, it, vi } from 'vitest';
import {
  classifyMarkerReadError,
  isMarkerReadError,
  MARKER_READ_RETRY,
  MarkerReadFailure,
  readMarkerWithRetry,
} from './marker-read';

// Verbatim from the vendored binding against the production Pubky network for a
// counterparty whose homeserver does not resolve (2026-09-29).
const RAW_TRANSPORT =
  'failed to fetch receiver marker: transport error: get_paykit_receiver_marker: fetch Paykit receiver marker';

describe('classifyMarkerReadError', () => {
  it('classifies the captured transport rejection as unreachable', () => {
    expect(classifyMarkerReadError(new Error(RAW_TRANSPORT))).toBe('unreachable');
  });

  it('classifies a fetched but unusable marker as unreadable', () => {
    expect(
      classifyMarkerReadError(
        new Error('failed to fetch receiver marker: invalid data: get_paykit_receiver_marker: x'),
      ),
    ).toBe('unreadable');
    expect(
      classifyMarkerReadError(new Error('failed to fetch receiver marker: validation: get_paykit_receiver_marker: x')),
    ).toBe('unreadable');
  });

  it('leaves every other rejection alone', () => {
    expect(classifyMarkerReadError(new Error('invalid owner public key: nope'))).toBeNull();
    expect(classifyMarkerReadError(new Error('failed to publish receiver marker: transport error: x'))).toBeNull();
    expect(classifyMarkerReadError('unexpected')).toBeNull();
    expect(classifyMarkerReadError(undefined)).toBeNull();
  });

  it('recognises a rejected string as the binding may throw one', () => {
    expect(classifyMarkerReadError(RAW_TRANSPORT)).toBe('unreachable');
  });
});

describe('readMarkerWithRetry', () => {
  it('resolves undefined for an absent marker without waiting or retrying', async () => {
    const read = vi.fn().mockResolvedValue(undefined);
    const sleep = vi.fn();
    await expect(readMarkerWithRetry(read, sleep)).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries unreachable reads on the configured delays and then fails with plain text', async () => {
    const read = vi.fn().mockRejectedValue(new Error(RAW_TRANSPORT));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const failure = await readMarkerWithRetry(read, sleep).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MarkerReadFailure);
    expect((failure as MarkerReadFailure).reason).toBe('unreachable');
    expect((failure as MarkerReadFailure).message).not.toContain('Paykit');
    expect(read).toHaveBeenCalledTimes(MARKER_READ_RETRY.delaysMs.length + 1);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([...MARKER_READ_RETRY.delaysMs]);
  });

  it('returns the marker when a later attempt succeeds', async () => {
    const marker = { receiverPath: 'marketplace/wallet', noisePublicKey: 'k' };
    const read = vi.fn().mockRejectedValueOnce(new Error(RAW_TRANSPORT)).mockResolvedValue(marker);
    await expect(readMarkerWithRetry(read, vi.fn())).resolves.toBe(marker);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('passes an unrelated error through unchanged', async () => {
    const boom = new Error('boom');
    await expect(readMarkerWithRetry(() => Promise.reject(boom), vi.fn())).rejects.toBe(boom);
  });
});

describe('isMarkerReadError', () => {
  it('matches both the failure and the raw rejection', () => {
    expect(isMarkerReadError(new MarkerReadFailure('unreachable'))).toBe(true);
    expect(isMarkerReadError(new Error(RAW_TRANSPORT))).toBe(true);
    expect(isMarkerReadError(new Error('other'))).toBe(false);
  });
});
