import { act, renderHook } from '@testing-library/react';
import type { ChangeEvent } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommerceController } from '@/controllers/commerce/commerce';
import { stripImageMetadata } from '@/libs/image/stripImageMetadata';
import { asOpaque } from '@/test-utils/type-assertions';
import { useMessageAttachmentPicker } from './useMessageAttachmentPicker';

vi.mock('@/libs/image/stripImageMetadata', () => ({
  stripImageMetadata: vi.fn((file: File) => file),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    uploadMarketplaceAttachment: vi.fn(),
  },
}));

function changeEvent(file: File): ChangeEvent<HTMLInputElement> {
  return asOpaque<ChangeEvent<HTMLInputElement>>({ target: { files: [file] } });
}

describe('useMessageAttachmentPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(CommerceController.uploadMarketplaceAttachment).mockResolvedValue({
      id: '00000000-0000-4000-8000-000000000995',
      senderPubky: 'y'.repeat(52),
      recipientPubky: 'b'.repeat(52),
      mimeType: 'image/jpeg',
      byteSize: 5,
      contentHash: 'a'.repeat(64),
      createdAt: '2026-08-19T23:00:00.000Z',
    });
  });

  it('sanitizes and uploads a private image for one recipient', async () => {
    const file = new File([new Uint8Array([0xff, 0xd8, 0xff, 1, 2])], 'proof.jpg', { type: 'image/jpeg' });
    const { result } = renderHook(() => useMessageAttachmentPicker());
    act(() => result.current.onInputChange(changeEvent(file)));

    let attachment = null;
    await act(async () => {
      attachment = await result.current.upload('b'.repeat(52));
    });

    expect(stripImageMetadata).toHaveBeenCalledWith(file);
    expect(CommerceController.uploadMarketplaceAttachment).toHaveBeenCalledWith('b'.repeat(52), file);
    expect(attachment).toMatchObject({ mimeType: 'image/jpeg', byteSize: 5 });
  });

  it('rejects active or unsupported image formats before upload', () => {
    const { result } = renderHook(() => useMessageAttachmentPicker());
    act(() => result.current.onInputChange(changeEvent(new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }))));
    expect(result.current.error).toBe('invalid-type');
  });
});
