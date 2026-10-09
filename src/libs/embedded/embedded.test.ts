import { afterEach, describe, expect, it } from 'vitest';
import { asOpaque } from '@/test-utils/type-assertions';
import { hasEmbeddedQueryFlag, isEmbedded, isFramed, resetEmbeddedForTests } from './embedded';

type FakeWindow = { self?: unknown; top?: unknown; location: { search: string } };

function topLevel(search = ''): Window {
  const win: FakeWindow = { location: { search } };
  win.self = win;
  win.top = win;
  return asOpaque<Window>(win);
}

function framed(search = ''): Window {
  const win: FakeWindow = { location: { search } };
  win.self = win;
  win.top = {};
  return asOpaque<Window>(win);
}

describe('isFramed', () => {
  it('is false for a top-level window and true for a framed one', () => {
    expect(isFramed(topLevel())).toBe(false);
    expect(isFramed(framed())).toBe(true);
  });

  it('treats a browser that refuses access to top as framed', () => {
    const win = asOpaque<Window>({
      self: {},
      get top(): never {
        throw new DOMException('blocked', 'SecurityError');
      },
    });
    expect(isFramed(win)).toBe(true);
  });
});

describe('hasEmbeddedQueryFlag', () => {
  it('recognises only embedded=1', () => {
    expect(hasEmbeddedQueryFlag('?embedded=1')).toBe(true);
    expect(hasEmbeddedQueryFlag('?a=b&embedded=1')).toBe(true);
    expect(hasEmbeddedQueryFlag('')).toBe(false);
    expect(hasEmbeddedQueryFlag('?embedded=0')).toBe(false);
    expect(hasEmbeddedQueryFlag('?embedded=true')).toBe(false);
    expect(hasEmbeddedQueryFlag('?notembedded=1')).toBe(false);
  });
});

describe('isEmbedded', () => {
  afterEach(() => resetEmbeddedForTests());

  it('is false for a plain top-level page', () => {
    expect(isEmbedded(false, topLevel())).toBe(false);
  });

  it('is true when the deployer forces it, even without a window', () => {
    expect(isEmbedded(true, topLevel())).toBe(true);
    expect(isEmbedded(true, undefined)).toBe(true);
  });

  it('is true when the page is framed', () => {
    expect(isEmbedded(false, framed())).toBe(true);
  });

  it('is true when the URL carries embedded=1', () => {
    expect(isEmbedded(false, topLevel('?embedded=1'))).toBe(true);
  });

  it('keeps the URL flag for the whole page load once read, as client navigation drops the query', () => {
    expect(isEmbedded(false, topLevel('?embedded=1'))).toBe(true);
    expect(isEmbedded(false, topLevel(''))).toBe(true);
  });

  it('does not make a never-flagged page embedded later', () => {
    expect(isEmbedded(false, topLevel(''))).toBe(false);
    expect(isEmbedded(false, topLevel('?embedded=1'))).toBe(false);
  });
});
