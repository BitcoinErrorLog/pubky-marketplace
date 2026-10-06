import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTH_ROUTES } from '@/app/routes';
import { MessagingController } from '@/controllers/messaging/messaging';
import { MessagingSyncCoordinator } from '@/coordinators/messaging-sync/messaging-sync';
import { MESSAGING_BACKGROUND_SYNC_INTERVAL_MS } from '@/coordinators/messaging-sync/messaging-sync.types';
import { MESSAGING_SYNC_PASS_TIMEOUT_MS } from '@/libs/messaging/pass-deadline';
import { useAuthStore } from '@/stores/auth/auth.store';
import { mockSession } from '@/test-utils/pubky';
import { installWebLocks, removeWebLocks } from '@/test-utils/web-locks';

const OWNER = 'o'.repeat(52);

function signIn(hasProfile = true) {
  useAuthStore.getState().init({ session: mockSession(), currentUserPubky: OWNER, hasProfile });
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

describe('MessagingSyncCoordinator', () => {
  let sync: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    installWebLocks();
    MessagingSyncCoordinator.resetInstance();
    useAuthStore.getState().reset();
    sync = vi.spyOn(MessagingController, 'syncInboxInBackground').mockResolvedValue('synced');
  });

  afterEach(() => {
    MessagingSyncCoordinator.resetInstance();
    removeWebLocks();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('syncs on start and then on its interval while signed in', async () => {
    signIn();
    await MessagingSyncCoordinator.getInstance().start();
    await settle();
    expect(sync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MESSAGING_BACKGROUND_SYNC_INTERVAL_MS);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('keeps syncing while the tab is hidden', async () => {
    signIn();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await MessagingSyncCoordinator.getInstance().start();
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(MESSAGING_BACKGROUND_SYNC_INTERVAL_MS);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('runs for an account without a profile', async () => {
    signIn(false);
    await MessagingSyncCoordinator.getInstance().start();
    await settle();
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('passes the account signed in when the pass started, never a later one', async () => {
    signIn();
    await MessagingSyncCoordinator.getInstance().start();
    await settle();
    expect(sync).toHaveBeenCalledWith(OWNER, expect.any(Function));
  });

  it('does nothing while signed out', async () => {
    await MessagingSyncCoordinator.getInstance().start();
    await vi.advanceTimersByTimeAsync(MESSAGING_BACKGROUND_SYNC_INTERVAL_MS * 2);
    expect(sync).not.toHaveBeenCalled();
  });

  it('stops when the account signs out', async () => {
    signIn();
    await MessagingSyncCoordinator.getInstance().start();
    await settle();
    useAuthStore.getState().reset();
    await vi.advanceTimersByTimeAsync(MESSAGING_BACKGROUND_SYNC_INTERVAL_MS * 2);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('never takes the interactive status path, which can create a key', async () => {
    signIn();
    const status = vi.spyOn(MessagingController, 'getMessagingStatus');
    await MessagingSyncCoordinator.getInstance().start();
    await settle();
    expect(status).not.toHaveBeenCalled();
  });

  it('tells a pass that runs too long to stop and gives the lock to the next pass', async () => {
    signIn();
    const continues: Array<() => boolean> = [];
    sync.mockImplementationOnce(async (_owner: string, shouldContinue: () => boolean) => {
      continues.push(shouldContinue);
      return await new Promise<'synced'>(() => undefined);
    });
    await MessagingSyncCoordinator.getInstance().start();
    await settle();
    expect(continues[0]()).toBe(true);

    await vi.advanceTimersByTimeAsync(MESSAGING_SYNC_PASS_TIMEOUT_MS);
    expect(continues[0]()).toBe(false);
    await expect(
      navigator.locks.request(
        `pubky-messaging-background-sync|${OWNER}`,
        { ifAvailable: true },
        async (lock) => lock !== null,
      ),
    ).resolves.toBe(true);

    await vi.advanceTimersByTimeAsync(MESSAGING_BACKGROUND_SYNC_INTERVAL_MS);
    expect(sync.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('leaves the pass to the tab already running one', async () => {
    signIn();
    let releaseOtherTab: () => void = () => undefined;
    const otherTab = navigator.locks.request(
      `pubky-messaging-background-sync|${OWNER}`,
      () =>
        new Promise<void>((resolve) => {
          releaseOtherTab = resolve;
        }),
    );
    await MessagingSyncCoordinator.getInstance().start();
    await settle();
    expect(sync).not.toHaveBeenCalled();

    releaseOtherTab();
    await otherTab;
    await vi.advanceTimersByTimeAsync(MESSAGING_BACKGROUND_SYNC_INTERVAL_MS);
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('keeps its interval after a failed pass', async () => {
    signIn();
    sync.mockRejectedValueOnce(new Error('homeserver unreachable'));
    await MessagingSyncCoordinator.getInstance().start();
    await settle();
    await vi.advanceTimersByTimeAsync(MESSAGING_BACKGROUND_SYNC_INTERVAL_MS);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('does not run on the sign-in and sign-out routes', async () => {
    signIn();
    const coordinator = MessagingSyncCoordinator.getInstance();
    await coordinator.setRoute(AUTH_ROUTES.SIGN_IN);
    await coordinator.start();
    await vi.advanceTimersByTimeAsync(MESSAGING_BACKGROUND_SYNC_INTERVAL_MS);
    expect(sync).not.toHaveBeenCalled();
  });
});
