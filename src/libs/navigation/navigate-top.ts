import { isShopEmbedded } from '@/config/embedded';
import { isFramed } from '@/libs/embedded/embedded';

/**
 * How a navigation left the Shop. Returned so callers and tests can tell a
 * real top-window navigation from a degraded one.
 *
 *  - `self`: the Shop is the top window, or not embedded; the page itself navigated.
 *  - `top`: the Shop is framed and the top window navigated.
 *  - `tab`: the top window could not be driven, so the URL opened in a new tab.
 *  - `frame`: last resort; only the frame navigated.
 */
export type NavigateTopResult = 'self' | 'top' | 'tab' | 'frame';

type NavigableWindow = Pick<Window, 'self' | 'top' | 'location' | 'open'>;

const WEB_PROTOCOLS = new Set(['http:', 'https:']);

function resolveTarget(url: string, win: NavigableWindow): URL | null {
  try {
    return new URL(url, win.location.href);
  } catch {
    return null;
  }
}

/** Reading a cross-origin `top.location.origin` throws; that is the same-origin test. */
function topOriginOf(win: NavigableWindow): string | null {
  try {
    return win.top?.location.origin ?? null;
  } catch {
    return null;
  }
}

/**
 * Leave the Shop for `url`, in the top window.
 *
 * Every flow that hands the user to another page (PayPal checkout, a Ring,
 * Bitkit or Passport deep link, a link to the host app) must call this instead
 * of `window.location`. When the Shop is framed, `window.location` would
 * navigate only the iframe: PayPal refuses to render in a frame, and mobile
 * browsers may block a custom-scheme navigation from a subframe.
 *
 * Order of attempts when the Shop is framed:
 *  1. Same-origin top window (the Shop mounted under the host app's origin):
 *     `window.top.location.assign(url)`.
 *  2. Cross-origin top window: the `href` setter, the one cross-origin
 *     navigation the platform allows. Browsers still require a user gesture or
 *     a sandbox flag for it, and report a refusal asynchronously, so it cannot
 *     be detected afterwards; only a synchronous throw falls through.
 *  3. A new tab, for http(s) URLs, so the user is never stranded in a frame
 *     that cannot show the destination.
 *  4. The frame itself.
 *
 * When the Shop is not embedded, or not framed, it is a plain `window.location.assign`.
 */
export function navigateTop(
  url: string,
  win: NavigableWindow = window,
  embedded: boolean = isShopEmbedded(),
): NavigateTopResult {
  // A frame the Shop was not configured to be embedded in (a test harness) navigates itself.
  if (!embedded || !isFramed(win)) {
    win.location.assign(url);
    return 'self';
  }

  const top = win.top;
  if (top) {
    const sameOrigin = topOriginOf(win) === win.location.origin;
    try {
      if (sameOrigin) {
        top.location.assign(url);
      } else {
        top.location.href = url;
      }
      return 'top';
    } catch {
      // Fall through to the degraded paths below.
    }
  }

  const target = resolveTarget(url, win);
  if (target && WEB_PROTOCOLS.has(target.protocol)) {
    const tab = win.open(target.href, '_blank', 'noopener,noreferrer');
    if (tab !== null) return 'tab';
  }

  win.location.assign(url);
  return 'frame';
}
