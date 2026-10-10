/**
 * Embedded detection: is the Shop running inside another app's page (an
 * iframe such as `https://pubky.app/shop`) rather than as a top-level page?
 *
 * Three independent signals, any of which makes the Shop embedded:
 *  1. The page is framed (`window.self !== window.top`) AND the deployment
 *     allows framing (`PUBKY_RUNTIME_FRAME_ANCESTORS` is not empty). With the
 *     default policy (`frame-ancestors 'none'`) the Shop cannot legitimately be
 *     framed, so a framed page there is a test harness (Cypress and the
 *     Vitest browser both run the page in an iframe) and must keep the normal
 *     layout.
 *  2. The deployer forced it (`PUBKY_RUNTIME_EMBEDDED=true`). It is the only
 *     signal the server knows, so it is also what server rendering uses.
 *  3. The URL carries `?embedded=1`. It lets the host page, a test harness or
 *     a visual-regression scene request the embedded layout on a page that is
 *     not actually framed.
 *
 * The URL flag is read once per page load and kept in memory: client-side
 * navigation drops query strings, and the layout must not flip mid-session.
 * It is deliberately not stored in `sessionStorage`, which a same-origin
 * iframe shares with its parent and which would leak the flag to the next
 * top-level visit in the tab.
 */

export const EMBEDDED_QUERY_PARAM = 'embedded';
const EMBEDDED_QUERY_VALUE = '1';

/**
 * True when `win` is not the top-level window. Reading `top` is allowed
 * cross-origin; a browser that throws anyway is treated as framed, because
 * the only way to be denied access to `top` is to sit inside a frame.
 */
export function isFramed(win: Pick<Window, 'self' | 'top'> | undefined = globalThis.window): boolean {
  if (!win) return false;
  try {
    return win.self !== win.top;
  } catch {
    return true;
  }
}

export function hasEmbeddedQueryFlag(search: string): boolean {
  return new URLSearchParams(search).get(EMBEDDED_QUERY_PARAM) === EMBEDDED_QUERY_VALUE;
}

let queryFlagAtLoad: boolean | null = null;

function readQueryFlagOnce(win: Window): boolean {
  queryFlagAtLoad ??= hasEmbeddedQueryFlag(win.location.search);
  return queryFlagAtLoad;
}

/** Test seam: forget the memoized URL flag. */
export function resetEmbeddedForTests(): void {
  queryFlagAtLoad = null;
}

export interface EmbeddedSignals {
  /** The deployer override (`PUBKY_RUNTIME_EMBEDDED`). */
  forced: boolean;
  /** Whether the deployment allows framing at all (`PUBKY_RUNTIME_FRAME_ANCESTORS` is not empty). */
  framingAllowed: boolean;
}

/**
 * Client-side embedded check. The caller passes the configuration signals, so
 * this module stays free of runtime-config imports and testable on its own.
 */
export function isEmbedded(
  { forced, framingAllowed }: EmbeddedSignals,
  win: Window | undefined = globalThis.window,
): boolean {
  if (forced) return true;
  if (!win) return false;
  return (framingAllowed && isFramed(win)) || readQueryFlagOnce(win);
}
