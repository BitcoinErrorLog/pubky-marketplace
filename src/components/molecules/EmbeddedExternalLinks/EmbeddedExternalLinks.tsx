'use client';

import { useEffect } from 'react';
import { isShopEmbedded } from '@/config/embedded';
import { navigateTop } from '@/libs/navigation/navigate-top';

function crossOriginWebAnchor(event: MouseEvent): HTMLAnchorElement | null {
  if (event.defaultPrevented || event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const target = event.target instanceof Element ? event.target : null;
  const anchor = target?.closest('a[href]');
  if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download')) return null;
  if (anchor.target !== '' && anchor.target !== '_self') return null;
  if (anchor.protocol !== 'http:' && anchor.protocol !== 'https:') return null;
  return anchor.origin === window.location.origin ? null : anchor;
}

/**
 * Keeps third-party pages out of the frame when the Shop is embedded.
 *
 * Most sites refuse to render inside a frame (`X-Frame-Options`, `frame-ancestors`), so a plain
 * link to one would leave the user on an error page inside the host app with no way back. While
 * embedded, a primary click on a link to another origin opens it in a new tab instead, from
 * inside the click so the browser does not treat it as a blocked popup. If the browser blocks the
 * tab anyway, the page goes through `navigateTop`. Links that already name a target, same-origin
 * links, downloads, non-web schemes and modified clicks (which already open a tab) are untouched.
 * Not embedded, nothing is attached.
 */
export function EmbeddedExternalLinks() {
  useEffect(() => {
    if (!isShopEmbedded()) return;
    const onClick = (event: MouseEvent) => {
      const anchor = crossOriginWebAnchor(event);
      if (!anchor) return;
      event.preventDefault();
      if (window.open(anchor.href, '_blank', 'noopener,noreferrer') === null) navigateTop(anchor.href);
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  return null;
}
