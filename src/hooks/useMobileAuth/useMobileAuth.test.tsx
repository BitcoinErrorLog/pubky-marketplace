import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { navigatesWithinGesture } from '@/test-utils/user-gesture';
import { useMobileAuth } from './useMobileAuth';

const navigation = vi.hoisted(() => ({ navigateTop: vi.fn() }));

vi.mock('@/libs/navigation/navigate-top', () => ({ navigateTop: navigation.navigateTop }));

const mockFetchUrl = vi.fn();
const mockCopyAuthUrl = vi.fn();
const mockUseAuthUrl = vi.fn();

vi.mock('../useAuthUrl/useAuthUrl', () => ({
  useAuthUrl: (...args: unknown[]) => mockUseAuthUrl(...args),
}));

describe('useMobileAuth', () => {
  const defaultAuthUrlReturn = {
    url: 'pubkyauth://signin?token=test123',
    isLoading: false,
    isExpired: false,
    fetchUrl: mockFetchUrl,
    copyAuthUrl: mockCopyAuthUrl,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuthUrl.mockReturnValue(defaultAuthUrlReturn);
  });

  it('returns useAuthUrl data plus hook values', () => {
    const { result } = renderHook(() => useMobileAuth());

    expect(result.current.url).toBe('pubkyauth://signin?token=test123');
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isExpired).toBe(false);
    expect(result.current.fetchUrl).toBe(mockFetchUrl);
    expect(result.current.copyAuthUrl).toBe(mockCopyAuthUrl);
    expect(result.current.isOpeningRing).toBe(false);
    expect(result.current.onAuthorizeClick).toBeInstanceOf(Function);
  });

  it('onAuthorizeClick calls fetchUrl when url is empty', () => {
    mockUseAuthUrl.mockReturnValue({ ...defaultAuthUrlReturn, url: '' });

    const { result } = renderHook(() => useMobileAuth());

    act(() => {
      result.current.onAuthorizeClick();
    });

    expect(mockFetchUrl).toHaveBeenCalled();
  });

  it('onAuthorizeClick does nothing when isLoading', () => {
    mockUseAuthUrl.mockReturnValue({ ...defaultAuthUrlReturn, isLoading: true });

    const { result } = renderHook(() => useMobileAuth());

    act(() => {
      result.current.onAuthorizeClick();
    });

    expect(mockFetchUrl).not.toHaveBeenCalled();
    expect(navigation.navigateTop).not.toHaveBeenCalled();
  });

  it('onAuthorizeClick navigates to deeplink url through the top window and sets isOpeningRing', () => {
    const { result } = renderHook(() => useMobileAuth());

    act(() => {
      result.current.onAuthorizeClick();
    });

    expect(result.current.isOpeningRing).toBe(true);
    expect(navigation.navigateTop).toHaveBeenCalledWith('pubkyauth://signin?token=test123');
  });

  it('hands the deeplink to the top window inside the tap, with no async boundary before it', () => {
    const { result } = renderHook(() => useMobileAuth());

    expect(
      navigatesWithinGesture(navigation.navigateTop, 'pubkyauth://signin?token=test123', () =>
        result.current.onAuthorizeClick(),
      ),
    ).toBe(true);
  });

  it('cleans up visibility listener on unmount', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');

    const { result, unmount } = renderHook(() => useMobileAuth());

    act(() => {
      result.current.onAuthorizeClick();
    });

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

    removeSpy.mockRestore();
  });

  it('passes options through to useAuthUrl', () => {
    renderHook(() => useMobileAuth({ type: 'signup', inviteCode: 'ABC-123' }));

    expect(mockUseAuthUrl).toHaveBeenCalledWith({ type: 'signup', inviteCode: 'ABC-123' });
  });
});
