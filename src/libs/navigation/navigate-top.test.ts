import { describe, expect, it, vi } from 'vitest';
import { asOpaque } from '@/test-utils/type-assertions';
import { navigateTop } from './navigate-top';

type FakeLocation = { href: string; origin: string; assign: ReturnType<typeof vi.fn> };

function makeLocation(origin: string, path = '/shop'): FakeLocation {
  return { href: `${origin}${path}`, origin, assign: vi.fn() };
}

/** A top-level window: `top` is itself. */
function makeTopLevel(origin = 'https://shop.pubky.app') {
  const win = asOpaque<Window & { location: FakeLocation; open: ReturnType<typeof vi.fn> }>({
    location: makeLocation(origin),
    open: vi.fn(),
  });
  Object.assign(win, { self: win, top: win });
  return win;
}

/** A framed window whose parent is `topLocation`. */
function makeFramed({
  frameOrigin = 'https://pubky.app',
  top,
  openResult = {} as WindowProxy | null,
}: {
  frameOrigin?: string;
  top: { location: unknown };
  openResult?: WindowProxy | null;
}) {
  const win = asOpaque<Window & { location: FakeLocation; open: ReturnType<typeof vi.fn> }>({
    location: makeLocation(frameOrigin, '/shop/marketplace/checkout'),
    open: vi.fn(() => openResult),
    top,
  });
  Object.assign(win, { self: win });
  return win;
}

describe('navigateTop', () => {
  it('assigns the page itself when the Shop is the top window', () => {
    const win = makeTopLevel();
    expect(navigateTop('https://www.paypal.com/checkoutnow?token=abc', win)).toBe('self');
    expect(win.location.assign).toHaveBeenCalledWith('https://www.paypal.com/checkoutnow?token=abc');
    expect(win.open).not.toHaveBeenCalled();
  });

  it('assigns a custom-scheme deep link on the page itself when it is not framed', () => {
    const win = makeTopLevel();
    expect(navigateTop('pubkyauth://?secret=x', win)).toBe('self');
    expect(win.location.assign).toHaveBeenCalledWith('pubkyauth://?secret=x');
  });

  it('drives the same-origin top window with location.assign when framed', () => {
    const topLocation = { origin: 'https://pubky.app', href: 'https://pubky.app/shop', assign: vi.fn() };
    const win = makeFramed({ top: { location: topLocation } });
    expect(navigateTop('https://www.paypal.com/checkoutnow?token=abc', win)).toBe('top');
    expect(topLocation.assign).toHaveBeenCalledWith('https://www.paypal.com/checkoutnow?token=abc');
    expect(win.location.assign).not.toHaveBeenCalled();
    expect(win.open).not.toHaveBeenCalled();
  });

  it('leaves a custom-scheme deep link to the same-origin top window when framed', () => {
    const topLocation = { origin: 'https://pubky.app', href: 'https://pubky.app/shop', assign: vi.fn() };
    const win = makeFramed({ top: { location: topLocation } });
    expect(navigateTop('pubkyauth://?secret=x', win)).toBe('top');
    expect(topLocation.assign).toHaveBeenCalledWith('pubkyauth://?secret=x');
  });

  it('sets href on a cross-origin top window, which the platform allows', () => {
    const hrefSetter = vi.fn();
    const topLocation = {
      get origin(): string {
        throw new DOMException('Blocked a frame from accessing a cross-origin frame.', 'SecurityError');
      },
      set href(value: string) {
        hrefSetter(value);
      },
    };
    const win = makeFramed({ frameOrigin: 'https://shop.pubky.app', top: { location: topLocation } });
    expect(navigateTop('https://www.paypal.com/checkoutnow?token=abc', win)).toBe('top');
    expect(hrefSetter).toHaveBeenCalledWith('https://www.paypal.com/checkoutnow?token=abc');
    expect(win.location.assign).not.toHaveBeenCalled();
  });

  it('opens a new tab for web URLs when the top window cannot be driven', () => {
    const topLocation = {
      get origin(): string {
        throw new DOMException('cross-origin', 'SecurityError');
      },
      set href(_value: string) {
        throw new DOMException('navigation refused', 'SecurityError');
      },
    };
    const win = makeFramed({ frameOrigin: 'https://shop.pubky.app', top: { location: topLocation } });
    expect(navigateTop('https://www.paypal.com/checkoutnow?token=abc', win)).toBe('tab');
    expect(win.open).toHaveBeenCalledWith(
      'https://www.paypal.com/checkoutnow?token=abc',
      '_blank',
      'noopener,noreferrer',
    );
    expect(win.location.assign).not.toHaveBeenCalled();
  });

  it('falls back to the frame when the top window cannot be driven and the popup is blocked', () => {
    const topLocation = {
      get origin(): string {
        throw new DOMException('cross-origin', 'SecurityError');
      },
      set href(_value: string) {
        throw new DOMException('navigation refused', 'SecurityError');
      },
    };
    const win = makeFramed({ frameOrigin: 'https://shop.pubky.app', top: { location: topLocation }, openResult: null });
    expect(navigateTop('https://www.paypal.com/checkoutnow?token=abc', win)).toBe('frame');
    expect(win.location.assign).toHaveBeenCalledWith('https://www.paypal.com/checkoutnow?token=abc');
  });

  it('never opens a tab for a custom-scheme deep link; the frame is the last resort', () => {
    const topLocation = {
      get origin(): string {
        throw new DOMException('cross-origin', 'SecurityError');
      },
      set href(_value: string) {
        throw new DOMException('navigation refused', 'SecurityError');
      },
    };
    const win = makeFramed({ frameOrigin: 'https://shop.pubky.app', top: { location: topLocation } });
    expect(navigateTop('pubkyauth://?secret=x', win)).toBe('frame');
    expect(win.open).not.toHaveBeenCalled();
    expect(win.location.assign).toHaveBeenCalledWith('pubkyauth://?secret=x');
  });

  it('resolves a relative target against the frame when choosing the fallback', () => {
    const win = makeFramed({
      frameOrigin: 'https://shop.pubky.app',
      top: {
        location: {
          get origin(): string {
            throw new DOMException('cross-origin', 'SecurityError');
          },
          set href(_value: string) {
            throw new DOMException('navigation refused', 'SecurityError');
          },
        },
      },
    });
    expect(navigateTop('/marketplace/orders', win)).toBe('tab');
    expect(win.open).toHaveBeenCalledWith('https://shop.pubky.app/marketplace/orders', '_blank', 'noopener,noreferrer');
  });
});
