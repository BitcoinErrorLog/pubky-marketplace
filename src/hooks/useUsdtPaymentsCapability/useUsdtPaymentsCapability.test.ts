import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useUsdtPaymentsCapability } from './useUsdtPaymentsCapability';

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: { fetchUsdtPaymentsAvailable: vi.fn() },
}));

const fetchCapability = vi.mocked(CommerceController.fetchUsdtPaymentsAvailable);

beforeEach(() => {
  fetchCapability.mockReset();
});

describe('useUsdtPaymentsCapability', () => {
  it('is checking until the first read answers', async () => {
    fetchCapability.mockResolvedValue(true);
    const { result } = renderHook(() => useUsdtPaymentsCapability());

    expect(result.current.status).toBe('checking');
    await waitFor(() => expect(result.current.status).toBe('available'));
  });

  it('reports unavailable when the Shop flag is off or the service sends no USDT key', async () => {
    fetchCapability.mockResolvedValue(false);
    const { result } = renderHook(() => useUsdtPaymentsCapability());

    await waitFor(() => expect(result.current.status).toBe('unavailable'));
  });

  it('tells a failed read apart from "no USDT"', async () => {
    fetchCapability.mockRejectedValue(new TypeError('offline'));
    const { result } = renderHook(() => useUsdtPaymentsCapability());

    await waitFor(() => expect(result.current.status).toBe('unreadable'));
  });

  it('reads again on demand and recovers', async () => {
    fetchCapability.mockRejectedValueOnce(new TypeError('offline')).mockResolvedValue(true);
    const { result } = renderHook(() => useUsdtPaymentsCapability());
    await waitFor(() => expect(result.current.status).toBe('unreadable'));

    await act(async () => {
      await result.current.recheck();
    });

    expect(result.current.status).toBe('available');
    expect(fetchCapability).toHaveBeenCalledTimes(2);
  });

  it('never reads the capability when the surface has no use for it', () => {
    fetchCapability.mockResolvedValue(true);
    const { result } = renderHook(() => useUsdtPaymentsCapability(false));

    expect(result.current.status).toBe('checking');
    expect(fetchCapability).not.toHaveBeenCalled();
  });
});
