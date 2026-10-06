import type { Metadata as NextMetadata } from 'next';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { Metadata } from '@/molecules/Metadata/Metadata';
import { MarketplaceDrops } from '@/templates/Marketplace/MarketplaceDrops';

const DROPS_SEO = {
  title: 'Drops — Pubky Marketplace',
  description:
    'Timed, limited releases with a server-enforced clock: no fake queues, no invented stock, portable numbered editions.',
};

export function generateMetadata(): NextMetadata {
  const { openGraph, twitter, alternates } = Metadata({
    title: DROPS_SEO.title,
    description: DROPS_SEO.description,
    url: MARKETPLACE_ROUTES.DROPS,
    omitImages: true,
  });
  return {
    title: DROPS_SEO.title,
    description: DROPS_SEO.description,
    openGraph,
    twitter,
    alternates,
  };
}

export default function MarketplaceDropsPage() {
  return <MarketplaceDrops />;
}
