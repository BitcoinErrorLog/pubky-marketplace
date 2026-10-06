import { ExpirationPlugin, NetworkFirst, NetworkOnly, type RuntimeCaching } from 'serwist';

/**
 * Runtime routes for the service worker (`src/sw.ts`).
 *
 * Navigation preload is enabled, so every navigation must be answered by a
 * strategy: NetworkOnly returns `event.preloadResponse` when the browser has
 * one. Without a navigation route the preload goes unused and the browser
 * sends the page request only after the preload settles.
 */
export function buildRuntimeCaching(): RuntimeCaching[] {
  return [
    {
      matcher: ({ request }) => request.mode === 'navigate',
      handler: new NetworkOnly(),
    },
    // API caching for Nexus
    {
      matcher: ({ url }) => /^https:\/\/nexus\..*\.pubky\.app\/.*$/i.test(url.href),
      handler: new NetworkFirst({
        cacheName: 'api-cache',
        networkTimeoutSeconds: 10,
        plugins: [
          new ExpirationPlugin({
            maxEntries: 50,
            maxAgeSeconds: 60 * 5, // 5 minutes
          }),
        ],
      }),
    },
    // Do not use `defaultCache` to prevent other origin services such as pkarr, homeserver and httprelay from being cached
  ];
}
