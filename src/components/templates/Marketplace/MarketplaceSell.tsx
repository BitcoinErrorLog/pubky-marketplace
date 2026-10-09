'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, History, Rocket } from 'lucide-react';
import { getMarketplaceListingEditRoute, getMarketplaceListingRoute, MARKETPLACE_ROUTES } from '@/app/routes';
import { Button } from '@/atoms/Button/Button';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useCreateMarketplaceListing } from '@/hooks/useCreateMarketplaceListing/useCreateMarketplaceListing';
import { CREATE_MARKETPLACE_LISTING_FIELDS } from '@/hooks/useCreateMarketplaceListing/useCreateMarketplaceListing.types';
import { useMarketplaceSellingAccess } from '@/hooks/useMarketplaceSellingAccess/useMarketplaceSellingAccess';
import { useSellerPaymentMethodGate } from '@/hooks/useSellerPaymentMethodGate/useSellerPaymentMethodGate';
import { listingDraftResumePrompt, listingDraftTitleLabel } from '@/libs/commerce/listing-drafts';
import { BackToMyShop } from '@/molecules/Marketplace/BackToMyShop';
import { ListingComposerPaymentInterstitial } from '@/molecules/Marketplace/ListingComposerPaymentInterstitial';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { MarketplaceListingForm } from '@/organisms/Marketplace/MarketplaceListingForm';
import { MarketplaceSectionNav } from '@/organisms/Marketplace/MarketplaceSectionNav';
import { MarketplaceSessionConnectDialog } from '@/organisms/Marketplace/MarketplaceSessionConnectDialog';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';

export function MarketplaceSell() {
  const router = useRouter();
  const access = useMarketplaceSellingAccess();
  const [approvedPubky, setApprovedPubky] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);

  useEffect(() => {
    if (access.allowed && access.pubky) setApprovedPubky(access.pubky);
  }, [access.allowed, access.pubky]);

  // Mount the composer only after approval. Later expiry is handled by its
  // existing publish-time check, preserving any draft already being edited.
  if (access.allowed || (approvedPubky !== null && approvedPubky === access.pubky)) {
    return <MarketplaceSellComposer />;
  }

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
    >
      {access.ready && !cancelled && (
        <MarketplaceSessionConnectDialog
          intent="sell"
          open
          hideTrigger
          onOpenChange={(open) => {
            if (!open) {
              // Successful approval closes the same dialog before onConnected.
              if (access.checkAccess()) setApprovedPubky(access.pubky);
              else {
                setCancelled(true);
                router.push(MARKETPLACE_ROUTES.DASHBOARD);
              }
            }
          }}
          onConnected={() => {
            if (access.checkAccess()) setApprovedPubky(access.pubky);
          }}
        />
      )}
    </ContentLayout>
  );
}

function MarketplaceSellComposer() {
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
      if (!compositeId) return false;
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
      return true;
    } finally {
      setIsPublishing(false);
    }
  };

  const submit = async () => {
    if (isDurableCommerceMode(getCommerceAdapterMode()) && !useCommerceStore.getState().marketplaceSession) {
      await listing.flushDraft();
      const pubky = useAuthStore.getState().currentUserPubky;
      if (pubky && CommerceController.restorePersistedMarketplaceSession(pubky)) {
        return await publish();
      }
      setPublishAfterSession(true);
      return false;
    }
    return await publish();
  };

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      disableMainContentOverflow
      className="pb-28 lg:pb-16"
    >
      <Container overrideDefaults data-surface="seller-studio" className="flex w-full flex-col gap-6">
        <MarketplaceSectionNav />
        <BackToMyShop />

        <div>
          <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
            Create a listing
          </Heading>
          <Typography as="p" className="mt-3 max-w-2xl text-muted-foreground">
            Add your item, set a price or start an auction, and choose how buyers receive it.
          </Typography>
        </div>

        {blockComposer && <ListingComposerPaymentInterstitial checking={!paymentGate.ready} />}

        {!blockComposer && (
          <>
            {listing.pendingRestore && (
              <div
                role="status"
                data-surface="listing-draft-restore-prompt"
                className="flex flex-col gap-3 rounded-md bg-brand/5 p-4 sm:flex-row sm:items-center sm:justify-between"
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
                className="flex flex-col gap-3 rounded-md bg-brand/5 p-4 sm:flex-row sm:items-center sm:justify-between"
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

            <MarketplaceListingForm
              sidebarFooter={
                paymentGate.isDurable && paymentGate.ready && paymentGate.reason === null ? (
                  <div className="flex flex-col gap-3">
                    <div className="flex items-center gap-2">
                      <Rocket className="size-5 shrink-0 text-brand" aria-hidden="true" />
                      <Heading level={2} size="sm">
                        Drops
                      </Heading>
                    </div>
                    <Typography as="p" size="sm" className="text-muted-foreground">
                      Bundle listings into a scheduled release with limited quantities.
                    </Typography>
                    <Button asChild variant="secondary" size="sm" className="w-full rounded-full">
                      <Link href={MARKETPLACE_ROUTES.SELL_DROPS} overrideDefaults>
                        Open Drops
                      </Link>
                    </Button>
                  </div>
                ) : undefined
              }
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
                intent="sell"
                autoOpen
                onConnected={async () => {
                  setPublishAfterSession(false);
                  await publish();
                }}
              />
            )}
          </>
        )}
        <Typography as="p" size="sm" className="flex items-center justify-center gap-2 text-muted-foreground">
          <Check className="size-4 shrink-0 text-brand" aria-hidden="true" />
          Drafts are saved locally
        </Typography>
      </Container>
    </ContentLayout>
  );
}
