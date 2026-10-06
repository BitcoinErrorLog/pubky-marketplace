/**
 * Route headers for the Shop deployment.
 *
 * Clickjacking defence: Shop only ever EMBEDS pubky.app's `/session-bridge`
 * (see `src/libs/vibe-session/bridge.ts`); nothing legitimate embeds Shop
 * itself, so every route denies framing. `frame-ancestors 'none'` is the
 * modern CSP directive; `X-Frame-Options: DENY` covers browsers without CSP
 * level 2.
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
export function buildDenyFramingRouteHeaders() {
  return [
    {
      source: '/(.*)',
      headers: [
        { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
      ],
    },
  ];
}
