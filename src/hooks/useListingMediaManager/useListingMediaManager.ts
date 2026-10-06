'use client';

import { type ChangeEvent, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { COMMERCE_LISTING_STUDIO_MAX_PHOTOS } from '@/config/commerce';
import { IMAGE_MAX_RAW_SIZE } from '@/config/images';
import { resolveMarketplaceMediaUrlAsync } from '@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl';
import type { ListingDraftHydrateItem } from '@/libs/commerce/listing-drafts';
import { type CommerceListingRecord, commerceMediaSchema } from '@/libs/commerce/marketplace-records';
import { stripImageMetadata } from '@/libs/image/stripImageMetadata';
import { CommerceRecordNormalizer } from '@/pipes/commerce/commerce.normalizer';

export type ListingMediaRecord = CommerceListingRecord['media'][number];

export type ListingMediaManagerError = 'invalid-type' | 'too-large' | 'decode-failed' | 'limit-reached';

/**
 * One photo in the sell/edit studio, in display order (`items[0]` is the
 * cover). New photos hold the picked file until publish; existing photos
 * (edit mode) keep their already-uploaded record so publishing an edit never
 * re-uploads bytes that are already on the homeserver.
 */
export type ListingMediaItem =
  | { key: string; kind: 'new'; file: File; previewUrl: string; altText: string }
  | { key: string; kind: 'existing'; record: ListingMediaRecord; previewUrl: string | null; altText: string };

export type PrepareListingMediaResult =
  | { ok: true; media: ListingMediaRecord[]; uploads: Array<{ record: ListingMediaRecord; bytes: Uint8Array }> }
  | { ok: false; reason: 'no-photos' | 'missing-alt-text' | 'decode-failed' };

export function isListingMediaPublishReady(items: ListingMediaItem[]): boolean {
  return items.length > 0 && items.every((item) => item.altText.trim().length > 0);
}

export interface UseListingMediaManagerResult {
  items: ListingMediaItem[];
  maxPhotos: number;
  error: ListingMediaManagerError | null;
  inputRef: RefObject<HTMLInputElement | null>;
  onInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  choose: () => void;
  removeItem: (key: string) => void;
  /** Moves a photo one position earlier (-1) or later (1) in display order. */
  moveItem: (key: string, direction: -1 | 1) => void;
  setAltText: (key: string, altText: string) => void;
  /** Replaces the working set with a listing's already-published media (edit mode). */
  seed: (records: ListingMediaRecord[]) => void;
  /** Rehydrates composer photos from a Dexie listing draft. */
  restore: (items: ListingDraftHydrateItem[]) => void;
  reset: () => void;
  /**
   * Sanitizes, hashes, and measures every NEW photo and returns the full
   * media array in the current display order, plus the byte payloads that
   * still need uploading. Existing records pass through untouched except for
   * their (freely editable) alt text.
   */
  prepare: (ownerPubky: string) => Promise<PrepareListingMediaResult>;
}

export function useListingMediaManager(maxSize = IMAGE_MAX_RAW_SIZE): UseListingMediaManagerResult {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [items, setItems] = useState<ListingMediaItem[]>([]);
  const [error, setError] = useState<ListingMediaManagerError | null>(null);
  const itemsRef = useRef(items);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(
    () => () => {
      for (const item of itemsRef.current) {
        if (item.kind === 'new') URL.revokeObjectURL(item.previewUrl);
      }
    },
    [],
  );

  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    if (event.target) event.target.value = '';
    if (selected.length === 0) return;

    let nextError: ListingMediaManagerError | null = null;
    const additions: ListingMediaItem[] = [];
    let capacity = COMMERCE_LISTING_STUDIO_MAX_PHOTOS - itemsRef.current.length;
    for (const file of selected) {
      if (!file.type.startsWith('image/')) {
        nextError = 'invalid-type';
        continue;
      }
      if (file.size > maxSize) {
        nextError = 'too-large';
        continue;
      }
      if (capacity <= 0) {
        nextError = 'limit-reached';
        continue;
      }
      capacity -= 1;
      additions.push({
        key: crypto.randomUUID(),
        kind: 'new',
        file,
        previewUrl: URL.createObjectURL(file),
        altText: '',
      });
    }
    if (additions.length > 0) {
      setItems((current) => [...current, ...additions]);
    }
    setError(nextError);
  };

  const removeItem = (key: string) => {
    setItems((current) => {
      const removed = current.find((item) => item.key === key);
      if (removed?.kind === 'new') URL.revokeObjectURL(removed.previewUrl);
      return current.filter((item) => item.key !== key);
    });
    setError(null);
  };

  const moveItem = (key: string, direction: -1 | 1) => {
    setItems((current) => {
      const from = current.findIndex((item) => item.key === key);
      const to = from + direction;
      if (from === -1 || to < 0 || to >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const setAltText = (key: string, altText: string) => {
    setItems((current) => current.map((item) => (item.key === key ? { ...item, altText } : item)));
  };

  const seed = useCallback((records: ListingMediaRecord[]) => {
    setItems((current) => {
      for (const item of current) {
        if (item.kind === 'new') URL.revokeObjectURL(item.previewUrl);
      }
      const next = records.map((record) => ({
        key: record.id,
        kind: 'existing' as const,
        record,
        previewUrl: null,
        altText: record.altText,
      }));
      for (const record of records) {
        if (record.type !== 'image') continue;
        void resolveMarketplaceMediaUrlAsync(record.url).then((previewUrl) => {
          setItems((current) =>
            current.map((item) =>
              item.key === record.id && item.kind === 'existing' ? { ...item, previewUrl } : item,
            ),
          );
        });
      }
      return next;
    });
    setError(null);
  }, []);

  const restore = useCallback((incoming: ListingDraftHydrateItem[]) => {
    setItems((current) => {
      for (const item of current) {
        if (item.kind === 'new') URL.revokeObjectURL(item.previewUrl);
      }
      const next: ListingMediaItem[] = incoming.map((item) =>
        item.kind === 'existing'
          ? { key: item.key, kind: 'existing' as const, record: item.record, previewUrl: null, altText: item.altText }
          : {
              key: item.key,
              kind: 'new' as const,
              file: item.file,
              previewUrl: URL.createObjectURL(item.file),
              altText: item.altText,
            },
      );
      for (const item of next) {
        if (item.kind !== 'existing' || item.record.type !== 'image') continue;
        const record = item.record;
        void resolveMarketplaceMediaUrlAsync(record.url).then((previewUrl) => {
          setItems((currentItems) =>
            currentItems.map((entry) =>
              entry.key === record.id && entry.kind === 'existing' ? { ...entry, previewUrl } : entry,
            ),
          );
        });
      }
      return next;
    });
    setError(null);
  }, []);

  const reset = useCallback(() => {
    setItems((current) => {
      for (const item of current) {
        if (item.kind === 'new') URL.revokeObjectURL(item.previewUrl);
      }
      return [];
    });
    setError(null);
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  const prepare = async (ownerPubky: string): Promise<PrepareListingMediaResult> => {
    const current = itemsRef.current;
    if (current.length === 0) return { ok: false, reason: 'no-photos' };
    if (!isListingMediaPublishReady(current)) {
      return { ok: false, reason: 'missing-alt-text' };
    }

    try {
      const media: ListingMediaRecord[] = [];
      const uploads: Array<{ record: ListingMediaRecord; bytes: Uint8Array }> = [];
      for (const item of current) {
        if (item.kind === 'existing') {
          media.push(commerceMediaSchema.parse({ ...item.record, altText: item.altText.trim() }));
          continue;
        }
        const sanitized = await stripImageMetadata(item.file);
        const bytes = new Uint8Array(await sanitized.arrayBuffer());
        const image = await createImageBitmap(sanitized);
        const dimensions = { width: image.width, height: image.height };
        image.close();
        const mediaId = crypto.randomUUID().replaceAll('-', '');
        const record = commerceMediaSchema.parse({
          id: mediaId,
          type: 'image',
          url: CommerceRecordNormalizer.mediaUri(ownerPubky, mediaId),
          contentHash: bytesToHex(blake3(bytes)),
          mimeType: sanitized.type,
          byteSize: bytes.byteLength,
          width: dimensions.width,
          height: dimensions.height,
          altText: item.altText.trim(),
        });
        media.push(record);
        uploads.push({ record, bytes });
      }
      setError(null);
      return { ok: true, media, uploads };
    } catch {
      setError('decode-failed');
      return { ok: false, reason: 'decode-failed' };
    }
  };

  return {
    items,
    maxPhotos: COMMERCE_LISTING_STUDIO_MAX_PHOTOS,
    error,
    inputRef,
    onInputChange,
    choose: () => inputRef.current?.click(),
    removeItem,
    moveItem,
    setAltText,
    seed,
    restore,
    reset,
    prepare,
  };
}
