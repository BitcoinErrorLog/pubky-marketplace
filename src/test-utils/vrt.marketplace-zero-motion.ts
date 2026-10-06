/** Injected into `vrt-marketplace` only. Vitest's `page` has no `addStyleTag`. */
export const VRT_MARKETPLACE_ZERO_MOTION_CSS =
  '* { transition-duration: 0s !important; animation-name: none !important; animation-delay: 0s !important; }';

export const VRT_MARKETPLACE_ZERO_MOTION_STYLE_ID = '__vrt_marketplace_zero_motion__';

export const VRT_STABILIZER_STYLE_ID = '__vrt_stabilizer__';

/**
 * Hover end-state must paint on the first frame. Shared VRT setup uses
 * `transition: none`, which updates CSSOM immediately (`getComputedStyle` and
 * `getBoundingClientRect`) while Firefox under full-suite load can still
 * screenshot the rest compositor frame. Duration 0s keeps a real transition
 * that completes on that frame. `offsetWidth` is layout-only and cannot
 * observe `transform: scale()`.
 *
 * Enter animations stay killed. Rewriting `animation: none` to
 * `animation-duration: 0s` re-enables `.marketplace-card-enter` (`fill-mode:
 * both` + `animation-delay: index * 60ms`). During the delay the `from`
 * keyframe (`translateY(18px) scale(0.96)`) holds and composes with hover
 * scale/rotate — the mobile drop-hover flake on chromium and firefox.
 */
export function rewriteMarketplaceStabilizerCss(css: string): string {
  return css.replace(/transition:\s*none\s*!important;?/g, 'transition-duration: 0s !important;');
}

export function applyMarketplaceStabilizerRewrite(): void {
  const stabilizer = document.getElementById(VRT_STABILIZER_STYLE_ID);
  if (!stabilizer) return;
  stabilizer.textContent = rewriteMarketplaceStabilizerCss(stabilizer.textContent ?? '');
}

export function injectMarketplaceZeroMotion(): void {
  if (document.getElementById(VRT_MARKETPLACE_ZERO_MOTION_STYLE_ID)) {
    return;
  }
  const styleEl = document.createElement('style');
  styleEl.id = VRT_MARKETPLACE_ZERO_MOTION_STYLE_ID;
  styleEl.textContent = VRT_MARKETPLACE_ZERO_MOTION_CSS;
  document.head.appendChild(styleEl);
}
