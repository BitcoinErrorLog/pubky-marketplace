import { TagKind } from '@/application/tag/tag.types';
import { db } from '@/database/franky/franky';
import { DatabaseErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { HttpMethod } from '@/libs/http/http.types';
import { MarketplaceTagsModel, type MarketplaceTagsModelSchema } from '@/models/marketplace/tags/marketplaceTags';
import type { Pubky } from '@/models/models.types';
import { ViewerTagMarkerStorage } from '@/services/local/tag/post/viewerTagMarkerStorage';
import type { TLocalTagParams } from '@/services/local/tag/tag.types';
import type { NexusTag } from '@/services/nexus/nexus.types';

export type MarketplaceTagKind = TagKind.LISTING | TagKind.SHOP;

/**
 * Builds the `marketplace_tags` row id for a tag target.
 *
 * - `TagKind.LISTING` + composite `sellerPubky:listingId` -> `listing:seller:listingId`
 * - `TagKind.SHOP` + `ownerPubky` -> `shop:owner`
 *
 * The kind prefix keeps listing and shop rows unambiguous in the shared table.
 */
export function buildMarketplaceTagRowId(kind: MarketplaceTagKind, taggedId: string): string {
  return `${kind}:${taggedId}`;
}

/**
 * Local-first storage for community tags on marketplace targets (listings and
 * shops). Mirrors `LocalPostTagService` with two deliberate differences:
 *
 * - No counts/TTL side tables: marketplace targets have no local counts models
 *   (`PostCountsModel` equivalents), so only the tag aggregate row is written.
 * - Rows are keyed by the kind-prefixed target id (see `buildMarketplaceTagRowId`).
 *
 * Viewer-mutation markers reuse `ViewerTagMarkerStorage`, passing the row id
 * as the target key, so `mergeTags` can ignore stale Nexus responses for the
 * same ~5-minute window the post flow uses.
 */
export class LocalMarketplaceTagService {
  /**
   * Adds the tagger to a tag on the marketplace target.
   *
   * @param params.taggedId - Kind-prefixed target row id (see `buildMarketplaceTagRowId`)
   * @param params.label - Normalized tag label (pre-normalized by caller)
   * @param params.taggerId - Pubky of the user adding the tag
   * @returns true if local state changed; false if the tagger already had this tag
   */
  static async create({ taggedId, label, taggerId }: TLocalTagParams): Promise<boolean> {
    let mutated = false;
    try {
      mutated = await db.transaction('rw', [MarketplaceTagsModel.table], async () => {
        const model = await MarketplaceTagsModel.getOrCreate<string, MarketplaceTagsModelSchema>(taggedId);
        const status = model.addTagger(label, taggerId);
        if (status === null) {
          return false;
        }
        await MarketplaceTagsModel.upsert({ id: taggedId, tags: model.tags as NexusTag[] });
        return true;
      });
    } catch (error) {
      throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'Failed to create marketplace tag', {
        service: ErrorService.Local,
        operation: 'create',
        context: { taggedId, label, taggerId },
        cause: error,
      });
    }

    if (mutated) {
      ViewerTagMarkerStorage.set({ pubky: taggerId, postId: taggedId, label, op: HttpMethod.PUT });
    }

    return mutated;
  }

  /**
   * Removes the tagger from a tag on the marketplace target.
   *
   * @param params.taggedId - Kind-prefixed target row id (see `buildMarketplaceTagRowId`)
   * @param params.label - Tag label to remove
   * @param params.taggerId - Pubky of the user removing the tag
   * @returns true if a tag was removed, false if nothing to delete (idempotent)
   */
  static async delete({ taggedId, label, taggerId }: TLocalTagParams): Promise<boolean> {
    const tagsData = await MarketplaceTagsModel.findById(taggedId);
    if (!tagsData) {
      return false;
    }

    const model = new MarketplaceTagsModel(tagsData);
    const status = model.removeTagger(label, taggerId);
    if (status === null) {
      return false;
    }

    try {
      await db.transaction('rw', [MarketplaceTagsModel.table], async () => {
        await MarketplaceTagsModel.upsert({ id: taggedId, tags: model.tags as NexusTag[] });
      });
    } catch (error) {
      throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'Failed to delete marketplace tag', {
        service: ErrorService.Local,
        operation: 'delete',
        context: { taggedId, label, taggerId },
        cause: error,
      });
    }

    ViewerTagMarkerStorage.set({ pubky: taggerId, postId: taggedId, label, op: HttpMethod.DELETE });
    return true;
  }

  /**
   * Reads the locally cached tag aggregate for a marketplace target.
   *
   * @param taggedId - Kind-prefixed target row id (see `buildMarketplaceTagRowId`)
   * @returns The cached NexusTag[] aggregate, or an empty array when none exists
   */
  static async read(taggedId: string): Promise<NexusTag[]> {
    const row = await MarketplaceTagsModel.findById(taggedId);
    return row?.tags ?? [];
  }

  /**
   * Merges Nexus tags for a marketplace target into local IndexedDB with the
   * same per-field policy as `LocalPostTagService.mergeTags`:
   *
   * - `taggers_count`: Nexus value, adjusted by ±1 when an active viewer
   *   marker disagrees with Nexus about the viewer's membership.
   * - Viewer relationship / viewer taggers entry: marker overrides Nexus.
   * - Other taggers: union of existing + Nexus (the Nexus sample is truncated).
   * - Labels present locally but absent from this response: left alone.
   *
   * @param params.taggedId - Kind-prefixed target row id
   * @param params.tags - Tags from the Nexus response
   * @param params.viewerId - Current viewer pubky for marker lookup, or null
   */
  static async mergeTags({
    taggedId,
    tags,
    viewerId,
  }: {
    taggedId: string;
    tags: NexusTag[];
    viewerId: Pubky | null;
  }): Promise<void> {
    ViewerTagMarkerStorage.sweepExpired();

    try {
      await db.transaction('rw', [MarketplaceTagsModel.table], async () => {
        const existing = await MarketplaceTagsModel.findById(taggedId);
        const existingTags = existing?.tags ?? [];

        const tagMap = new Map<string, NexusTag>();
        for (const tag of existingTags) {
          tagMap.set(tag.label.toLowerCase(), tag);
        }

        for (const newTag of tags) {
          const key = newTag.label.toLowerCase();
          const existingTag = tagMap.get(key);

          const marker = viewerId
            ? ViewerTagMarkerStorage.get({ pubky: viewerId, postId: taggedId, label: newTag.label })
            : null;
          const nexusSaysViewerIsTagger = Boolean(newTag.relationship);
          const viewerIsTagger = marker ? marker.op === HttpMethod.PUT : nexusSaysViewerIsTagger;

          const otherTaggers = new Set(
            [...(existingTag?.taggers ?? []), ...(newTag.taggers ?? [])].filter((tagger) => tagger !== viewerId),
          );
          const mergedTaggers: Pubky[] = Array.from(otherTaggers);
          if (viewerIsTagger && viewerId) {
            mergedTaggers.push(viewerId);
          }

          let taggers_count = newTag.taggers_count;
          if (marker && viewerIsTagger !== nexusSaysViewerIsTagger) {
            taggers_count = viewerIsTagger ? taggers_count + 1 : Math.max(0, taggers_count - 1);
          }

          tagMap.set(key, {
            ...newTag,
            taggers_count,
            taggers: mergedTaggers,
            relationship: viewerIsTagger,
          });
        }

        await MarketplaceTagsModel.upsert({
          id: taggedId,
          tags: Array.from(tagMap.values()),
        });
      });
    } catch (error) {
      throw Err.database(DatabaseErrorCode.WRITE_FAILED, 'Failed to merge marketplace tags', {
        service: ErrorService.Local,
        operation: 'mergeTags',
        context: { taggedId },
        cause: error,
      });
    }
  }
}
