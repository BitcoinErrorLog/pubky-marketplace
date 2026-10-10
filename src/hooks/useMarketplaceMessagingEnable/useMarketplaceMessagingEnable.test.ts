import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessagingController } from '@/controllers/messaging/messaging';
import { AppError } from '@/libs/error/error';
import { AuthErrorCode } from '@/libs/error/error.codes';
import { ErrorCategory, ErrorService } from '@/libs/error/error.types';
import { useMessagingStore } from '@/stores/messaging/messaging.store';
import { navigatesWithinGesture } from '@/test-utils/user-gesture';
import { useMarketplaceMessagingEnable } from './useMarketplaceMessagingEnable';

const navigation = vi.hoisted(() => ({ navigateTop: vi.fn() }));

vi.mock('@/libs/navigation/navigate-top', () => ({ navigateTop: navigation.navigateTop }));

type EnableFlow = Awaited<ReturnType<typeof MessagingController.beginMessagingEnable>>;

describe('useMarketplaceMessagingEnable', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useMessagingStore.getState().setMessagingAtRestDegraded(false);
  });

  it('pauses with "storage protection unavailable" when the boot wrap sweep left messaging storage degraded', () => {
    useMessagingStore.getState().setMessagingAtRestDegraded(true);
    const beginSpy = vi.spyOn(MessagingController, 'beginMessagingEnable');

    const { result } = renderHook(() => useMarketplaceMessagingEnable());
    act(() => result.current.start());

    // No Ring flow is started on top of degraded at-rest protection.
    expect(result.current.status).toBe('error');
    expect(result.current.errorMessage).toBe('Messaging paused: storage protection unavailable');
    expect(beginSpy).not.toHaveBeenCalled();
  });

  it('starts the Ring flow normally when at-rest storage protection is intact', async () => {
    const pendingFlow: EnableFlow = {
      authorizationUrl: 'pubkyauth://test',
      awaitEnabled: () => new Promise(() => {}),
      cancel: vi.fn(),
    };
    const beginSpy = vi.spyOn(MessagingController, 'beginMessagingEnable').mockResolvedValue(pendingFlow);

    const { result } = renderHook(() => useMarketplaceMessagingEnable());
    act(() => result.current.start());
    await act(async () => {});

    expect(result.current.status).toBe('awaiting');
    expect(beginSpy).toHaveBeenCalledTimes(1);
  });

  it('hands the signer deeplink to the top window inside the tap, with no async boundary before it', async () => {
    vi.spyOn(MessagingController, 'beginMessagingEnable').mockResolvedValue({
      authorizationUrl: 'pubkyauth://messaging-enable',
      awaitEnabled: () => new Promise(() => {}),
      cancel: vi.fn(),
    });
    const { result } = renderHook(() => useMarketplaceMessagingEnable());
    act(() => result.current.start());
    await act(async () => {});

    expect(
      navigatesWithinGesture(navigation.navigateTop, 'pubkyauth://messaging-enable', () => result.current.openInRing()),
    ).toBe(true);
    expect(result.current.isOpeningRing).toBe(true);
  });

  it('maps thrown sentinel failures to static copy and keeps the error message static', async () => {
    const sentinel = 'SENTINEL_SERVER_TEXT_messaging_enable';
    vi.spyOn(MessagingController, 'beginMessagingEnable').mockRejectedValue(
      new AppError({
        category: ErrorCategory.Auth,
        code: AuthErrorCode.SESSION_EXPIRED,
        message: sentinel,
        service: ErrorService.Marketplace,
        operation: 'messagingEnable',
      }),
    );
    const { result } = renderHook(() => useMarketplaceMessagingEnable());

    act(() => result.current.start());
    await vi.waitFor(() => expect(result.current.errorMessage).toBeTypeOf('string'));
    expect(result.current.errorMessage).not.toContain(sentinel);
  });
});
