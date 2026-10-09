import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import type { PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import tsconfigPaths from 'vite-tsconfig-paths';
import { playwright } from '@vitest/browser-playwright';
import { resizeVrtBrowser } from './src/test-utils/vrt.commands';
import { VRT_VIEWPORT_DESKTOP } from './src/test-utils/vrt.viewports';

// Tests that import the paykit-wasm / locks-sdk-wasm bindings must exercise
// the VENDORED artifacts in this repository, not whatever a shared/linked
// node_modules happens to point at (e.g. worktrees sharing a sibling
// checkout's node_modules, where the file: symlink resolves to the sibling's
// vendor directory). These aliases are INTENTIONALLY PERMANENT, not a
// worktree-local workaround: in a normal checkout they are a no-op (the file:
// dependency links node_modules to this same vendored path), while in
// shared-node_modules worktrees they pin tests to THIS repo's artifacts.
// Vitest projects do NOT inherit top-level resolve, so each project applies
// them via `paykitWasmAlias`.
const paykitWasmAlias = {
  'paykit-wasm': fileURLToPath(new URL('./vendor/paykit-wasm/paykit_wasm.js', import.meta.url)),
  'locks-sdk-wasm': fileURLToPath(new URL('./vendor/locks-sdk-wasm/locks_sdk_wasm.js', import.meta.url)),
};
const assetIncludes = ['**/*.woff', '**/*.woff2', '**/*.ttf', '**/*.otf'];
const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const nodeModulesRoot = realpathSync(new URL('./node_modules', import.meta.url));
const fontAssetPattern = /\.(woff2?|ttf|otf)(?:\?.*)?$/;

const vrtBrowserNames = (process.env.VRT_BROWSERS ?? 'chromium,firefox,webkit')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);

const allowedVrtBrowsers = new Set(['chromium', 'firefox', 'webkit']);
for (const name of vrtBrowserNames) {
  if (!allowedVrtBrowsers.has(name)) {
    throw new Error(`VRT_BROWSERS contains unknown browser "${name}". Use chromium, firefox, and/or webkit.`);
  }
}

const vrtBrowserInstances = vrtBrowserNames.map((browser) => ({
  browser: browser as 'chromium' | 'firefox' | 'webkit',
  viewport: VRT_VIEWPORT_DESKTOP,
}));

type PixelmatchComparatorOptions = {
  allowedMismatchedPixels?: number;
  allowedMismatchedPixelRatio?: number;
  threshold?: number;
};

function vrtProject(opts: {
  name: string;
  include: string[];
  exclude?: string[];
  comparatorOptions: PixelmatchComparatorOptions;
  setupFiles?: string[];
  fileParallelism?: boolean;
}) {
  return {
    plugins: [fontUrlImportPlugin(), react(), tsconfigPaths()],
    assetsInclude: assetIncludes,
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-dom/client',
        'react/jsx-runtime',
        'react/jsx-dev-runtime',
        'next/font/google',
        '@noble/hashes/blake3.js',
        '@noble/hashes/utils.js',
        '@noble/ciphers/chacha.js',
        '@noble/hashes/hkdf.js',
        '@noble/hashes/hmac.js',
        '@noble/hashes/sha2.js',
      ],
    },
    resolve: { alias: paykitWasmAlias },
    test: {
      name: opts.name,
      globals: true,
      testTimeout: 30_000,
      include: opts.include,
      exclude: ['**/node_modules/**', '**/.claude/**', '**/._*', ...(opts.exclude ?? [])],
      setupFiles: ['./src/test-utils/vrt.setup.ts', ...(opts.setupFiles ?? [])],
      ...(opts.fileParallelism === false ? { fileParallelism: false } : {}),
      server: { deps: { inline: ['react-tweet'] } },
      browser: {
        enabled: true,
        provider: playwright(),
        headless: true,
        commands: { resizeVrtBrowser },
        expect: {
          toMatchScreenshot: {
            comparatorName: 'pixelmatch' as const,
            comparatorOptions: opts.comparatorOptions,
            // Element border box, not a viewport page crop. `caret`/`animations`
            // match Playwright locator.screenshot defaults so linux and darwin
            // capture the same region.
            screenshotOptions: {
              animations: 'disabled' as const,
              caret: 'hide' as const,
            },
            // Image-heavy suites (Home, Collections) on WebKit/Linux need
            // extra headroom for layout to settle after fonts/images decode.
            timeout: 15_000,
          },
        },
        // `viewport` below is the INITIAL browser size only. Each test
        // resizes the page per-call via `page.viewport(w, h)` inside
        // `renderForVRT` (see `src/test-utils/vrt.tsx`), so mobile
        // (VRT_VIEWPORT_MOBILE) is driven by the test, not by this
        // config. Add new sizes to `src/test-utils/vrt.viewports.ts`.
        instances: vrtBrowserInstances,
      },
    },
  };
}

function fontUrlImportPlugin(): PluginOption {
  return {
    name: 'font-url-import',
    enforce: 'pre',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? '';
        if (!fontAssetPattern.test(url) || !url.includes('import') || !url.includes('url')) {
          next();
          return;
        }

        const [servedPath] = url.split('?');
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/javascript');
        res.end(`export default ${JSON.stringify(servedPath)};`);
      });
    },
    load(id) {
      if (!fontAssetPattern.test(id) || !id.includes('url')) return null;

      const [filePath] = id.split('?');
      const fsPath = filePath.startsWith('/@fs/') ? filePath.slice('/@fs'.length) : filePath;
      const servedPath = `/@fs/${fsPath.replace(/^\/+/, '')}`;

      return `export default ${JSON.stringify(servedPath)};`;
    },
  };
}

export default defineConfig({
  // Release worktrees share node_modules, so allow each gate to isolate Vite's
  // optimizer cache instead of racing another worktree's browser run.
  cacheDir: process.env.VITE_CACHE_DIR ?? 'node_modules/.vite',
  plugins: [fontUrlImportPlugin(), react(), tsconfigPaths()],
  assetsInclude: assetIncludes,
  resolve: {
    // Force a single copy of these packages so we never load two versions at once.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    fs: {
      allow: [repoRoot, nodeModulesRoot],
    },
  },
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      reportOnFailure: true,
    },
    snapshotFormat: {
      escapeString: true,
      printBasicPrototype: false,
    },
    resolveSnapshotPath: (testPath, snapExtension) => testPath + snapExtension,
    onConsoleLog(log) {
      if (
        log.includes('WebAssembly.instantiateStreaming') ||
        log.includes('application/wasm') ||
        log.includes('MIME type')
      ) {
        return false;
      }
      if (log.includes('Not implemented: navigation')) {
        return false;
      }
      return true;
    },
    dangerouslyIgnoreUnhandledErrors: false,
    silent: false,
    projects: [
      // Unit tests run in jsdom.
      {
        plugins: [fontUrlImportPlugin(), react(), tsconfigPaths()],
        assetsInclude: assetIncludes,
        resolve: { alias: paykitWasmAlias },
        test: {
          name: 'unit',
          environment: 'jsdom',
          setupFiles: ['./src/config/test.ts'],
          globals: true,
          include: ['**/*.test.{ts,tsx}'],
          // .claude excludes local tooling worktrees checked out inside the repo.
          // ._* excludes macOS AppleDouble resource-fork files on external drives.
          exclude: ['**/node_modules/**', '**/.claude/**', '**/*.vrt.test.{ts,tsx}', '**/._*'],
          server: { deps: { inline: ['react-tweet'] } },
        },
      },
      // VRT(Visual Regression Tests) run in real browsers via Playwright.
      vrtProject({
        name: 'vrt',
        include: ['**/*.vrt.test.{ts,tsx}'],
        exclude: ['**/src/test/vrt/marketplace/**'],
        // Shared by comparison (`npm run test:vrt`) and regeneration
        // (`--update`). 0.001 (0.1%) hid a user-visible marketplace
        // badge rewrite ("Local pickup" → "Shipping") on 1440×900
        // desktop captures (~1.3M px → 1,296 allowed mismatches).
        // The more restrictive of pixels and ratio wins. 80 px is
        // enough for residual AA/font raster noise; a one-word label
        // change is hundreds of pixels and must fail. Scenes that
        // genuinely need more slack pass `comparatorOptions` on that
        // `toMatchScreenshot` call only.
        comparatorOptions: {
          allowedMismatchedPixels: 80,
          allowedMismatchedPixelRatio: 0.00005,
        },
        // One file at a time. With file parallelism, Chromium and Firefox
        // open every spec while Vite is still bundling dependencies. The
        // server drops those sockets, and Vitest aborts with a closed
        // browser before any test runs. Playwright already passes
        // --disable-dev-shm-usage, and a 2GB /dev/shm does not prevent it.
        fileParallelism: false,
      }),
      vrtProject({
        name: 'vrt-marketplace',
        include: ['src/test/vrt/marketplace/**/*.vrt.test.{ts,tsx}'],
        // shop-v0.6.10, shop-v0.6.11, and shop-v0.6.12 each halted after
        // merge onto release/shop-v0.6.8 on 0.01–0.02 reported ratio
        // (69 px badge-disc AA; ~1.3% firefox hover scale/shadow raster).
        // Global `vrt` keeps 80 px / 0.00005 so a one-word badge rewrite
        // still fails there. Marketplace full-page scenes use Vitest's
        // 2% ratio example plus a slightly looser per-pixel colour
        // threshold; do not also set allowedMismatchedPixels or that
        // 80 px cap remains the winner and the halt class returns.
        comparatorOptions: {
          allowedMismatchedPixelRatio: 0.02,
          threshold: 0.2,
        },
        // Zero-duration transitions so hover scale paints on the first
        // frame. Serialize marketplace files: instrumented full-suite
        // Firefox mobile had matches(':hover') true and a scaled
        // getBoundingClientRect while the PNG was still rest — parallel
        // files share the Firefox compositor/pointer.
        setupFiles: ['./src/test-utils/vrt.marketplace.setup.ts'],
        fileParallelism: false,
      }),
    ],
  },
});
