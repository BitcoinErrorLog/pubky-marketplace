/**
 * Route headers for the Shop deployment.
 *
 * Clickjacking defence: by default nothing legitimate embeds the Shop (it only
 * ever EMBEDS other origins' pages: the Paykit setup and Lock Server connect
 * frames), so every route denies framing. `frame-ancestors 'none'` is the modern
 * CSP directive; `X-Frame-Options: DENY` covers browsers without CSP level 2.
 *
 * Embedding: a deployer that mounts the Shop inside another app (for example an
 * iframe at `https://pubky.app/shop`) lists the framing origins in
 * `PUBKY_RUNTIME_FRAME_ANCESTORS`. The CSP then names exactly those sources.
 * `X-Frame-Options` cannot express an allow-list, so it is dropped, except for
 * the same-origin-only list, where `SAMEORIGIN` is the exact legacy equivalent.
 *
 * Opener isolation: `same-origin-allow-popups` cuts the link to any
 * cross-origin page that opened Shop, while popups Shop opens itself keep
 * their opener. Pubky Passport needs that opener to post its outcome message
 * back; plain `same-origin` would sever the Passport popup.
 *
 * Keeping the policy in a pure builder lets the unit test assert the exact
 * header set without booting Next (same pattern as upstream's
 * `buildSessionBridgeRouteHeaders`).
 */
export type RouteHeader = { key: string; value: string };

const SELF_SOURCE = "'self'";

export function buildFramingHeaders(frameAncestors: readonly string[]): RouteHeader[] {
  const sources = [...new Set(frameAncestors)];
  const csp = sources.length === 0 ? "frame-ancestors 'none'" : `frame-ancestors ${sources.join(' ')}`;
  const headers: RouteHeader[] = [{ key: 'Content-Security-Policy', value: csp }];
  if (sources.length === 0) {
    headers.push({ key: 'X-Frame-Options', value: 'DENY' });
  } else if (sources.length === 1 && sources[0] === SELF_SOURCE) {
    headers.push({ key: 'X-Frame-Options', value: 'SAMEORIGIN' });
  }
  headers.push({ key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' });
  return headers;
}
