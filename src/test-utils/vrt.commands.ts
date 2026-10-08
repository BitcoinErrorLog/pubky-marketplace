import { defineBrowserCommand } from '@vitest/browser-playwright';
import type { BrowserCommandContext } from 'vitest/node';
import type { VrtViewport } from './vrt.viewports';

const initialViewports = new WeakMap<BrowserCommandContext['page'], VrtViewport>();

/** Resize the real browser, not just Vitest's automatically scaled test iframe. */
export const resizeVrtBrowser = defineBrowserCommand(async ({ page }, viewport?: VrtViewport) => {
  if (!initialViewports.has(page)) initialViewports.set(page, page.viewportSize()!);
  await page.setViewportSize(viewport ?? initialViewports.get(page)!);
});

declare module 'vitest/browser' {
  interface BrowserCommands {
    resizeVrtBrowser: (viewport?: VrtViewport) => Promise<void>;
  }
}
