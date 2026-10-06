import { describe, expect, it } from 'vitest';
import { COVER_MIN_LAYOUT_PX, coverIsPainted, paintedCoverCount, SETTLED_CARD_STYLE } from './vrt.social-settle';

describe('coverIsPainted', () => {
  it('rejects the intrinsic data-URL size and an incomplete decode', () => {
    expect(
      coverIsPainted({
        complete: true,
        naturalWidth: 8,
        width: 8,
        height: 8,
      }),
    ).toBe(false);
    expect(
      coverIsPainted({
        complete: false,
        naturalWidth: 0,
        width: 280,
        height: 280,
      }),
    ).toBe(false);
    expect(COVER_MIN_LAYOUT_PX).toBe(64);
  });

  it('accepts a decoded cover that has stretched into the card frame', () => {
    expect(
      coverIsPainted({
        complete: true,
        naturalWidth: 8,
        width: 280,
        height: 280,
      }),
    ).toBe(true);
  });

  it('counts only painted covers', () => {
    expect(
      paintedCoverCount([
        { complete: true, naturalWidth: 8, width: 8, height: 8 },
        { complete: true, naturalWidth: 8, width: 280, height: 280 },
      ]),
    ).toBe(1);
  });
});

describe('SETTLED_CARD_STYLE', () => {
  it('pins the enter animation end state, not the from-frame', () => {
    expect(SETTLED_CARD_STYLE).toEqual({
      animation: 'none',
      opacity: '1',
      transform: 'none',
    });
  });
});
