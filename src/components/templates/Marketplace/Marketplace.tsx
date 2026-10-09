'use client';

import { useLayoutEffect, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { ArrowRight, Gavel, ShieldCheck, Store, X } from 'lucide-react';
import { MARKETPLACE_ROUTES } from '@/app/routes';
import { Button } from '@/atoms/Button/Button';
import { Card } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Input } from '@/atoms/Input/Input';
import { Typography } from '@/atoms/Typography/Typography';
import { isDurableCommerceMode } from '@/config/commerce';
import { buildFeatureDiscoveryDeviceStorageKey, MARKETPLACE_PROMO_STORAGE_ID } from '@/config/featureDiscovery';
import { SEARCH_CLOSED_STYLE } from '@/config/search';
import { useIsMobile } from '@/hooks/useIsMobile/useIsMobile';
import { useMarketplaceCatalog } from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog';
import type { MarketplaceCatalogItem } from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import { useMarketplaceDrops } from '@/hooks/useMarketplaceDrops/useMarketplaceDrops';
import { useMarketplacePromoDismissal } from '@/hooks/useMarketplacePromoDismissal/useMarketplacePromoDismissal';
import { useMarketplaceSellingAccess } from '@/hooks/useMarketplaceSellingAccess/useMarketplaceSellingAccess';
import { useMarketplaceWatchDetection } from '@/hooks/useMarketplaceWatchDetection/useMarketplaceWatchDetection';
import { useRequireAuth } from '@/hooks/useRequireAuth/useRequireAuth';
import type { CommerceShopRecord } from '@/libs/commerce/marketplace-records';
import { removeMarketplacePromoPrepaintStyle } from '@/libs/commerce/promo-prepaint';
import { cn } from '@/libs/utils/utils';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { DropCard } from '@/organisms/Marketplace/DropCard';
import { MarketplaceFilters } from '@/organisms/Marketplace/MarketplaceFilters';
import { MarketplaceListingCard } from '@/organisms/Marketplace/MarketplaceListingCard';
import { MarketplaceSavedSearches } from '@/organisms/Marketplace/MarketplaceSavedSearches';
import { MarketplaceSectionNav } from '@/organisms/Marketplace/MarketplaceSectionNav';
import { MarketplaceSessionConnectDialog } from '@/organisms/Marketplace/MarketplaceSessionConnectDialog';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import { MarketplaceSkeleton } from './Marketplace.skeleton';
import { DROPS_INDEX_CAVEAT } from './MarketplaceDrops';

const MARKETPLACE_PROMO_DEVICE_STORAGE_KEY = buildFeatureDiscoveryDeviceStorageKey(MARKETPLACE_PROMO_STORAGE_ID);

export function Marketplace({
  initialListings = [],
  initialShops = [],
}: {
  initialListings?: MarketplaceCatalogItem[];
  initialShops?: CommerceShopRecord[];
}) {
  const router = useRouter();
  const isMobile = useIsMobile({ breakpoint: 'sm' });
  const { requireAuth } = useRequireAuth();
  const sellingAccess = useMarketplaceSellingAccess();
  const [showSellingApproval, setShowSellingApproval] = useState(false);
  const query = useCommerceStore((state) => state.query);
  const setQuery = useCommerceStore((state) => state.setQuery);
  const saleFormat = useCommerceStore((state) => state.saleFormat);
  const categoryId = useCommerceStore((state) => state.categoryId);
  const countryCode = useCommerceStore((state) => state.countryCode);
  const drops = useMarketplaceDrops();
  // The drop index has no category or location fields: exclude unknown matches.
  const visibleDrops =
    (saleFormat === 'all' || saleFormat === 'drops') && !categoryId && !countryCode
      ? (['live', 'upcoming', 'ended'] as const).flatMap((bucket) =>
          drops.buckets[bucket]
            .filter((entry) =>
              `${entry.title} ${entry.description} ${entry.owner_id}`
                .toLowerCase()
                .includes(query.trim().toLowerCase()),
            )
            .map((entry) => ({ entry, bucket })),
        )
      : [];
  const sort = useCommerceStore((state) => state.sort);
  const layout = useCommerceStore((state) => state.layout);
  const catalog = useMarketplaceCatalog(initialListings, initialShops);
  const { shopsBySeller, adapterMode, listings, facetPool, countryFacetPool } = catalog;
  const listingCards = listings.map((listing) => ({ kind: 'listing' as const, listing }));
  const dropCards = uniqueDropCards(visibleDrops.map((drop) => ({ kind: 'drop' as const, ...drop })));
  const catalogListingCards = saleFormat === 'drops' ? [] : listingCards;
  const catalogCards: Array<(typeof listingCards)[number] | (typeof dropCards)[number]> = [];
  if (sort === 'recommended' && saleFormat === 'all') {
    const groups = [
      listingCards.filter(({ listing }) => listing.saleFormat === 'fixed_price'),
      listingCards.filter(({ listing }) => listing.saleFormat === 'auction'),
      dropCards,
    ];
    // Stable round-robin keeps each type visible and retains its existing rank.
    const longest = Math.max(...groups.map((group) => group.length));
    for (let index = 0; index < longest; index++) {
      for (const group of groups) {
        if (group[index]) catalogCards.push(group[index]);
      }
    }
  } else {
    catalogCards.push(...dropCards, ...catalogListingCards);
  }
  const resultCount = catalogListingCards.length + dropCards.length;
  const isLoading =
    (saleFormat !== 'drops' && catalog.isLoading && listings.length === 0) ||
    ((saleFormat === 'all' || saleFormat === 'drops') && drops.isLoading && resultCount === 0);
  const { showPromo, isResolved: isPromoDismissalResolved, dismissPromo } = useMarketplacePromoDismissal();
  const [promoStorageHydrated, setPromoStorageHydrated] = useState(false);
  const [isPromoDismissedOnDevice, setIsPromoDismissedOnDevice] = useState(false);
  const [isPromoDismissing, setIsPromoDismissing] = useState(false);
  // Visiting the marketplace (or refocusing its tab) runs the bounded
  // watchlist detection pass — the app has no background daemon.
  useMarketplaceWatchDetection();
  const shouldShowPromo = showPromo && promoStorageHydrated && !isPromoDismissedOnDevice;
  // Until both dismissal reads resolve, keep the server-rendered promo mounted:
  // mounting it later would push the catalog down after the first paint.
  const isPromoResolved = promoStorageHydrated && isPromoDismissalResolved;
  const renderPromo = shouldShowPromo || !isPromoResolved;

  useLayoutEffect(() => {
    try {
      setIsPromoDismissedOnDevice(window.localStorage.getItem(MARKETPLACE_PROMO_DEVICE_STORAGE_KEY) === 'dismissed');
    } catch {
      setIsPromoDismissedOnDevice(false);
    } finally {
      setPromoStorageHydrated(true);
    }
  }, []);

  useLayoutEffect(() => {
    if (isPromoResolved) removeMarketplacePromoPrepaintStyle();
  }, [isPromoResolved]);

  const dismissMarketplacePromo = () => {
    setIsPromoDismissing(true);
    window.setTimeout(() => {
      dismissPromo();
      setIsPromoDismissedOnDevice(true);
      try {
        window.localStorage.setItem(MARKETPLACE_PROMO_DEVICE_STORAGE_KEY, 'dismissed');
      } catch {
        // The in-memory state still hides the promo for this tab.
      }
    }, 180);
  };

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      hasGradientBackground={false}
      className="marketplace-surface pb-28 lg:pb-16"
      classNameWrapperContent="overflow-visible lg:overflow-visible"
    >
      <Container overrideDefaults className="flex w-full flex-col gap-6">
        <div className="sticky top-24 z-(--z-sticky-subnav) bg-background after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-16 after:bg-linear-to-b after:from-background/80 after:to-transparent after:content-[''] lg:top-(--header-offset-main)">
          <MarketplaceSectionNav className="mb-0" onNavigate={(href) => requireAuth(() => router.push(href))} />
        </div>
        {renderPromo && (
          <section
            data-marketplace-promo=""
            aria-label="Marketplace promo"
            className={cn(
              'marketplace-promo-enter relative overflow-hidden rounded-md bg-card p-6 sm:p-10',
              isPromoDismissing && 'marketplace-promo-exit',
            )}
          >
            <Button
              variant="ghost"
              size="icon"
              aria-label="Dismiss marketplace promo"
              onClick={dismissMarketplacePromo}
              className="absolute top-2 right-2 z-10 size-8 text-muted-foreground hover:text-foreground sm:top-3 sm:right-3 sm:size-10"
            >
              <X className="size-4" />
            </Button>
            <div className="flex flex-col items-start gap-6 sm:flex-row sm:items-center">
              <div className="w-full min-w-0 sm:w-auto sm:flex-1">
                <Heading
                  level={2}
                  size="xl"
                  className="relative pr-8 text-3xl leading-tight sm:text-4xl lg:pr-0 lg:text-5xl"
                >
                  <span className="text-white">Find something rare.</span>{' '}
                  <span className="text-brand">Trade freely.</span>
                </Heading>
                <div className="relative mt-6 hidden w-full gap-6 sm:grid sm:grid-cols-3">
                  {[
                    { icon: Gavel, label: 'Fair auctions', detail: 'Verified bids. Clear outcomes.' },
                    { icon: ShieldCheck, label: 'Signed by owner', detail: 'Listings remain tied to a pubky.' },
                    {
                      icon: ArrowRight,
                      label: 'Local first',
                      detail: 'Browser cached catalog records.',
                    },
                  ].map(({ icon: Icon, label, detail }) => (
                    <Card key={label} className="flex-row items-start gap-4 rounded-md bg-background p-6">
                      <div className="rounded-full bg-brand/15 p-2 text-brand">
                        <Icon className="size-5" />
                      </div>
                      <div>
                        <Typography as="h3" className="font-semibold">
                          {label}
                        </Typography>
                        <Typography as="p" className="mt-1 text-sm text-muted-foreground">
                          {detail}
                        </Typography>
                      </div>
                    </Card>
                  ))}
                </div>
              </div>
              <Image
                src="/images/marketplace/marketplace-icon.png"
                alt=""
                preload
                width={1280}
                height={1280}
                sizes="(min-width: 1024px) 152px, (min-width: 640px) 112px, 144px"
                className="h-auto w-36 shrink-0 self-center sm:w-28 sm:self-auto lg:w-38"
              />
            </div>
          </section>
        )}

        <section id="marketplace-catalog" className="flex scroll-mt-28 flex-col gap-6">
          <MarketplaceFilters
            resultCount={resultCount}
            facetPool={facetPool}
            countryFacetPool={countryFacetPool}
            searchControl={
              <div
                className="relative flex h-8 min-w-48 flex-1 items-center gap-1.5 rounded-full border border-border pl-3"
                style={SEARCH_CLOSED_STYLE}
              >
                <Input
                  aria-label="Filter marketplace"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={isMobile ? 'Search' : 'Filter items, styles, or sellers'}
                  className="h-auto min-w-0 flex-1 border-none bg-transparent p-0 text-xs font-medium text-foreground md:text-xs"
                />
                <span
                  className="shrink-0 text-xs font-medium whitespace-nowrap text-muted-foreground"
                  aria-live="polite"
                >
                  {resultCount.toLocaleString('en-US')} {resultCount === 1 ? 'item' : 'items'}
                </span>
                <MarketplaceSavedSearches />
              </div>
            }
            sellControl={
              <Button
                size="sm"
                className="ml-auto rounded-full text-xs font-bold"
                onClick={() =>
                  requireAuth(() => {
                    if (sellingAccess.checkAccess()) router.push(MARKETPLACE_ROUTES.SELL);
                    else setShowSellingApproval(true);
                  })
                }
              >
                <Store className="size-4" />
                Sell an item
              </Button>
            }
          />

          {adapterMode === 'unavailable' && (
            <div role="status" className="rounded-md border border-amber-500/30 bg-amber-500/10 p-4 text-amber-200">
              Marketplace transactions are unavailable in this deployment. Public browsing remains read-only.
            </div>
          )}

          {saleFormat === 'drops' && !drops.isLoading && (
            <Typography as="p" role="note" className="text-sm text-muted-foreground">
              {DROPS_INDEX_CAVEAT}
            </Typography>
          )}
          {saleFormat === 'drops' &&
            !drops.isLoading &&
            ((!isDurableCommerceMode(adapterMode) && adapterMode !== 'sandbox') || drops.error || !drops.isIndexed) && (
              <Typography as="p" role="status" className="text-sm text-muted-foreground">
                {!isDurableCommerceMode(adapterMode)
                  ? 'Drops are not available in this sandbox.'
                  : (drops.error ?? 'Drop discovery is not available on this deployment yet.')}
              </Typography>
            )}
          {isLoading ? (
            <MarketplaceSkeleton />
          ) : resultCount > 0 ? (
            <div
              className={cn(
                layout === 'grid' ? 'grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4' : 'grid grid-cols-1 gap-6',
              )}
            >
              {catalogCards.map((card, index) =>
                card.kind === 'drop' ? (
                  <DropCard
                    key={`drop:${card.entry.owner_id}:${card.entry.id}`}
                    entry={card.entry}
                    shopName={shopsBySeller.get(card.entry.owner_id)?.name}
                    bucket={card.bucket}
                    layout={layout}
                    index={index}
                  />
                ) : (
                  <MarketplaceListingCard
                    key={card.listing.id}
                    listing={card.listing}
                    shopName={shopsBySeller.get(card.listing.sellerId)?.name}
                    layout={layout}
                    index={index}
                  />
                ),
              )}
            </div>
          ) : (
            <div className="flex min-h-64 flex-col items-center justify-center rounded-md bg-card/40 p-6 text-center">
              <Store className="mb-4 size-10 text-muted-foreground" />
              <Heading level={2} size="md">
                No listings match
              </Heading>
              <Typography as="p" className="mt-2 text-muted-foreground">
                Try another search or clear the active filters.
              </Typography>
            </div>
          )}
        </section>
      </Container>
      {showSellingApproval && (
        <MarketplaceSessionConnectDialog
          intent="sell"
          open={showSellingApproval}
          onOpenChange={setShowSellingApproval}
          hideTrigger
          onConnected={() => {
            setShowSellingApproval(false);
            router.push(MARKETPLACE_ROUTES.SELL);
          }}
        />
      )}
    </ContentLayout>
  );
}

function uniqueDropCards<T extends { entry: { owner_id: string; id: string }; bucket: 'live' | 'upcoming' | 'ended' }>(
  cards: T[],
): T[] {
  const rank = { live: 0, upcoming: 1, ended: 2 } as const;
  const seen = new Set<string>();
  return [...cards]
    .sort((a, b) => rank[a.bucket] - rank[b.bucket])
    .filter((card) => {
      const key = `${card.entry.owner_id}:${card.entry.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
