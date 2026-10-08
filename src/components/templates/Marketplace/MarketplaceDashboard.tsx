'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  AlertTriangle,
  Banknote,
  Copy,
  Download,
  History,
  ImageIcon,
  Package,
  Pause,
  PencilLine,
  Play,
  Plus,
  ShoppingBag,
  Store,
  TrendingUp,
  Truck,
  Wallet,
} from 'lucide-react';
import { getMarketplaceListingEditRoute, getMarketplaceListingRoute, MARKETPLACE_ROUTES } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Checkbox } from '@/atoms/Checkbox/Checkbox';
import { Container } from '@/atoms/Container/Container';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/atoms/Dialog/Dialog';
import { Heading } from '@/atoms/Heading/Heading';
import { Image } from '@/atoms/Image/Image';
import { Link } from '@/atoms/Link/Link';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Typography } from '@/atoms/Typography/Typography';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useIsMobile } from '@/hooks/useIsMobile/useIsMobile';
import { useMarketplaceFirstMediaUrl } from '@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl';
import { useMarketplaceSellerDashboard } from '@/hooks/useMarketplaceSellerDashboard/useMarketplaceSellerDashboard';
import { useNowMs } from '@/hooks/useNowMs/useNowMs';
import { useSellerPaymentMethodGate } from '@/hooks/useSellerPaymentMethodGate/useSellerPaymentMethodGate';
import { listingDisplayState } from '@/libs/commerce/auction-phase';
import { formatCommerceMoney } from '@/libs/commerce/format';
import { formatListingStock } from '@/libs/commerce/unlimited-stock';
import { isListingRegistrationPending } from '@/models/commerce/commerce.schema';
import { SettingsSectionContent } from '@/molecules/Settings/SettingsSectionContent/SettingsSectionContent';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { MarketplaceSectionNav } from '@/organisms/Marketplace/MarketplaceSectionNav';
import { MarketplaceSessionConnectDialog } from '@/organisms/Marketplace/MarketplaceSessionConnectDialog';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';

export function MarketplaceDashboard() {
  const dashboard = useMarketplaceSellerDashboard();
  const isMobile = useIsMobile({ breakpoint: 'md' });
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [showSellingApproval, setShowSellingApproval] = useState(false);
  const [duplicatingId, setDuplicatingId] = useState<string | null>(null);
  const [pendingDuplicateId, setPendingDuplicateId] = useState<string | null>(null);
  const [pendingUnsavedDraftId, setPendingUnsavedDraftId] = useState<string | null>(null);
  const [pendingStateChange, setPendingStateChange] = useState<{
    listingIds: string[];
    state: 'active' | 'paused';
  } | null>(null);
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const marketplaceSession = useCommerceStore((state) => state.marketplaceSession);
  const paymentGate = useSellerPaymentMethodGate();
  const nowMs = useNowMs(paymentGate.isDurable && !!marketplaceSession);
  const needsSellingApproval =
    paymentGate.isDurable &&
    (!marketplaceSession ||
      marketplaceSession.pubky !== currentUserPubky ||
      Date.parse(marketplaceSession.expiresAt) <= nowMs);
  // Normalize "no record" to null so `undefined` keeps meaning "still loading".
  const shop = useLiveQuery(
    () => (currentUserPubky ? CommerceController.getShop(currentUserPubky).then((found) => found ?? null) : null),
    [currentUserPubky],
  );
  const [shopFetchSettled, setShopFetchSettled] = useState(false);

  useEffect(() => {
    if (showSellingApproval && !needsSellingApproval) {
      setShowSellingApproval(false);
      router.push(MARKETPLACE_ROUTES.SELL);
    }
  }, [showSellingApproval, needsSellingApproval, router]);

  useEffect(() => {
    if (!currentUserPubky) return;
    let active = true;
    setShopFetchSettled(false);
    CommerceController.getOrFetchShop(currentUserPubky)
      .catch(() => undefined)
      .finally(() => {
        if (active) setShopFetchSettled(true);
      });
    return () => {
      active = false;
    };
  }, [currentUserPubky]);

  const runDuplicate = async (listingId: string, replaceUnsavedDraft = false, unsavedDraftId?: string) => {
    setDuplicatingId(listingId);
    const seeded = await dashboard.duplicateListing(
      listingId,
      unsavedDraftId ? { replaceUnsavedDraft, unsavedDraftId } : { replaceUnsavedDraft },
    );
    setDuplicatingId(null);
    if (seeded) router.push(MARKETPLACE_ROUTES.SELL);
  };

  const updateListingState = (listingIds: string[], state: 'active' | 'paused') => {
    if (isDurableCommerceMode(getCommerceAdapterMode()) && !marketplaceSession) {
      setPendingStateChange({ listingIds, state });
      return;
    }
    void dashboard.updateListingState(listingIds, state);
  };

  const requestDuplicate = async (listingId: string) => {
    const unsavedDraftId = await dashboard.hasUnsavedListingDraft();
    if (unsavedDraftId) {
      setPendingDuplicateId(listingId);
      setPendingUnsavedDraftId(unsavedDraftId);
      return;
    }
    await runDuplicate(listingId);
  };

  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob([dashboard.exportCsv()], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'pubky-marketplace-inventory.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      className="pb-28"
    >
      <Container overrideDefaults className="flex w-full flex-col gap-6">
        <MarketplaceSectionNav />
        <div>
          <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
            My shop
          </Heading>
          <Typography as="p" className="mt-2 text-muted-foreground">
            Manage your listings, shop, orders, and offers.
          </Typography>
        </div>
        <nav aria-label="Shop actions" className="flex flex-wrap items-center gap-2">
          <SellAnItemControl
            size="sm"
            needsApproval={needsSellingApproval}
            approvalVisible={showSellingApproval}
            onRequestApproval={() => setShowSellingApproval(true)}
          />
          <Button asChild variant="secondary" size="sm" className="rounded-full text-xs font-bold">
            <Link href={MARKETPLACE_ROUTES.MY_SHOP} overrideDefaults>
              <Store className="size-4" />
              Storefront
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="rounded-full text-xs font-bold">
            <Link href={MARKETPLACE_ROUTES.INVENTORY} overrideDefaults>
              <Package className="size-4" />
              Inventory
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="rounded-full text-xs font-bold">
            <Link href={MARKETPLACE_ROUTES.SETTINGS_SHIPPING} overrideDefaults>
              <Truck className="size-4" aria-hidden="true" />
              Shipping presets
            </Link>
          </Button>
          <Button asChild variant="secondary" size="sm" className="rounded-full text-xs font-bold">
            <Link href={MARKETPLACE_ROUTES.SETTINGS} overrideDefaults>
              <Wallet className="size-4" aria-hidden="true" />
              Payment settings
            </Link>
          </Button>
        </nav>

        {dashboard.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : (
          <>
            {/* A seller with published listings but no shop record dead-ends
                every buyer who taps "View shop" — surface that here, where
                sellers actually work. */}
            {shopFetchSettled && shop === null && dashboard.listings.length > 0 && (
              <Card className="rounded-md bg-card p-0">
                <CardContent className="flex flex-col gap-3 p-6 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <Typography as="h2" className="font-semibold">
                      Your storefront is not set up
                    </Typography>
                    <Typography as="p" className="text-sm text-muted-foreground">
                      Add a shop name, bio, and policies.
                    </Typography>
                  </div>
                  <Button asChild className="shrink-0 rounded-full">
                    <Link href={MARKETPLACE_ROUTES.MY_SHOP} overrideDefaults>
                      <Store className="size-4" />
                      Set up your storefront
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            )}
            {dashboard.unfinishedDrafts.length > 1 && (
              <Card data-surface="listing-drafts-list" className="rounded-md bg-brand/5 p-0 shadow-lg">
                <CardContent className="grid gap-6 p-6">
                  <div className="flex items-start gap-3">
                    <History className="mt-1 size-5 shrink-0 text-brand" />
                    <div>
                      <Typography as="h2" className="font-semibold">
                        Unfinished drafts
                      </Typography>
                      <Typography as="p" className="text-sm text-muted-foreground">
                        Listings saved on this device. Resume one or discard it.
                      </Typography>
                    </div>
                  </div>
                  <SettingsSectionContent>
                    <ul className="flex flex-col gap-3">
                      {dashboard.unfinishedDrafts.map((draft) => (
                        <li
                          key={draft.listingId}
                          className="flex flex-col gap-2 rounded-md bg-background p-6 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div>
                            <Typography as="p" className="font-medium">
                              {draft.title}
                            </Typography>
                            <Typography as="p" className="text-sm text-muted-foreground">
                              {draft.ageLabel}
                            </Typography>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              className="rounded-full"
                              onClick={() => {
                                dashboard.resumeListingDraft(draft.listingId);
                                router.push(MARKETPLACE_ROUTES.SELL);
                              }}
                            >
                              Resume
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              className="rounded-full"
                              onClick={() => {
                                void dashboard.discardListingDraft(draft.listingId);
                              }}
                            >
                              Discard
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </SettingsSectionContent>
                </CardContent>
              </Card>
            )}
            {dashboard.actionNeeded.total > 0 && (
              <Card className="rounded-md bg-brand/5 p-0">
                <CardContent className="flex flex-col gap-4 p-6 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-1 size-5 shrink-0 text-brand" />
                    <div>
                      <Typography as="h2" className="font-semibold">
                        Action needed
                      </Typography>
                      <Typography as="p" className="text-sm text-muted-foreground">
                        {[
                          dashboard.actionNeeded.ordersToShip > 0
                            ? `${dashboard.actionNeeded.ordersToShip} paid ${dashboard.actionNeeded.ordersToShip === 1 ? 'order' : 'orders'} to ship`
                            : null,
                          dashboard.actionNeeded.offersAwaitingReply > 0
                            ? `${dashboard.actionNeeded.offersAwaitingReply} open ${dashboard.actionNeeded.offersAwaitingReply === 1 ? 'offer' : 'offers'} awaiting your reply`
                            : null,
                          dashboard.actionNeeded.expiringAuctions > 0
                            ? `${dashboard.actionNeeded.expiringAuctions} expiring ${dashboard.actionNeeded.expiringAuctions === 1 ? 'auction' : 'auctions'}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </Typography>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {dashboard.actionNeeded.ordersToShip > 0 && (
                      <Button asChild variant="secondary" className="rounded-full">
                        <Link href={MARKETPLACE_ROUTES.ORDERS} overrideDefaults>
                          Ship orders
                        </Link>
                      </Button>
                    )}
                    {dashboard.actionNeeded.offersAwaitingReply > 0 && (
                      <Button asChild variant="secondary" className="rounded-full">
                        <Link href={MARKETPLACE_ROUTES.OFFERS} overrideDefaults>
                          Review offers
                        </Link>
                      </Button>
                    )}
                    {dashboard.actionNeeded.expiringAuctions > 0 && (
                      <Button asChild variant="secondary" className="rounded-full">
                        <Link href={MARKETPLACE_ROUTES.OFFERS} overrideDefaults>
                          Check auctions
                        </Link>
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}
            {isMobile ? (
              <div
                className="-mx-4 flex gap-6 overflow-x-auto px-4 pb-1"
                data-testid="marketplace-dashboard-kpi-chips"
                tabIndex={0}
                role="region"
                aria-label="Dashboard metrics"
              >
                {dashboardKpis(dashboard.metrics).map(({ label, value }) => (
                  <div key={label} className="shrink-0 rounded-full bg-card p-6">
                    <Typography as="p" className="text-sm font-semibold">
                      {value}
                    </Typography>
                    <Typography as="p" className="text-xs text-muted-foreground">
                      {label}
                    </Typography>
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-5">
                {dashboardKpis(dashboard.metrics).map(({ label, value, icon: Icon }) => (
                  <Card key={label} className="gap-3 rounded-md p-0">
                    <CardContent className="flex items-start justify-between gap-4 p-6">
                      <div className="min-w-0">
                        <Typography as="p" className="text-2xl font-bold">
                          {value}
                        </Typography>
                        <Typography as="p" className="text-sm text-muted-foreground">
                          {label}
                        </Typography>
                      </div>
                      <Icon className="size-6 shrink-0 text-brand" />
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            <Card className="rounded-md p-0 shadow-lg">
              {dashboard.error ? (
                <div role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-6">
                  <Heading level={3} size="md">
                    Listings could not be loaded
                  </Heading>
                  <Typography as="p" className="mt-2 text-muted-foreground">
                    {dashboard.error}
                  </Typography>
                </div>
              ) : (
                <CardContent className="grid gap-6 p-6">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <Typography as="h2" className="text-xl font-semibold">
                        My listings
                      </Typography>
                      <Typography as="p" className="text-sm text-muted-foreground">
                        {dashboard.metrics.openOffers} open offers need attention.
                      </Typography>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        className="rounded-full"
                        disabled={!selected.length}
                        onClick={() => updateListingState(selected, 'paused')}
                      >
                        <Pause className="size-4" />
                        Pause
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="rounded-full"
                        disabled={!selected.length}
                        onClick={() => updateListingState(selected, 'active')}
                      >
                        <Play className="size-4" />
                        Activate
                      </Button>
                      <Button size="sm" variant="secondary" className="rounded-full" onClick={exportCsv}>
                        <Download className="size-4" />
                        Export CSV
                      </Button>
                    </div>
                  </div>

                  <SettingsSectionContent
                    className={dashboard.listings.length === 0 ? 'border-0 shadow-none' : undefined}
                  >
                    {dashboard.listings.length === 0 ? (
                      <div className="flex min-h-48 flex-col items-center justify-center rounded-md bg-card/40 p-6 text-center">
                        <ShoppingBag className="mb-4 size-10 text-muted-foreground" />
                        <Heading level={3} size="md">
                          You have no listings yet
                        </Heading>
                        <Typography as="p" className="mt-2 text-muted-foreground">
                          Let&apos;s create a listing to sell your first item.
                        </Typography>
                        <div className="mt-6">
                          <SellAnItemControl
                            label="Create a listing"
                            variant="secondary"
                            needsApproval={needsSellingApproval}
                            approvalVisible={showSellingApproval}
                            onRequestApproval={() => setShowSellingApproval(true)}
                          />
                        </div>
                      </div>
                    ) : (
                      <div className="overflow-x-auto">
                        <table className="w-full min-w-2xl text-left text-sm">
                          <thead className="text-muted-foreground">
                            <tr className="border-b">
                              <th className="p-3">
                                <span className="sr-only">Select</span>
                              </th>
                              <th className="p-3">Listing</th>
                              <th className="p-3">State</th>
                              <th className="p-3">Format</th>
                              <th className="p-3">Inventory</th>
                              <th className="p-3">Price</th>
                              <th className="p-3">
                                <span className="sr-only">Actions</span>
                              </th>
                            </tr>
                          </thead>
                          <tbody>
                            {dashboard.listings.map((listing) => {
                              const checked = selected.includes(listing.id);
                              return (
                                <tr key={listing.id} className="border-b last:border-0">
                                  <td className="p-3">
                                    <Checkbox
                                      checked={checked}
                                      onCheckedChange={(next) =>
                                        setSelected((current) =>
                                          next ? [...current, listing.id] : current.filter((id) => id !== listing.id),
                                        )
                                      }
                                      aria-label={`Select ${listing.record.title}`}
                                    />
                                  </td>
                                  <td className="p-3">
                                    <div className="flex items-center gap-3">
                                      <ListingThumbnail
                                        mediaUrls={listing.record.media
                                          .filter(({ type }) => type === 'image')
                                          .map(({ url }) => url)}
                                        title={listing.record.title}
                                      />
                                      <Link
                                        href={getMarketplaceListingRoute(listing.seller_id, listing.listing_id)}
                                        overrideDefaults
                                        className="font-semibold hover:text-brand hover:underline"
                                      >
                                        {listing.record.title}
                                      </Link>
                                    </div>
                                  </td>
                                  <td className="p-3">
                                    <Badge variant="secondary">
                                      {listingDisplayState(listing.state, listing.record.sale, dashboard.nowMs)}
                                    </Badge>
                                  </td>
                                  <td className="p-3">{listing.format.replace('_', ' ')}</td>
                                  <td className="p-3">{formatListingStock(listing.record)}</td>
                                  <td className="p-3">
                                    {/* The record's own price money: the model row's
                                    `price_minor` has no exponent column, and
                                    assuming 2 misstates bitcoin-priced listings. */}
                                    {formatCommerceMoney(
                                      listing.record.sale.format === 'fixed_price'
                                        ? listing.record.sale.unitPrice
                                        : listing.record.sale.startingPrice,
                                    )}
                                  </td>
                                  <td className="p-3">
                                    <div className="flex flex-wrap gap-1">
                                      <Button asChild size="sm" variant="ghost" className="rounded-full">
                                        <Link
                                          href={getMarketplaceListingEditRoute(listing.seller_id, listing.listing_id)}
                                          overrideDefaults
                                        >
                                          <PencilLine className="size-4" />
                                          Edit
                                        </Link>
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        className="rounded-full"
                                        disabled={duplicatingId === listing.listing_id}
                                        onClick={() => {
                                          void requestDuplicate(listing.listing_id);
                                        }}
                                      >
                                        <Copy className="size-4" />
                                        Duplicate
                                      </Button>
                                      {isListingRegistrationPending(listing) && (
                                        <Button
                                          size="sm"
                                          variant="secondary"
                                          className="rounded-full"
                                          onClick={() => void dashboard.retryListingRegistration(listing.listing_id)}
                                        >
                                          Register for checkout
                                        </Button>
                                      )}
                                    </div>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </SettingsSectionContent>
                </CardContent>
              )}
            </Card>
          </>
        )}
        <MarketplaceSessionConnectDialog
          intent="sell"
          open={showSellingApproval}
          onOpenChange={setShowSellingApproval}
          hideTrigger
          onConnected={() => router.push(MARKETPLACE_ROUTES.SELL)}
        />
        {pendingStateChange && (
          <MarketplaceSessionConnectDialog
            intent="sell"
            autoOpen
            onConnected={async () => {
              const pending = pendingStateChange;
              setPendingStateChange(null);
              await dashboard.updateListingState(pending.listingIds, pending.state);
            }}
          />
        )}
      </Container>
      <Dialog
        open={pendingDuplicateId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setPendingDuplicateId(null);
            setPendingUnsavedDraftId(null);
          }
        }}
      >
        <DialogContent className="w-xl" hiddenTitle="Replace your unsaved draft?">
          <DialogHeader>
            <DialogTitle>Replace your unsaved draft?</DialogTitle>
          </DialogHeader>
          <Typography className="text-base tracking-wide text-white/80">
            Duplicating this listing will replace the unsaved draft currently in the sell studio.
          </Typography>
          <DialogFooter>
            <Button
              variant="outline"
              size="lg"
              onClick={() => {
                setPendingDuplicateId(null);
                setPendingUnsavedDraftId(null);
              }}
            >
              Keep
            </Button>
            <Button
              variant="destructive"
              size="lg"
              onClick={() => {
                const listingId = pendingDuplicateId;
                const unsavedDraftId = pendingUnsavedDraftId;
                setPendingDuplicateId(null);
                setPendingUnsavedDraftId(null);
                if (listingId) void runDuplicate(listingId, true, unsavedDraftId ?? undefined);
              }}
            >
              Replace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ContentLayout>
  );
}

function SellAnItemControl({
  label = 'Sell an item',
  variant = 'default',
  size = 'default',
  needsApproval,
  approvalVisible,
  onRequestApproval,
}: {
  label?: string;
  variant?: 'default' | 'secondary';
  size?: 'default' | 'sm';
  needsApproval: boolean;
  approvalVisible: boolean;
  onRequestApproval: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {needsApproval ? (
        <Button
          variant={variant}
          size={size}
          className={size === 'sm' ? 'rounded-full text-xs font-bold' : 'rounded-full'}
          onClick={onRequestApproval}
          aria-expanded={approvalVisible}
          aria-haspopup="dialog"
        >
          <Plus className="size-4" aria-hidden="true" />
          {label}
        </Button>
      ) : (
        <Button
          asChild
          variant={variant}
          size={size}
          className={size === 'sm' ? 'rounded-full text-xs font-bold' : 'rounded-full'}
        >
          <Link href={MARKETPLACE_ROUTES.SELL} overrideDefaults>
            <Plus className="size-4" aria-hidden="true" />
            {label}
          </Link>
        </Button>
      )}
    </div>
  );
}

type DashboardMetrics = ReturnType<typeof useMarketplaceSellerDashboard>['metrics'];

function dashboardKpis(metrics: DashboardMetrics) {
  return [
    { label: 'Active listings', value: metrics.activeListings, icon: ShoppingBag },
    { label: 'Inventory', value: metrics.totalInventory, icon: Package },
    { label: 'Low stock', value: metrics.lowStock, icon: Package },
    { label: 'Paid orders', value: metrics.paidOrders, icon: Banknote },
    {
      // In sandbox mode this number is simulated and must say so; in the
      // durable modes it reflects real orders. One figure per pricing asset.
      label: getCommerceAdapterMode() === 'sandbox' ? 'Sandbox revenue' : 'Revenue',
      value: metrics.revenue.length
        ? metrics.revenue.map(formatCommerceMoney).join(' + ')
        : formatCommerceMoney({ amountMinor: 0, currency: 'USD', exponent: 2 }),
      icon: TrendingUp,
    },
  ];
}

function ListingThumbnail({ mediaUrls, title }: { mediaUrls: readonly string[]; title: string }) {
  const [failed, setFailed] = useState(false);
  const mediaUrl = useMarketplaceFirstMediaUrl(mediaUrls);

  if (mediaUrl !== null && !failed) {
    return (
      <div className="relative size-10 shrink-0 overflow-hidden rounded-lg border bg-card">
        <Image
          src={mediaUrl}
          alt={`${title} thumbnail`}
          fill
          sizes="40px"
          className="absolute inset-0 object-cover object-center"
          onError={() => setFailed(true)}
        />
      </div>
    );
  }

  return (
    <div
      className="flex size-10 shrink-0 items-center justify-center rounded-lg border bg-muted text-muted-foreground"
      aria-label={`No thumbnail for ${title}`}
    >
      <ImageIcon className="size-4" />
    </div>
  );
}
