import type { NextConfig } from 'next';
import withSerwistInit from '@serwist/next';
import { withSentryConfig } from '@sentry/nextjs';
import packageJson from './package.json';
import { buildInfoToEnv } from './src/libs/build-info/build-info';
import { resolveBuildInfo } from './src/libs/build-info/resolve-build-info';
import { buildDenyFramingRouteHeaders } from './src/libs/security/headers';
import {
  ASSET_PREFIX_ENV_VAR,
  BASE_PATH_ENV_VAR,
  isValidAssetPrefix,
  isValidBasePath,
  normalizeAssetPrefix,
  normalizeBasePath,
} from './src/libs/base-path/base-path';
import { buildSocialLinkOutRedirects, parseSocialHost, resolveShopOrigins } from './src/libs/social-host/social-host';

/**
 * Mount path and asset prefix (see `src/libs/base-path/base-path.ts`). Both are
 * baked into the build by Next.js, so they are read from the build environment.
 * Unset keeps the Shop on the origin root, with no `basePath` or `assetPrefix`.
 */
export function resolveMountConfig(env: Record<string, string | undefined>) {
  const basePath = normalizeBasePath(env[BASE_PATH_ENV_VAR]);
  if (!isValidBasePath(basePath)) {
    throw new Error(`${BASE_PATH_ENV_VAR} must be empty or a path like /shop (received ${JSON.stringify(basePath)})`);
  }
  const assetPrefix = normalizeAssetPrefix(env[ASSET_PREFIX_ENV_VAR]);
  if (assetPrefix !== undefined && !isValidAssetPrefix(assetPrefix)) {
    throw new Error(
      `${ASSET_PREFIX_ENV_VAR} must be a path like /shop-static or an absolute http(s) URL without a trailing slash (received ${JSON.stringify(assetPrefix)})`,
    );
  }
  return {
    ...(basePath !== '' && { basePath }),
    ...(assetPrefix !== undefined && { assetPrefix }),
  };
}

export const redirects = async () => [
  {
    source: '/',
    destination: '/marketplace',
    permanent: false,
  },
  // Social link-out (off unless NEXT_PUBLIC_SOCIAL_HOST is set). Listed before the
  // legacy posts redirect so a legacy URL reaches the social host in one hop.
  // Unconditional and session-free: a Shop-signed-in user lands on the social
  // host signed out unless they signed in there too (one sign-in per site).
  ...buildSocialLinkOutRedirects(
    parseSocialHost(process.env.NEXT_PUBLIC_SOCIAL_HOST, process.env.NODE_ENV, resolveShopOrigins(process.env)),
  ),
  // /profile/[pubky] is the canonical other-user posts view (see app/profile/[pubky]/page.tsx).
  // The legacy /profile/[pubky]/posts route is kept as a 308 permanent redirect so existing
  // bookmarks, shares, and search indexes consolidate onto the canonical URL without invoking
  // any React/SSR work for the legacy path.
  {
    source: '/profile/:pubky/posts',
    destination: '/profile/:pubky',
    permanent: true,
  },
];

const nextConfig: NextConfig = {
  ...resolveMountConfig(process.env),
  env: {
    NEXT_PUBLIC_APP_VERSION: process.env.NEXT_PUBLIC_APP_VERSION ?? packageJson.version,
    // Served at /version.json and as <meta name="build"> (see docs/ecommerce/release.md).
    ...buildInfoToEnv(
      resolveBuildInfo({ env: process.env, packageName: 'pubky-marketplace', packageVersion: packageJson.version }),
    ),
  },
  reactCompiler: true,
  transpilePackages: ['@bitcoinerrorlog/pubky-shop'],
  // Source maps are generated for every build (browser + server), but the Sentry plugin upload
  // is disabled below. Docker builds inject Debug IDs and optionally upload maps when Sentry
  // build credentials are provided; public builds without those credentials skip upload.
  // See docs/sentry.md + ADR 0018.
  productionBrowserSourceMaps: true,
  // OG image routes read satori font/brand assets from disk at runtime. On
  // serverless deploys (Vercel) the bundler does not emit them, so trace the
  // asset directory into every function bundle (see src/libs/og/ogFonts.ts).
  outputFileTracingIncludes: {
    '/**': ['./src/libs/og/assets/**/*'],
  },
  experimental: {
    serverSourceMaps: true,
  },
  // Only use standalone output when building for Docker (set NEXT_STANDALONE=true)
  ...(process.env.NEXT_STANDALONE === 'true' && { output: 'standalone' }),
  // Clickjacking defence: Shop embeds pubky.app's /session-bridge, but nothing
  // legitimate embeds Shop — deny framing on every route. COOP keeps the
  // opener of popups Shop opens (Pubky Passport).
  async headers() {
    return buildDenyFramingRouteHeaders();
  },
  redirects,
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals.push('@synonymdev/pubky');
    }

    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };

    return config;
  },
  // Turbopack config for WebAssembly dependencies
  turbopack: {
    resolveAlias: {
      '@synonymdev/pubky': '@synonymdev/pubky/index.js',
      'pubky-app-specs': 'pubky-app-specs/index.js',
    },
  },
};

/**
 * The precache downloads in the background on a first visit, competing with the page.
 * It holds shell assets only (CSS, fonts, the manifest and the header logo). Route JS,
 * WASM, images and video stay in the HTTP cache, which serves visited `/_next/static`
 * files immutably.
 */
export const SW_PRECACHE_PUBLIC_PATTERNS = ['manifest.json', 'pubky-favicon.svg', 'pubky-logo.svg'];
export const SW_PRECACHE_EXCLUDE = [
  /\.map$/,
  /^manifest.*\.js$/,
  /^static\/chunks\//,
  /\.wasm$/,
  /^static\/media\/.*\.(png|jpe?g|gif|webp|avif|svg|mp4|webm)$/,
];

const withSerwist = withSerwistInit({
  swSrc: 'src/sw.ts',
  swDest: 'public/sw.js',
  disable: process.env.NODE_ENV === 'development',
  globPublicPatterns: SW_PRECACHE_PUBLIC_PATTERNS,
  exclude: SW_PRECACHE_EXCLUDE,
});

const composedConfig = withSerwist(nextConfig);

export default withSentryConfig(composedConfig, {
  silent: !process.env.CI,
  disableLogger: true,
  // Disable the Sentry plugin upload. Docker builds handle Debug-ID injection and optional
  // source-map upload via sentry-cli, while public builds without Sentry credentials skip upload.
  sourcemaps: {
    disable: true,
  },
  // Release identification comes from Sentry.init({ release }) at runtime. Local builds use the
  // package version; Docker CI overrides NEXT_PUBLIC_APP_VERSION with the commit SHA so events
  // and uploaded maps share one release value. Disable release creation here so the plugin never
  // attempts Sentry API calls.
  release: {
    create: false,
  },
  // tunnelRoute deferred — adopting it requires creating middleware.ts to exclude
  // the /monitoring path. Revisit if Sentry shows ad-blocker drops.
});
