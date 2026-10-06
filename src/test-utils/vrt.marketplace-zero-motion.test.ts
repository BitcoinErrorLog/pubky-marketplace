import { afterEach, describe, expect, it } from 'vitest';
import {
  applyMarketplaceStabilizerRewrite,
  injectMarketplaceZeroMotion,
  rewriteMarketplaceStabilizerCss,
  VRT_MARKETPLACE_ZERO_MOTION_CSS,
  VRT_MARKETPLACE_ZERO_MOTION_STYLE_ID,
  VRT_STABILIZER_STYLE_ID,
} from './vrt.marketplace-zero-motion';

const STABILIZER_CSS = `
  *, *::before, *::after {
    transition: none !important;
    animation: none !important;
    caret-color: transparent !important;
  }
`;

describe('rewriteMarketplaceStabilizerCss', () => {
  it('rewrites transition: none to duration 0s so hover scale can paint', () => {
    const rewritten = rewriteMarketplaceStabilizerCss(STABILIZER_CSS);
    expect(rewritten).toContain('transition-duration: 0s !important;');
    expect(rewritten).not.toMatch(/transition:\s*none/);
  });

  it('leaves animation: none so marketplace-card-enter cannot fill during delay', () => {
    const rewritten = rewriteMarketplaceStabilizerCss(STABILIZER_CSS);
    expect(rewritten).toMatch(/animation:\s*none\s*!important/);
    expect(rewritten).not.toContain('animation-duration: 0s');
  });
});

describe('VRT_MARKETPLACE_ZERO_MOTION_CSS', () => {
  it('zeroes hover transitions without re-enabling named enter animations', () => {
    expect(VRT_MARKETPLACE_ZERO_MOTION_CSS).toContain('transition-duration: 0s');
    expect(VRT_MARKETPLACE_ZERO_MOTION_CSS).toContain('animation-name: none');
    expect(VRT_MARKETPLACE_ZERO_MOTION_CSS).toContain('animation-delay: 0s');
    expect(VRT_MARKETPLACE_ZERO_MOTION_CSS).not.toContain('animation-duration: 0s');
  });
});

describe('applyMarketplaceStabilizerRewrite', () => {
  afterEach(() => {
    document.getElementById(VRT_STABILIZER_STYLE_ID)?.remove();
    document.getElementById(VRT_MARKETPLACE_ZERO_MOTION_STYLE_ID)?.remove();
  });

  it('mutates the live stabilizer node with the same rewrite', () => {
    const styleEl = document.createElement('style');
    styleEl.id = VRT_STABILIZER_STYLE_ID;
    styleEl.textContent = STABILIZER_CSS;
    document.head.appendChild(styleEl);

    applyMarketplaceStabilizerRewrite();

    expect(styleEl.textContent).toContain('transition-duration: 0s !important;');
    expect(styleEl.textContent).toMatch(/animation:\s*none\s*!important/);
    expect(styleEl.textContent).not.toContain('animation-duration: 0s');
  });

  it('injects zero-motion CSS that keeps animation-name none', () => {
    injectMarketplaceZeroMotion();
    const injected = document.getElementById(VRT_MARKETPLACE_ZERO_MOTION_STYLE_ID);
    expect(injected?.textContent).toBe(VRT_MARKETPLACE_ZERO_MOTION_CSS);
  });
});
