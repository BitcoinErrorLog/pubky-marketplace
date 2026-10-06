import { TagKind, type TCreateTagListInput, type TDeleteTagInput } from '@/application/tag/tag.types';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { HttpMethod } from '@/libs/http/http.types';
import { Logger } from '@/libs/logger/logger';
import type { Pubky } from '@/models/models.types';
import { HomeserverService } from '@/services/homeserver/homeserver';
import {
  buildMarketplaceTagRowId,
  LocalMarketplaceTagService,
  type MarketplaceTagKind,
} from '@/services/local/tag/marketplace/tag.marketplace';
import { LocalPostTagService } from '@/services/local/tag/post/tag.post';
import { ViewerTagMarkerStorage } from '@/services/local/tag/post/viewerTagMarkerStorage';
import { LocalUserTagService } from '@/services/local/tag/user/tag.user';

function isMarketplaceTagKind(kind: TagKind): kind is MarketplaceTagKind {
  return kind === TagKind.LISTING || kind === TagKind.SHOP;
}

/**
 * Routes a local tag write to the service owning the target kind.
 * Marketplace targets are keyed by their kind-prefixed row id.
 */
async function applyLocalTagWrite(
  op: 'create' | 'delete',
  { taggedKind, taggedId, label, taggerId }: { taggedKind: TagKind; taggedId: string; label: string; taggerId: string },
): Promise<boolean> {
  if (isMarketplaceTagKind(taggedKind)) {
    const rowId = buildMarketplaceTagRowId(taggedKind, taggedId);
    return op === 'create'
      ? LocalMarketplaceTagService.create({ taggerId, taggedId: rowId, label })
      : LocalMarketplaceTagService.delete({ taggerId, taggedId: rowId, label });
  }
  if (taggedKind === TagKind.POST) {
    return op === 'create'
      ? LocalPostTagService.create({ taggerId, taggedId, label })
      : LocalPostTagService.delete({ taggerId, taggedId, label });
  }
  return op === 'create'
    ? LocalUserTagService.create({ taggerId, taggedId, label })
    : LocalUserTagService.delete({ taggerId, taggedId, label });
}

/**
 * Tag application service implementing local-first architecture with rollback.
 *
 * **Local-First Write Pattern:**
 * Both `create` and `delete` methods update the local IndexedDB first, then
 * synchronize with the homeserver. This keeps the UI responsive while still
 * compensating locally if the homeserver request fails.
 *
 * **Failure Handling:**
 * If the homeserver request fails after the local update, the failed write is
 * rolled back locally so counters and relationship state stay consistent with
 * Nexus.
 */
export class TagApplication {
  /**
   * Commits the create tag operation to the homeserver and local database.
   * @param tagList - The list of tags to create
   */
  static async commitCreate({ tagList }: TCreateTagListInput) {
    // Process tags one at a time so callers never observe hidden in-flight work
    // from later entries after an earlier tag fails.
    for (const { taggerId, taggedId, label, tagUrl, tagJson, taggedKind } of tagList) {
      const didCreateLocally = await applyLocalTagWrite('create', { taggedKind, taggedId, label, taggerId });

      try {
        await HomeserverService.request({ method: HttpMethod.PUT, url: tagUrl, bodyJson: tagJson });
      } catch (error) {
        if (didCreateLocally) {
          try {
            await applyLocalTagWrite('delete', { taggedKind, taggedId, label, taggerId });
          } catch (rollbackError) {
            Logger.error('[TagApplication.commitCreate] Failed to rollback local tag create', {
              taggedId,
              label,
              taggerId,
              taggedKind,
              rollbackError,
            });
          }
        }

        throw error;
      }
    }
  }

  /**
   * Commits the delete tag operation to the homeserver and local database.
   * @param params - The parameters object
   * @param params.taggerId - The ID of the user who is deleting the tag
   * @param params.taggedId - The ID of the post or user who is being tagged
   * @param params.label - The label of the tag
   * @param params.tagUrl - The URL of the tag
   * @param params.taggedKind - The kind of the tagged entity
   */
  static async commitDelete({ taggerId, taggedId, label, tagUrl, taggedKind }: TDeleteTagInput) {
    const wasDeleted = await applyLocalTagWrite('delete', { taggedKind, taggedId, label, taggerId });

    // Only send to homeserver if something was actually deleted locally
    if (wasDeleted) {
      try {
        await HomeserverService.request({ method: HttpMethod.DELETE, url: tagUrl });
      } catch (error) {
        // 404 means the tag is already gone on the homeserver. Local just made the
        // same change, so the two states match — accept the delete and skip rollback.
        // Without this, the rollback re-creates the tag locally and the user is left
        // with a "ghost" tag they can't remove (HS keeps returning 404).
        if (error instanceof AppError && error.code === ClientErrorCode.NOT_FOUND) {
          Logger.warn('[TagApplication.commitDelete] Homeserver returned 404; treating as already deleted', {
            taggedId,
            label,
            taggerId,
            taggedKind,
          });
          return;
        }

        try {
          await applyLocalTagWrite('create', { taggedKind, taggedId, label, taggerId });
        } catch (rollbackError) {
          Logger.error('[TagApplication.commitDelete] Failed to rollback local tag delete', {
            taggedId,
            label,
            taggerId,
            taggedKind,
            rollbackError,
          });
        }

        throw error;
      }
    }
  }

  /**
   * Clears all viewer-mutation tag markers (sessionStorage) for the given user.
   * Called from logout / session-cleanup paths to drop stale markers before the
   * next user signs in on the same tab.
   */
  static clearViewerMarkers(pubky: Pubky) {
    ViewerTagMarkerStorage.clearForUser(pubky);
  }
}
