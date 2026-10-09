'use client';

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, LayoutDashboard, Store, User, UserCheck, UserPlus } from 'lucide-react';
import { APP_ROUTES, getProfileRoute, MARKETPLACE_ROUTES, PROFILE_ROUTES } from '@/app/routes';
import { TagKind } from '@/application/tag/tag.types';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import { getSocialHostUrl } from '@/config/social';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useCommerceShopFollow } from '@/hooks/useCommerceShopFollow/useCommerceShopFollow';
import {
  buildMarketplaceCatalogItems,
  type MarketplaceCatalogItem,
} from '@/hooks/useMarketplaceCatalog/useMarketplaceCatalog.utils';
import { useMarketplaceMediaUrl } from '@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { MarketplaceCommunityTags } from '@/organisms/Marketplace/MarketplaceCommunityTags';
import { MarketplaceListingCard } from '@/organisms/Marketplace/MarketplaceListingCard';
import { MarketplaceReputationHeader } from '@/organisms/Marketplace/MarketplaceReputationHeader';
import { MarketplaceReviewsSection } from '@/organisms/Marketplace/MarketplaceReviewsSection';
import { ShopProfileCard } from '@/organisms/Marketplace/ShopProfileCard/ShopProfileCard';
import { useAuthStore } from '@/stores/auth/auth.store';
import { MarketplaceSkeleton } from './Marketplace.skeleton';

export function MarketplaceShop({ sellerPubky }: { sellerPubky: string }) {
  const follow = useCommerceShopFollow(sellerPubky);
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const isOwner = currentUserPubky === sellerPubky;
  const profileRoute = getProfileRoute(PROFILE_ROUTES.PROFILE, sellerPubky);
  // With social link-out on, profiles live on the social host; plain <a>, same tab.
  const socialProfileUrl = getSocialHostUrl(profileRoute);
  // The shop record lives on the seller's homeserver; a visitor's local cache
  // may not hold it yet, so resolve network-first and only then treat a
  // missing record as "this seller has no shop".
  const [shopFetchSettled, setShopFetchSettled] = useState(false);

  useEffect(() => {
    let active = true;
    setShopFetchSettled(false);
    CommerceController.getOrFetchShop(sellerPubky)
      .catch(() => undefined)
      .finally(() => {
        if (active) setShopFetchSettled(true);
      });
    // Best-effort: hydrate this seller's listings from the Nexus index so a
    // direct shop visit is not limited to what this device already cached.
    void CommerceController.fetchSellerCatalogListings(sellerPubky).catch(() => undefined);
    return () => {
      active = false;
    };
  }, [sellerPubky]);

  const shop = useLiveQuery(() => CommerceController.getShop(sellerPubky), [sellerPubky]);
  // Same two catalog sources as the home grid: hydrated canonical records
  // plus Nexus index projections discovered for this seller.
  const sellerListings = useLiveQuery(() => CommerceController.getListingsBySeller(sellerPubky), [sellerPubky]);
  const sellerEntries = useLiveQuery(() => CommerceController.getCatalogEntriesBySeller(sellerPubky), [sellerPubky]);
  const listings =
    sellerListings === undefined || sellerEntries === undefined
      ? undefined
      : buildMarketplaceCatalogItems(sellerListings, sellerEntries);

  const isLoading = listings === undefined || shop === undefined || (!shop && !shopFetchSettled);

  // A media URI that resolves but whose bytes 404 (e.g. a seller on another
  // homeserver) must not leave a broken image; fall back like the cards do.
  const bannerUrl = useMarketplaceMediaUrl(shop?.record.bannerUrl);
  const avatarUrl = useMarketplaceMediaUrl(shop?.record.avatarUrl);

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      className="pb-28 lg:pb-16"
    >
      <Container overrideDefaults className="flex w-full flex-col gap-6">
        <Link
          href={APP_ROUTES.MARKETPLACE}
          overrideDefaults
          className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Marketplace
        </Link>

        {isLoading ? (
          <MarketplaceSkeleton count={4} />
        ) : shop ? (
          <>
            <ShopProfileCard
              variant="full"
              name={shop.record.name}
              bio={shop.record.bio}
              avatarUrl={avatarUrl}
              bannerUrl={bannerUrl}
              location={shop.record.location}
              vacation={shop.record.vacationMode}
              bannerAlt={`${shop.record.name} banner`}
              avatarAlt={`${shop.record.name} avatar`}
              locationExtras={
                <MarketplaceCommunityTags target={{ kind: TagKind.SHOP, ownerPubky: sellerPubky }} variant="inline" />
              }
              afterLocation={<MarketplaceReputationHeader sellerPubky={sellerPubky} variant="full" className="mt-3" />}
              aside={
                <div className="flex flex-col items-start gap-4 sm:items-end">
                  <div className="flex flex-wrap gap-2">
                    {isOwner ? (
                      <StorefrontOwnerActions />
                    ) : (
                      <Button
                        variant={follow.isFollowing ? 'default' : 'secondary'}
                        className="rounded-full"
                        aria-pressed={follow.isFollowing}
                        disabled={follow.isMutating}
                        onClick={follow.toggle}
                      >
                        {follow.isFollowing ? <UserCheck className="size-4" /> : <UserPlus className="size-4" />}
                        {follow.isFollowing ? 'Following' : 'Follow shop'}
                      </Button>
                    )}
                    <Button asChild variant="secondary" className="rounded-full">
                      {socialProfileUrl ? (
                        <a href={socialProfileUrl} data-cy="profile-on-pubky-link">
                          <User className="size-4" />
                          {isOwner ? 'My profile on Pubky' : 'Profile on Pubky'}
                        </a>
                      ) : (
                        <Link href={profileRoute} overrideDefaults>
                          <User className="size-4" />
                          {isOwner ? 'My profile' : 'Contact seller'}
                        </Link>
                      )}
                    </Button>
                  </div>
                  <div className="flex gap-6 text-sm">
                    <div>
                      <Typography as="p" className="text-2xl font-bold">
                        {listings.length}
                      </Typography>
                      <Typography as="p" className="text-muted-foreground">
                        Listings
                      </Typography>
                    </div>
                    <div>
                      <Typography as="p" className="text-2xl font-bold">
                        Yes
                      </Typography>
                      <Typography as="p" className="text-muted-foreground">
                        Owner-signed
                      </Typography>
                    </div>
                  </div>
                </div>
              }
            />

            <ShopListingsGrid listings={listings} shopName={shop.record.name} isOwner={isOwner} />

            {/* The section styles its own container and renders NOTHING when no
                review index serves this deployment — no empty card shell. */}
            <MarketplaceReviewsSection sellerPubky={sellerPubky} className="rounded-md bg-card p-5" />
          </>
        ) : (
          <>
            <Card className="overflow-hidden rounded-md p-0">
              <div className="h-28 bg-linear-to-br from-brand/24 to-brand/8 sm:h-40" />
              <CardContent className="flex flex-col gap-4 p-6 sm:flex-row sm:items-end sm:justify-between">
                <div className="-mt-16">
                  <div className="mb-4 flex size-20 items-center justify-center rounded-2xl border-4 border-card bg-brand text-primary-foreground shadow-lg">
                    <Store className="size-9" aria-hidden="true" />
                  </div>
                  <Heading level={1} size="xl" className="text-3xl break-all sm:text-5xl">
                    {sellerPubky.slice(0, 10)}…
                  </Heading>
                  <Typography as="p" className="mt-2 max-w-2xl text-muted-foreground">
                    {isOwner
                      ? 'Add a shop name, description, and images to personalize your storefront.'
                      : 'This seller hasn\u2019t set up a shop profile yet. Their owner-signed listings are below.'}
                  </Typography>
                  <MarketplaceReputationHeader sellerPubky={sellerPubky} variant="full" className="mt-3" />
                </div>
                <div className="flex flex-wrap gap-2">
                  {isOwner ? (
                    <StorefrontOwnerActions />
                  ) : (
                    <Button asChild variant="secondary" className="rounded-full">
                      {socialProfileUrl ? (
                        <a href={socialProfileUrl} data-cy="profile-on-pubky-link">
                          <User className="size-4" />
                          Profile on Pubky
                        </a>
                      ) : (
                        <Link href={profileRoute} overrideDefaults>
                          <User className="size-4" />
                          View seller profile
                        </Link>
                      )}
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>

            <ShopListingsGrid listings={listings} isOwner={isOwner} />

            <MarketplaceReviewsSection sellerPubky={sellerPubky} className="rounded-md bg-card p-5" />
          </>
        )}
      </Container>
    </ContentLayout>
  );
}

function ShopListingsGrid({
  listings,
  shopName,
  isOwner,
}: {
  listings: MarketplaceCatalogItem[];
  shopName?: string;
  isOwner: boolean;
}) {
  if (listings.length === 0) {
    return (
      <div className="flex min-h-64 flex-col items-center justify-center rounded-md bg-card/40 p-6 text-center">
        <Store className="mb-4 size-10 text-muted-foreground" />
        <Heading level={2} size="md">
          {isOwner ? 'No listings yet' : 'No listings from this seller yet'}
        </Heading>
        <Typography as="p" className="mt-2 text-muted-foreground">
          {isOwner ? 'Publish your first item to fill this page.' : 'Check back later or browse the marketplace.'}
        </Typography>
        <Button asChild className="mt-6 rounded-full">
          <Link href={isOwner ? MARKETPLACE_ROUTES.SELL : APP_ROUTES.MARKETPLACE} overrideDefaults>
            {isOwner ? 'Sell an item' : 'Browse the marketplace'}
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 lg:gap-5">
      {listings.map((listing) => (
        <MarketplaceListingCard key={listing.id} listing={listing} shopName={shopName} />
      ))}
    </div>
  );
}

function StorefrontOwnerActions() {
  return (
    <>
      <Button asChild variant="secondary" className="rounded-full">
        <Link href={MARKETPLACE_ROUTES.MY_SHOP} overrideDefaults>
          <Store className="size-4" aria-hidden="true" />
          Edit storefront
        </Link>
      </Button>
      <Button asChild variant="secondary" className="rounded-full">
        <Link href={MARKETPLACE_ROUTES.DASHBOARD} overrideDefaults>
          <LayoutDashboard className="size-4" aria-hidden="true" />
          Manage shop
        </Link>
      </Button>
    </>
  );
}
