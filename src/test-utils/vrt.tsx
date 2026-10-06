import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-react';
import { TooltipProvider } from '@/atoms/Tooltip/Tooltip';
import { TOOLTIP_DELAY_MS } from '@/config/ui';
import { injectMarketplaceZeroMotion } from './vrt.marketplace-zero-motion';
import type { VrtViewport } from './vrt.viewports';

export interface RenderForVRTOptions {
  viewport: VrtViewport;
  /**
   * Render the tree with pointer events disabled so `:hover` styles cannot
   * apply. The browser window's pointer keeps whatever position the last
   * interaction test left it at, and in Chromium that resting position
   * re-applies hover effects (card lift/scale) to whatever element sits
   * beneath it — a nondeterministic capture. Only for non-interactive
   * captures: real clicks inside the tree stop working under this option.
   */
  disableHover?: boolean;
}

export const VRT_ROOT_TESTID = 'vrt-root';

/**
 * Dense feed/onboarding chrome (tab labels, Inter Tight at 1440×900) has
 * 200–1300 px of residual AA versus committed darwin baselines — over the
 * global 80 px cap, under a one-word badge rewrite on a marketplace card
 * (~183 px was caught). Use only on those shell captures.
 */
export const VRT_DENSE_CHROME_SCREENSHOT = {
  comparatorOptions: {
    allowedMismatchedPixels: 1_600,
    allowedMismatchedPixelRatio: 0.003,
  },
} as const;

/**
 * Playwright `locator.screenshot` options shared by marketplace VRT.
 *
 * Capture the element's border box (not a 720px viewport crop, not `fullPage`).
 * Linux GitHub runners and darwin must use this same region: clipping to the
 * viewport would shrink sell/drops/orders/cart scenes and fail darwin 957/957.
 * Fonts are the app's vendored Inter Tight / JetBrains Mono (`vrt.setup.ts`);
 * do not let system-font substitution drive the diff.
 */
export const VRT_CAPTURE_SCREENSHOT = {
  screenshotOptions: {
    animations: 'disabled' as const,
    caret: 'hide' as const,
  },
};

function resetVrtScroll(target?: HTMLElement | null) {
  window.scrollTo(0, 0);
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  if (target) {
    target.scrollTop = 0;
    target.style.scrollMargin = '0';
    target.scrollIntoView({ block: 'start', inline: 'nearest' });
  }
}

/**
 * Surface guard: a VRT scene must capture a PRODUCTION surface, marked with
 * `data-surface="<name>"` on the surface root inside the component under
 * test — never a test-only stand-in. Returns a locator over the marker so
 * the capture wraps exactly the surface (including portaled dialog content,
 * which lives outside the VRT root in the DOM but inside its screenshot
 * region). A scene missing the production root is rejected here rather than
 * silently baselining a mock.
 */
export function expectVrtSurface(surface: string) {
  const marker = document.querySelector(`[data-surface="${surface}"]`);
  if (!marker) {
    throw new Error(
      `VRT scene rejected: no production [data-surface="${surface}"] root is mounted. ` +
        'Mount the production component that carries the marker, not a test stand-in.',
    );
  }
  // Playwright's element screenshot scrolls tall elements into view before
  // capturing them. Firefox can choose a middle scroll position for a surface
  // taller than the viewport, which changes sticky layout and clips the
  // capture. Reset window + element scroll, then pin the top of the surface.
  // The screenshot is the element's border box on both linux and darwin —
  // never a viewport-sized page crop.
  if (marker instanceof HTMLElement) {
    resetVrtScroll(marker);
  }
  return page.elementLocator(marker as HTMLElement);
}

interface VRTProvidersProps {
  children: ReactNode;
  viewport: VrtViewport;
  queryClient: QueryClient;
  disableHover?: boolean;
}

function VRTProviders({ children, viewport, queryClient, disableHover }: VRTProvidersProps) {
  // The wrapper clamps the rendered tree to the requested viewport so
  // `locator.screenshot()` returns a viewport-sized image instead of the full
  // scrollable document height. The data-testid lets tests target this element
  // via `screen.getByTestId(VRT_ROOT_TESTID)` for a deterministic crop.
  const rootStyle: React.CSSProperties = {
    width: viewport.width,
    height: viewport.height,
    overflow: 'hidden',
    ...(disableHover ? { pointerEvents: 'none' as const } : {}),
  };

  return (
    <TooltipProvider delayDuration={TOOLTIP_DELAY_MS}>
      <QueryClientProvider client={queryClient}>
        <div data-testid={VRT_ROOT_TESTID} style={rootStyle}>
          {children}
        </div>
      </QueryClientProvider>
    </TooltipProvider>
  );
}

export async function renderForVRT(ui: ReactNode, options: RenderForVRTOptions) {
  await page.viewport(options.viewport.width, options.viewport.height);
  // Time is already frozen (and the formatting time zone pinned to UTC) by
  // `vrt.setup.ts` before any app module loads — see its "Time determinism"
  // comment block for the rules.
  mockMathRandom(0xdeadbeef);
  // Fresh QueryClient per test keeps cache state isolated; instantiating here
  // (rather than in the component body) avoids re-creation on every React render.
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  const screen = render(
    <VRTProviders viewport={options.viewport} queryClient={queryClient} disableHover={options.disableHover}>
      {ui}
    </VRTProviders>,
  );
  // Wait for Inter Tight (loaded in vrt.setup.ts via Google Fonts) to be
  // ready so the screenshot is never taken while the browser is still
  // showing the fallback face.
  await document.fonts.ready;
  // Images (mocked next/image → plain <img>, including SVGs like the header
  // logo) load asynchronously. `decode()` alone is not enough: it can reject
  // before the request finishes (we used to ignore that), or resolve before
  // layout/paint, which produced intermittent blank logos / brand marks in CI.
  // Wait until each <img> has successfully loaded pixels (`naturalWidth > 0`),
  // then decode + two animation frames so paint catches up. Broken assets fail
  // the test instead of becoming a blank baseline.
  const root = document.querySelector(`[data-testid="${VRT_ROOT_TESTID}"]`);
  if (root) {
    await waitForImagesReady(root);
    if (root instanceof HTMLElement) {
      resetVrtScroll(root);
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    }
  }
  return screen;
}

/** Drop leftover :hover from a prior test's cursor (shared browser window). */
export async function parkVrtHover() {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) {
    active.blur();
    await userEvent.unhover(active);
  }
  const root = document.querySelector(`[data-testid="${VRT_ROOT_TESTID}"]`);
  if (root instanceof HTMLElement) root.style.pointerEvents = 'none';
}

/** Marketplace cards use `hover:scale-105`. Live proof treats ≥ 1.04 as settled. */
export const VRT_HOVER_SCALE_SETTLED = 1.04;

/** Zero-duration hover still needs a compositor frame under Firefox load. */
export const VRT_HOVER_SCALE_TIMEOUT_MS = 2_000;

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

interface VrtHoverLocator {
  hover(options?: { force?: boolean }): Promise<void>;
  element(): Element;
}

function requireHoverElement(locator: VrtHoverLocator): HTMLElement {
  const element = locator.element();
  if (!(element instanceof HTMLElement)) {
    throw new Error('VRT hover scale requires an HTMLElement');
  }
  return element;
}

function vrtHoverRoot(element: HTMLElement): HTMLElement {
  const root = document.querySelector(`[data-testid="${VRT_ROOT_TESTID}"]`);
  return root instanceof HTMLElement ? root : element;
}

function pinVrtRootScroll(): void {
  const root = document.querySelector(`[data-testid="${VRT_ROOT_TESTID}"]`);
  resetVrtScroll(root instanceof HTMLElement ? root : undefined);
}

async function hoverWithoutScroll(locator: VrtHoverLocator): Promise<void> {
  pinVrtRootScroll();
  // Method call — extracting `locator.hover` drops the vitest receiver and
  // throws `Cannot read properties of undefined (reading 'triggerCommand')`.
  // `force: true` skips Playwright's scroll-into-view (~39px on the mobile
  // bottom-row drop card, ±8px vs the committed crop).
  await locator.hover({ force: true });
  pinVrtRootScroll();
}

function finishCssAnimations(root: HTMLElement): void {
  if (typeof root.getAnimations !== 'function') return;
  for (const animation of root.getAnimations({ subtree: true })) {
    try {
      animation.finish();
    } catch {
      animation.cancel();
    }
  }
}

function runningAnimationCount(root: HTMLElement): number {
  if (typeof root.getAnimations !== 'function') return 0;
  return root.getAnimations({ subtree: true }).filter((animation) => animation.playState === 'running').length;
}

/**
 * Hover a marketplace card and wait until the transformed box is settled.
 *
 * `offsetWidth` is layout and ignores `transform: scale()`.
 * `getComputedStyle().transform` / `scale` report the hover *target* as soon
 * as `:hover` matches, including during `duration-300`. Finish leftover enter
 * animations on the VRT root (so rest width is not the delayed `from`
 * keyframe), measure rest `getBoundingClientRect().width`, inject 0s
 * transition duration so the hover end-state can paint on the first frame,
 * re-assert `:hover` if suite load drops the pointer, then wait until bbox
 * width is ≥ rest × 1.04 and no CSS animations are still running.
 * Hover uses `force: true` as a bound method and pins VRT_ROOT at scroll 0
 * so Playwright does not crop the grid by scrolling a bottom-row card into
 * view (~39px, flakes ±8px against the committed mobile drop-hover crop).
 */
export async function hoverAndWaitForScale(
  locator: VrtHoverLocator,
  minScale = VRT_HOVER_SCALE_SETTLED,
  timeoutMs = VRT_HOVER_SCALE_TIMEOUT_MS,
): Promise<void> {
  injectMarketplaceZeroMotion();
  if (document.fonts?.ready) {
    await document.fonts.ready;
  }

  finishCssAnimations(vrtHoverRoot(requireHoverElement(locator)));
  pinVrtRootScroll();
  await nextFrame();
  await nextFrame();

  const restWidth = requireHoverElement(locator).getBoundingClientRect().width;
  const minWidth = restWidth * minScale;
  await hoverWithoutScroll(locator);
  const deadline = Date.now() + timeoutMs;
  let lastWidth = requireHoverElement(locator).getBoundingClientRect().width;
  while (Date.now() < deadline) {
    let element = requireHoverElement(locator);
    finishCssAnimations(vrtHoverRoot(element));
    pinVrtRootScroll();
    if (!element.matches(':hover')) {
      await hoverWithoutScroll(locator);
      element = requireHoverElement(locator);
    }
    lastWidth = element.getBoundingClientRect().width;
    const settled =
      element.matches(':hover') && lastWidth >= minWidth && runningAnimationCount(vrtHoverRoot(element)) === 0;
    if (settled) {
      await nextFrame();
      await nextFrame();
      element = requireHoverElement(locator);
      finishCssAnimations(vrtHoverRoot(element));
      pinVrtRootScroll();
      lastWidth = element.getBoundingClientRect().width;
      if (element.matches(':hover') && lastWidth >= minWidth && runningAnimationCount(vrtHoverRoot(element)) === 0) {
        return;
      }
    }
    await nextFrame();
  }
  const element = requireHoverElement(locator);
  throw new Error(
    `VRT hover transformed box stayed below rest×${minScale} (lastWidth=${lastWidth.toFixed(2)}, restWidth=${restWidth.toFixed(2)}, minWidth=${minWidth.toFixed(2)}, :hover=${element.matches(':hover')}) after ${timeoutMs}ms`,
  );
}

async function waitForImagesReady(root: Element) {
  const images = Array.from(root.querySelectorAll('img'));
  await Promise.all(images.map((img) => waitForHtmlImage(img)));
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** Per-image budget so a hung load/decode fails with the offending URL instead
 * of the whole test dying at the project `testTimeout` with no context. */
const IMAGE_READY_TIMEOUT_MS = 8_000;

/**
 * Wait until an <img> has loaded real pixels. Re-checks `complete` after
 * attaching listeners so a cached load cannot race past us. Load/decode
 * failures reject with the image URL so VRT never treats a blank mark as ready.
 */
async function waitForHtmlImage(img: HTMLImageElement): Promise<void> {
  const src = img.currentSrc || img.src || img.getAttribute('src') || '(unknown src)';
  await withTimeout(waitForHtmlImageReady(img, src), IMAGE_READY_TIMEOUT_MS, () => {
    const state = `complete=${img.complete} naturalWidth=${img.naturalWidth}`;
    return `VRT image timed out after ${IMAGE_READY_TIMEOUT_MS}ms (${state}): ${src}`;
  });
}

async function waitForHtmlImageReady(img: HTMLImageElement, src: string): Promise<void> {
  if (!img.complete) {
    await new Promise<void>((resolve, reject) => {
      const onLoad = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`VRT image failed to load: ${src}`));
      };
      const cleanup = () => {
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
      };
      img.addEventListener('load', onLoad);
      img.addEventListener('error', onError);
      // Cached images can flip to complete between the early check and the
      // listeners above; settle immediately so we neither hang nor double-fire.
      if (img.complete) {
        cleanup();
        if (img.naturalWidth > 0) resolve();
        else reject(new Error(`VRT image loaded without pixels: ${src}`));
      }
    });
  }

  if (img.naturalWidth === 0) {
    throw new Error(`VRT image loaded without pixels: ${src}`);
  }

  try {
    await img.decode();
  } catch {
    throw new Error(`VRT image failed to decode: ${src}`);
  }
}

/**
 * Preload static assets (e.g. logo SVGs) into the browser's image cache before
 * mounting. `waitForImagesReady` already waits for every `<img>` under the VRT
 * root, but a cold fetch racing the initial paint is what caused the
 * intermittent blank Pubky / Synonym / "a tether. company" logos in CI (see
 * `docs/visual-regression-testing.md`). Preloading first means the `<img>` the
 * component renders resolves from cache immediately, removing that race
 * instead of only reacting to it after the fact.
 */
export async function preloadImages(urls: readonly string[]) {
  await Promise.all(
    urls.map(async (url) => {
      const image = new Image();
      await new Promise<void>((resolve, reject) => {
        image.addEventListener('load', () => resolve(), { once: true });
        image.addEventListener('error', () => reject(new Error(`Failed to preload VRT image: ${url}`)), {
          once: true,
        });
        image.src = url;
      });
      await image.decode();
    }),
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: () => string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message())), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// VRT compares pixels, so random values must be stable across runs. This
// replaces Math.random with a seeded pseudo-random generator: it does not return
// the same number every time, but the sequence is identical on every test run
// when calls happen in the same order. In other words, calls are not “truly
// random”; given the seed and the call order, every return value is predictable
// ahead of time (deterministic / reproducible). For example, QuickReply
// component chooses a random placeholder prompt; without a stable sequence,
// text and line wrapping can change between screenshots.
// Vitest calls out random values as dynamic content that should be mocked:
// https://vitest.dev/guide/browser/visual-regression-testing#handle-dynamic-content
function mockMathRandom(seed: number) {
  let state = seed >>> 0;
  Math.random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}
