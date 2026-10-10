import { render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { setEmbedded } from '@/test-utils/embedded';
import { EMBEDDED_DOCUMENT_ATTRIBUTE, EmbeddedDocumentFlag } from './EmbeddedDocumentFlag';

describe('EmbeddedDocumentFlag', () => {
  afterEach(() => setEmbedded(false));

  it('leaves the document untouched for a top-level Shop', () => {
    render(<EmbeddedDocumentFlag />);
    expect(document.documentElement).not.toHaveAttribute(EMBEDDED_DOCUMENT_ATTRIBUTE);
  });

  it('marks the document while the Shop is embedded and clears it on unmount', () => {
    setEmbedded(true);
    const { unmount } = render(<EmbeddedDocumentFlag />);

    expect(document.documentElement).toHaveAttribute(EMBEDDED_DOCUMENT_ATTRIBUTE, 'true');

    unmount();
    expect(document.documentElement).not.toHaveAttribute(EMBEDDED_DOCUMENT_ATTRIBUTE);
  });
});
