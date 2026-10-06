'use client';

import { Banknote } from 'lucide-react';
import { getMarketplacePaymentSettingsRoute, MARKETPLACE_ROUTES } from '@/app/routes';
import { Button } from '@/atoms/Button/Button';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import {
  LISTING_COMPOSER_PAYMENT_COPY,
  LISTING_PUBLISH_GUARD_CHECKING,
  rememberListingComposerReturnTo,
} from '@/libs/commerce/listing-publish-guards';

export function ListingComposerPaymentInterstitial({ checking = false }: { checking?: boolean }) {
  const settingsHref = getMarketplacePaymentSettingsRoute(MARKETPLACE_ROUTES.SELL);

  return (
    <div
      data-surface="listing-payment-setup"
      className="flex flex-col gap-5 rounded-xl border border-border p-6 sm:p-8"
    >
      <div className="flex items-start gap-3">
        <Banknote className="mt-1 size-6 shrink-0 text-brand" aria-hidden />
        <div className="flex flex-col gap-2">
          <Heading level={2} size="lg">
            {LISTING_COMPOSER_PAYMENT_COPY.title}
          </Heading>
          <Typography as="p" className="max-w-xl text-muted-foreground">
            {checking ? LISTING_PUBLISH_GUARD_CHECKING : LISTING_COMPOSER_PAYMENT_COPY.body}
          </Typography>
        </div>
      </div>
      {!checking ? (
        <Button asChild className="w-fit rounded-full">
          <Link
            href={settingsHref}
            overrideDefaults
            onClick={() => rememberListingComposerReturnTo(MARKETPLACE_ROUTES.SELL)}
          >
            Payment settings
          </Link>
        </Button>
      ) : null}
    </div>
  );
}
