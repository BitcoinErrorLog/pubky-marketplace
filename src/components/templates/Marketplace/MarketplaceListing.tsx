'use client';

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  ArrowLeft,
  Bell,
  ChevronDown,
  Hash,
  Heart,
  MapPin,
  Package,
  PlaneTakeoff,
  ShieldCheck,
  ShoppingCart,
  Store,
} from 'lucide-react';
import { APP_ROUTES, getMarketplaceShopRoute, MARKETPLACE_ROUTES } from '@/app/routes';
import { TagKind } from '@/application/tag/tag.types';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/atoms/Select/Select';
import { Typography } from '@/atoms/Typography/Typography';
import { getCommerceAdapterMode, isDurableCommerceMode, isTransactionalCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useCommerceFavorite } from '@/hooks/useCommerceFavorite/useCommerceFavorite';
import { useMarketplaceCart } from '@/hooks/useMarketplaceCart/useMarketplaceCart';
import { useMarketplaceMediaUrl } from '@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl';
import { useMarketplaceOffers } from '@/hooks/useMarketplaceOffers/useMarketplaceOffers';
import { useMarketplaceOrders } from '@/hooks/useMarketplaceOrders/useMarketplaceOrders';
import { useMarketplaceProjection } from '@/hooks/useMarketplaceProjection/useMarketplaceProjection';
import { useSellerReputation } from '@/hooks/useMarketplaceReviews/useMarketplaceReviews';
import { useMeasurementSystem } from '@/hooks/useMeasurementSystem/useMeasurementSystem';
import { useRequireAuth } from '@/hooks/useRequireAuth/useRequireAuth';
import { getAuctionPhase } from '@/libs/commerce/auction-phase';
import {
  CHECKOUT_HOLD_COPY,
  findViewerAcceptedOfferHold,
  findViewerPendingHoldOrder,
} from '@/libs/commerce/checkout-hold';
import { getMarketplaceCheckoutRoute, getMarketplaceOfferCheckoutRoute } from '@/libs/commerce/checkout-phase';
import { DIGITAL_DELIVERY_COPY, digitalDeliveryBadgeLabel } from '@/libs/commerce/digital';
import { MARKETPLACE_FAILURE_MESSAGES } from '@/libs/commerce/failure-messages';
import { formatCommerceCondition, formatCommerceMoney } from '@/libs/commerce/format';
import {
  commerceListingFulfillmentMethods,
  type CommerceListingRecord,
  commerceListingTakesOffers,
  type CommerceShippingOption,
} from '@/libs/commerce/marketplace-records';
import type { MarketplaceFulfillmentMethod } from '@/libs/commerce/pickup';
import { buildMarketplaceListingAggregateId } from '@/libs/commerce/transaction-commands';
import { formatPackageDimensions, formatWeight } from '@/libs/commerce/units';
import { formatStockQuantity, UNLIMITED_STOCK_LABEL } from '@/libs/commerce/unlimited-stock';
import { MarketplaceFulfillmentBadge } from '@/molecules/MarketplaceFulfillmentBadge/MarketplaceFulfillmentBadge';
import { MarketplaceSellerIdentity } from '@/molecules/MarketplaceSellerIdentity/MarketplaceSellerIdentity';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { MarketplaceAuctionPanel } from '@/organisms/Marketplace/MarketplaceAuctionPanel';
import { MarketplaceBidDialog } from '@/organisms/Marketplace/MarketplaceBidDialog';
import { MarketplaceCommunityTags } from '@/organisms/Marketplace/MarketplaceCommunityTags';
import { MarketplaceDigitalDeliveryNotice } from '@/organisms/Marketplace/MarketplaceDigitalDeliveryNotice';
import { MarketplaceIndicativePrice } from '@/organisms/Marketplace/MarketplaceIndicativePrice';
import { MarketplaceListingOwnerPanel } from '@/organisms/Marketplace/MarketplaceListingOwnerPanel';
import { MarketplaceListingSavePicker } from '@/organisms/Marketplace/MarketplaceListingSavePicker';
import { MarketplaceListingSpecifics } from '@/organisms/Marketplace/MarketplaceListingSpecifics';
import { MarketplaceMediaGallery } from '@/organisms/Marketplace/MarketplaceMediaGallery';
import { MarketplaceMessageDialog } from '@/organisms/Marketplace/MarketplaceMessageDialog';
import { MarketplaceOfferDialog } from '@/organisms/Marketplace/MarketplaceOfferDialog';
import { MarketplaceReviewsSection } from '@/organisms/Marketplace/MarketplaceReviewsSection';
import { MarketplaceSectionNav } from '@/organisms/Marketplace/MarketplaceSectionNav';
import { MarketplaceSessionConnectDialog } from '@/organisms/Marketplace/MarketplaceSessionConnectDialog';
import { MarketplaceSimilarItems } from '@/organisms/Marketplace/MarketplaceSimilarItems';
import { MarketplaceSessionService } from '@/services/marketplace/marketplace-session';
import { useAuthStore } from '@/stores/auth/auth.store';
import { MarketplaceListingDetailSkeleton } from './Marketplace.skeleton';

export interface MarketplaceListingProps {
  sellerPubky: string;
  listingId: string;
}

export function MarketplaceListing({ sellerPubky, listingId }: MarketplaceListingProps) {
  const [error, setError] = useState<string | null>(null);
  // Local cache answers `null` instantly for a listing this device has never
  // seen, while the network fetch is still in flight — without tracking the
  // fetch, the page flashes "Listing unavailable" before the record lands.
  const [isFetchSettled, setIsFetchSettled] = useState(false);
  const [selectedVariantId, setSelectedVariantId] = useState('');
  const [showSessionRequired, setShowSessionRequired] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const adapterMode = getCommerceAdapterMode();
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const { requireAuth } = useRequireAuth();
  const isOwner = currentUserPubky === sellerPubky;
  const favorite = useCommerceFavorite(`${sellerPubky}:${listingId}`);
  const negotiation = useMarketplaceProjection(sellerPubky, listingId);
  const sellerReputation = useSellerReputation(sellerPubky);
  const cart = useMarketplaceCart();
  const orders = useMarketplaceOrders();
  const offers = useMarketplaceOffers();
  const sessionPubky = MarketplaceSessionService.getActiveSession()?.pubky ?? null;
  const measurementSystem = useMeasurementSystem();
  const aggregateId = buildMarketplaceListingAggregateId(sellerPubky, listingId);

  useEffect(() => {
    if (adapterMode === 'sandbox') {
      setIsFetchSettled(true);
      return;
    }
    let active = true;
    setIsFetchSettled(false);
    CommerceController.getOrFetchListing(sellerPubky, listingId)
      .catch(async (fetchError: unknown) => {
        let confirmedRemoved = false;
        try {
          confirmedRemoved = await CommerceController.isListingConfirmedRemoved(sellerPubky, listingId, fetchError);
        } catch {
          confirmedRemoved = false;
        }
        if (active) {
          setError(
            confirmedRemoved ? MARKETPLACE_FAILURE_MESSAGES.listingRemoved : 'This listing could not be loaded.',
          );
        }
      })
      .finally(() => {
        if (active) setIsFetchSettled(true);
      });
    return () => {
      active = false;
    };
  }, [adapterMode, listingId, sellerPubky]);

  const listing = useLiveQuery(() => CommerceController.getListing(sellerPubky, listingId), [sellerPubky, listingId]);
  const shop = useLiveQuery(() => CommerceController.getShop(sellerPubky), [sellerPubky]);
  const auctionEndsAt =
    listing?.record.sale.format === 'auction'
      ? (negotiation.projection?.auction?.endsAt ?? listing.record.sale.endsAt)
      : null;
  const auctionStatus = negotiation.projection?.auction?.status;
  const auctionPhase =
    listing?.record.sale.format === 'auction'
      ? getAuctionPhase(listing.record.sale.startsAt, auctionEndsAt ?? listing.record.sale.endsAt, nowMs, auctionStatus)
      : null;
  const shopAvatarUrl = useMarketplaceMediaUrl(shop?.record.avatarUrl);

  useEffect(() => {
    const firstVariant = listing?.record.variants[0]?.id;
    if (firstVariant && !listing?.record.variants.some(({ id }) => id === selectedVariantId)) {
      setSelectedVariantId(firstVariant);
    }
  }, [listing, selectedVariantId]);

  useEffect(() => {
    if (!negotiation.needsSession) setShowSessionRequired(false);
  }, [negotiation.needsSession]);

  useEffect(() => {
    if (!auctionEndsAt) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [auctionEndsAt]);

  if (listing === undefined || shop === undefined || (!listing && !isFetchSettled && !error)) {
    return (
      <ContentLayout
        className="marketplace-surface font-medium"
        showLeftSidebar={false}
        showRightSidebar={false}
        showLeftMobileButton={false}
        showRightMobileButton={false}
      >
        <Container overrideDefaults className="w-full">
          <MarketplaceListingDetailSkeleton />
        </Container>
      </ContentLayout>
    );
  }

  if (!listing || error) {
    return (
      <ContentLayout
        className="marketplace-surface font-medium"
        showLeftSidebar={false}
        showRightSidebar={false}
        showLeftMobileButton={false}
        showRightMobileButton={false}
      >
        <Container className="min-h-96 items-center justify-center px-6 text-center">
          <Store className="mb-4 size-12 text-muted-foreground" />
          <Heading level={1} size="lg">
            Listing unavailable
          </Heading>
          <Typography as="p" className="mt-2 text-muted-foreground">
            {negotiation.listingRemoved
              ? MARKETPLACE_FAILURE_MESSAGES.listingRemoved
              : (error ?? 'This listing is no longer in the local marketplace catalog.')}
          </Typography>
          <Button asChild className="mt-6 rounded-full">
            <Link href={APP_ROUTES.MARKETPLACE} overrideDefaults>
              Back to marketplace
            </Link>
          </Button>
        </Container>
      </ContentLayout>
    );
  }

  const record = listing.record;
  const selectedVariant = record.variants.find(({ id }) => id === selectedVariantId) ?? record.variants[0];
  const price = record.sale.format === 'fixed_price' ? record.sale.unitPrice : record.sale.startingPrice;
  const displayPrice = negotiation.projection?.auction?.currentPrice ?? price;
  // The methods the service sells this listing by (digital delivery design
  // §6 A1–A3). A Locks listing keeps its own digital notice and derives to
  // shipping, so it is kept apart here exactly as before.
  const isLocksListing = record.digitalLock !== undefined;
  const methods = commerceListingFulfillmentMethods(record.fulfillmentMethods, isLocksListing);
  const offersDigital = methods.includes('digital');
  const shipsItem = !isLocksListing && methods.includes('shipping');
  // Offers settle through shipping or pickup (§6 B7, B8): a digital listing
  // with neither takes no offers.
  const offersPhysical = shipsItem || (!isLocksListing && methods.includes('pickup'));
  const offersDigitalOnly = offersDigital && !offersPhysical;
  const shippingCopy = formatListingShipping(record, methods);
  const hasFreeShipping = shippingCopy === 'Shipping: free';
  const flatShipping = shipsItem ? record.shippingOptions.find((option) => option.pricing === 'flat') : undefined;
  const shippingBadge =
    hasFreeShipping || flatShipping?.price.amountMinor === 0
      ? 'Shipping: Free'
      : flatShipping
        ? `Shipping: ${formatCommerceMoney(flatShipping.price)}`
        : null;
  const sellerDisplayName = shop?.record.name ?? `${sellerPubky.slice(0, 10)}…`;
  const recordQuantity = record.variants.reduce(
    (total, variant) => total + (variant.enabled ? variant.quantity : 0),
    0,
  );
  const isDurable = isDurableCommerceMode(adapterMode);
  const projectionIsReserved = isDurable && negotiation.projection?.state === 'reserved';
  const viewerHoldOrder = projectionIsReserved
    ? findViewerPendingHoldOrder(orders.orders, aggregateId, currentUserPubky)
    : null;
  const viewerOfferHold =
    projectionIsReserved && !viewerHoldOrder
      ? findViewerAcceptedOfferHold(offers.offers, aggregateId, sessionPubky)
      : null;
  const projectionIsSoldOut =
    negotiation.projection !== null &&
    (negotiation.projection.state === 'sold' ||
      (negotiation.projection.state === 'available' && negotiation.projection.availableQuantity === 0));
  const isSoldOut = isDurable ? projectionIsSoldOut : (listing.purchasableQuantity ?? recordQuantity) <= 0;
  const isPurchasable = record.state === 'active';
  const availabilityPending = isDurable && negotiation.isLoading;
  const availabilityNeedsSession = isDurable && negotiation.needsSession;
  const availabilityReady =
    !isDurable || (!availabilityPending && !availabilityNeedsSession && negotiation.projection !== null);
  const stateNotice =
    record.state === 'paused'
      ? 'The seller has unlisted this item. It cannot be purchased right now.'
      : record.state === 'ended'
        ? 'This listing has ended.'
        : record.state === 'removed'
          ? 'This listing was removed.'
          : null;
  const revealSessionRequired = () => setShowSessionRequired(true);
  const beginPurchaseAuth = () => {
    requireAuth(revealSessionRequired);
  };
  const onSessionConnected = () => {
    setShowSessionRequired(false);
    void negotiation.refresh();
  };
  const addSelectedVariantToCart = () => {
    if (!selectedVariant) return;
    if (isOwner) return;
    void cart.add(`${record.ownerPubky}:${record.listingId}`, selectedVariant.id, 1);
  };

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      hasGradientBackground={false}
      className="marketplace-surface pb-28 font-medium lg:pb-16"
      classNameWrapperContent="overflow-visible lg:overflow-visible"
    >
      <Container overrideDefaults className="flex w-full flex-col gap-6">
        <div className="sticky top-24 z-(--z-sticky-subnav) bg-background after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-16 after:bg-linear-to-b after:from-background/80 after:to-transparent after:content-[''] lg:top-(--header-offset-main)">
          <MarketplaceSectionNav className="mb-0" />
        </div>
        <div className="flex w-full items-center justify-between gap-2">
          <Link
            href={APP_ROUTES.MARKETPLACE}
            overrideDefaults
            className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            Back to results
          </Link>
          {cart.itemCount > 0 && (
            <Link
              href={MARKETPLACE_ROUTES.CART}
              overrideDefaults
              data-cy="marketplace-listing-cart-link"
              className="inline-flex items-center gap-2 rounded-full border border-border/60 px-3 py-1.5 text-sm text-foreground transition-colors hover:border-brand/40 hover:text-brand"
            >
              <ShoppingCart className="size-4" />
              Cart
              <Badge variant="secondary" className="px-1.5">
                {cart.itemCount}
              </Badge>
            </Link>
          )}
        </div>

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)] lg:grid-rows-[auto_1fr]">
          <MarketplaceMediaGallery
            media={record.media}
            categoryId={record.categoryId}
            saleFormat={record.sale.format}
            auctionPhase={auctionPhase ?? undefined}
          />

          <div className="flex min-w-0 flex-col gap-5 lg:col-start-2 lg:row-span-2 lg:row-start-1">
            {isOwner && (
              <MarketplaceListingOwnerPanel record={record} registrationStatus={listing.registration_status} />
            )}
            {stateNotice && (
              <div
                role="status"
                className="rounded-md border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-200"
              >
                {stateNotice}
              </div>
            )}
            <div>
              <div className="mb-3 flex flex-wrap gap-2">
                <Badge variant="secondary">{formatCommerceCondition(record.condition)}</Badge>
                {shippingBadge ? (
                  <>
                    <Badge variant="secondary">{shippingBadge}</Badge>
                    {methods.includes('pickup') && <MarketplaceFulfillmentBadge methods={['pickup']} />}
                  </>
                ) : (
                  !offersDigital && <MarketplaceFulfillmentBadge methods={methods} />
                )}
                {offersDigital && (
                  <Badge variant="secondary" data-testid="marketplace-listing-digital-badge">
                    {digitalDeliveryBadgeLabel(negotiation.projection?.digitalDelivery ?? null)}
                  </Badge>
                )}
                {isSoldOut && record.sale.format === 'fixed_price' && <Badge variant="outline">Sold out</Badge>}
                {shop?.record.vacationMode && (
                  <Badge variant="outline" className="border-amber-500/50 bg-amber-500/10 text-amber-300">
                    <PlaneTakeoff className="mr-1 size-3" />
                    Seller on vacation
                  </Badge>
                )}
                {adapterMode === 'sandbox' && <Badge variant="outline">Sandbox · no real funds</Badge>}
              </div>
              <Heading level={1} size="xl" className="text-3xl leading-none sm:text-5xl sm:leading-none">
                {record.title}
              </Heading>
              <Typography as="p" className="mt-1 text-3xl font-bold text-brand">
                {record.sale.format === 'auction'
                  ? negotiation.projection?.auction?.bidCount
                    ? auctionStatus === 'sold'
                      ? 'Final bid '
                      : 'Current bid '
                    : 'Starting bid '
                  : ''}
                {formatCommerceMoney(displayPrice)}
              </Typography>
              <MarketplaceIndicativePrice
                money={displayPrice}
                className="text-base font-medium text-muted-foreground"
              />
              {!shippingBadge && (
                <Typography as="p" className="mt-1 text-sm text-muted-foreground">
                  {shippingCopy}
                </Typography>
              )}
              {negotiation.projection?.auction && (
                <Typography as="p" className="mt-1 text-sm text-muted-foreground">
                  {negotiation.projection.auction.bidCount}{' '}
                  {negotiation.projection.auction.bidCount === 1 ? 'bid' : 'bids'}
                </Typography>
              )}
            </div>

            {record.variants.length > 1 && (
              <div>
                <Typography as="p" className="mb-2 text-sm font-semibold">
                  Variant
                </Typography>
                <Select value={selectedVariant?.id} onValueChange={setSelectedVariantId}>
                  <SelectTrigger theme="secondary" className="w-full" aria-label="Choose listing variant">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {record.variants.map((variant) => {
                      const stock = formatStockQuantity(record, variant.quantity);
                      return (
                        <SelectItem
                          key={variant.id}
                          value={variant.id}
                          disabled={!variant.enabled || variant.quantity === 0}
                        >
                          {Object.values(variant.options).join(' · ') || variant.sku || 'Default'} ·{' '}
                          {stock === UNLIMITED_STOCK_LABEL ? stock : `${stock} left`}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              </div>
            )}

            {record.digitalLock && <MarketplaceDigitalDeliveryNotice adapterMode={adapterMode} />}

            {record.sale.format === 'auction' && (
              <MarketplaceAuctionPanel
                sellerPubky={sellerPubky}
                listingId={listingId}
                auction={negotiation.projection?.auction ?? null}
                scheduledEndsAt={record.sale.endsAt ?? null}
                isSignedIn={Boolean(currentUserPubky)}
                auctionPhase={auctionPhase ?? undefined}
              />
            )}

            <div className="flex flex-wrap items-center gap-2" data-surface="marketplace-listing-purchase">
              {record.sale.format === 'auction' ? (
                <div className="[&_[data-slot=button]]:border-brand [&_[data-slot=button]]:bg-brand [&_[data-slot=button]]:text-background [&_[data-slot=button]:hover]:bg-brand/90">
                  <MarketplaceBidDialog
                    aggregateId={aggregateId}
                    projection={negotiation.projection}
                    priceAsset={price}
                    isOwner={isOwner}
                    isSessionRequired={negotiation.needsSession}
                    onSessionRequired={revealSessionRequired}
                    onAccepted={negotiation.refresh}
                    auctionPhase={auctionPhase ?? undefined}
                  />
                </div>
              ) : (
                <>
                  {viewerHoldOrder ? (
                    <Button asChild size="default" className="w-fit rounded-full">
                      <Link
                        href={getMarketplaceCheckoutRoute(viewerHoldOrder.orderId)}
                        overrideDefaults
                        data-cy="marketplace-listing-held-for-you"
                      >
                        Buy
                      </Link>
                    </Button>
                  ) : viewerOfferHold ? (
                    <Button asChild size="default" className="w-fit rounded-full">
                      <Link
                        href={getMarketplaceOfferCheckoutRoute(viewerOfferHold.offerId)}
                        overrideDefaults
                        data-cy="marketplace-listing-held-for-you-offer"
                      >
                        Buy
                      </Link>
                    </Button>
                  ) : (
                    <Button
                      size="default"
                      className="w-fit rounded-full"
                      disabled={
                        availabilityNeedsSession
                          ? isOwner || adapterMode === 'unavailable'
                          : isOwner ||
                            adapterMode === 'unavailable' ||
                            !isPurchasable ||
                            !availabilityReady ||
                            isSoldOut ||
                            projectionIsReserved ||
                            !selectedVariant ||
                            selectedVariant.quantity === 0
                      }
                      onClick={availabilityNeedsSession ? beginPurchaseAuth : addSelectedVariantToCart}
                    >
                      <ShoppingCart className="size-4" />
                      Buy
                    </Button>
                  )}
                  {projectionIsReserved && !viewerHoldOrder && !viewerOfferHold && (
                    <Typography as="p" className="w-full text-sm text-muted-foreground">
                      {CHECKOUT_HOLD_COPY.listingReserved}
                    </Typography>
                  )}
                  {commerceListingTakesOffers(record) && !viewerOfferHold && (
                    <MarketplaceOfferDialog
                      aggregateId={aggregateId}
                      expectedRevision={negotiation.projection?.serverRevision ?? null}
                      priceAsset={price}
                      askingPrice={record.sale.unitPrice}
                      isSessionRequired={negotiation.needsSession}
                      onSessionRequired={revealSessionRequired}
                      onAccepted={negotiation.refresh}
                      isOwner={isOwner}
                      holdDisabled={projectionIsReserved}
                      holdLabel={
                        viewerHoldOrder ? CHECKOUT_HOLD_COPY.heldForYouCta : CHECKOUT_HOLD_COPY.heldWhileAnotherPays
                      }
                    />
                  )}
                  {record.sale.acceptsOffers && offersDigital && (
                    <Typography
                      as="p"
                      className="w-full text-sm text-muted-foreground"
                      data-testid="marketplace-listing-digital-offer-note"
                    >
                      {offersDigitalOnly
                        ? DIGITAL_DELIVERY_COPY.offersUnavailable
                        : shipsItem
                          ? DIGITAL_DELIVERY_COPY.offersBuyShipped
                          : DIGITAL_DELIVERY_COPY.offersBuyPickup}
                    </Typography>
                  )}
                </>
              )}
              <Button
                size="icon"
                variant="secondary"
                className="size-10 rounded-full"
                aria-label={favorite.isFavorite ? 'Remove from watchlist' : 'Add to watchlist'}
                aria-pressed={favorite.isFavorite}
                disabled={favorite.isMutating}
                onClick={favorite.toggle}
              >
                {record.sale.format === 'auction' ? (
                  <Bell className={favorite.isFavorite ? 'fill-brand text-brand' : ''} />
                ) : (
                  <Heart className={favorite.isFavorite ? 'fill-brand text-brand' : ''} />
                )}
              </Button>
              <MarketplaceListingSavePicker sellerPubky={record.ownerPubky} listingId={record.listingId} />
            </div>
            {adapterMode === 'unavailable' && (
              <Typography as="p" className="text-center text-sm text-muted-foreground">
                Transactions are disabled in this deployment.
              </Typography>
            )}
            {isTransactionalCommerceMode(adapterMode) && (
              <MarketplaceSessionConnectDialog
                open={showSessionRequired}
                onOpenChange={setShowSessionRequired}
                hideTrigger
                onConnected={onSessionConnected}
              />
            )}
            {isTransactionalCommerceMode(adapterMode) && negotiation.error && !negotiation.needsSession && (
              <Typography as="p" role="alert" className="text-center text-sm text-amber-300">
                {auctionPhase === 'ended' && negotiation.error === MARKETPLACE_FAILURE_MESSAGES.claimListingUnavailable
                  ? MARKETPLACE_FAILURE_MESSAGES.bidClosed
                  : negotiation.error}
              </Typography>
            )}
            <Card className="rounded-md p-0">
              <CardContent className="flex flex-col gap-3 p-6">
                <div className="min-w-0 flex-1 sm:min-w-[12rem]">
                  <MarketplaceSellerIdentity
                    variant="card"
                    sellerPubky={sellerPubky}
                    displayName={sellerDisplayName}
                    avatarUrl={shopAvatarUrl}
                    avatarAlt={`${shop?.record.name ?? 'Shop'} avatar`}
                    reputation={sellerReputation}
                  />
                  {isOwner && !shop && (
                    <Typography as="p" className="mt-2 text-sm text-muted-foreground">
                      You haven&apos;t created a storefront yet — buyers only see your key.
                    </Typography>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {isOwner && !shop ? (
                    <Button asChild size="sm" className="rounded-full">
                      <Link href={MARKETPLACE_ROUTES.MY_SHOP} overrideDefaults>
                        Set up your storefront
                      </Link>
                    </Button>
                  ) : (
                    <Button asChild variant="secondary" size="sm" className="rounded-full">
                      <Link href={getMarketplaceShopRoute(sellerPubky)} overrideDefaults>
                        <Store className="size-4" aria-hidden="true" />
                        View storefront
                      </Link>
                    </Button>
                  )}
                  <div>
                    <MarketplaceMessageDialog sellerPubky={sellerPubky} listingId={listingId} />
                  </div>
                </div>
              </CardContent>
            </Card>
            <section aria-label="Fulfillment and listing information" className="flex min-w-0 flex-col gap-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <MarketplaceListingSpecifics record={record} />
                {!isLocksListing && (shipsItem || methods.includes('pickup')) && (
                  <div className="flex items-start gap-3 rounded-md bg-card p-6 text-card-foreground shadow-sm">
                    <MapPin className="size-5 shrink-0 text-brand" aria-hidden="true" />
                    <div className="flex min-w-0 flex-col gap-1">
                      <Typography as="p" className="text-sm leading-5 font-semibold">
                        {shipsItem ? 'Ships from' : 'Pickup location'}
                      </Typography>
                      <Typography as="p" className="text-sm leading-5 font-medium text-muted-foreground">
                        {record.location.region ? `${record.location.region}, ` : ''}
                        {record.location.countryCode}
                      </Typography>
                    </div>
                  </div>
                )}
                <details className="group/signature rounded-md bg-card text-card-foreground shadow-sm">
                  <summary className="flex cursor-pointer list-none items-start gap-3 rounded-md p-5 focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
                    <ShieldCheck className="size-5 shrink-0 text-brand" aria-hidden="true" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <Typography as="p" className="text-sm leading-5 font-semibold">
                        Owner-signed
                      </Typography>
                      <Typography as="p" className="text-sm leading-5 font-medium text-muted-foreground">
                        Revision {record.revision}
                      </Typography>
                    </div>
                    <ChevronDown
                      className="size-4 shrink-0 self-center text-muted-foreground transition-transform group-open/signature:rotate-180 motion-reduce:transition-none"
                      aria-hidden="true"
                    />
                  </summary>
                  <p className="px-5 pb-5 text-sm leading-5 font-medium text-muted-foreground">
                    Signed by the listing owner. This does not verify the item&apos;s authenticity.
                  </p>
                </details>
                {record.package && (
                  <div className="flex items-start gap-3 rounded-md bg-card p-6 text-card-foreground shadow-sm">
                    <Package className="size-5 shrink-0 text-brand" aria-hidden="true" />
                    <div className="flex min-w-0 flex-col gap-1">
                      <Typography as="p" className="text-sm leading-5 font-semibold">
                        Package
                      </Typography>
                      <Typography as="p" className="text-sm leading-5 font-medium text-muted-foreground">
                        {formatWeight(record.package.weightGrams, measurementSystem)} ·{' '}
                        {formatPackageDimensions(record.package, measurementSystem).replace(/ ([^ ]+)$/, '\u00a0$1')}
                      </Typography>
                    </div>
                  </div>
                )}
                {record.tags.length > 0 && (
                  <div className="marketplace-item-details flex min-w-0 items-start gap-3 rounded-md bg-card p-6 text-card-foreground shadow-sm">
                    <Hash className="size-5 shrink-0 text-brand" aria-hidden="true" />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <Heading level={2} size="sm" className="text-sm leading-5 font-semibold">
                        Seller&apos;s keywords
                      </Heading>
                      <div className="flex flex-wrap gap-1" data-cy="marketplace-seller-keywords">
                        {record.tags.map((tag) => (
                          <Badge key={tag} variant="outline" className="text-muted-foreground">
                            #{tag}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
                <MarketplaceCommunityTags
                  variant="info-card"
                  target={{ kind: TagKind.LISTING, sellerPubky: record.ownerPubky, listingId: record.listingId }}
                />
                <MarketplaceReviewsSection sellerPubky={record.ownerPubky} listingId={record.listingId} infoCard />
              </div>
            </section>
          </div>
          <div className="min-w-0 lg:col-start-1 lg:row-start-2">
            <MarketplaceSimilarItems categoryId={record.categoryId} sellerPubky={sellerPubky} listingId={listingId} />
          </div>
        </div>
      </Container>
    </ContentLayout>
  );
}

function formatListingShipping(
  record: CommerceListingRecord,
  methods: readonly MarketplaceFulfillmentMethod[],
): string {
  if (record.digitalLock !== undefined) return 'Digital delivery';
  if (!methods.includes('shipping')) return methods.includes('pickup') ? 'Local pickup only' : 'Digital delivery';
  const flat = record.shippingOptions.find((option) => option.pricing === 'flat');
  if (flat) return `Shipping: ${formatShippingOption(flat)} ${formatCommerceMoney(flat.price)}`;

  const free = record.shippingOptions.find((option) => option.pricing === 'free');
  if (free) return 'Shipping: free';

  return 'Shipping: calculated at checkout';
}

function formatShippingOption(option: CommerceShippingOption): string {
  return option.label.endsWith(':') ? option.label.slice(0, -1) : option.label;
}
