/**
 * Firefox-only settle for MarketplaceSocialSurfaces captures.
 *
 * `.marketplace-card-enter` is `opacity: 0` + `translateY(18px)` during its
 * fill delay. The suite stylesheet sets `animation: none`, and Playwright
 * finishes finite animations before a screenshot, but Firefox under load
 * still composites that from-frame. The boots cover then stays invisible
 * and the gradient icon shows through. That is the hot-marketplace-modules
 * desktop delta (the re-pinned baseline has the cover; the previous one
 * does not). Pin the settled frame on the card itself, then wait until each
 * expected cover has a real layout box — an 8×8 data URL that has not
 * stretched into the media frame does not count.
 */

export const SETTLED_CARD_STYLE = {
  animation: 'none',
  opacity: '1',
  transform: 'none',
} as const;

/** Below this, the element is still the intrinsic data-URL size, not the card frame. */
export const COVER_MIN_LAYOUT_PX = 64;

export interface CoverBox {
  complete: boolean;
  naturalWidth: number;
  width: number;
  height: number;
}

export function coverIsPainted(image: CoverBox): boolean {
  return (
    image.complete &&
    image.naturalWidth > 0 &&
    image.width >= COVER_MIN_LAYOUT_PX &&
    image.height >= COVER_MIN_LAYOUT_PX
  );
}

export function paintedCoverCount(images: readonly CoverBox[]): number {
  return images.filter(coverIsPainted).length;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function coverBox(image: HTMLImageElement): CoverBox {
  const box = image.getBoundingClientRect();
  return {
    complete: image.complete,
    naturalWidth: image.naturalWidth,
    width: box.width,
    height: box.height,
  };
}

export async function settleMarketplaceSocialCapture(expectedCovers: number, timeoutMs = 2_000): Promise<void> {
  const root = document.querySelector('[data-testid="vrt-root"]');
  if (!(root instanceof HTMLElement)) {
    throw new Error('VRT social settle: no [data-testid="vrt-root"] element');
  }

  if (typeof root.getAnimations === 'function') {
    for (const animation of root.getAnimations({ subtree: true })) {
      try {
        animation.cancel();
      } catch {
        // Already finished or not cancelable.
      }
    }
  }

  for (const card of root.querySelectorAll('.marketplace-card-enter')) {
    if (!(card instanceof HTMLElement)) continue;
    card.style.setProperty('animation', SETTLED_CARD_STYLE.animation, 'important');
    card.style.setProperty('opacity', SETTLED_CARD_STYLE.opacity, 'important');
    card.style.setProperty('transform', SETTLED_CARD_STYLE.transform, 'important');
  }

  if (document.fonts?.load) {
    await Promise.all(
      ['400 12px "Inter Tight"', '500 11px "Inter Tight"', '700 16px "Inter Tight"', '700 20px "Inter Tight"'].map(
        (font) => document.fonts.load(font).catch(() => []),
      ),
    );
    await document.fonts.ready;
  }

  // Flush layout after the inline settle so Firefox measures the stretched cover.
  root.getBoundingClientRect();

  const deadline = performance.now() + timeoutMs;
  let images: HTMLImageElement[] = [];
  while (performance.now() < deadline) {
    images = [...root.querySelectorAll('img')].filter(
      (node): node is HTMLImageElement => node instanceof HTMLImageElement,
    );
    if (paintedCoverCount(images.map(coverBox)) >= expectedCovers) {
      await nextFrame();
      await nextFrame();
      images = [...root.querySelectorAll('img')].filter(
        (node): node is HTMLImageElement => node instanceof HTMLImageElement,
      );
      if (paintedCoverCount(images.map(coverBox)) >= expectedCovers) {
        return;
      }
    }
    await nextFrame();
  }

  const detail = images
    .map((image) => {
      const box = coverBox(image);
      return `${image.currentSrc || image.src} complete=${box.complete} naturalWidth=${box.naturalWidth} box=${box.width.toFixed(1)}x${box.height.toFixed(1)}`;
    })
    .join('; ');
  throw new Error(
    `VRT social settle: expected ${expectedCovers} painted cover(s) within ${timeoutMs}ms, saw ${paintedCoverCount(images.map(coverBox))}. ${detail}`,
  );
}
