import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useUsdtPaymentsAvailable } from './useUsdtPaymentsAvailable';

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: { fetchUsdtPaymentsAvailable: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(CommerceController.fetchUsdtPaymentsAvailable).mockReset();
});

describe('useUsdtPaymentsAvailable', () => {
  it('is false while loading, then follows the gate', async () => {
    vi.mocked(CommerceController.fetchUsdtPaymentsAvailable).mockResolvedValue(true);
    const { result } = renderHook(() => useUsdtPaymentsAvailable());

    expect(result.current).toBe(false);
    await waitFor(() => {
      expect(result.current).toBe(true);
    });
  });

  it('stays false when the gate is closed', async () => {
    vi.mocked(CommerceController.fetchUsdtPaymentsAvailable).mockResolvedValue(false);
    const { result } = renderHook(() => useUsdtPaymentsAvailable());

    await waitFor(() => {
      expect(CommerceController.fetchUsdtPaymentsAvailable).toHaveBeenCalledTimes(1);
    });
    expect(result.current).toBe(false);
  });

  it('reads a failed /health read as unavailable', async () => {
    vi.mocked(CommerceController.fetchUsdtPaymentsAvailable).mockRejectedValue(new TypeError('offline'));
    const { result } = renderHook(() => useUsdtPaymentsAvailable());

    await waitFor(() => {
      expect(CommerceController.fetchUsdtPaymentsAvailable).toHaveBeenCalledTimes(1);
    });
    expect(result.current).toBe(false);
  });
});
