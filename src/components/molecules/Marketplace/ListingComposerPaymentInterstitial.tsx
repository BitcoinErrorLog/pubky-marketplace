'use client';

import { Banknote } from 'lucide-react';
import { getMarketplacePaymentSettingsRoute, MARKETPLACE_ROUTES } from '@/app/routes';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
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
    <Card data-surface="listing-payment-setup" className="rounded-md p-0">
      <CardContent className="flex flex-col gap-6 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <Banknote className="mt-0.5 size-6 shrink-0 text-brand" aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-2">
            <Heading level={2} size="md">
              {LISTING_COMPOSER_PAYMENT_COPY.title}
            </Heading>
            <Typography as="p" size="sm" className="text-muted-foreground">
              {checking ? LISTING_PUBLISH_GUARD_CHECKING : LISTING_COMPOSER_PAYMENT_COPY.body}
            </Typography>
          </div>
        </div>
        {!checking ? (
          <Button asChild className="w-fit shrink-0 rounded-full">
            <Link
              href={settingsHref}
              overrideDefaults
              onClick={() => rememberListingComposerReturnTo(MARKETPLACE_ROUTES.SELL)}
            >
              Payment settings
            </Link>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}
