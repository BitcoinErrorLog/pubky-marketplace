import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetEmbeddedForTests } from '@/libs/embedded/embedded';
import { setEmbedded } from '@/test-utils/embedded';
import { isShopEmbedded } from './embedded';

const runtime = vi.hoisted(() => ({ forced: false, frameAncestors: [] as string[] }));

vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>();
  return { ...actual, getEmbeddedFlag: () => runtime.forced, getFrameAncestors: () => runtime.frameAncestors };
});

function frameWindow(): void {
  // jsdom runs top-level; make `window.top` a different object, as inside an iframe.
  Object.defineProperty(window, 'top', { configurable: true, value: {} });
}

describe('isShopEmbedded', () => {
  afterEach(() => {
    runtime.forced = false;
    runtime.frameAncestors = [];
    Object.defineProperty(window, 'top', { configurable: true, value: window });
    setEmbedded(false);
    resetEmbeddedForTests();
  });

  it('is false for a top-level Shop with default configuration', () => {
    expect(isShopEmbedded()).toBe(false);
  });

  it('keeps the normal layout in a frame when the deployment allows no framing (Cypress, Vitest browser)', () => {
    frameWindow();
    expect(isShopEmbedded()).toBe(false);
  });

  it('is embedded in a frame when the deployment allows framing', () => {
    runtime.frameAncestors = ["'self'"];
    frameWindow();
    expect(isShopEmbedded()).toBe(true);
  });

  it('is not embedded at the top level even when the deployment allows framing', () => {
    runtime.frameAncestors = ["'self'"];
    expect(isShopEmbedded()).toBe(false);
  });

  it('is embedded when forced by the deployer or requested by the URL', () => {
    runtime.forced = true;
    expect(isShopEmbedded()).toBe(true);
    runtime.forced = false;
    setEmbedded(true);
    expect(isShopEmbedded()).toBe(true);
  });
});
