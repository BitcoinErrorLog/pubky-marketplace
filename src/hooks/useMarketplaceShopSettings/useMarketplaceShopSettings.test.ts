import { act, renderHook, waitFor } from '@testing-library/react';
import type { ChangeEvent } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IMAGE_MAX_RAW_SIZE } from '@/config/images';
import { CommerceController } from '@/controllers/commerce/commerce';
import { Logger } from '@/libs/logger/logger';
import { asOpaque } from '@/test-utils/type-assertions';
import { useMarketplaceShopSettings } from './useMarketplaceShopSettings';

const OWNER = 'y'.repeat(52);
const AVATAR_MEDIA_URL = `pubky://${OWNER}/pub/pubky.app/marketplace/v1/media/avatar_media_id`;
const BANNER_MEDIA_URL = `pubky://${OWNER}/pub/pubky.app/marketplace/v1/media/banner_media_id`;

vi.mock('@/stores/auth/auth.store', () => ({
  useAuthStore: (selector: (state: { currentUserPubky: string }) => unknown) => selector({ currentUserPubky: OWNER }),
}));

vi.mock('@/controllers/commerce/commerce', () => ({
  CommerceController: {
    getShop: vi.fn(),
    getOrFetchShop: vi.fn(),
    commitUpsertShop: vi.fn(),
    commitCreateMedia: vi.fn(),
  },
}));

vi.mock('@/molecules/Toaster/use-toast', () => ({
  toast: vi.fn(),
}));

vi.mock('@/libs/image/stripImageMetadata', () => ({
  stripImageMetadata: vi.fn((file: File) => file),
}));

vi.mock('@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl', async () => {
  return await import('@/test/mocks/marketplace-media-hooks');
});

const publishedShop = {
  schemaVersion: 1 as const,
  recordType: 'shop' as const,
  ownerPubky: OWNER,
  revision: 3,
  createdAt: '2026-08-01T10:00:00.000Z',
  updatedAt: '2026-08-10T10:00:00.000Z',
  name: 'Satoshi Vintage',
  bio: 'Independent circular fashion.',
  location: { countryCode: 'US', region: 'NY' },
  shippingPolicy: 'Ships within three business days.',
  returnPolicy: 'Returns accepted within 30 days.',
  vacationMode: false,
};

function changeEvent(file: File): ChangeEvent<HTMLInputElement> {
  return asOpaque<ChangeEvent<HTMLInputElement>>({
    target: { files: [file] },
  });
}

function imageFile(name: string, bytes: number[] = [1, 2, 3]): File {
  const file = new File([new Uint8Array(bytes)], name, { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: vi.fn(async () => new Uint8Array(bytes).buffer),
  });
  return file;
}

describe('useMarketplaceShopSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(CommerceController.getOrFetchShop).mockRejectedValue(new Error('no shop record'));
    vi.mocked(CommerceController.getShop).mockResolvedValue(null);
    vi.mocked(CommerceController.commitCreateMedia).mockResolvedValue(AVATAR_MEDIA_URL);
    vi.stubGlobal(
      'URL',
      Object.assign(URL, {
        createObjectURL: vi.fn((file: File) => `blob:${file.name}`),
        revokeObjectURL: vi.fn(),
      }),
    );
  });

  it('publishes versioned owner-signed shop policies for a first-time seller', async () => {
    const { result } = renderHook(() => useMarketplaceShopSettings());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.hasShop).toBe(false);

    act(() => {
      result.current.form.setValue('name', 'Satoshi Vintage');
      result.current.form.setValue('bio', 'Independent circular fashion.');
    });

    await act(() => result.current.submit());

    expect(CommerceController.commitUpsertShop).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerPubky: OWNER,
        revision: 1,
        name: 'Satoshi Vintage',
        avatarUrl: undefined,
        bannerUrl: undefined,
        shippingPolicy: expect.any(String),
        returnPolicy: expect.any(String),
        vacationMode: false,
      }),
    );
    expect(CommerceController.commitCreateMedia).not.toHaveBeenCalled();
    expect(result.current.hasShop).toBe(true);
  });

  it('edits the published shop record network-first instead of restarting at revision 1', async () => {
    vi.mocked(CommerceController.getOrFetchShop).mockResolvedValue(publishedShop);

    const { result } = renderHook(() => useMarketplaceShopSettings());
    await waitFor(() => expect(result.current.hasShop).toBe(true));
    expect(result.current.form.getValues('name')).toBe('Satoshi Vintage');

    await act(() => result.current.submit());

    expect(CommerceController.commitUpsertShop).toHaveBeenCalledWith(
      expect.objectContaining({ revision: 4, createdAt: publishedShop.createdAt }),
    );
  });

  it('round-trips unedited and unknown record members through a save (open-world records)', async () => {
    // transactionService is a real optional field this form does not edit;
    // futureField stands in for a member added by a newer writer. Both must
    // survive the read-modify-write untouched (social/v1 alignment).
    vi.mocked(CommerceController.getOrFetchShop).mockResolvedValue({
      ...publishedShop,
      transactionService: 'https://service.example',
      futureField: { promo: true },
    } as never);

    const { result } = renderHook(() => useMarketplaceShopSettings());
    await waitFor(() => expect(result.current.hasShop).toBe(true));
    await act(() => result.current.submit());

    expect(CommerceController.commitUpsertShop).toHaveBeenCalledWith(
      expect.objectContaining({
        transactionService: 'https://service.example',
        futureField: { promo: true },
        revision: 4,
      }),
    );
  });

  it('falls back to the local cache when the homeserver is unreachable', async () => {
    vi.mocked(CommerceController.getOrFetchShop).mockRejectedValue(new Error('offline'));
    vi.mocked(CommerceController.getShop).mockResolvedValue({ record: publishedShop } as never);

    const { result } = renderHook(() => useMarketplaceShopSettings());
    await waitFor(() => expect(result.current.hasShop).toBe(true));

    expect(result.current.revision).toBe(3);
    expect(result.current.form.getValues('name')).toBe('Satoshi Vintage');
  });

  it('uploads picked avatar and banner images and publishes their marketplace media URIs', async () => {
    vi.mocked(CommerceController.commitCreateMedia)
      .mockResolvedValueOnce(AVATAR_MEDIA_URL)
      .mockResolvedValueOnce(BANNER_MEDIA_URL);

    const { result } = renderHook(() => useMarketplaceShopSettings());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.form.setValue('name', 'Satoshi Vintage');
      result.current.avatar.onInputChange(changeEvent(imageFile('avatar.png', [1, 2, 3])));
      result.current.banner.onInputChange(changeEvent(imageFile('banner.png', [4, 5, 6])));
    });
    expect(result.current.avatar.previewUrl).toBe('blob:avatar.png');
    expect(result.current.banner.previewUrl).toBe('blob:banner.png');

    await act(() => result.current.submit());

    expect(CommerceController.commitCreateMedia).toHaveBeenCalledTimes(2);
    expect(CommerceController.commitCreateMedia).toHaveBeenCalledWith(expect.any(String), new Uint8Array([1, 2, 3]));
    expect(CommerceController.commitCreateMedia).toHaveBeenCalledWith(expect.any(String), new Uint8Array([4, 5, 6]));
    expect(CommerceController.commitUpsertShop).toHaveBeenCalledWith(
      expect.objectContaining({ avatarUrl: AVATAR_MEDIA_URL, bannerUrl: BANNER_MEDIA_URL }),
    );
  });

  it('hydrates published shop images and republishes them without re-uploading bytes', async () => {
    vi.mocked(CommerceController.getOrFetchShop).mockResolvedValue({
      ...publishedShop,
      avatarUrl: AVATAR_MEDIA_URL,
      bannerUrl: BANNER_MEDIA_URL,
    });

    const { result } = renderHook(() => useMarketplaceShopSettings());
    await waitFor(() => expect(result.current.hasShop).toBe(true));
    expect(result.current.avatar.previewUrl).toBe(
      `https://homeserver.example/pub/pubky.app/marketplace/v1/media/avatar_media_id?pubky-host=${OWNER}`,
    );
    expect(result.current.banner.previewUrl).toBe(
      `https://homeserver.example/pub/pubky.app/marketplace/v1/media/banner_media_id?pubky-host=${OWNER}`,
    );

    await act(() => result.current.submit());

    expect(CommerceController.commitCreateMedia).not.toHaveBeenCalled();
    expect(CommerceController.commitUpsertShop).toHaveBeenCalledWith(
      expect.objectContaining({ avatarUrl: AVATAR_MEDIA_URL, bannerUrl: BANNER_MEDIA_URL }),
    );
  });

  it('removes a published image so the next revision publishes without the field', async () => {
    vi.mocked(CommerceController.getOrFetchShop).mockResolvedValue({
      ...publishedShop,
      avatarUrl: AVATAR_MEDIA_URL,
      bannerUrl: BANNER_MEDIA_URL,
    });

    const { result } = renderHook(() => useMarketplaceShopSettings());
    await waitFor(() => expect(result.current.hasShop).toBe(true));

    act(() => result.current.banner.remove());
    expect(result.current.banner.previewUrl).toBeNull();
    expect(result.current.banner.hasImage).toBe(false);

    await act(() => result.current.submit());

    expect(CommerceController.commitUpsertShop).toHaveBeenCalledWith(
      expect.objectContaining({ avatarUrl: AVATAR_MEDIA_URL, bannerUrl: undefined }),
    );
  });

  it('rejects non-image and oversized files without staging them', async () => {
    const { result } = renderHook(() => useMarketplaceShopSettings());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => result.current.avatar.onInputChange(changeEvent(new File(['x'], 'notes.txt', { type: 'text/plain' }))));
    expect(result.current.avatar.error).toBe('invalid-type');
    expect(result.current.avatar.hasImage).toBe(false);

    const oversized = imageFile('huge.png');
    Object.defineProperty(oversized, 'size', { value: IMAGE_MAX_RAW_SIZE + 1 });
    act(() => result.current.avatar.onInputChange(changeEvent(oversized)));
    expect(result.current.avatar.error).toBe('too-large');
    expect(result.current.avatar.hasImage).toBe(false);

    act(() => result.current.avatar.onInputChange(changeEvent(imageFile('ok.png'))));
    expect(result.current.avatar.error).toBeNull();
    expect(result.current.avatar.hasImage).toBe(true);
  });

  it('maps thrown sentinel image-upload failures to static copy', async () => {
    const { toast } = await import('@/molecules/Toaster/use-toast');
    const sentinel = 'SENTINEL_SERVER_TEXT_shop_settings';
    vi.mocked(CommerceController.commitCreateMedia).mockRejectedValue({
      name: 'AppError',
      code: 'INVALID_STATE',
      message: sentinel,
    });
    const errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(Logger, 'warn').mockImplementation(() => {});

    const { result } = renderHook(() => useMarketplaceShopSettings());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    act(() => {
      result.current.form.setValue('name', 'Satoshi Vintage');
      result.current.avatar.onInputChange(changeEvent(imageFile('avatar.png')));
    });

    const succeeded = await act(() => result.current.submit());

    expect(succeeded).toBe(false);
    expect(CommerceController.commitUpsertShop).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({
      variant: 'error',
      description: expect.stringContaining('Could not upload the shop avatar image'),
    });
    expect(JSON.stringify(vi.mocked(toast).mock.calls)).not.toContain(sentinel);
    expect(JSON.stringify([...errorSpy.mock.calls, ...warnSpy.mock.calls])).not.toContain(sentinel);
    expect(typeof vi.mocked(toast).mock.calls.at(-1)?.[0]?.description).toBe('string');
  });
});
