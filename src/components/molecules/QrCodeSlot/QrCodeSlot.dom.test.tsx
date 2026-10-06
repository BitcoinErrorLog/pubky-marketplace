import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QrCodeSlot } from './QrCodeSlot';

vi.mock('next/image', () => ({
  __esModule: true,
  default: ({ src, alt }: { src: string; alt: string }) => <img src={src} alt={alt} />,
}));

const RELAY_SECRET = 'c2VjcmV0LWNoYW5uZWwta2V5LWZvci10aGlzLWZsb3c';
const AUTH_URL = `pubkyauth://signin_grant?caps=%2Fpub%2Fpubky.app%2F%3Arw&relay=https%3A%2F%2Frelay.example%2Finbox&secret=${RELAY_SECRET}&cid=shop.pubky.app`;

describe('QrCodeSlot with the real QR renderer', () => {
  it('keeps the relay secret out of the DOM markup', () => {
    const { container } = render(
      <QrCodeSlot
        isLoading={false}
        isExpired={false}
        url={AUTH_URL}
        generatingLabel="Generating..."
        clickToReloadLabel="Click to reload"
      />,
    );

    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.innerHTML).not.toContain(RELAY_SECRET);
    expect(container.innerHTML).not.toContain('pubkyauth://');
  });
});
