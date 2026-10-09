# Serving the Shop inside pubky.app

What the Shop build now supports, and what the App, the reverse proxy and the backing services must do so the Shop can run at `https://pubky.app/shop` (an iframe or a proxied path) next to the App. It covers embedding readiness only (lane L3). Sign-in, session sharing and the App's own route are separate lanes: see [Out of scope](#out-of-scope-and-open-items).

Everything here is off by default. With none of the keys below set, the Shop behaves as it did before, with one exception: its browser storage names change, and existing users' data moves to them on first load (see [Browser storage](#browser-storage)).

## Environment keys this change adds

| Key | Kind | Default | Meaning |
|---|---|---|---|
| `NEXT_PUBLIC_BASE_PATH` | build | empty | Mount path, for example `/shop`. Leading slash, no trailing slash. Baked into the build by Next.js, so changing it needs a rebuild. In Docker, pass it as a build arg. |
| `NEXT_PUBLIC_ASSET_PREFIX` | build | unset | Optional prefix for `/_next/*` assets: a path such as `/shop-static`, or an absolute `https://` CDN URL. Unset keeps the Next.js default (the base path). |
| `NEXT_PUBLIC_DB_NAME` | build | `shop-franky` | Dexie database name. Was `franky`. Leave it at the default. |
| `PUBKY_RUNTIME_FRAME_ANCESTORS` | runtime | unset | Origins allowed to frame the Shop. Space- or comma-separated exact origins and the `'self'` keyword. Unset denies framing everywhere. Read on every request, so one image serves both modes. |
| `PUBKY_RUNTIME_EMBEDDED` | runtime | `false` | Force the embedded layout and behaviour even when the page is not detected as framed. Use it on a deployment that exists only to be embedded, so server-rendered HTML is already the embedded layout. |
| `PUBKY_RUNTIME_STORAGE_ADOPT_LEGACY` | runtime | derived | Whether this origin's old storage names (`franky`, `auth-store`, ...) are the Shop's, so they are migrated. Unset means yes when `NEXT_PUBLIC_BASE_PATH` is empty and no when it is set. |

`PUBKY_RUNTIME_DEFAULT_URL` stays the site **origin** (`https://pubky.app`). The mount path is appended where a public URL is built (canonical links, structured data, share links).

Invalid values fail the build (build keys) or startup (runtime keys), not silently.

## The reverse proxy

Route `https://pubky.app/shop` and everything under it to the Shop deployment, with the path unchanged. The Shop is built for `/shop` and expects to receive `/shop/...`; do not strip the prefix.

- **Static assets.** `/shop/_next/static/*` is immutable and safe to cache for a year. If `NEXT_PUBLIC_ASSET_PREFIX` is set to a path, route that path too.
- **HTML and API.** Do not cache `/shop/*` HTML or `/shop/api/*`.
- **Headers.** Pass `Host` and `X-Forwarded-Proto: https` through. The Shop's grant bridge checks the browser `Origin` against its allow-list, so `Origin` must arrive unmodified.
- **Cookies.** The Shop's bridge cookies are `__Host-`prefixed, `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`. On `pubky.app` they are sent to App routes too. They do not clash by name, but the App must not clear or overwrite cookies it did not set.
- **Redirects.** `/shop` redirects to `/shop/marketplace`.
- **Socials.** Leave `NEXT_PUBLIC_SOCIAL_HOST` unset in the embedded build. With it set, `/shop/home` and the other social routes answer a 307 to the App and would load the App inside the frame.

The Shop exposes no manifest and registers no service worker under a base path (see [Service worker](#service-worker)), so the App's manifest and worker are the only ones on the origin.

## Framing and the host page

The Shop answers every response with:

```
Content-Security-Policy: frame-ancestors <PUBKY_RUNTIME_FRAME_ANCESTORS, or 'none'>
Cross-Origin-Opener-Policy: same-origin-allow-popups
X-Frame-Options: DENY            (only when no ancestor is allowed)
X-Frame-Options: SAMEORIGIN      (only when the list is exactly 'self')
```

For the iframe at `pubky.app/shop`, set `PUBKY_RUNTIME_FRAME_ANCESTORS='self'`. To also allow staging to frame a production Shop (or the reverse), list the exact origins: `'self' https://staging.pubky.app`. Wildcards, paths and `'none'` are rejected.

On the App's side:

- **Its own CSP.** If the App ships `frame-src` or `child-src`, it must allow `'self'`.
- **The iframe element.** A same-origin iframe needs no `sandbox`. If the App adds one anyway, it must include `allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-top-navigation allow-top-navigation-to-custom-protocols`, or the Shop cannot leave the frame (see [Leaving the frame](#leaving-the-frame)). Add `allow="clipboard-write"` so copy buttons work.
- **Initial URL.** `src="/shop/marketplace"` is enough: the Shop detects that it is framed, provided `PUBKY_RUNTIME_FRAME_ANCESTORS` is set (which framing needs anyway). Adding `?embedded=1` is harmless and also forces the embedded layout in a window that is not framed (useful for tests).
- **Inner path in the outer URL.** The Shop does not rewrite the App's address bar. Deep links, refresh and Back need the App's `/shop/<path>` route to pass the path to the iframe and to update itself when the Shop navigates.
- **Returns that land top-level.** PayPal and signer apps return to a top-level URL, so `https://pubky.app/shop/...` must also load as a full page, not only inside the frame. The Shop renders its own full layout when it is not framed.

## Allowed origins on the backing services

The Shop's origin changes to `https://pubky.app`, and the setup and connect frames are nested one level deeper, so each service must accept it. Keep the `shop.pubky.app` entries in place until the standalone site is retired; it is the rollback.

| Service | Setting | Add |
|---|---|---|
| Marketplace service | `SERVICE_ALLOWED_ORIGINS` (CORS) | `https://pubky.app` |
| Shop grant bridge (in the Shop deployment) | `SHOP_ALLOWED_ORIGINS` | `https://pubky.app` |
| Paykit server | `[setup] allowed_origins` | `https://pubky.app` |
| Lock Server | `allowed_return_origins` | `https://pubky.app` |
| Marketplace Nexus | CORS allow-list | `https://pubky.app` |
| Fiat verifier | CORS allow-list | `https://pubky.app` |

Also decide for the embedded deployment: `SHOP_PUBLIC_ORIGIN` and `SHOP_GRANT_ASSERTION_ISSUER` must be equal, and the marketplace service must trust that issuer and its key. If the embedded deployment is a separate instance from `shop.pubky.app`, it carries its own origin there; this is a trust change on the service, not a Shop setting.

Apply on staging first, then re-run [install verification](install-verification.md) with the new origin: the `service.cors.*`, `flow.paykit-setup.*` and `flow.locks-connect.*` checks cover these settings.

## Leaving the frame

Every flow that hands the user to another page must navigate the **top** window. Inside a frame, `window.location` would navigate only the iframe, PayPal refuses to render in a frame, and mobile browsers may block a custom-scheme navigation from a subframe.

`navigateTop(url)` in `src/libs/navigation/navigate-top.ts` is the one helper for this:

1. Not embedded, or not framed: `window.location.assign(url)`.
2. Framed, top window same origin (the `pubky.app/shop` case): `window.top.location.assign(url)`.
3. Framed, top window cross-origin: the `href` setter, the one cross-origin navigation the platform allows. Browsers want a user gesture or a sandbox flag for it and report a refusal asynchronously, so it cannot be detected.
4. Otherwise, for `http(s)` URLs, a new tab. The frame is the last resort.

Adopted in this change: the PayPal checkout hand-off, in the cart and accepted-offer paths, with tests. Social-host profile links render `target="_top"` when embedded.

Not adopted here, because the files belong to the sign-in work: the five signer deep links, which still use `window.location.href = authorizationUrl`:

- `src/hooks/useMobileAuth/useMobileAuth.tsx`
- `src/hooks/useStepUpReauth/useStepUpReauth.ts`
- `src/hooks/useMarketplaceSessionConnect/useMarketplaceSessionConnect.ts`
- `src/hooks/useMarketplaceMessagingEnable/useMarketplaceMessagingEnable.ts`
- `src/hooks/useMarketplaceInventoryGrantConnect/useMarketplaceInventoryGrantConnect.ts`

Replace each with `navigateTop(authorizationUrl)`. The Paykit setup and Lock Server connect panels are nested iframes whose sandbox already grants top navigation to custom protocols. They write no `location`, so nothing changes there.

## Embedded layout

The Shop is embedded when the page is framed **and** the deployment allows framing (`PUBKY_RUNTIME_FRAME_ANCESTORS` is not empty), when `PUBKY_RUNTIME_EMBEDDED=true`, or when the URL has `?embedded=1` (read once per page load). A frame the deployment does not allow keeps the normal layout: that is how the Cypress and Vitest browser harnesses, which run the page in an iframe, stay unchanged. Embedded, the Shop renders no header, no mobile header, no mobile footer and no floating action button: the host app owns the page chrome. The marketplace section bar (Marketplace, Messages, Watchlist, Cart, Offers, Orders, Activity, My shop) is page content and stays, so every Shop destination remains reachable.

The document also gets `data-shop-embedded="true"`, which collapses the header offsets (`--header-offset-main`, `--header-offset-mobile`, the marketplace sub-navigation's fixed mobile offset) so sticky elements stick to the top of the frame instead of leaving a gap where the Shop header used to be.

A deployment that sets `PUBKY_RUNTIME_EMBEDDED=true` renders this from the first byte. A page detected only in the browser (framed, or `?embedded=1`) shows the Shop chrome for a moment, then drops it right after hydration.

## Service worker

The Serwist build plugin no longer registers the worker by itself. `ServiceWorkerRegistration` registers it only when the Shop is **not** embedded and **not** mounted under a base path. Under `pubky.app/shop` the Shop therefore registers no worker of its own, and the App's worker owns the origin. The App's navigation fallback must not capture `/shop/` navigations.

## Browser storage

The Shop is a fork of the App and shares its storage names. On one origin they collide: the same Dexie database at two schema versions (the Shop's recreate-on-mismatch would wipe the App's, and the reverse), one app's sign-out sweep clearing the other's keys, and the App reading the Shop's `auth-store` as its own legacy identity and deleting it.

Names the App also defines now carry a `shop-` prefix:

| Before | After |
|---|---|
| Dexie `franky` | `shop-franky` |
| Messaging keyring `franky-messaging-keyring` | `shop-franky-messaging-keyring` |
| `auth-store`, `onboarding-storage`, `notification-store`, `search-store`, `home-store`, `hot-store`, `settings-storage`, `marketplace-display-storage` | the same names with `shop-` |
| `pubky-feature-discovery:*` | `shop-pubky-feature-discovery:*` |
| session keys `pubky:force-feed-scroll-top`, `pubky-app:mute-sync-cursor:*` | `shop-` prefixed (not migrated; per-tab) |

Names only the Shop uses (`marketplace:*`, `pubky.marketplace.*`, the Web Lock names, the messaging-keys teardown flag) are unchanged, because nothing else can collide with them.

### Migration of existing users

Runs on the first load of the new build, in two parts:

- **localStorage, synchronous.** Runs while the persisted stores are imported, before any store reads its key. Each legacy key is copied to its namespaced name, read back, then deleted.
- **IndexedDB, before the database opens.** Under one exclusive Web Lock: the messaging keyring is copied first (the encrypted rows are useless without its key), then every table of `franky`, then each table's row count is checked, and only then are the legacy databases deleted.

Guarantees:

- **No data loss.** Nothing is deleted before everything is copied and verified. Any failure leaves the legacy data untouched, records no outcome and retries on the next load. A failed database migration shows the existing recovery screen instead of opening an empty database.
- **Safe to run twice.** Copies are add-if-absent: an existing namespaced row or key always wins over the legacy one. A recorded outcome (`shop-storage-migration:local-v1`, `shop-storage-migration:database-v1` in localStorage) ends every later run at once, so a stale tab on the old build, or an App that later writes `auth-store` or `franky` on the same origin, is never read.
- **Only the Shop's data moves.** The legacy database must contain Shop-only tables (`commerce_shops`); a database that does not is left alone and recorded as foreign. On an origin where those names are the App's (`NEXT_PUBLIC_BASE_PATH` set, or `PUBKY_RUNTIME_STORAGE_ADOPT_LEGACY=false`) nothing is read or moved, and the decision is recorded so flipping the setting later cannot start adopting the App's data.
- **Quota.** The copy briefly holds the data twice. A device too full to copy keeps the legacy data and retries.

Known edges:

- A tab still running the previous build writes to the legacy names after the move; those writes are not carried over. Close old tabs after deploying.
- The marketplace promo's pre-paint script (inline, before any bundle) reads the new key, so on the very first load after the upgrade a user who had dismissed the promo may see it for a moment.
- If the migration cannot delete a legacy database because another tab holds it open, it leaves the database and moves on (after five seconds).

### Sequencing

Ship the namespaced build to `shop.pubky.app` first and let users load it before the App ever shares an origin with Shop data. The embedded deployment on `pubky.app` has no Shop data of its own to migrate. Existing `shop.pubky.app` data stays on that origin (browser storage does not follow users to another origin); keep the standalone site serving through the transition.

## Mounted-path details

Prefixed with the mount path: same-origin API calls, public images (through `BasePathImage`), `<video>` and CSS-referenced artwork, share links, `history.replaceState` for the checkout URL, canonical and Open Graph URLs (`metadataBase` includes the path), structured data, and the OG fallback redirect. Next.js handles the router, `next/link`, redirects and `/_next` assets itself. The web manifest link is omitted under a base path.

## Out of scope and open items

Left to the sign-in lane, because the files are in its area:

- **SDK and grant state.** The SDK's own `pubky-auth` IndexedDB store and the Shop's sign-out `clearAll()` are shared with the App on one origin. Namespacing or removing them is part of the grant work.
- **Auth coordination names.** `pubky-auth-epoch-v1` (localStorage), `pubky-auth-v1` (BroadcastChannel) and `pubky-auth-finalization-v1` (Web Lock) are Shop-only names today, so they do not collide.
- **Signer deep links** listed under [Leaving the frame](#leaving-the-frame).
- **Service-session requests.** `src/core/services/marketplace/marketplace-grant-client.ts` and `marketplace-bootstrap-client.ts` call `fetch('/api/marketplace/...')` with a root-relative path. Wrap each URL in `withBasePath(...)` from `@/config/base-path`, as the other API calls now are. `src/core/services/homeserver/homeserver.ts` has one more for the development-only `/api/dev/signup-token`.

Needs a decision or a live check:

- Whether the Shop shows its own sign-in when embedded, or always defers to the App.
- The outer/inner URL scheme and where mobile and PayPal returns land.
- Safari and iOS behaviour of a same-origin iframe (storage persistence, Web Locks, BroadcastChannel, custom-scheme navigation from the frame) is inferred, not yet tested.
