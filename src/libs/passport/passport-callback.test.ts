import { describe, expect, it, vi } from 'vitest';
import { PASSPORT_CALLBACK_HTML, PASSPORT_CALLBACK_SCRIPT } from './passport-callback';
import { PASSPORT_CALLBACK_MESSAGE } from './passport-popup';

type Opener = { closed: boolean; postMessage: ReturnType<typeof vi.fn> };

function runCallbackScript({ search, opener }: { search: string; opener: Opener | null | 'throws' }) {
  const status = { textContent: 'You can close this window and return to Pubky Shop.' };
  const close = vi.fn();
  const fakeWindow = {
    location: { search, origin: 'https://shop.pubky.app' },
    close,
    get opener() {
      if (opener === 'throws') throw new Error('cross-origin');
      return opener;
    },
  };
  const fakeDocument = { getElementById: (id: string) => (id === 'passport-return-status' ? status : null) };
  new Function('window', 'document', 'URLSearchParams', PASSPORT_CALLBACK_SCRIPT)(
    fakeWindow,
    fakeDocument,
    URLSearchParams,
  );
  return { status, close };
}

describe('Passport return page', () => {
  it.each(['success', 'error', 'cancel'])(
    'forwards a %s hint to the opener on the Shop origin and closes',
    (outcome) => {
      const opener = { closed: false, postMessage: vi.fn() };
      const { close } = runCallbackScript({ search: `?outcome=${outcome}`, opener });

      expect(opener.postMessage).toHaveBeenCalledWith(
        { type: PASSPORT_CALLBACK_MESSAGE, outcome },
        'https://shop.pubky.app',
      );
      expect(close).toHaveBeenCalled();
    },
  );

  it('ignores an unknown outcome and leaves the page open with its link back', () => {
    const opener = { closed: false, postMessage: vi.fn() };
    const { close, status } = runCallbackScript({ search: '?outcome=<img src=x>', opener });

    expect(opener.postMessage).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(status.textContent).toBe('You can close this window and return to Pubky Shop.');
  });

  it.each([
    ['no opener', null],
    ['a closed opener', { closed: true, postMessage: vi.fn() }],
    ['an unreadable opener', 'throws' as const],
  ])('stays open with the outcome shown when there is %s', (_label, opener) => {
    const { close, status } = runCallbackScript({ search: '?outcome=success', opener });

    expect(close).not.toHaveBeenCalled();
    expect(status.textContent).toBe('Approved in Pubky Passport. Return to Pubky Shop to continue.');
  });

  it('is a static document with a link back to the Shop and nothing taken from the request', () => {
    expect(PASSPORT_CALLBACK_HTML).toContain('<a href="/marketplace">Return to Pubky Shop</a>');
    expect(PASSPORT_CALLBACK_HTML).toContain('<meta name="robots" content="noindex">');
    expect(PASSPORT_CALLBACK_HTML).toContain(PASSPORT_CALLBACK_SCRIPT);
    expect(PASSPORT_CALLBACK_SCRIPT).not.toContain('innerHTML');
    expect(PASSPORT_CALLBACK_SCRIPT).not.toContain("'*'");
  });
});
