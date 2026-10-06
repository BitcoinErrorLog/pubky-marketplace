import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBuyerPaykitWallet } from './useBuyerPaykitWallet';

const controller = vi.hoisted(() => ({
  hasBuyerPaykitWallet: vi.fn<(buyerPubky: unknown) => Promise<boolean>>(),
}));

vi.mock('@/controllers/commerce/commerce', () => ({ CommerceController: controller }));

const BUYER = 'b'.repeat(52);

describe('useBuyerPaykitWallet', () => {
  beforeEach(() => {
    controller.hasBuyerPaykitWallet.mockReset();
  });

  it('stays idle and reads nothing while Bitcoin is not in play', () => {
    const { result } = renderHook(() => useBuyerPaykitWallet(BUYER, false));
    expect(result.current.state).toBe('idle');
    expect(controller.hasBuyerPaykitWallet).not.toHaveBeenCalled();
  });

  it('reports payable and not_payable from the public Paykit read', async () => {
    controller.hasBuyerPaykitWallet.mockResolvedValueOnce(false);
    const { result } = renderHook(() => useBuyerPaykitWallet(BUYER, true));
    expect(result.current.state).toBe('checking');
    await waitFor(() => expect(result.current.state).toBe('not_payable'));
    expect(controller.hasBuyerPaykitWallet).toHaveBeenCalledWith(BUYER);

    controller.hasBuyerPaykitWallet.mockResolvedValueOnce(true);
    act(() => result.current.recheck());
    await waitFor(() => expect(result.current.state).toBe('payable'));
    expect(controller.hasBuyerPaykitWallet).toHaveBeenCalledTimes(2);
  });

  it('reports unknown, never not_payable, when the read fails', async () => {
    controller.hasBuyerPaykitWallet.mockRejectedValueOnce(new TypeError('unreachable'));
    const { result } = renderHook(() => useBuyerPaykitWallet(BUYER, true));
    await waitFor(() => expect(result.current.state).toBe('unknown'));
  });
});
