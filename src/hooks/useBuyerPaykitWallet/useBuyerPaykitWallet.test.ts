import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BuyerPaykitWallet } from '@/libs/commerce/paykit-wallet';
import { useBuyerPaykitWallet } from './useBuyerPaykitWallet';

const controller = vi.hoisted(() => ({
  fetchBuyerPaykitWallet: vi.fn<(buyerPubky: unknown) => Promise<BuyerPaykitWallet>>(),
}));

vi.mock('@/controllers/commerce/commerce', () => ({ CommerceController: controller }));

const BUYER = 'b'.repeat(52);

describe('useBuyerPaykitWallet', () => {
  beforeEach(() => {
    controller.fetchBuyerPaykitWallet.mockReset();
  });

  it('stays idle and reads nothing while Bitcoin is not in play', () => {
    const { result } = renderHook(() => useBuyerPaykitWallet(BUYER, false));
    expect(result.current.state).toBe('idle');
    expect(controller.fetchBuyerPaykitWallet).not.toHaveBeenCalled();
  });

  it('reports payable and not_payable from the public Paykit read', async () => {
    controller.fetchBuyerPaykitWallet.mockResolvedValueOnce('not_payable');
    const { result } = renderHook(() => useBuyerPaykitWallet(BUYER, true));
    expect(result.current.state).toBe('checking');
    await waitFor(() => expect(result.current.state).toBe('not_payable'));
    expect(controller.fetchBuyerPaykitWallet).toHaveBeenCalledWith(BUYER);

    controller.fetchBuyerPaykitWallet.mockResolvedValueOnce('payable');
    act(() => result.current.recheck());
    await waitFor(() => expect(result.current.state).toBe('payable'));
    expect(controller.fetchBuyerPaykitWallet).toHaveBeenCalledTimes(2);
  });

  it('reports a Bitkit 2.6 wallet as unsupported', async () => {
    controller.fetchBuyerPaykitWallet.mockResolvedValueOnce('unsupported');
    const { result } = renderHook(() => useBuyerPaykitWallet(BUYER, true));
    await waitFor(() => expect(result.current.state).toBe('unsupported'));
  });

  it('reports unknown, never not_payable, when the read fails', async () => {
    controller.fetchBuyerPaykitWallet.mockRejectedValueOnce(new TypeError('unreachable'));
    const { result } = renderHook(() => useBuyerPaykitWallet(BUYER, true));
    await waitFor(() => expect(result.current.state).toBe('unknown'));
  });
});
