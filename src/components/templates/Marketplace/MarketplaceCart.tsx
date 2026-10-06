'use client';

import { Minus, Plus, ShoppingCart, Trash2 } from 'lucide-react';
import { APP_ROUTES, getMarketplaceListingRoute } from '@/app/routes';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Image } from '@/atoms/Image/Image';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import { type MarketplaceCartGroup, useMarketplaceCart } from '@/hooks/useMarketplaceCart/useMarketplaceCart';
import {
  useMarketplaceFirstMediaUrls,
  useMarketplaceMediaUrl,
} from '@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl';
import { useMarketplaceOffers } from '@/hooks/useMarketplaceOffers/useMarketplaceOffers';
import { useMarketplaceSellerSummary } from '@/hooks/useMarketplaceSellerSummary/useMarketplaceSellerSummary';
import { getMarketplaceCheckoutRoute, getMarketplaceOfferCheckoutRoute } from '@/libs/commerce/checkout-phase';
import { formatCommerceMoney } from '@/libs/commerce/format';
import { MarketplaceSellerIdentity } from '@/molecules/MarketplaceSellerIdentity/MarketplaceSellerIdentity';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { MarketplaceIndicativePrice } from '@/organisms/Marketplace/MarketplaceIndicativePrice';
import { MarketplaceSectionNav } from '@/organisms/Marketplace/MarketplaceSectionNav';
import { MarketplaceCartSkeleton } from './MarketplaceCart.skeleton';

export function MarketplaceCart() {
  const cart = useMarketplaceCart();
  const cartMediaUris = cart.items.map((item) =>
    item.listing.record.media.filter(({ type }) => type === 'image').map(({ url }) => url),
  );
  const cartMediaUrls = useMarketplaceFirstMediaUrls(cartMediaUris);
  const ordinaryItems = cart.ordinaryItems ?? cart.items;
  const awardItems = cart.awardItems ?? [];
  const offers = useMarketplaceOffers();

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      className="pb-28"
      classNameWrapperContent="max-w-7xl"
    >
      <Container overrideDefaults className="flex w-full flex-col gap-6 px-4 sm:px-6">
        <MarketplaceSectionNav />
        <div>
          <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
            Cart
          </Heading>
          <Typography as="p" className="mt-2 text-muted-foreground">
            {cart.itemCount} {cart.itemCount === 1 ? 'item' : 'items'} · local-first until checkout.
          </Typography>
        </div>

        {cart.isLoading ? (
          <div data-surface="marketplace-cart">
            <MarketplaceCartSkeleton />
          </div>
        ) : cart.items.length ? (
          <div className="grid gap-6 lg:grid-cols-[1fr_420px]" data-surface="marketplace-cart">
            <div className="flex flex-col gap-6 lg:col-start-1 lg:row-start-1">
              <div className="flex flex-col gap-4" data-testid="marketplace-cart-items">
                {awardItems.map((item) => {
                  const variant = item.listing.record.variants.find(({ id }) => id === item.variantId);
                  const award = offers.offers.find(({ award }) => award?.id === item.awardId)?.award;
                  return (
                    <section
                      key={item.id}
                      className="grid gap-3"
                      aria-label="Accepted offer checkout"
                      data-surface="marketplace-award-cart-group"
                    >
                      <Heading level={2} size="sm" className="text-xl font-semibold">
                        Accepted offer
                      </Heading>
                      <Card className="border py-4">
                        <CardContent className="flex flex-col gap-4 px-4 sm:flex-row sm:items-center sm:justify-between">
                          <div>
                            <Typography as="p" className="font-semibold">
                              {item.listing.record.title}
                            </Typography>
                            <Typography as="p" className="text-sm text-muted-foreground">
                              {variant ? Object.values(variant.options).join(' · ') || 'Default' : 'Default'} · Quantity{' '}
                              {item.quantity}
                            </Typography>
                            {award && (
                              <>
                                <Typography as="p" className="mt-1 text-sm text-muted-foreground">
                                  {formatCommerceMoney(award.unitPrice)} × {award.quantity} +{' '}
                                  {formatCommerceMoney(award.shipping)} shipping ={' '}
                                  {formatCommerceMoney(award.merchandiseTotal)}
                                </Typography>
                                <Typography as="p" className="text-sm text-muted-foreground">
                                  Buy by {new Date(award.convertBy).toLocaleString('en-US')}
                                </Typography>
                              </>
                            )}
                            <Typography as="p" className="mt-1 text-sm text-muted-foreground">
                              Quantity and variant are fixed at the accepted offer.
                            </Typography>
                          </div>
                          <Button asChild className="rounded-full">
                            <Link href={getMarketplaceOfferCheckoutRoute(item.awardId)} overrideDefaults>
                              Checkout
                            </Link>
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            aria-label={`Remove ${item.listing.record.title}`}
                            onClick={() => void cart.remove(item.listingId, item.variantId, item.awardId ?? undefined)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </CardContent>
                      </Card>
                    </section>
                  );
                })}
                {ordinaryItems.length > 0 && (
                  <Typography as="p" className="rounded-xl border bg-card/60 px-4 py-3 text-sm text-muted-foreground">
                    Each seller ships separately; shipping is calculated at checkout.
                  </Typography>
                )}
                {cart.groups.map((group) => (
                  <section
                    key={group.sellerPubky}
                    className="grid gap-3"
                    aria-label={`Cart items from ${group.sellerPubky}`}
                  >
                    {cart.groups.length > 1 && <MarketplaceCartSellerHeader group={group} />}
                    {group.items.map((item) => {
                      const variant = item.listing.record.variants.find(({ id }) => id === item.variantId);
                      const price =
                        variant?.priceOverride ??
                        (item.listing.record.sale.format === 'fixed_price' ? item.listing.record.sale.unitPrice : null);
                      const coverUrl = cartMediaUrls[cart.items.findIndex(({ id }) => id === item.id)] ?? null;
                      const listingRoute = getMarketplaceListingRoute(
                        item.listing.record.ownerPubky,
                        item.listing.listing_id,
                      );
                      return (
                        <Card key={item.id} className="border py-4">
                          <CardContent className="flex items-center gap-4 px-4">
                            <Link href={listingRoute} overrideDefaults aria-label={`View ${item.listing.record.title}`}>
                              <div className="relative flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand/15">
                                <ShoppingCart className="size-7 text-brand" />
                                {coverUrl && (
                                  <Image
                                    src={coverUrl}
                                    alt={item.listing.record.title}
                                    fill
                                    sizes="80px"
                                    className="absolute inset-0 object-cover object-center"
                                  />
                                )}
                              </div>
                            </Link>
                            <div className="min-w-0 flex-1">
                              <Typography as="h2" className="truncate font-semibold">
                                <Link href={listingRoute} overrideDefaults className="hover:text-brand hover:underline">
                                  {item.listing.record.title}
                                </Link>
                              </Typography>
                              <Typography as="p" className="text-sm text-muted-foreground">
                                {variant ? Object.values(variant.options).join(' · ') || 'Default' : 'Default'}
                              </Typography>
                              {price && (
                                <Typography as="p" className="mt-1 font-bold text-brand">
                                  {formatCommerceMoney(price)}{' '}
                                  <MarketplaceIndicativePrice money={price} className="font-normal" />
                                </Typography>
                              )}
                            </div>
                            <div className="flex items-center gap-1">
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`Decrease ${item.listing.record.title} quantity`}
                                disabled={item.quantity <= 1}
                                onClick={() => void cart.update(item.listingId, item.variantId, item.quantity - 1)}
                              >
                                <Minus className="size-4" />
                              </Button>
                              <Typography as="span" className="min-w-8 text-center">
                                {item.quantity}
                              </Typography>
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`Increase ${item.listing.record.title} quantity`}
                                disabled={!variant || item.quantity >= variant.quantity}
                                onClick={() => void cart.update(item.listingId, item.variantId, item.quantity + 1)}
                              >
                                <Plus className="size-4" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                aria-label={`Remove ${item.listing.record.title}`}
                                onClick={() => void cart.remove(item.listingId, item.variantId)}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </div>
                          </CardContent>
                        </Card>
                      );
                    })}
                  </section>
                ))}
              </div>
            </div>

            {ordinaryItems.length > 0 && (
              <Card
                className="h-fit border lg:col-start-2 lg:row-start-1 lg:self-start"
                data-testid="marketplace-cart-summary"
              >
                <CardContent className="grid gap-6 px-6">
                  <section className="grid gap-3" aria-label="Checkout">
                    <Heading level={2} size="sm" className="text-xl font-semibold">
                      Checkout
                    </Heading>
                    <div className="flex justify-between">
                      <Typography as="span">Items</Typography>
                      <div className="flex flex-col items-end">
                        {cart.subtotals.map((subtotal) => (
                          <Typography key={`${subtotal.currency}:${subtotal.exponent}`} as="span" className="font-bold">
                            {formatCommerceMoney(subtotal)}{' '}
                            <MarketplaceIndicativePrice money={subtotal} className="font-normal" />
                          </Typography>
                        ))}
                      </div>
                    </div>
                    <Typography as="p" className="text-xs text-muted-foreground">
                      Shipping is calculated at checkout for the items that ship.
                    </Typography>
                    <Button asChild className="w-full rounded-full">
                      <Link
                        href={getMarketplaceCheckoutRoute()}
                        overrideDefaults
                        data-testid="marketplace-cart-checkout"
                      >
                        Checkout
                      </Link>
                    </Button>
                  </section>
                </CardContent>
              </Card>
            )}
          </div>
        ) : (
          <div
            className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed text-center"
            data-surface="marketplace-cart"
          >
            <ShoppingCart className="mb-3 size-10 text-muted-foreground" />
            <Heading level={2} size="md">
              Your cart is empty
            </Heading>
            <Typography as="p" className="mt-2 text-muted-foreground">
              Items you add from listings appear here, saved on this device.
            </Typography>
            <Button asChild className="mt-6 rounded-full">
              <Link href={APP_ROUTES.MARKETPLACE} overrideDefaults>
                Browse the marketplace
              </Link>
            </Button>
          </div>
        )}
      </Container>
    </ContentLayout>
  );
}

function MarketplaceCartSellerHeader({ group }: { group: MarketplaceCartGroup }) {
  const seller = useMarketplaceSellerSummary(group.sellerPubky, { includeReputation: false });
  const avatarUrl = useMarketplaceMediaUrl(seller.shop?.record.avatarUrl);

  return (
    <Card className="border py-4">
      <CardContent className="flex flex-col gap-4 px-4 sm:flex-row sm:items-center sm:justify-between">
        <MarketplaceSellerIdentity
          sellerPubky={group.sellerPubky}
          displayName={seller.displayName}
          avatarUrl={avatarUrl}
          avatarAlt={`${seller.shop?.record.name ?? 'Shop'} avatar`}
          reputation={seller.reputation}
        />
        <div className="flex flex-col gap-1 sm:items-end">
          <Typography as="p" className="text-sm text-muted-foreground">
            Seller subtotal
          </Typography>
          {group.subtotals.map((subtotal) => (
            <Typography key={`${subtotal.currency}:${subtotal.exponent}`} as="p" className="font-bold text-brand">
              {formatCommerceMoney(subtotal)} <MarketplaceIndicativePrice money={subtotal} className="font-normal" />
            </Typography>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
