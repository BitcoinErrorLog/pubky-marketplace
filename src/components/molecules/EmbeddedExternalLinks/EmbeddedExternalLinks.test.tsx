import { fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setEmbedded } from '@/test-utils/embedded';
import { EmbeddedExternalLinks } from './EmbeddedExternalLinks';

const navigation = vi.hoisted(() => ({ navigateTop: vi.fn() }));

vi.mock('@/libs/navigation/navigate-top', () => ({ navigateTop: navigation.navigateTop }));

function renderLink(attributes: Record<string, string> = {}, href = 'https://www.example.com/page') {
  const view = render(
    <>
      <EmbeddedExternalLinks />
      <a href={href} data-testid="link" {...attributes}>
        <span data-testid="label">link</span>
      </a>
    </>,
  );
  return view;
}

describe('EmbeddedExternalLinks', () => {
  const open = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    open.mockReturnValue({});
    vi.spyOn(window, 'open').mockImplementation(open);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setEmbedded(false);
  });

  it('opens a cross-origin web link in a new tab instead of loading it in the frame', () => {
    setEmbedded(true);
    const { getByTestId } = renderLink();

    const proceeded = fireEvent.click(getByTestId('label'));

    expect(proceeded).toBe(false);
    expect(open).toHaveBeenCalledWith('https://www.example.com/page', '_blank', 'noopener,noreferrer');
    expect(navigation.navigateTop).not.toHaveBeenCalled();
  });

  it('opens the tab inside the click, with no async boundary before it', () => {
    setEmbedded(true);
    const { getByTestId } = renderLink();
    let openedBeforeReturn = false;
    getByTestId('link').addEventListener('click', () => {
      openedBeforeReturn = open.mock.calls.length === 1;
    });

    fireEvent.click(getByTestId('link'));

    expect(openedBeforeReturn).toBe(true);
  });

  it('falls back to the top window when the browser blocks the new tab', () => {
    setEmbedded(true);
    open.mockReturnValue(null);
    const { getByTestId } = renderLink();

    fireEvent.click(getByTestId('link'));

    expect(navigation.navigateTop).toHaveBeenCalledWith('https://www.example.com/page');
  });

  it.each([
    ['a same-origin link', {}, '/marketplace/cart'],
    ['a link that names its own target', { target: '_blank' }, 'https://www.example.com/page'],
    ['a download', { download: 'file.txt' }, 'https://www.example.com/file.txt'],
    ['a custom-scheme deep link', {}, 'pubkyauth://signin'],
    ['a mailto link', {}, 'mailto:hello@pubky.com'],
  ])('leaves %s alone', (_label, attributes, href) => {
    setEmbedded(true);
    const { getByTestId } = renderLink(attributes, href);

    const proceeded = fireEvent.click(getByTestId('link'));

    expect(proceeded).toBe(true);
    expect(open).not.toHaveBeenCalled();
    expect(navigation.navigateTop).not.toHaveBeenCalled();
  });

  it('leaves modified clicks to the browser, which already opens a tab', () => {
    setEmbedded(true);
    const { getByTestId } = renderLink();

    expect(fireEvent.click(getByTestId('link'), { ctrlKey: true })).toBe(true);
    expect(fireEvent.click(getByTestId('link'), { metaKey: true })).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it('attaches nothing when the Shop is not embedded', () => {
    const { getByTestId } = renderLink();

    expect(fireEvent.click(getByTestId('link'))).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it('stops intercepting once unmounted', () => {
    setEmbedded(true);
    const { getByTestId, unmount } = renderLink();
    const link = getByTestId('link');
    unmount();
    document.body.appendChild(link);

    expect(fireEvent.click(link)).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });
});
