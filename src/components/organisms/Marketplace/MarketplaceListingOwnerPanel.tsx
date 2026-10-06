'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { EyeOff, LinkIcon, PencilLine, Play, Trash2 } from 'lucide-react';
import { getMarketplaceListingEditRoute, getMarketplaceListingRoute, MARKETPLACE_ROUTES } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/atoms/Dialog/Dialog';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { CommerceListingRecord } from '@/libs/commerce/marketplace-records';
import { Logger } from '@/libs/logger/logger';
import {
  type CommerceListingRegistrationStatus,
  isListingRegistrationPending,
} from '@/models/commerce/commerce.schema';
import { toast } from '@/molecules/Toaster/use-toast';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';

export interface MarketplaceListingOwnerPanelProps {
  record: CommerceListingRecord;
  registrationStatus?: CommerceListingRegistrationStatus;
}

/**
 * The seller's management strip on their own listing page: edit, unlist or
 * relist (the record contract's `paused`/`active` states), delete, and copy
 * the public link. Auctions cannot be unlisted here — pausing a live auction
 * would pull terms bidders already acted on, so only fixed-price listings
 * offer the pause/relist toggle.
 */
export function MarketplaceListingOwnerPanel({ record, registrationStatus }: MarketplaceListingOwnerPanelProps) {
  // Self-heal: listings published before durable-mode registration existed
  // (or while it failed) have no aggregate on the transaction service, which
  // makes them un-buyable. Registration is idempotent, so re-run it whenever
  // the owner views their listing — and again the moment a marketplace
  // session connects (the store object is replaced on connect), because
  // without a session the attempt cannot run and previously failed silently,
  // forcing a manual reload after connecting. Remaining failures stay quiet
  // here: the transactional surfaces own session guidance, buyers self-heal
  // via `listing.sync`, and the next visit retries.
  const marketplaceSession = useCommerceStore((state) => state.marketplaceSession);
  const retryRegistration = async () => {
    setIsMutating(true);
    const registered = await CommerceController.ensureListingRegistered(record);
    setIsMutating(false);
    if (registered) {
      toast({ title: 'Listing registered for checkout' });
      return;
    }
    toast({ description: 'Published, but not yet registered for checkout — retry from your listing' });
  };

  const canRegister = CommerceController.canRegisterListings();
  const registrationPending = isListingRegistrationPending({ registration_status: registrationStatus });
  useEffect(() => {
    if (!registrationPending || !marketplaceSession || !canRegister) return;
    void CommerceController.ensureListingRegistered(record);
  }, [record, registrationPending, marketplaceSession, canRegister]);

  const router = useRouter();
  // A page opened in a fresh tab renders from the persisted pubky before the homeserver session is restored;
  // a delete sent in that window fails with "Authenticated writes must target an owned path".
  const hasHomeserverSession = useAuthStore((state) => state.session !== null);
  const [isMutating, setIsMutating] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const canToggleVisibility = record.sale.format === 'fixed_price' && ['active', 'paused'].includes(record.state);

  const setListingState = async (state: 'active' | 'paused') => {
    setIsMutating(true);
    try {
      await CommerceController.commitUpsertListing({
        ...record,
        revision: record.revision + 1,
        state,
        updatedAt: new Date().toISOString(),
      });
      toast(
        state === 'paused'
          ? { title: 'Listing unlisted', description: 'Buyers can no longer purchase it. Relist it anytime.' }
          : { title: 'Listing relisted', description: 'Buyers can purchase it again.' },
      );
    } catch {
      toast({ variant: 'error', description: 'Could not update the listing state.' });
    } finally {
      setIsMutating(false);
    }
  };

  const deleteListing = async () => {
    if (!hasHomeserverSession) return;
    setIsMutating(true);
    try {
      await CommerceController.commitDeleteListing(record.ownerPubky, record.listingId);
      toast({ title: 'Listing deleted', description: 'The owner-signed record was removed from your homeserver.' });
      router.push(MARKETPLACE_ROUTES.DASHBOARD);
    } catch (error) {
      Logger.error('Failed to delete a marketplace listing', {
        listing: `${record.ownerPubky}:${record.listingId}`,
        error,
      });
      toast({ variant: 'error', description: 'Could not delete this listing.' });
      setIsMutating(false);
      setConfirmingDelete(false);
    }
  };

  const copyLink = async () => {
    const url = `${window.location.origin}${getMarketplaceListingRoute(record.ownerPubky, record.listingId)}`;
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: 'Link copied', description: 'Share it anywhere — the listing page is public.' });
    } catch {
      toast({ variant: 'error', description: 'Could not copy the link.' });
    }
  };

  return (
    <Card className="gap-4 border border-brand/30 bg-brand/5 py-5">
      <CardContent className="flex flex-col gap-3 px-5">
        <div className="flex items-center gap-2">
          <Typography as="p" className="text-sm font-semibold">
            Your listing
          </Typography>
          <Badge variant="secondary">{record.state}</Badge>
        </div>
        {registrationPending && !canRegister && (
          <Typography as="p" className="text-xs text-muted-foreground" data-testid="listing-registration-unsupported">
            This browser can&apos;t register listings for checkout. Update it or use another browser.
          </Typography>
        )}
        <div className="flex flex-wrap gap-2">
          {registrationPending && canRegister && (
            <Button
              size="sm"
              variant="secondary"
              className="rounded-full"
              disabled={isMutating}
              onClick={() => void retryRegistration()}
            >
              Register for checkout
            </Button>
          )}
          <Button asChild size="sm" className="rounded-full" disabled={isMutating}>
            <Link href={getMarketplaceListingEditRoute(record.ownerPubky, record.listingId)} overrideDefaults>
              <PencilLine className="mr-2 size-4" />
              Edit listing
            </Link>
          </Button>
          {canToggleVisibility &&
            (record.state === 'active' ? (
              <Button
                size="sm"
                variant="secondary"
                className="rounded-full"
                disabled={isMutating}
                onClick={() => void setListingState('paused')}
              >
                <EyeOff className="mr-2 size-4" />
                Unlist
              </Button>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                className="rounded-full"
                disabled={isMutating}
                onClick={() => void setListingState('active')}
              >
                <Play className="mr-2 size-4" />
                Relist
              </Button>
            ))}
          <Button size="sm" variant="secondary" className="rounded-full" onClick={() => void copyLink()}>
            <LinkIcon className="mr-2 size-4" />
            Copy link
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full text-destructive hover:text-destructive"
            disabled={isMutating || !hasHomeserverSession}
            onClick={() => setConfirmingDelete(true)}
          >
            <Trash2 className="mr-2 size-4" />
            Delete
          </Button>
        </div>
        {!hasHomeserverSession && (
          <Typography as="p" className="text-xs text-muted-foreground" data-testid="listing-delete-waiting-for-session">
            Delete is available once your session is restored.
          </Typography>
        )}
        {record.sale.format === 'auction' && (
          <Typography as="p" className="text-xs text-muted-foreground">
            Auctions cannot be unlisted: published auction terms stay live until the auction ends.
          </Typography>
        )}
      </CardContent>

      <Dialog open={confirmingDelete} onOpenChange={(next) => !isMutating && setConfirmingDelete(next)}>
        <DialogContent className="border-border bg-popover">
          <DialogHeader>
            <DialogTitle>Delete this listing?</DialogTitle>
            <DialogDescription>
              This removes the owner-signed record and its photos from your homeserver. Buyers will no longer be able to
              open it. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="secondary"
              className="rounded-full"
              disabled={isMutating}
              onClick={() => setConfirmingDelete(false)}
            >
              Keep listing
            </Button>
            <Button
              variant="destructive"
              className="rounded-full"
              disabled={isMutating || !hasHomeserverSession}
              onClick={() => void deleteListing()}
            >
              {isMutating ? 'Deleting…' : 'Delete listing'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
