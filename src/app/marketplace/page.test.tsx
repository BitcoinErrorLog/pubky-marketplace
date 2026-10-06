import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_ROUTES } from '@/app/routes';
import { MARKETPLACE_STATIC_SEO } from '@/libs/commerce/seo';
import { createCommerceShopFixture, createNexusListingDetailsFixture } from '@/test/fixtures/commerce/commerce';
import MarketplacePage, { generateMetadata } from './page';

vi.mock('@synonymdev/pubky', () => ({
  Client: class {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      return globalThis.fetch(input, init);
    }
  },
  resolvePubky: (identifier: string) => identifier.replace('pubky://', 'https://_pubky.'),
}));

vi.mock('@/libs/runtime-config/runtime-config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/libs/runtime-config/runtime-config')>();
  return {
    ...actual,
    getCommerceAdapterMode: () => 'transaction-service',
  };
});

vi.mock('@/templates/Marketplace/Marketplace', () => ({
  Marketplace: ({
    initialListings,
    initialShops = [],
  }: {
    initialListings: Array<{ title: string }>;
    initialShops?: Array<{ name: string }>;
  }) => (
    <main>
      {initialListings.map((listing) => (
        <article key={listing.title}>
          {listing.title}
          {initialShops[0]?.name}
        </article>
      ))}
    </main>
  ),
}));

describe('marketplace catalog page', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits OG title and description consistent with listing fallback copy', () => {
    const metadata = generateMetadata();

    expect(metadata.title).toBe(MARKETPLACE_STATIC_SEO.title);
    expect(metadata.description).toBe(MARKETPLACE_STATIC_SEO.description);
    expect(metadata.openGraph?.url).toBe(APP_ROUTES.MARKETPLACE);
    expect(metadata.openGraph).not.toHaveProperty('images');
    expect(metadata.twitter).not.toHaveProperty('images');
  });

  it('keeps the Pubky resolver transport hostname shape', async () => {
    const { resolvePubky } = await import('@synonymdev/pubky');

    expect(resolvePubky('pubky://example-pubky/pub/pubky.app/shop.json')).toBe(
      'https://_pubky.example-pubky/pub/pubky.app/shop.json',
    );
  });

  it('server-renders listing cards from a fixture Nexus stream', async () => {
    const fixture = createNexusListingDetailsFixture();
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(JSON.stringify([fixture]), { status: 200, headers: { 'Content-Type': 'application/json' } }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(createCommerceShopFixture()), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

    render(await MarketplacePage());

    expect(screen.getByRole('article')).toHaveTextContent('Vintage leather boots');
    expect(screen.getByRole('article')).toHaveTextContent('Satoshi Vintage');
  });

  it('rejects a wrong-shaped listing stream instead of rendering fabricated cards', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ listings: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    render(await MarketplacePage());

    expect(screen.queryAllByRole('article')).toHaveLength(0);
  });
});
