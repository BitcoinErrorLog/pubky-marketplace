import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TagKind } from '@/application/tag/tag.types';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { HttpMethod } from '@/libs/http/http.types';
import type { Pubky } from '@/models/models.types';
import { HomeserverService } from '@/services/homeserver/homeserver';
import { LocalMarketplaceTagService } from '@/services/local/tag/marketplace/tag.marketplace';
import { LocalPostTagService } from '@/services/local/tag/post/tag.post';
import { ViewerTagMarkerStorage } from '@/services/local/tag/post/viewerTagMarkerStorage';
import { LocalUserTagService } from '@/services/local/tag/user/tag.user';
import { TagApplication } from './tag';
import type { TCreateTagInput, TDeleteTagInput } from './tag.types';

// Mock the HomeserverService
vi.mock('@/services/homeserver/homeserver', () => ({
  HomeserverService: {
    request: vi.fn(),
  },
}));

// Build a real AppError for the relevant client status so the layered
// `error instanceof AppError && error.code === ...` checks pass.
const httpError = (code: ClientErrorCode, operation: string) =>
  Err.client(code, code, {
    service: ErrorService.Homeserver,
    operation,
  });

describe('Tag Application', () => {
  // Test data factory
  const createMockTagData = (taggedKind: TagKind = TagKind.POST): TCreateTagInput => ({
    taggedId: taggedKind === TagKind.POST ? 'author:post123' : ('tagged-user-123' as Pubky),
    label: 'test-tag',
    taggerId: 'tagger123' as Pubky,
    tagUrl: 'pubky://tagger123/pub/pubky.app/tags/test-tag',
    tagJson: { label: 'test-tag' },
    taggedKind,
  });

  const createMockTagBatch = (labels: string[], taggedKind: TagKind = TagKind.POST): TCreateTagInput[] =>
    labels.map((label, index) => ({
      taggedId: taggedKind === TagKind.POST ? 'author:post123' : ('tagged-user-123' as Pubky),
      label,
      taggerId: `tagger${index + 1}` as Pubky,
      tagUrl: `pubky://tagger${index + 1}/pub/pubky.app/tags/${label}`,
      tagJson: { label },
      taggedKind,
    }));

  const createMockDeleteData = (taggedKind: TagKind = TagKind.POST): TDeleteTagInput => ({
    taggedId: taggedKind === TagKind.POST ? 'author:post123' : ('tagged-user-123' as Pubky),
    label: 'test-tag',
    taggerId: 'tagger123' as Pubky,
    tagUrl: 'pubky://tagger123/pub/pubky.app/tags/test-tag',
    taggedKind,
  });

  // Helper functions
  const setupMocks = (taggedKind: TagKind = TagKind.POST) => {
    const localTagService = taggedKind === TagKind.POST ? LocalPostTagService : LocalUserTagService;

    return {
      createSpy: vi.spyOn(localTagService, 'create'),
      deleteSpy: vi.spyOn(localTagService, 'delete'),
      requestSpy: vi.spyOn(HomeserverService, 'request'),
    };
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('commitCreate', () => {
    it('should save locally and sync to homeserver successfully', async () => {
      const mockData = createMockTagData();
      const { createSpy, requestSpy } = setupMocks();

      createSpy.mockResolvedValue(true);
      requestSpy.mockResolvedValue(undefined);

      await TagApplication.commitCreate({ tagList: [mockData] });

      expect(createSpy).toHaveBeenCalledWith({
        taggedId: mockData.taggedId,
        label: mockData.label,
        taggerId: mockData.taggerId,
      });
      expect(requestSpy).toHaveBeenCalledWith({
        method: HttpMethod.PUT,
        url: mockData.tagUrl,
        bodyJson: mockData.tagJson,
      });
    });

    it('should throw when local save fails', async () => {
      const mockData = createMockTagData();
      const { createSpy, requestSpy } = setupMocks();

      createSpy.mockRejectedValue(new Error('Database error'));

      await expect(TagApplication.commitCreate({ tagList: [mockData] })).rejects.toThrow('Database error');
      expect(createSpy).toHaveBeenCalledOnce();
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it('should rollback local create when homeserver sync fails', async () => {
      const mockData = createMockTagData();
      const { createSpy, deleteSpy, requestSpy } = setupMocks();

      createSpy.mockResolvedValue(true);
      deleteSpy.mockResolvedValue(true);
      requestSpy.mockRejectedValue(new Error('Failed to PUT to homeserver: 500'));

      await expect(TagApplication.commitCreate({ tagList: [mockData] })).rejects.toThrow(
        'Failed to PUT to homeserver: 500',
      );
      expect(createSpy).toHaveBeenCalledOnce();
      expect(requestSpy).toHaveBeenCalledOnce();
      expect(deleteSpy).toHaveBeenCalledWith({
        taggedId: mockData.taggedId,
        label: mockData.label,
        taggerId: mockData.taggerId,
      });
    });

    it('should rollback local create for user tags when homeserver sync fails', async () => {
      const mockData = createMockTagData(TagKind.USER);
      const { createSpy, deleteSpy, requestSpy } = setupMocks(TagKind.USER);

      createSpy.mockResolvedValue(true);
      deleteSpy.mockResolvedValue(true);
      requestSpy.mockRejectedValue(new Error('Failed to PUT to homeserver: 500'));

      await expect(TagApplication.commitCreate({ tagList: [mockData] })).rejects.toThrow(
        'Failed to PUT to homeserver: 500',
      );
      expect(createSpy).toHaveBeenCalledWith({
        taggedId: mockData.taggedId,
        label: mockData.label,
        taggerId: mockData.taggerId,
      });
      expect(requestSpy).toHaveBeenCalledOnce();
      expect(deleteSpy).toHaveBeenCalledWith({
        taggedId: mockData.taggedId,
        label: mockData.label,
        taggerId: mockData.taggerId,
      });
    });

    it('should stop processing later tags after an earlier create failure', async () => {
      const mockData = createMockTagBatch(['first-tag', 'second-tag']);
      const { createSpy, deleteSpy, requestSpy } = setupMocks();

      createSpy.mockResolvedValue(true);
      deleteSpy.mockResolvedValue(true);
      requestSpy.mockRejectedValueOnce(new Error('Failed to PUT to homeserver: 500'));

      await expect(TagApplication.commitCreate({ tagList: mockData })).rejects.toThrow(
        'Failed to PUT to homeserver: 500',
      );

      expect(createSpy).toHaveBeenCalledTimes(1);
      expect(createSpy).toHaveBeenCalledWith({
        taggedId: mockData[0].taggedId,
        label: mockData[0].label,
        taggerId: mockData[0].taggerId,
      });
      expect(requestSpy).toHaveBeenCalledTimes(1);
      expect(requestSpy).toHaveBeenCalledWith({
        method: HttpMethod.PUT,
        url: mockData[0].tagUrl,
        bodyJson: mockData[0].tagJson,
      });
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(deleteSpy).toHaveBeenCalledWith({
        taggedId: mockData[0].taggedId,
        label: mockData[0].label,
        taggerId: mockData[0].taggerId,
      });
    });
  });

  describe('commitDelete', () => {
    it('should remove locally and sync to homeserver successfully', async () => {
      const mockData = createMockDeleteData();
      const { deleteSpy, requestSpy } = setupMocks();

      deleteSpy.mockResolvedValue(true);
      requestSpy.mockResolvedValue(undefined);

      await TagApplication.commitDelete(mockData);

      expect(deleteSpy).toHaveBeenCalledWith({
        taggedId: mockData.taggedId,
        label: mockData.label,
        taggerId: mockData.taggerId,
      });
      expect(requestSpy).toHaveBeenCalledWith({ method: HttpMethod.DELETE, url: mockData.tagUrl });
    });

    it('should throw when local remove fails', async () => {
      const mockData = createMockDeleteData();
      const { deleteSpy, requestSpy } = setupMocks();

      deleteSpy.mockRejectedValue(new Error('User has not tagged this post with this label'));

      await expect(TagApplication.commitDelete(mockData)).rejects.toThrow(
        'User has not tagged this post with this label',
      );
      expect(deleteSpy).toHaveBeenCalledOnce();
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it('should rollback local delete when homeserver sync fails', async () => {
      const mockData = createMockDeleteData();
      const { createSpy, deleteSpy, requestSpy } = setupMocks();

      deleteSpy.mockResolvedValue(true);
      createSpy.mockResolvedValue(true);
      requestSpy.mockRejectedValue(new Error('Failed to DELETE from homeserver: 404'));

      await expect(TagApplication.commitDelete(mockData)).rejects.toThrow('Failed to DELETE from homeserver: 404');
      expect(deleteSpy).toHaveBeenCalledOnce();
      expect(requestSpy).toHaveBeenCalledOnce();
      expect(createSpy).toHaveBeenCalledWith({
        taggedId: mockData.taggedId,
        label: mockData.label,
        taggerId: mockData.taggerId,
      });
    });

    it('should rollback local delete for user tags when homeserver sync fails', async () => {
      const mockData = createMockDeleteData(TagKind.USER);
      const { createSpy, deleteSpy, requestSpy } = setupMocks(TagKind.USER);

      deleteSpy.mockResolvedValue(true);
      createSpy.mockResolvedValue(true);
      requestSpy.mockRejectedValue(new Error('Failed to DELETE from homeserver: 404'));

      await expect(TagApplication.commitDelete(mockData)).rejects.toThrow('Failed to DELETE from homeserver: 404');
      expect(deleteSpy).toHaveBeenCalledWith({
        taggedId: mockData.taggedId,
        label: mockData.label,
        taggerId: mockData.taggerId,
      });
      expect(requestSpy).toHaveBeenCalledOnce();
      expect(createSpy).toHaveBeenCalledWith({
        taggedId: mockData.taggedId,
        label: mockData.label,
        taggerId: mockData.taggerId,
      });
    });

    it('should not call homeserver when nothing was deleted locally (idempotent)', async () => {
      const mockData = createMockDeleteData();
      const { deleteSpy, requestSpy } = setupMocks();

      deleteSpy.mockResolvedValue(false); // Nothing to delete

      await TagApplication.commitDelete(mockData);

      expect(deleteSpy).toHaveBeenCalledOnce();
      expect(requestSpy).not.toHaveBeenCalled();
    });

    it('should treat 404 (Not Found) as already-deleted and skip rollback', async () => {
      const mockData = createMockDeleteData();
      const { createSpy, deleteSpy, requestSpy } = setupMocks();

      deleteSpy.mockResolvedValue(true);
      // Tag URL is content-addressed; 404 means the exact tag is already gone on HS.
      requestSpy.mockRejectedValue(httpError(ClientErrorCode.NOT_FOUND, 'commitDelete'));

      // Should resolve, not throw — local delete is already correct.
      await TagApplication.commitDelete(mockData);

      expect(deleteSpy).toHaveBeenCalledOnce();
      expect(requestSpy).toHaveBeenCalledOnce();
      // Without this, rollback re-creates the tag and the user is stuck with a
      // ghost tag they can't remove (HS keeps returning 404 on every retry).
      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  describe('marketplace tag routing', () => {
    const setupMarketplaceMocks = () => ({
      createSpy: vi.spyOn(LocalMarketplaceTagService, 'create'),
      deleteSpy: vi.spyOn(LocalMarketplaceTagService, 'delete'),
      requestSpy: vi.spyOn(HomeserverService, 'request'),
    });

    const listingTagData: TCreateTagInput = {
      taggedId: 'seller123:0034A0X7NJ52A',
      label: 'handmade',
      taggerId: 'tagger123' as Pubky,
      tagUrl: 'pubky://tagger123/pub/pubky.app/tags/handmade-id',
      tagJson: { label: 'handmade' },
      taggedKind: TagKind.LISTING,
    };

    const shopTagData: TCreateTagInput = {
      taggedId: 'shopowner123' as Pubky,
      label: 'trusted',
      taggerId: 'tagger123' as Pubky,
      tagUrl: 'pubky://tagger123/pub/pubky.app/tags/trusted-id',
      tagJson: { label: 'trusted' },
      taggedKind: TagKind.SHOP,
    };

    it('routes LISTING creates to LocalMarketplaceTagService with the kind-prefixed row id', async () => {
      const { createSpy, requestSpy } = setupMarketplaceMocks();
      createSpy.mockResolvedValue(true);
      requestSpy.mockResolvedValue(undefined);

      await TagApplication.commitCreate({ tagList: [listingTagData] });

      expect(createSpy).toHaveBeenCalledWith({
        taggedId: 'listing:seller123:0034A0X7NJ52A',
        label: 'handmade',
        taggerId: 'tagger123',
      });
      expect(requestSpy).toHaveBeenCalledWith({
        method: HttpMethod.PUT,
        url: listingTagData.tagUrl,
        bodyJson: listingTagData.tagJson,
      });
    });

    it('routes SHOP creates to LocalMarketplaceTagService with the kind-prefixed row id', async () => {
      const { createSpy, requestSpy } = setupMarketplaceMocks();
      createSpy.mockResolvedValue(true);
      requestSpy.mockResolvedValue(undefined);

      await TagApplication.commitCreate({ tagList: [shopTagData] });

      expect(createSpy).toHaveBeenCalledWith({
        taggedId: 'shop:shopowner123',
        label: 'trusted',
        taggerId: 'tagger123',
      });
    });

    it('rolls back a LISTING create through the marketplace service when homeserver sync fails', async () => {
      const { createSpy, deleteSpy, requestSpy } = setupMarketplaceMocks();
      createSpy.mockResolvedValue(true);
      deleteSpy.mockResolvedValue(true);
      requestSpy.mockRejectedValue(new Error('Failed to PUT to homeserver: 500'));

      await expect(TagApplication.commitCreate({ tagList: [listingTagData] })).rejects.toThrow(
        'Failed to PUT to homeserver: 500',
      );
      expect(deleteSpy).toHaveBeenCalledWith({
        taggedId: 'listing:seller123:0034A0X7NJ52A',
        label: 'handmade',
        taggerId: 'tagger123',
      });
    });

    it('routes SHOP deletes through the marketplace service and syncs to the homeserver', async () => {
      const { deleteSpy, requestSpy } = setupMarketplaceMocks();
      deleteSpy.mockResolvedValue(true);
      requestSpy.mockResolvedValue(undefined);

      await TagApplication.commitDelete({
        taggedId: shopTagData.taggedId,
        label: shopTagData.label,
        taggerId: shopTagData.taggerId,
        tagUrl: shopTagData.tagUrl,
        taggedKind: TagKind.SHOP,
      });

      expect(deleteSpy).toHaveBeenCalledWith({
        taggedId: 'shop:shopowner123',
        label: 'trusted',
        taggerId: 'tagger123',
      });
      expect(requestSpy).toHaveBeenCalledWith({ method: HttpMethod.DELETE, url: shopTagData.tagUrl });
    });

    it('never touches the post or user tag services for marketplace kinds', async () => {
      const { createSpy, requestSpy } = setupMarketplaceMocks();
      const postCreateSpy = vi.spyOn(LocalPostTagService, 'create');
      const userCreateSpy = vi.spyOn(LocalUserTagService, 'create');
      createSpy.mockResolvedValue(true);
      requestSpy.mockResolvedValue(undefined);

      await TagApplication.commitCreate({ tagList: [listingTagData, shopTagData] });

      expect(postCreateSpy).not.toHaveBeenCalled();
      expect(userCreateSpy).not.toHaveBeenCalled();
    });
  });

  describe('clearViewerMarkers', () => {
    it('delegates to ViewerTagMarkerStorage.clearForUser', () => {
      const spy = vi.spyOn(ViewerTagMarkerStorage, 'clearForUser').mockImplementation(() => {});

      TagApplication.clearViewerMarkers('user-pubky' as Pubky);

      expect(spy).toHaveBeenCalledWith('user-pubky');
    });
  });
});
