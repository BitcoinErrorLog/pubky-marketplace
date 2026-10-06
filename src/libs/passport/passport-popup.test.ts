import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asOpaque } from '@/test-utils/type-assertions';
import {
  PASSPORT_CALLBACK_MESSAGE,
  PASSPORT_CLOSED_GRACE_MS,
  type PassportApproval,
  PassportAttemptError,
  passportAuthorizeUrl,
  passportCallbacks,
  startPassportAttempt,
} from './passport-popup';

const PASSPORT_ORIGIN = 'https://passport.staging.pubky.app';
const APP_ORIGIN = 'https://shop.example.com';
const AUTH_URL =
  'pubkyauth://signin_grant?caps=/pub/pubky.app/:rw&relay=https://httprelay.staging.pubky.app/inbox&secret=abc&cid=shop.pubky.app&cpk=xyz';

type FakePopup = {
  closed: boolean;
  location: { replace: ReturnType<typeof vi.fn> };
  close: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
};

type MessageListener = (event: { data: unknown; origin: string; source: unknown }) => void;

function createPopup(): FakePopup {
  const popup: FakePopup = {
    closed: false,
    location: { replace: vi.fn() },
    close: vi.fn(() => {
      popup.closed = true;
    }),
    focus: vi.fn(),
    postMessage: vi.fn(),
  };
  return popup;
}

function createAppWindow(popup: FakePopup | null) {
  const listeners = new Set<MessageListener>();
  const appWindow = {
    location: { origin: APP_ORIGIN },
    crypto: { randomUUID: () => '00000000-0000-4000-8000-000000000000' },
    open: vi.fn(() => popup),
    addEventListener: vi.fn((type: string, listener: MessageListener) => {
      if (type === 'message') listeners.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: MessageListener) => {
      if (type === 'message') listeners.delete(listener);
    }),
  };
  const deliver = (event: { data: unknown; origin: string; source: unknown }) => {
    for (const listener of [...listeners]) listener(event);
  };
  return { appWindow: asOpaque<Window>(appWindow), deliver, listeners };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function approvalHarness<T>() {
  const result = deferred<T>();
  const cancel = vi.fn(async () => {
    result.reject(new Error('flow_cancelled'));
  });
  const approval: PassportApproval<T> = { authorizationUrl: AUTH_URL, result: result.promise, cancel };
  return { approval, result, cancel };
}

const passportMessage = (outcome: string, messageId = 'm-1') => ({
  type: 'pubky-passport.authorization-outcome',
  version: 1,
  outcome,
  messageId,
});

async function settle<T>(promise: Promise<T>) {
  return await promise.then(
    (value) => ({ status: 'resolved' as const, value }),
    (error: unknown) => ({ status: 'rejected' as const, error }),
  );
}

describe('passportCallbacks', () => {
  it('returns one-origin HTTPS callbacks for each outcome', () => {
    expect(passportCallbacks('https://shop.pubky.app')).toEqual({
      xSource: 'Pubky Shop',
      xSuccess: 'https://shop.pubky.app/auth/passport/return?outcome=success',
      xError: 'https://shop.pubky.app/auth/passport/return?outcome=error',
      xCancel: 'https://shop.pubky.app/auth/passport/return?outcome=cancel',
    });
  });

  it('sends no callbacks from plain HTTP, which Passport would reject', () => {
    expect(passportCallbacks('http://localhost:3000')).toBeUndefined();
  });

  it('sends no callbacks for an unparseable origin', () => {
    expect(passportCallbacks('not a url')).toBeUndefined();
  });
});

describe('passportAuthorizeUrl', () => {
  it('puts the authorization URL, encoded once, in the fragment and nothing in the query', () => {
    const url = passportAuthorizeUrl(PASSPORT_ORIGIN, AUTH_URL);
    const parsed = new URL(url);
    expect(parsed.origin).toBe(PASSPORT_ORIGIN);
    expect(parsed.pathname).toBe('/authorize');
    expect(parsed.search).toBe('');
    expect(url).toBe(`${PASSPORT_ORIGIN}/authorize#d=${encodeURIComponent(AUTH_URL)}`);
    expect(decodeURIComponent(parsed.hash.slice('#d='.length))).toBe(AUTH_URL);
  });
});

describe('startPassportAttempt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  it('opens the popup synchronously, before begin runs, without noopener', async () => {
    const popup = createPopup();
    const { appWindow } = createAppWindow(popup);
    const minted = deferred<PassportApproval<string>>();
    const begin = vi.fn(() => minted.promise);

    const attempt = settle(startPassportAttempt(begin, { passportOrigin: PASSPORT_ORIGIN, appWindow }));

    expect(appWindow.open).toHaveBeenCalledTimes(1);
    const [url, , features] = vi.mocked(appWindow.open).mock.calls[0];
    expect(url).toBe('about:blank');
    expect(String(features)).not.toMatch(/noopener|noreferrer/);
    minted.reject(new Error('stop'));
    expect((await attempt).status).toBe('rejected');
  });

  it('navigates the popup to Passport and resolves with the approval result, then closes the popup', async () => {
    const popup = createPopup();
    const { appWindow, listeners } = createAppWindow(popup);
    const { approval, result } = approvalHarness<string>();

    const attempt = startPassportAttempt(async () => approval, { passportOrigin: PASSPORT_ORIGIN, appWindow });
    await vi.advanceTimersByTimeAsync(0);
    expect(popup.location.replace).toHaveBeenCalledWith(passportAuthorizeUrl(PASSPORT_ORIGIN, AUTH_URL));

    result.resolve('session');
    await expect(attempt).resolves.toBe('session');
    expect(popup.close).toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it('a success message alone does not complete the attempt, and it is acknowledged', async () => {
    const popup = createPopup();
    const { appWindow, deliver } = createAppWindow(popup);
    const { approval, result, cancel } = approvalHarness<string>();

    const attempt = settle(startPassportAttempt(async () => approval, { passportOrigin: PASSPORT_ORIGIN, appWindow }));
    await vi.advanceTimersByTimeAsync(0);
    deliver({ data: passportMessage('success', 'ack-me'), origin: PASSPORT_ORIGIN, source: popup });
    expect(popup.postMessage).toHaveBeenCalledWith(
      { type: 'pubky-passport.authorization-outcome-ack', version: 1, messageId: 'ack-me' },
      PASSPORT_ORIGIN,
    );

    // Passport closes its popup after the acknowledgement; the attempt keeps waiting for the relay.
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(PASSPORT_CLOSED_GRACE_MS * 3);
    expect(cancel).not.toHaveBeenCalled();

    result.resolve('session');
    await expect(attempt).resolves.toEqual({ status: 'resolved', value: 'session' });
  });

  it.each([
    ['cancel', 'cancelled'],
    ['error', 'failed'],
  ])('a %s message ends the attempt and cancels the approval', async (outcome, reason) => {
    const popup = createPopup();
    const { appWindow, deliver } = createAppWindow(popup);
    const { approval, cancel } = approvalHarness<string>();

    const attempt = settle(startPassportAttempt(async () => approval, { passportOrigin: PASSPORT_ORIGIN, appWindow }));
    await vi.advanceTimersByTimeAsync(0);
    deliver({ data: passportMessage(outcome), origin: PASSPORT_ORIGIN, source: popup });
    await vi.advanceTimersByTimeAsync(300);

    const settled = await attempt;
    expect(settled.status).toBe('rejected');
    expect(settled.status === 'rejected' && (settled.error as PassportAttemptError).reason).toBe(reason);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(popup.close).toHaveBeenCalled();
  });

  it('accepts the callback-page message from the Shop origin when Passport fell back to navigation', async () => {
    const popup = createPopup();
    const { appWindow, deliver } = createAppWindow(popup);
    const { approval, cancel } = approvalHarness<string>();

    const attempt = settle(startPassportAttempt(async () => approval, { passportOrigin: PASSPORT_ORIGIN, appWindow }));
    await vi.advanceTimersByTimeAsync(0);
    deliver({ data: { type: PASSPORT_CALLBACK_MESSAGE, outcome: 'cancel' }, origin: APP_ORIGIN, source: popup });
    await vi.advanceTimersByTimeAsync(300);

    const settled = await attempt;
    expect(settled.status === 'rejected' && (settled.error as PassportAttemptError).reason).toBe('cancelled');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(popup.postMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['another origin', { data: passportMessage('cancel'), origin: 'https://evil.example', source: 'popup' }],
    ['another window', { data: passportMessage('cancel'), origin: PASSPORT_ORIGIN, source: 'other' }],
    [
      'a wrong type',
      { data: { ...passportMessage('cancel'), type: 'other' }, origin: PASSPORT_ORIGIN, source: 'popup' },
    ],
    [
      'a wrong version',
      { data: { ...passportMessage('cancel'), version: 2 }, origin: PASSPORT_ORIGIN, source: 'popup' },
    ],
    [
      'a missing message id',
      {
        data: { type: 'pubky-passport.authorization-outcome', version: 1, outcome: 'cancel' },
        origin: PASSPORT_ORIGIN,
        source: 'popup',
      },
    ],
    [
      'a callback message from Passport',
      { data: { type: PASSPORT_CALLBACK_MESSAGE, outcome: 'cancel' }, origin: PASSPORT_ORIGIN, source: 'popup' },
    ],
    [
      'a Passport message from the Shop origin',
      { data: passportMessage('cancel'), origin: APP_ORIGIN, source: 'popup' },
    ],
    ['an unknown outcome', { data: passportMessage('approved'), origin: PASSPORT_ORIGIN, source: 'popup' }],
  ])('ignores a message from %s', async (_label, message) => {
    const popup = createPopup();
    const { appWindow, deliver } = createAppWindow(popup);
    const { approval, result, cancel } = approvalHarness<string>();

    const attempt = startPassportAttempt(async () => approval, { passportOrigin: PASSPORT_ORIGIN, appWindow });
    await vi.advanceTimersByTimeAsync(0);
    deliver({ ...message, source: message.source === 'popup' ? popup : {} });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(cancel).not.toHaveBeenCalled();
    expect(popup.postMessage).not.toHaveBeenCalled();
    result.resolve('session');
    await expect(attempt).resolves.toBe('session');
  });

  it('closing the popup without an outcome ends the attempt after the grace period', async () => {
    const popup = createPopup();
    const { appWindow } = createAppWindow(popup);
    const { approval, cancel } = approvalHarness<string>();

    const attempt = settle(startPassportAttempt(async () => approval, { passportOrigin: PASSPORT_ORIGIN, appWindow }));
    await vi.advanceTimersByTimeAsync(0);
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(PASSPORT_CLOSED_GRACE_MS - 500);
    expect(cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);

    const settled = await attempt;
    expect(settled.status === 'rejected' && (settled.error as PassportAttemptError).reason).toBe('closed');
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('an approval that lands during the grace period still completes', async () => {
    const popup = createPopup();
    const { appWindow } = createAppWindow(popup);
    const { approval, result, cancel } = approvalHarness<string>();

    const attempt = startPassportAttempt(async () => approval, { passportOrigin: PASSPORT_ORIGIN, appWindow });
    await vi.advanceTimersByTimeAsync(0);
    popup.closed = true;
    await vi.advanceTimersByTimeAsync(PASSPORT_CLOSED_GRACE_MS / 2);
    result.resolve('session');

    await expect(attempt).resolves.toBe('session');
    expect(cancel).not.toHaveBeenCalled();
  });

  it('a blocked popup fails immediately and never runs begin', async () => {
    const { appWindow } = createAppWindow(null);
    const begin = vi.fn();

    const settled = await settle(startPassportAttempt(begin, { passportOrigin: PASSPORT_ORIGIN, appWindow }));

    expect(settled.status === 'rejected' && (settled.error as PassportAttemptError).reason).toBe('blocked');
    expect(begin).not.toHaveBeenCalled();
  });

  it('a second attempt while one is pending focuses the open popup and does not start another', async () => {
    const popup = createPopup();
    const { appWindow } = createAppWindow(popup);
    const { approval, result } = approvalHarness<string>();
    const first = startPassportAttempt(async () => approval, { passportOrigin: PASSPORT_ORIGIN, appWindow });
    await vi.advanceTimersByTimeAsync(0);

    const secondBegin = vi.fn();
    const second = await settle(startPassportAttempt(secondBegin, { passportOrigin: PASSPORT_ORIGIN, appWindow }));

    expect(second.status === 'rejected' && (second.error as PassportAttemptError).reason).toBe('busy');
    expect(secondBegin).not.toHaveBeenCalled();
    expect(appWindow.open).toHaveBeenCalledTimes(1);
    expect(popup.focus).toHaveBeenCalled();

    result.resolve('session');
    await expect(first).resolves.toBe('session');

    const nextPopup = createPopup();
    vi.mocked(appWindow.open).mockReturnValue(asOpaque<Window>(nextPopup));
    const next = approvalHarness<string>();
    const third = startPassportAttempt(async () => next.approval, { passportOrigin: PASSPORT_ORIGIN, appWindow });
    await vi.advanceTimersByTimeAsync(0);
    expect(appWindow.open).toHaveBeenCalledTimes(2);
    next.result.resolve('again');
    await expect(third).resolves.toBe('again');
  });

  it('the deadline ends the attempt and cancels the approval', async () => {
    const popup = createPopup();
    const { appWindow } = createAppWindow(popup);
    const { approval, cancel } = approvalHarness<string>();

    const attempt = settle(
      startPassportAttempt(async () => approval, { passportOrigin: PASSPORT_ORIGIN, appWindow, timeoutMs: 5_000 }),
    );
    await vi.advanceTimersByTimeAsync(5_500);

    const settled = await attempt;
    expect(settled.status === 'rejected' && (settled.error as PassportAttemptError).reason).toBe('timeout');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(popup.close).toHaveBeenCalled();
  });

  it('a failing begin closes the popup and surfaces its own error', async () => {
    const popup = createPopup();
    const { appWindow, listeners } = createAppWindow(popup);

    const settled = await settle(
      startPassportAttempt(
        async () => {
          throw new Error('grant_unavailable');
        },
        { passportOrigin: PASSPORT_ORIGIN, appWindow },
      ),
    );

    expect(settled.status === 'rejected' && (settled.error as Error).message).toBe('grant_unavailable');
    expect(popup.close).toHaveBeenCalled();
    expect(popup.location.replace).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it('a popup closed while the URL was minted cancels the new approval before Passport sees it', async () => {
    const popup = createPopup();
    const { appWindow } = createAppWindow(popup);
    const { approval, cancel } = approvalHarness<string>();

    const settled = await settle(
      startPassportAttempt(
        async () => {
          popup.closed = true;
          return approval;
        },
        { passportOrigin: PASSPORT_ORIGIN, appWindow },
      ),
    );

    expect(settled.status === 'rejected' && (settled.error as PassportAttemptError).reason).toBe('closed');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(popup.location.replace).not.toHaveBeenCalled();
  });

  it('a rejected approval result surfaces as is', async () => {
    const popup = createPopup();
    const { appWindow } = createAppWindow(popup);
    const { approval, result, cancel } = approvalHarness<string>();

    const attempt = settle(startPassportAttempt(async () => approval, { passportOrigin: PASSPORT_ORIGIN, appWindow }));
    await vi.advanceTimersByTimeAsync(0);
    result.reject(new Error('relay down'));

    const settled = await attempt;
    expect(settled.status === 'rejected' && (settled.error as Error).message).toBe('relay down');
    expect(settled.status === 'rejected' && settled.error instanceof PassportAttemptError).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    expect(popup.close).toHaveBeenCalled();
  });
});
