import type { CommerceListingRecord } from '@/libs/commerce/marketplace-records';

type ListingMediaRecord = CommerceListingRecord['media'][number];

export const LISTING_DRAFT_AUTOSAVE_MS = 500;
export const LISTING_DRAFT_MAX_PER_OWNER = 10;
export const LISTING_DRAFT_MAX_BLOB_BYTES = 32 * 1024 * 1024;
export const LISTING_DRAFT_RESUME_STORAGE_KEY = 'pubky.marketplace.listingDraft.resumeId';
export const LISTING_DRAFT_UNTITLED_LABEL = 'Untitled listing';

export const LISTING_DRAFT_SECTION_IDS = [
  'listing-section-photos',
  'listing-section-item',
  'listing-section-price',
  'listing-section-shipping',
  'listing-section-review',
] as const;

export type ListingDraftSectionId = (typeof LISTING_DRAFT_SECTION_IDS)[number];

export type ListingDraftExistingMediaRef = {
  kind: 'existing';
  key: string;
  altText: string;
  record: ListingMediaRecord;
};

export type ListingDraftNewMediaRef = {
  kind: 'new';
  key: string;
  altText: string;
  name: string;
  type: string;
  lastModified: number;
};

export type ListingDraftMediaRef = ListingDraftExistingMediaRef | ListingDraftNewMediaRef;

export type ListingDraftMediaInput =
  | { key: string; kind: 'new'; file: Blob; altText: string; name?: string; type?: string; lastModified?: number }
  | { key: string; kind: 'existing'; record: ListingMediaRecord; altText: string };

export type ListingDraftHydrateItem =
  | { key: string; kind: 'new'; file: File; altText: string }
  | { key: string; kind: 'existing'; record: ListingMediaRecord; altText: string };

/** Dexie `cloneSimpleObjectTree` drops nested `Blob`s; store bytes instead. */
export type ListingDraftStoredBlob = {
  type: string;
  bytes: Uint8Array;
};

export type ListingDraftBlobMap = Record<string, Blob>;
export type ListingDraftStoredBlobMap = Record<string, ListingDraftStoredBlob>;

export interface ListingDraftEvictionRow {
  id: string;
  listing_id: string;
  updated_at: number;
  blobBytes: number;
  blobKeys: string[];
}

export interface ListingDraftEvictionPlan {
  deleteIds: string[];
  trimKeepBlobKeys: string[];
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export function isListingDraftSectionId(value: unknown): value is ListingDraftSectionId {
  return typeof value === 'string' && (LISTING_DRAFT_SECTION_IDS as readonly string[]).includes(value);
}

export function listingDraftTitleLabel(title: unknown): string {
  return typeof title === 'string' && title.trim() !== '' ? title.trim() : LISTING_DRAFT_UNTITLED_LABEL;
}

export function formatListingDraftAge(updatedAt: number, nowMs: number): string {
  const elapsed = Math.max(0, nowMs - updatedAt);
  if (elapsed < 45_000) return 'just now';
  if (elapsed < 90_000) return '1 min ago';
  if (elapsed < 45 * MINUTE_MS) return `${Math.round(elapsed / MINUTE_MS)} min ago`;
  if (elapsed < 90 * MINUTE_MS) return '1 hour ago';
  if (elapsed < 22 * HOUR_MS) return `${Math.round(elapsed / HOUR_MS)} hours ago`;
  if (elapsed < 36 * HOUR_MS) return '1 day ago';
  if (elapsed < 25 * DAY_MS) return `${Math.round(elapsed / DAY_MS)} days ago`;
  return 'weeks ago';
}

export function listingDraftResumePrompt(updatedAt: number, nowMs: number): string {
  return `Resume your draft from ${formatListingDraftAge(updatedAt, nowMs)}?`;
}

export function listingDraftBlobBytes(blobs: Record<string, Blob> | ListingDraftStoredBlobMap | undefined): number {
  if (!blobs) return 0;
  return Object.values(blobs).reduce((total, blob) => total + listingDraftStoredBlobBytes(blob), 0);
}

export async function encodeListingDraftBlobs(blobs: ListingDraftBlobMap): Promise<ListingDraftStoredBlobMap> {
  const encoded: ListingDraftStoredBlobMap = {};
  for (const [key, blob] of Object.entries(blobs)) {
    encoded[key] = {
      type: blob.type || 'application/octet-stream',
      bytes: new Uint8Array(await blob.arrayBuffer()),
    };
  }
  return encoded;
}

export function decodeListingDraftBlobs(
  stored: ListingDraftBlobMap | ListingDraftStoredBlobMap | Record<string, unknown> | undefined,
): ListingDraftBlobMap {
  if (!stored) return {};
  const blobs: ListingDraftBlobMap = {};
  for (const [key, value] of Object.entries(stored)) {
    const blob = listingDraftValueToBlob(value);
    if (blob) blobs[key] = blob;
  }
  return blobs;
}

export function serializeListingDraftMedia(items: ListingDraftMediaInput[]): {
  mediaRefs: ListingDraftMediaRef[];
  mediaBlobs: Record<string, Blob>;
} {
  const mediaRefs: ListingDraftMediaRef[] = [];
  const mediaBlobs: Record<string, Blob> = {};
  for (const item of items) {
    if (item.kind === 'existing') {
      mediaRefs.push({ kind: 'existing', key: item.key, altText: item.altText, record: item.record });
      continue;
    }
    const name = item.name ?? (item.file instanceof File ? item.file.name : 'photo');
    const type = item.type ?? item.file.type ?? 'application/octet-stream';
    const lastModified = item.lastModified ?? (item.file instanceof File ? item.file.lastModified : 0);
    mediaRefs.push({ kind: 'new', key: item.key, altText: item.altText, name, type, lastModified });
    mediaBlobs[item.key] = item.file;
  }
  return { mediaRefs, mediaBlobs };
}

export function hydrateListingDraftMedia(
  refs: ListingDraftMediaRef[] | undefined,
  blobs: Record<string, Blob> | undefined,
): ListingDraftHydrateItem[] {
  if (!refs || refs.length === 0) return [];
  const stored = blobs ?? {};
  const items: ListingDraftHydrateItem[] = [];
  for (const ref of refs) {
    if (ref.kind === 'existing') {
      items.push({ key: ref.key, kind: 'existing', record: ref.record, altText: ref.altText });
      continue;
    }
    const blob = stored[ref.key];
    if (!blob) continue;
    items.push({
      key: ref.key,
      kind: 'new',
      file: new File([blob], ref.name, { type: ref.type, lastModified: ref.lastModified }),
      altText: ref.altText,
    });
  }
  return items;
}

export function parseListingDraftMediaRefs(value: unknown): ListingDraftMediaRef[] {
  if (!Array.isArray(value)) return [];
  const refs: ListingDraftMediaRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const row = entry as Record<string, unknown>;
    if (row.kind === 'existing' && typeof row.key === 'string' && row.record && typeof row.record === 'object') {
      refs.push({
        kind: 'existing',
        key: row.key,
        altText: typeof row.altText === 'string' ? row.altText : '',
        record: row.record as ListingMediaRecord,
      });
      continue;
    }
    if (
      row.kind === 'new' &&
      typeof row.key === 'string' &&
      typeof row.name === 'string' &&
      typeof row.type === 'string'
    ) {
      refs.push({
        kind: 'new',
        key: row.key,
        altText: typeof row.altText === 'string' ? row.altText : '',
        name: row.name,
        type: row.type,
        lastModified: typeof row.lastModified === 'number' ? row.lastModified : 0,
      });
    }
  }
  return refs;
}

export function listingDraftFormRecord(draft: { data?: { form?: unknown } }): Record<string, unknown> | null {
  const form = draft.data?.form;
  if (!form || typeof form !== 'object' || Array.isArray(form)) return null;
  return form as Record<string, unknown>;
}

export function contentfulListingDrafts<T extends { data?: { form?: unknown } }>(drafts: T[]): T[] {
  return drafts.filter((draft) => {
    const form = listingDraftFormRecord(draft);
    return form !== null && listingDraftHasUserContent(form);
  });
}

export function listingDraftHasUserContent(record: Record<string, unknown>): boolean {
  if (
    [record.title, record.description, record.seededFromTitle, record.categoryId, record.price].some(isNonEmptyString)
  ) {
    return true;
  }
  if (typeof record.condition === 'string' && record.condition.trim() !== '' && record.condition !== 'good') {
    return true;
  }
  if (listingDraftHasCustomVariants(record.variants)) return true;
  if (listingDraftHasMedia(record)) return true;
  if (
    [
      record.shippingPrice,
      record.packageWeight,
      record.packageLength,
      record.packageWidth,
      record.packageHeight,
      record.region,
    ].some(isNonEmptyString)
  ) {
    return true;
  }
  if (
    typeof record.shippingLabel === 'string' &&
    record.shippingLabel.trim() !== '' &&
    record.shippingLabel !== 'Seller shipping'
  ) {
    return true;
  }
  if (
    typeof record.shippingMinDays === 'string' &&
    record.shippingMinDays.trim() !== '' &&
    record.shippingMinDays !== '3'
  ) {
    return true;
  }
  if (
    typeof record.shippingMaxDays === 'string' &&
    record.shippingMaxDays.trim() !== '' &&
    record.shippingMaxDays !== '7'
  ) {
    return true;
  }
  return false;
}

export function planListingDraftEviction(
  drafts: ListingDraftEvictionRow[],
  keepListingId: string,
  maxCount = LISTING_DRAFT_MAX_PER_OWNER,
  maxBlobBytes = LISTING_DRAFT_MAX_BLOB_BYTES,
): ListingDraftEvictionPlan {
  const deleteIds = new Set<string>();
  const newestFirst = [...drafts].sort((left, right) => right.updated_at - left.updated_at);
  const overflow = newestFirst.length - maxCount;
  if (overflow > 0) {
    const oldestFirst = [...newestFirst].reverse();
    let remaining = overflow;
    for (const row of oldestFirst) {
      if (remaining <= 0) break;
      if (row.listing_id === keepListingId) continue;
      deleteIds.add(row.id);
      remaining -= 1;
    }
  }

  const surviving = newestFirst.filter((row) => !deleteIds.has(row.id));
  let totalBytes = surviving.reduce((sum, row) => sum + row.blobBytes, 0);
  if (totalBytes > maxBlobBytes) {
    const othersOldestFirst = surviving.filter((row) => row.listing_id !== keepListingId).reverse();
    for (const row of othersOldestFirst) {
      if (totalBytes <= maxBlobBytes) break;
      deleteIds.add(row.id);
      totalBytes -= row.blobBytes;
    }
  }

  return { deleteIds: [...deleteIds], trimKeepBlobKeys: [] };
}

/** Drops the largest blobs from the kept draft until `maxBlobBytes` holds. */
export function planListingDraftBlobTrim(
  blobs: Record<string, Blob>,
  otherBlobBytes: number,
  maxBlobBytes = LISTING_DRAFT_MAX_BLOB_BYTES,
): string[] {
  const entries = Object.entries(blobs).sort((left, right) => right[1].size - left[1].size);
  let total = otherBlobBytes + listingDraftBlobBytes(blobs);
  const drop: string[] = [];
  for (const [key, blob] of entries) {
    if (total <= maxBlobBytes) break;
    drop.push(key);
    total -= blob.size;
  }
  return drop;
}

export function peekListingDraftResumeId(): string | null {
  if (typeof sessionStorage === 'undefined') return null;
  const value = sessionStorage.getItem(LISTING_DRAFT_RESUME_STORAGE_KEY);
  return value && value.trim() !== '' ? value : null;
}

export function takeListingDraftResumeId(): string | null {
  const value = peekListingDraftResumeId();
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.removeItem(LISTING_DRAFT_RESUME_STORAGE_KEY);
  }
  return value;
}

export function markListingDraftResumeId(listingId: string): void {
  if (typeof sessionStorage === 'undefined') return;
  sessionStorage.setItem(LISTING_DRAFT_RESUME_STORAGE_KEY, listingId);
}

function listingDraftStoredBlobBytes(value: unknown): number {
  if (value instanceof Blob) return value.size;
  const bytes = listingDraftAsUint8Array(listingDraftStoredBytesField(value));
  return bytes?.byteLength ?? 0;
}

function listingDraftValueToBlob(value: unknown): Blob | null {
  if (value instanceof Blob) return value;
  const bytes = listingDraftAsUint8Array(listingDraftStoredBytesField(value));
  if (!bytes) return null;
  const type =
    value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string'
      ? (value as { type: string }).type
      : 'application/octet-stream';
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type: type || 'application/octet-stream' });
}

function listingDraftStoredBytesField(value: unknown): unknown {
  if (!value || typeof value !== 'object') return null;
  return (value as { bytes?: unknown }).bytes;
}

function listingDraftAsUint8Array(bytes: unknown): Uint8Array | null {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes &&
    typeof bytes === 'object' &&
    typeof (bytes as { byteLength?: unknown }).byteLength === 'number' &&
    (bytes as { byteLength: number }).byteLength >= 0
  ) {
    try {
      return new Uint8Array(bytes as ArrayBuffer);
    } catch {
      return null;
    }
  }
  return null;
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}

function listingDraftHasMedia(record: Record<string, unknown>): boolean {
  if (isNonEmptyString(record.altText)) return true;
  if (Array.isArray(record.mediaRefs) && record.mediaRefs.length > 0) return true;
  return ['photos', 'media', 'photoIds', 'mediaIds'].some((key) => {
    const value = record[key];
    return Array.isArray(value) && value.length > 0;
  });
}

function listingDraftHasCustomVariants(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) return false;
  if (value.length > 1) return true;
  const row = value[0];
  if (!row || typeof row !== 'object') return true;
  const variant = row as Record<string, unknown>;
  return (
    isNonEmptyString(variant.sku) ||
    isNonEmptyString(variant.size) ||
    isNonEmptyString(variant.color) ||
    isNonEmptyString(variant.style) ||
    variant.unlimited === true ||
    (typeof variant.quantity === 'string' && variant.quantity.trim() !== '' && variant.quantity !== '1') ||
    isNonEmptyString(variant.priceOverride)
  );
}
