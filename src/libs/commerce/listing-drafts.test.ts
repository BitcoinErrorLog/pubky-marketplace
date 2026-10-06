import { afterEach, describe, expect, it } from 'vitest';
import {
  contentfulListingDrafts,
  decodeListingDraftBlobs,
  encodeListingDraftBlobs,
  formatListingDraftAge,
  hydrateListingDraftMedia,
  LISTING_DRAFT_MAX_BLOB_BYTES,
  LISTING_DRAFT_MAX_PER_OWNER,
  LISTING_DRAFT_RESUME_STORAGE_KEY,
  listingDraftBlobBytes,
  listingDraftHasUserContent,
  listingDraftResumePrompt,
  listingDraftTitleLabel,
  markListingDraftResumeId,
  parseListingDraftMediaRefs,
  planListingDraftBlobTrim,
  planListingDraftEviction,
  serializeListingDraftMedia,
  takeListingDraftResumeId,
} from './listing-drafts';

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

describe('listing drafts helpers', () => {
  afterEach(() => {
    sessionStorage.removeItem(LISTING_DRAFT_RESUME_STORAGE_KEY);
  });

  it('formats relative draft ages for restore copy', () => {
    expect(formatListingDraftAge(NOW, NOW)).toBe('just now');
    expect(formatListingDraftAge(NOW - 3 * 60_000, NOW)).toBe('3 min ago');
    expect(listingDraftResumePrompt(NOW - 3 * 60_000, NOW)).toBe('Resume your draft from 3 min ago?');
    expect(formatListingDraftAge(NOW - 2 * 60 * 60_000, NOW)).toBe('2 hours ago');
    expect(listingDraftTitleLabel('  Vintage boots  ')).toBe('Vintage boots');
    expect(listingDraftTitleLabel('')).toBe('Untitled listing');
  });

  it('treats unlimited stock as an edited variant', () => {
    expect(
      listingDraftHasUserContent({
        variants: [{ sku: '', size: '', color: '', style: '', quantity: '1', unlimited: true, priceOverride: '' }],
      }),
    ).toBe(true);
    expect(
      listingDraftHasUserContent({
        variants: [{ sku: '', size: '', color: '', style: '', quantity: '1', unlimited: false, priceOverride: '' }],
      }),
    ).toBe(false);
    expect(
      listingDraftHasUserContent({
        variants: [{ sku: '', size: '', color: '', style: '', quantity: '1', priceOverride: '' }],
      }),
    ).toBe(false);
  });

  it('treats media refs as user content and ignores default shipping', () => {
    expect(listingDraftHasUserContent({})).toBe(false);
    expect(listingDraftHasUserContent({ title: 'Boots' })).toBe(true);
    expect(listingDraftHasUserContent({ shippingLabel: 'Seller shipping', shippingMinDays: '3' })).toBe(false);
    expect(
      listingDraftHasUserContent({
        mediaRefs: [{ kind: 'new', key: 'p1', altText: '', name: 'a.jpg', type: 'image/jpeg', lastModified: 1 }],
      }),
    ).toBe(true);
  });

  it('lists only contentful draft rows', () => {
    expect(
      contentfulListingDrafts([{ data: { form: { title: 'Boots' } } }, { data: { form: {} } }, { data: {} }]),
    ).toEqual([{ data: { form: { title: 'Boots' } } }]);
  });

  it('round-trips new photo blobs and existing homeserver refs', () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'front.jpg', { type: 'image/jpeg', lastModified: 42 });
    const record = {
      id: 'image_01',
      type: 'image' as const,
      url: 'pubky://y'.padEnd(59, 'y') + '/pub/pubky.app/marketplace/v1/media/image_01',
      contentHash: 'a'.repeat(64),
      mimeType: 'image/jpeg',
      byteSize: 3,
      width: 12,
      height: 16,
      altText: 'Cover',
    };
    const serialized = serializeListingDraftMedia([
      { key: 'new-1', kind: 'new', file, altText: 'Front' },
      { key: record.id, kind: 'existing', record, altText: 'Cover cropped' },
    ]);
    expect(serialized.mediaRefs).toHaveLength(2);
    expect(serialized.mediaBlobs['new-1']).toBe(file);
    expect(serialized.mediaRefs[1]).toMatchObject({ kind: 'existing', altText: 'Cover cropped' });

    const hydrated = hydrateListingDraftMedia(serialized.mediaRefs, serialized.mediaBlobs);
    expect(hydrated[0]).toMatchObject({ kind: 'new', altText: 'Front' });
    expect(hydrated[0].kind === 'new' && hydrated[0].file.name).toBe('front.jpg');
    expect(hydrated[1]).toMatchObject({ kind: 'existing', altText: 'Cover cropped' });
    expect(hydrateListingDraftMedia(serialized.mediaRefs, {})).toHaveLength(1);
    expect(parseListingDraftMediaRefs(serialized.mediaRefs)).toHaveLength(2);
  });

  it('round-trips photo bytes through the Dexie Uint8Array encoding', async () => {
    const file = new File([new Uint8Array([9, 8, 7])], 'front.jpg', { type: 'image/jpeg' });
    const encoded = await encodeListingDraftBlobs({ photo_front: file });
    expect(encoded.photo_front.bytes.byteLength).toBe(3);
    expect(encoded.photo_front.type).toBe('image/jpeg');
    const decoded = decodeListingDraftBlobs(encoded);
    expect(decoded.photo_front).toBeInstanceOf(Blob);
    expect(decoded.photo_front.size).toBe(3);
    expect(decoded.photo_front.type).toBe('image/jpeg');
    expect(listingDraftBlobBytes(encoded)).toBe(3);

    const fromDetached = decodeListingDraftBlobs({
      photo_front: { type: 'image/jpeg', bytes: encoded.photo_front.bytes.buffer },
    });
    expect(fromDetached.photo_front.size).toBe(3);
  });

  it('evicts oldest other drafts by count and blob size without deleting the kept row', () => {
    const drafts = Array.from({ length: 12 }, (_, index) => ({
      id: `owner:draft_${index}`,
      listing_id: `draft_${index}`,
      updated_at: index + 1,
      blobBytes: 0,
      blobKeys: [],
    }));
    const countPlan = planListingDraftEviction(drafts, 'draft_11');
    expect(countPlan.deleteIds).toHaveLength(drafts.length - LISTING_DRAFT_MAX_PER_OWNER);
    expect(countPlan.deleteIds).toContain('owner:draft_0');
    expect(countPlan.deleteIds).not.toContain('owner:draft_11');

    const bulky = [
      { id: 'owner:old', listing_id: 'old', updated_at: 1, blobBytes: LISTING_DRAFT_MAX_BLOB_BYTES, blobKeys: ['a'] },
      { id: 'owner:keep', listing_id: 'keep', updated_at: 2, blobBytes: 1024, blobKeys: ['b'] },
    ];
    const sizePlan = planListingDraftEviction(bulky, 'keep');
    expect(sizePlan.deleteIds).toEqual(['owner:old']);
  });

  it('trims the largest blobs on the kept draft when it alone exceeds the cap', () => {
    const small = new Blob([new Uint8Array(100)]);
    const large = new Blob([new Uint8Array(LISTING_DRAFT_MAX_BLOB_BYTES)]);
    expect(planListingDraftBlobTrim({ keep: small, drop: large }, 0)).toEqual(['drop']);
  });

  it('stores a one-shot resume id in sessionStorage', () => {
    markListingDraftResumeId('draft_resume');
    expect(takeListingDraftResumeId()).toBe('draft_resume');
    expect(takeListingDraftResumeId()).toBeNull();
  });
});
