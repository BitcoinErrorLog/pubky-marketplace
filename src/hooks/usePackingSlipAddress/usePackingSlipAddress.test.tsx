import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePackingSlipAddress } from './usePackingSlipAddress';

const mockPathname = vi.fn(() => '/marketplace/orders');
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname(),
}));

describe('usePackingSlipAddress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname.mockReturnValue('/marketplace/orders');
    window.localStorage.clear();
    window.sessionStorage.clear();
  });

  it('starts empty and stages the pasted value in component state', () => {
    const { result } = renderHook(() => usePackingSlipAddress());
    expect(result.current.address).toBe('');

    act(() => result.current.setAddress('123 Privacy Lane\n83820 Someville'));
    expect(result.current.address).toBe('123 Privacy Lane\n83820 Someville');
  });

  it('clear() drops the staged address', () => {
    const { result } = renderHook(() => usePackingSlipAddress());
    act(() => result.current.setAddress('123 Privacy Lane'));
    act(() => result.current.clear());
    expect(result.current.address).toBe('');
  });

  it('clears the staged address on route change', () => {
    const { result, rerender } = renderHook(() => usePackingSlipAddress());
    act(() => result.current.setAddress('123 Privacy Lane'));
    expect(result.current.address).toBe('123 Privacy Lane');

    mockPathname.mockReturnValue('/marketplace/dashboard');
    rerender();
    expect(result.current.address).toBe('');
  });

  it('never touches web storage', () => {
    const localSet = vi.spyOn(Storage.prototype, 'setItem');
    const { result } = renderHook(() => usePackingSlipAddress());
    act(() => result.current.setAddress('123 Privacy Lane'));
    act(() => result.current.clear());

    expect(localSet).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    localSet.mockRestore();
  });
});
