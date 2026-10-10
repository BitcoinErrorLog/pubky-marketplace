'use client';

import { useEffect } from 'react';
import { useIsEmbedded } from '@/hooks/useIsEmbedded/useIsEmbedded';

export const EMBEDDED_DOCUMENT_ATTRIBUTE = 'data-shop-embedded';

/**
 * Marks the document when the Shop is embedded so global CSS can drop the offsets that assume
 * the Shop header sits above the content (see `html[data-shop-embedded]` in `globals.css`).
 * A deployment that forces embedded mode renders the attribute on the server as well
 * (`RootContainer`); this covers pages detected as embedded only in the browser.
 */
export function EmbeddedDocumentFlag() {
  const isEmbedded = useIsEmbedded();

  useEffect(() => {
    const root = document.documentElement;
    if (isEmbedded) root.setAttribute(EMBEDDED_DOCUMENT_ATTRIBUTE, 'true');
    else root.removeAttribute(EMBEDDED_DOCUMENT_ATTRIBUTE);
    return () => root.removeAttribute(EMBEDDED_DOCUMENT_ATTRIBUTE);
  }, [isEmbedded]);

  return null;
}
