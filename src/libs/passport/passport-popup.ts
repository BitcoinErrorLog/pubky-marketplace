import type { XCallbackParams } from '@synonymdev/pubky';

/**
 * Pubky Passport popup attempts (https://github.com/pubky/pubky-passport/blob/main/docs/integration.md).
 *
 * An attempt opens Passport's `/authorize` page in a popup with a Pubky
 * authorization URL in the fragment and waits for the approval through its
 * own channel: the SDK relay poll for a sign-in, the marketplace BFF poll for
 * a purchase grant. Passport's outcome messages and the callback page only
 * steer the UI. `success` never completes an attempt; `cancel` and `error`
 * end it, and so does closing the popup.
 *
 * Integration requirement: the popup's `window.opener` must survive the
 * navigation to Passport. The Shop opens it without `noopener`, and its own
 * COOP is `same-origin-allow-popups`; Passport's `/authorize` (and the Google
 * pages it navigates through) must not send `Cross-Origin-Opener-Policy:
 * same-origin`. If one does, the opener is severed: the outcome message and
 * the callback-page fallback both stop reaching the Shop, `popup.closed`
 * reads true, and an attempt can end as `closed` after the grace period even
 * though an approval may still land on the relay. Re-check this against both
 * Passport deployments whenever Passport changes its headers.
 */

export type PassportOutcome = 'success' | 'error' | 'cancel';

export type PassportAttemptFailure = 'blocked' | 'busy' | 'cancelled' | 'failed' | 'closed' | 'timeout';

export class PassportAttemptError extends Error {
  readonly reason: PassportAttemptFailure;

  constructor(reason: PassportAttemptFailure) {
    super(`Pubky Passport attempt ended: ${reason}`);
    this.name = 'PassportAttemptError';
    this.reason = reason;
  }
}

export function isPassportAttemptError(error: unknown): error is PassportAttemptError {
  return error instanceof PassportAttemptError;
}

/** One approval channel: the URL Passport shows, its result, and how to abandon it. */
export type PassportApproval<T> = {
  authorizationUrl: string;
  result: Promise<T>;
  cancel: () => void | Promise<void>;
};

export const PASSPORT_CALLBACK_PATH = '/auth/passport/return';
/** Posted by the callback page to its opener when Passport fell back to navigation. */
export const PASSPORT_CALLBACK_MESSAGE = 'shop.pubky.app.passport-return';
const PASSPORT_OUTCOME_MESSAGE = 'pubky-passport.authorization-outcome';
const PASSPORT_OUTCOME_ACK_MESSAGE = 'pubky-passport.authorization-outcome-ack';
const PASSPORT_MESSAGE_VERSION = 1;
const PASSPORT_SOURCE_NAME = 'Pubky Shop';

const POPUP_FEATURES = 'popup,width=520,height=760';
export const PASSPORT_ATTEMPT_TIMEOUT_MS = 5 * 60_000;
/**
 * How long an attempt keeps waiting after the popup closed without a
 * `success` message. Without callbacks Passport shows its own result screen,
 * and a user who closes it after approving must not lose an approval that is
 * already on the relay.
 */
export const PASSPORT_CLOSED_GRACE_MS = 10_000;
const PASSPORT_CHECK_INTERVAL_MS = 250;

export function isPassportOutcome(value: unknown): value is PassportOutcome {
  return value === 'success' || value === 'error' || value === 'cancel';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Return destinations for a Passport request made from `appOrigin`. Passport
 * rejects callbacks that are not HTTPS, so a plain-HTTP origin (local
 * development) sends none and Passport shows its own result screen.
 */
export function passportCallbacks(appOrigin: string): XCallbackParams | undefined {
  let origin: URL;
  try {
    origin = new URL(appOrigin);
  } catch {
    return undefined;
  }
  if (origin.protocol !== 'https:') return undefined;
  const callback = (outcome: PassportOutcome) => {
    const url = new URL(PASSPORT_CALLBACK_PATH, origin.origin);
    url.searchParams.set('outcome', outcome);
    return url.href;
  };
  return {
    xSource: PASSPORT_SOURCE_NAME,
    xSuccess: callback('success'),
    xError: callback('error'),
    xCancel: callback('cancel'),
  };
}

/** Passport's authorize page for a `pubkyauth://` URL, encoded once in the fragment. */
export function passportAuthorizeUrl(passportOrigin: string, authorizationUrl: string): string {
  return `${new URL('/authorize', passportOrigin).href}#d=${encodeURIComponent(authorizationUrl)}`;
}

type PassportAttemptOptions = {
  passportOrigin: string;
  appWindow?: Window;
  timeoutMs?: number;
  closedGraceMs?: number;
  checkIntervalMs?: number;
};

type ActiveAttempt = { popup: Window; done: Promise<unknown> };

let activeAttempt: ActiveAttempt | null = null;

function closePopup(popup: Window): void {
  try {
    if (!popup.closed) popup.close();
  } catch {
    // Closing a popup that navigated cross-origin is best effort.
  }
}

/**
 * Starts a Passport attempt. Call it directly from a click or tap handler:
 * the popup opens before the first `await`, or the browser blocks it. One
 * attempt runs at a time; a second call while one is pending focuses the
 * open popup and rejects with `busy`.
 *
 * `begin` creates the approval only after the popup is open, so the popup
 * shows a blank page while the URL is minted. Every ending removes the
 * message listener and closes the popup; an interrupted attempt also calls
 * the approval's `cancel` so its flow is freed and nothing stays pending.
 */
export function startPassportAttempt<T>(
  begin: () => Promise<PassportApproval<T>>,
  options: PassportAttemptOptions,
): Promise<T> {
  const appWindow = options.appWindow ?? window;
  if (activeAttempt) {
    try {
      activeAttempt.popup.focus();
    } catch {
      // The popup may be cross-origin or closing.
    }
    return Promise.reject(new PassportAttemptError('busy'));
  }

  const popup = appWindow.open('about:blank', `pubky-passport-${appWindow.crypto.randomUUID()}`, POPUP_FEATURES);
  if (!popup) return Promise.reject(new PassportAttemptError('blocked'));

  const done = runAttempt(popup, begin, { ...options, appWindow });
  const attempt: ActiveAttempt = { popup, done };
  activeAttempt = attempt;
  return done.finally(() => {
    if (activeAttempt === attempt) activeAttempt = null;
  });
}

async function runAttempt<T>(
  popup: Window,
  begin: () => Promise<PassportApproval<T>>,
  options: PassportAttemptOptions & { appWindow: Window },
): Promise<T> {
  const { appWindow } = options;
  const passportOrigin = new URL(options.passportOrigin).origin;
  const timeoutMs = options.timeoutMs ?? PASSPORT_ATTEMPT_TIMEOUT_MS;
  const closedGraceMs = options.closedGraceMs ?? PASSPORT_CLOSED_GRACE_MS;
  const checkIntervalMs = options.checkIntervalMs ?? PASSPORT_CHECK_INTERVAL_MS;

  let outcome: PassportOutcome | undefined;
  const onMessage = (event: MessageEvent<unknown>) => {
    const received = readOutcome(event, popup, passportOrigin, appWindow.location.origin);
    if (received) outcome = received;
  };
  appWindow.addEventListener('message', onMessage);

  try {
    const approval = await begin();
    // Every ending observes the result, including one that never waits on it.
    approval.result.catch(() => undefined);
    if (popup.closed) {
      await approval.cancel();
      throw new PassportAttemptError('closed');
    }
    popup.location.replace(passportAuthorizeUrl(passportOrigin, approval.authorizationUrl));
    return await waitForApproval(approval, () => outcome, popup, { timeoutMs, closedGraceMs, checkIntervalMs });
  } finally {
    appWindow.removeEventListener('message', onMessage);
    closePopup(popup);
  }
}

/** Resolves with the approval's result, or rejects when the user or the clock ends the attempt first. */
function waitForApproval<T>(
  approval: PassportApproval<T>,
  currentOutcome: () => PassportOutcome | undefined,
  popup: Window,
  { timeoutMs, closedGraceMs, checkIntervalMs }: { timeoutMs: number; closedGraceMs: number; checkIntervalMs: number },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let closedAt: number | null = null;
    let settled = false;

    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      settle();
    };

    const interrupt = (reason: PassportAttemptFailure) => {
      finish(() => {
        void Promise.resolve()
          .then(() => approval.cancel())
          .catch(() => undefined)
          .then(() => reject(new PassportAttemptError(reason)));
      });
    };

    const interruption = (): PassportAttemptFailure | null => {
      const outcome = currentOutcome();
      if (outcome === 'cancel') return 'cancelled';
      if (outcome === 'error') return 'failed';
      if (popup.closed && outcome !== 'success') {
        closedAt ??= Date.now();
        if (Date.now() - closedAt >= closedGraceMs) return 'closed';
      }
      return Date.now() >= deadline ? 'timeout' : null;
    };

    const check = () => {
      const reason = interruption();
      if (reason) interrupt(reason);
    };

    const timer = setInterval(check, checkIntervalMs);
    approval.result.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

/**
 * The outcome carried by a message from this attempt's popup, or undefined.
 * Passport's own message is acknowledged so Passport closes the popup
 * instead of navigating it to the callback page.
 */
function readOutcome(
  event: MessageEvent<unknown>,
  popup: Window,
  passportOrigin: string,
  appOrigin: string,
): PassportOutcome | undefined {
  const data = event.data;
  if (event.source !== popup || !isRecord(data) || !isPassportOutcome(data.outcome)) return undefined;

  if (event.origin === passportOrigin) {
    if (
      data.type !== PASSPORT_OUTCOME_MESSAGE ||
      data.version !== PASSPORT_MESSAGE_VERSION ||
      typeof data.messageId !== 'string'
    ) {
      return undefined;
    }
    popup.postMessage(
      { type: PASSPORT_OUTCOME_ACK_MESSAGE, version: PASSPORT_MESSAGE_VERSION, messageId: data.messageId },
      passportOrigin,
    );
    return data.outcome;
  }

  if (event.origin === appOrigin && data.type === PASSPORT_CALLBACK_MESSAGE) {
    return data.outcome;
  }
  return undefined;
}
