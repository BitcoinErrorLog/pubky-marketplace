import { act, renderHook } from '@testing-library/react';
import type { ChangeEvent } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { stripImageMetadata } from '@/libs/image/stripImageMetadata';
import { asOpaque } from '@/test-utils/type-assertions';
import { useListingMediaManager } from './useListingMediaManager';

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  return await import('@/test/mocks/marketplace-media-hooks');
});

vi.mock('@/libs/image/stripImageMetadata', () => ({
  stripImageMetadata: vi.fn((file: File) => file),
}));

const OWNER = 'y'.repeat(52);

function changeEvent(...files: File[]): ChangeEvent<HTMLInputElement> {
  return asOpaque<ChangeEvent<HTMLInputElement>>({
    target: { files },
  });
}

function imageFile(name: string, bytes: number[] = [1, 2, 3]): File {
  const file = new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: vi.fn(async () => new Uint8Array(bytes).buffer),
  });
  return file;
}

describe('useListingMediaManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    let uuidCounter = 0;
    vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
      () => `018f47d2-6a27-7c23-a49d-6b21bb7701${String(20 + uuidCounter++).padStart(2, '0')}`,
    );
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn((file: File) => `blob:${file.name}`),
        revokeObjectURL: vi.fn(),
      }),
    );
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () =>
        asOpaque<ImageBitmap>({
          width: 1200,
          height: 1600,
          close: vi.fn(),
        }),
      ),
    );
  });

  it('adds multiple photos in selection order and prepares owner-scoped media', async () => {
    const { result } = renderHook(() => useListingMediaManager());

    act(() => result.current.onInputChange(changeEvent(imageFile('front.jpg'), imageFile('back.jpg', [4, 5, 6]))));
    expect(result.current.items.map(({ previewUrl }) => previewUrl)).toEqual(['blob:front.jpg', 'blob:back.jpg']);

    act(() => {
      result.current.setAltText(result.current.items[0].key, 'Front of the boots');
    });
    act(() => {
      result.current.setAltText(result.current.items[1].key, 'Back of the boots');
    });

    const prepared = await act(async () => await result.current.prepare(OWNER));
    if (!prepared.ok) throw new Error('Preparation should succeed.');

    expect(stripImageMetadata).toHaveBeenCalledTimes(2);
    expect(prepared.media).toHaveLength(2);
    expect(prepared.uploads).toHaveLength(2);
    expect(prepared.media[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/jpeg',
      width: 1200,
      height: 1600,
      altText: 'Front of the boots',
    });
    expect(prepared.media[0].contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.media[0].url).toContain(`pubky://${OWNER}/pub/pubky.app/marketplace/v1/media/`);
    expect(prepared.media[1].altText).toBe('Back of the boots');
  });

  it('reorders photos with moveItem and preserves the order in preparation', async () => {
    const { result } = renderHook(() => useListingMediaManager());

    act(() => result.current.onInputChange(changeEvent(imageFile('one.jpg'), imageFile('two.jpg'))));
    act(() => {
      result.current.setAltText(result.current.items[0].key, 'One');
    });
    act(() => {
      result.current.setAltText(result.current.items[1].key, 'Two');
    });

    act(() => result.current.moveItem(result.current.items[1].key, -1));
    expect(result.current.items.map(({ altText }) => altText)).toEqual(['Two', 'One']);

    // Moving past either end is a no-op, not a crash or a wrap-around.
    act(() => result.current.moveItem(result.current.items[0].key, -1));
    expect(result.current.items.map(({ altText }) => altText)).toEqual(['Two', 'One']);

    const prepared = await act(async () => await result.current.prepare(OWNER));
    if (!prepared.ok) throw new Error('Preparation should succeed.');
    expect(prepared.media.map(({ altText }) => altText)).toEqual(['Two', 'One']);
  });

  it('rejects non-image and oversized files and enforces the photo limit', () => {
    const { result } = renderHook(() => useListingMediaManager(2));

    act(() => result.current.onInputChange(changeEvent(new File(['text'], 'notes.txt', { type: 'text/plain' }))));
    expect(result.current.error).toBe('invalid-type');
    expect(result.current.items).toHaveLength(0);

    act(() => result.current.onInputChange(changeEvent(new File(['abc'], 'large.jpg', { type: 'image/jpeg' }))));
    expect(result.current.error).toBe('too-large');

    const { result: capped } = renderHook(() => useListingMediaManager());
    act(() =>
      capped.current.onInputChange(changeEvent(...Array.from({ length: 9 }, (_, i) => imageFile(`p${i}.jpg`)))),
    );
    expect(capped.current.items).toHaveLength(8);
    expect(capped.current.error).toBe('limit-reached');
  });

  it('requires every photo to carry alt text before preparation', async () => {
    const { result } = renderHook(() => useListingMediaManager());

    let prepared = await act(async () => await result.current.prepare(OWNER));
    expect(prepared).toEqual({ ok: false, reason: 'no-photos' });

    act(() => result.current.onInputChange(changeEvent(imageFile('front.jpg'))));
    prepared = await act(async () => await result.current.prepare(OWNER));
    expect(prepared).toEqual({ ok: false, reason: 'missing-alt-text' });
  });

  it('seeds existing records for editing and reuses them without re-upload', async () => {
    const existing = {
      id: 'image_01',
      type: 'image' as const,
      url: `pubky://${OWNER}/pub/pubky.app/marketplace/v1/media/image_01`,
      contentHash: 'a'.repeat(64),
      mimeType: 'image/jpeg',
      byteSize: 3,
      width: 1200,
      height: 1600,
      altText: 'Already published photo',
    };
    const { result } = renderHook(() => useListingMediaManager());

    act(() => result.current.seed([existing]));
    expect(result.current.items).toHaveLength(1);
    expect(result.current.items[0]).toMatchObject({ kind: 'existing', altText: 'Already published photo' });

    act(() => result.current.setAltText('image_01', 'Better description'));
    const prepared = await act(async () => await result.current.prepare(OWNER));
    if (!prepared.ok) throw new Error('Preparation should succeed.');

    expect(prepared.uploads).toHaveLength(0);
    expect(prepared.media).toEqual([{ ...existing, altText: 'Better description' }]);
  });

  it('rehydrates draft photos as new files with object-URL previews', () => {
    const file = imageFile('restored.jpg');
    const existing = {
      id: 'image_01',
      type: 'image' as const,
      url: `pubky://${OWNER}/pub/pubky.app/marketplace/v1/media/image_01`,
      contentHash: 'a'.repeat(64),
      mimeType: 'image/jpeg',
      byteSize: 3,
      width: 1200,
      height: 1600,
      altText: 'Cover',
    };
    const { result } = renderHook(() => useListingMediaManager());

    act(() =>
      result.current.restore([
        { key: 'new-1', kind: 'new', file, altText: 'Restored front' },
        { key: existing.id, kind: 'existing', record: existing, altText: 'Cover cropped' },
      ]),
    );

    expect(result.current.items).toHaveLength(2);
    expect(result.current.items[0]).toMatchObject({
      kind: 'new',
      altText: 'Restored front',
      previewUrl: 'blob:restored.jpg',
    });
    expect(result.current.items[1]).toMatchObject({ kind: 'existing', altText: 'Cover cropped' });
  });
});
