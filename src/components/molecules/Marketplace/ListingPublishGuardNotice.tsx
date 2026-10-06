'use client';

import { getMarketplacePaymentSettingsRoute, MARKETPLACE_ROUTES } from '@/app/routes';
import { Button } from '@/atoms/Button/Button';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import {
  LISTING_PUBLISH_BLOCK_COPY,
  type ListingPublishBlockReason,
  rememberListingComposerReturnTo,
} from '@/libs/commerce/listing-publish-guards';
import { MarketplaceSessionConnectDialog } from '@/organisms/Marketplace/MarketplaceSessionConnectDialog';

export function ListingPublishGuardNotice({
  reason,
  surface,
  id,
  density = 'banner',
  returnTo,
  onSessionConnected,
}: {
  reason: ListingPublishBlockReason;
  surface: string;
  id?: string;
  density?: 'banner' | 'action';
  returnTo?: string;
  onSessionConnected?: () => void | Promise<void>;
}) {
  const copy = LISTING_PUBLISH_BLOCK_COPY[reason];
  const needsSession = reason === 'session' || reason === 'unverified';

  return (
    <div
      role="alert"
      id={id}
      data-surface={surface}
      className={
        density === 'action'
          ? 'rounded-xl border border-amber-500/40 bg-amber-500/10 p-3'
          : 'rounded-xl border border-amber-500/40 bg-amber-500/10 p-4'
      }
      tabIndex={-1}
    >
      <Typography as="p" className="font-semibold">
        {copy.title}
      </Typography>
      <Typography as="p" className="mt-1 text-sm text-muted-foreground">
        {copy.body}
      </Typography>
      {reason === 'no-method' ? (
        <Button asChild variant="link" className="mt-2 h-auto p-0">
          <Link
            href={getMarketplacePaymentSettingsRoute(returnTo ?? MARKETPLACE_ROUTES.SELL)}
            overrideDefaults
            onClick={() => rememberListingComposerReturnTo(returnTo ?? MARKETPLACE_ROUTES.SELL)}
          >
            Payment settings
          </Link>
        </Button>
      ) : needsSession ? (
        <div className="mt-3">
          <MarketplaceSessionConnectDialog
            triggerLabel="Connect marketplace session"
            onConnected={onSessionConnected}
          />
        </div>
      ) : null}
    </div>
  );
}
