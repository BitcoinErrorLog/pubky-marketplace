import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getNexusUrl } from '@/config/nexus';
import { queryNexus } from '@/services/nexus/nexus.utils';
import { createNexusListingDetailsFixture } from '@/test/fixtures/commerce/commerce';
import { NexusMarketplaceService } from './marketplace';
import { marketplaceApi } from './marketplace.api';

vi.mock('@/services/nexus/nexus.utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/nexus/nexus.utils')>();
  return {
    ...actual,
    queryNexus: vi.fn(),
  };
});

// Overridable stand-in for PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL: unset (null)
// keeps the real accessor's fallback-to-nexusUrl behavior, which is what the
// pre-existing URL assertions below rely on.
const nexusConfigOverride = vi.hoisted(() => ({ marketplaceNexusUrl: null as string | null }));

vi.mock('@/config/nexus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config/nexus')>();
  return {
    ...actual,
    getMarketplaceNexusUrl: () => nexusConfigOverride.marketplaceNexusUrl ?? actual.getMarketplaceNexusUrl(),
  };
});

const mockQueryNexus = vi.mocked(queryNexus);

describe('Marketplace API', () => {
  afterEach(() => {
    nexusConfigOverride.marketplaceNexusUrl = null;
  });

  it('builds the bare listing stream URL when no filters are set', () => {
    expect(marketplaceApi.listingStream({})).toBe(`${getNexusUrl()}/v0/stream/listings`);
  });

  it('routes listing stream URLs through the marketplace Nexus override when one is configured', () => {
    nexusConfigOverride.marketplaceNexusUrl = 'https://marketplace-nexus.example.com';

    const url = marketplaceApi.listingStream({ state: 'active' });

    expect(url).toBe('https://marketplace-nexus.example.com/v0/stream/listings?state=active');
    expect(url).not.toContain(getNexusUrl());
  });

  it('serializes server-side filters and pagination as query parameters', () => {
    const url = marketplaceApi.listingStream({
      state: 'active',
      sale_format: 'auction',
      condition: 'like_new',
      skip: 30,
      limit: 30,
    });

    expect(url).toBe(
      `${getNexusUrl()}/v0/stream/listings?state=active&sale_format=auction&condition=like_new&skip=30&limit=30`,
    );
  });

  it('serializes the auction end-time sorting as query parameters', () => {
    const url = marketplaceApi.listingStream({
      state: 'active',
      sorting: 'ends_at',
      order: 'ascending',
    });

    expect(url).toBe(`${getNexusUrl()}/v0/stream/listings?state=active&sorting=ends_at&order=ascending`);
  });

  it('omits undefined and null filters from the query string', () => {
    const url = marketplaceApi.listingStream({
      state: 'active',
      sale_format: undefined,
      condition: undefined,
    });

    expect(url).toBe(`${getNexusUrl()}/v0/stream/listings?state=active`);
    expect(url).not.toContain('sale_format=');
    expect(url).not.toContain('condition=');
  });
});

describe('NexusMarketplaceService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fetches the listing stream and returns the response unchanged', async () => {
    const listings = [createNexusListingDetailsFixture()];
    mockQueryNexus.mockResolvedValue(listings);

    await expect(NexusMarketplaceService.fetchListingStream({ state: 'active', limit: 30 })).resolves.toEqual(listings);
    expect(mockQueryNexus).toHaveBeenCalledWith({
      url: `${getNexusUrl()}/v0/stream/listings?state=active&limit=30`,
    });
  });

  it('propagates Nexus errors to the caller', async () => {
    mockQueryNexus.mockRejectedValue(new Error('nexus unreachable'));

    await expect(NexusMarketplaceService.fetchListingStream()).rejects.toThrow('nexus unreachable');
  });
});
