import { describe, expect, it } from 'vitest';
import { type Locator, page } from 'vitest/browser';
import { expectVrtSurface, renderForVRT, VRT_ROOT_TESTID } from './vrt';
import { VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE } from './vrt.viewports';

async function readCapture(element: Locator) {
  const base64 = await page.screenshot({ element, save: false });
  const image = new Image();
  image.src = `data:image/png;base64,${base64}`;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext('2d')!;
  context.drawImage(image, 0, 0);
  return {
    width: image.width,
    height: image.height,
    bottomPixel: [...context.getImageData(image.width - 1, image.height - 1, 1, 1).data],
  };
}

describe('VRT surface capture dimensions', () => {
  it.each([VRT_VIEWPORT_DESKTOP, VRT_VIEWPORT_MOBILE])(
    'captures a tall $width px surface without scaling or clipping and restores the next scene',
    async (viewport) => {
      const initial = await renderForVRT(<div />, { viewport });
      const before = await readCapture(page.getByTestId(VRT_ROOT_TESTID));
      initial.unmount();

      // Synthetic geometry fixture for the capture harness, not an app baseline.
      const tall = await renderForVRT(
        <div data-surface="capture-fixture" style={{ width: '100%', height: 3200, background: '#123456' }} />,
        { viewport },
      );
      const capture = await readCapture(await expectVrtSurface('capture-fixture'));
      expect(capture).toEqual({ width: viewport.width, height: 3200, bottomPixel: [18, 52, 86, 255] });
      tall.unmount();

      await renderForVRT(<div />, { viewport });
      const after = await readCapture(page.getByTestId(VRT_ROOT_TESTID));
      expect(after).toEqual(before);
    },
  );
});
