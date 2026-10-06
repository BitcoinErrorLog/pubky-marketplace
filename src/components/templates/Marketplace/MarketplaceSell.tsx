'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, History, Rocket, ShieldCheck } from 'lucide-react';
import {
  APP_ROUTES,
  getMarketplaceListingEditRoute,
  getMarketplaceListingRoute,
  MARKETPLACE_ROUTES,
} from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useCreateMarketplaceListing } from '@/hooks/useCreateMarketplaceListing/useCreateMarketplaceListing';
import { CREATE_MARKETPLACE_LISTING_FIELDS } from '@/hooks/useCreateMarketplaceListing/useCreateMarketplaceListing.types';
import { useSellerPaymentMethodGate } from '@/hooks/useSellerPaymentMethodGate/useSellerPaymentMethodGate';
import { listingDraftResumePrompt, listingDraftTitleLabel } from '@/libs/commerce/listing-drafts';
import { ListingComposerPaymentInterstitial } from '@/molecules/Marketplace/ListingComposerPaymentInterstitial';
import { ListingPublishGuardNotice } from '@/molecules/Marketplace/ListingPublishGuardNotice';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { MarketplaceListingForm } from '@/organisms/Marketplace/MarketplaceListingForm';
import { MarketplaceSessionConnectDialog } from '@/organisms/Marketplace/MarketplaceSessionConnectDialog';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';

export function MarketplaceSell() {
  const router = useRouter();
  const listing = useCreateMarketplaceListing();
  const paymentGate = useSellerPaymentMethodGate();
  const [isPublishing, setIsPublishing] = useState(false);
  const [publishAfterSession, setPublishAfterSession] = useState(false);
  const blockComposer = paymentGate.isDurable && (!paymentGate.ready || paymentGate.reason === 'no-method');

  const publish = async () => {
    setIsPublishing(true);
    try {
      const compositeId = await listing.submit();
      if (!compositeId) return;
      const separator = compositeId.indexOf(':');
      const sellerPubky = compositeId.slice(0, separator);
      const listingId = compositeId.slice(separator + 1);
      // A listing published WITH pickup still needs its meeting point, and a
      // digital one still needs its delivery; both editors exist only
      // post-publish (the service accepts their commands for a registered
      // listing): land the seller on the edit page's delivery section
      // instead of the public page.
      const fulfillment = listing.form.getValues(CREATE_MARKETPLACE_LISTING_FIELDS.FULFILLMENT);
      router.push(
        fulfillment === 'shipping'
          ? getMarketplaceListingRoute(sellerPubky, listingId)
          : `${getMarketplaceListingEditRoute(sellerPubky, listingId)}#listing-section-shipping`,
      );
    } finally {
      setIsPublishing(false);
    }
  };

  const submit = async () => {
    if (isDurableCommerceMode(getCommerceAdapterMode()) && !useCommerceStore.getState().marketplaceSession) {
      await listing.flushDraft();
      const pubky = useAuthStore.getState().currentUserPubky;
      if (pubky && CommerceController.restorePersistedMarketplaceSession(pubky)) {
        await publish();
        return;
      }
      setPublishAfterSession(true);
      return;
    }
    await publish();
  };

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      disableMainContentOverflow
      className="pb-28 lg:pb-16"
      classNameWrapperContent="max-w-7xl"
    >
      <Container
        overrideDefaults
        data-surface="seller-studio"
        className="flex w-full flex-col gap-6 px-4 sm:px-6 lg:px-8"
      >
        <Link
          href={APP_ROUTES.MARKETPLACE}
          overrideDefaults
          className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Marketplace
        </Link>

        <div>
          <Badge className="mb-4">Seller studio</Badge>
          <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
            Create a listing
          </Heading>
          <Typography as="p" className="mt-3 max-w-2xl text-muted-foreground">
            Publish owner-signed item terms, inventory, delivery, returns, and either a fixed price or seven-day
            auction.
          </Typography>
          <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
            <ShieldCheck className="size-4 text-brand" />
            Drafts autosave locally. Images are sanitized and BLAKE3 hashed before upload.
          </div>
          <Link href={MARKETPLACE_ROUTES.SETTINGS} className="mt-2 inline-flex">
            Configure Paykit and Locks for digital delivery
          </Link>
        </div>

        {isDurableCommerceMode(getCommerceAdapterMode()) && (
          <div className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <Rocket className="mt-0.5 size-5 shrink-0 text-brand" />
              <div>
                <Typography as="p" className="font-semibold">
                  Drops — timed limited releases
                </Typography>
                <Typography as="p" className="text-sm text-muted-foreground">
                  Bundle listings into a scheduled release with limited quantities.
                </Typography>
              </div>
            </div>
            <Button asChild variant="secondary" className="shrink-0 rounded-full">
              <Link href={MARKETPLACE_ROUTES.SELL_DROPS} overrideDefaults>
                Open Drops
              </Link>
            </Button>
          </div>
        )}

        {blockComposer ? (
          <ListingComposerPaymentInterstitial checking={!paymentGate.ready} />
        ) : (
          <>
            {listing.pendingRestore && (
              <div
                role="status"
                data-surface="listing-draft-restore-prompt"
                className="flex flex-col gap-3 rounded-xl border border-brand/30 bg-brand/5 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-start gap-3">
                  <History className="mt-0.5 size-5 shrink-0 text-brand" />
                  <div>
                    <Typography as="p" className="font-semibold">
                      {listingDraftResumePrompt(listing.pendingRestore.updatedAt, Date.now())}
                    </Typography>
                    <Typography as="p" className="text-sm text-muted-foreground">
                      {listingDraftTitleLabel(listing.pendingRestore.title)}
                      {listing.pendingRestore.extraCount > 0
                        ? ` · ${listing.pendingRestore.extraCount} more in Seller studio`
                        : ''}
                    </Typography>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button className="rounded-full" size="sm" onClick={listing.resumeDraft}>
                    Resume
                  </Button>
                  <Button variant="secondary" size="sm" className="rounded-full" onClick={listing.reset}>
                    Discard
                  </Button>
                </div>
              </div>
            )}

            {listing.restoredDraft && !listing.pendingRestore && (
              <div
                role="status"
                data-surface="listing-draft-restored"
                className="flex flex-col gap-3 rounded-xl border border-brand/30 bg-brand/5 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-start gap-3">
                  <History className="mt-0.5 size-5 shrink-0 text-brand" />
                  <div>
                    <Typography as="p" className="font-semibold">
                      {listing.seededFromTitle ? `Draft created from ${listing.seededFromTitle}` : 'Draft restored'}
                    </Typography>
                    <Typography as="p" className="text-sm text-muted-foreground">
                      {listing.seededFromTitle
                        ? [
                            listing.seededAuctionAsFixedPrice ? 'Auction listings are copied as fixed price.' : null,
                            'Photos were not copied from the published listing.',
                          ]
                            .filter(Boolean)
                            .join(' ')
                        : 'We loaded your unfinished listing from this device, including photos saved on it.'}
                    </Typography>
                  </div>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  className="shrink-0 rounded-full"
                  disabled={isPublishing}
                  onClick={listing.reset}
                >
                  Discard draft and start fresh
                </Button>
              </div>
            )}

            {listing.publishBlocked && (
              <ListingPublishGuardNotice
                reason={listing.publishBlocked}
                surface="seller-publish-blocked"
                density="banner"
                returnTo={MARKETPLACE_ROUTES.SELL}
                onSessionConnected={async () => {
                  setPublishAfterSession(false);
                  await publish();
                }}
              />
            )}

            <MarketplaceListingForm
              form={listing.form}
              media={listing.media}
              onSubmit={submit}
              isPublishing={isPublishing}
              initialActiveSectionId={listing.activeSectionId}
              onActiveSectionChange={listing.setActiveSectionId}
              publishBlocked={listing.publishBlocked}
              publishGuardReady={listing.publishGuardReady}
              returnTo={MARKETPLACE_ROUTES.SELL}
              onSessionConnected={async () => {
                setPublishAfterSession(false);
                await publish();
              }}
            />
            {publishAfterSession && (
              <MarketplaceSessionConnectDialog
                autoOpen
                onConnected={async () => {
                  setPublishAfterSession(false);
                  await publish();
                }}
              />
            )}
          </>
        )}
      </Container>
    </ContentLayout>
  );
}
