import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateMetadata } from './page';

const { fetchListingMock } = vi.hoisted(() => ({
  fetchListingMock: vi.fn(),
}));

vi.mock('@/libs/og/ogCommerceData', () => ({
  fetchListingForMetadata: fetchListingMock,
}));

vi.mock('@/molecules/Metadata/Metadata', () => ({
  Metadata: ({ title }: { title: string }) => ({
    openGraph: { title },
    twitter: { title },
    alternates: {},
  }),
}));

vi.mock('@/templates/Marketplace/MarketplaceListing', () => ({
  MarketplaceListing: () => null,
}));

describe('marketplace listing metadata', () => {
  beforeEach(() => {
    fetchListingMock.mockReset();
  });

  it('keeps the generic metadata fallback when seller metadata is unavailable', async () => {
    fetchListingMock.mockResolvedValue({ kind: 'unavailable', reason: 'timeout' });

    await expect(
      generateMetadata({
        params: Promise.resolve({
          sellerPubky: '8mmmaouyode95qf7scbt4moytceiga4we5i3fwra71xapmwguwdy',
          listingId: 'aa540efdabb144c0babc304c5d19f1d3',
        }),
      }),
    ).resolves.toMatchObject({ title: 'Pubky Marketplace' });
  });
});
