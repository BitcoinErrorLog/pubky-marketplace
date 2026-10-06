'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, SlidersHorizontal, Store } from 'lucide-react';
import { APP_ROUTES, MARKETPLACE_ROUTES, readMarketplaceListingComposerReturnTo } from '@/app/routes';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Label } from '@/atoms/Label/Label';
import { Link } from '@/atoms/Link/Link';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/atoms/Select/Select';
import { Switch } from '@/atoms/Switch/Switch';
import { Typography } from '@/atoms/Typography/Typography';
import { isSocialLinkOutEnabled } from '@/config/social';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useMarketplaceLocksConnect } from '@/hooks/useMarketplaceLocksConnect/useMarketplaceLocksConnect';
import {
  consumeListingComposerReturnTo,
  peekListingComposerReturnTo,
  rememberListingComposerReturnTo,
} from '@/libs/commerce/listing-publish-guards';
import { availablePaymentMethods, type SellerPaymentConfigOwnView } from '@/libs/commerce/payment-methods';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { MarketplaceGetPaidSettings } from '@/organisms/Marketplace/MarketplaceGetPaidSettings';
import { MarketplaceSignOutCard } from '@/organisms/Marketplace/MarketplaceSignOutCard';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useMarketplaceDisplayStore } from '@/stores/marketplace-display/marketplace-display.store';

function ownViewLooksBuyerPayable(config: SellerPaymentConfigOwnView): boolean {
  return Boolean(config.paypalMerchantEmail || config.bitcoinEnabled);
}

export function MarketplacePaymentSettings() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const locksConnect = useMarketplaceLocksConnect();
  const showFxEstimate = useMarketplaceDisplayStore((state) => state.showFxEstimate);
  const setShowFxEstimate = useMarketplaceDisplayStore((state) => state.setShowFxEstimate);
  const measurementSystem = useMarketplaceDisplayStore((state) => state.measurementSystem);
  const setMeasurementSystem = useMarketplaceDisplayStore((state) => state.setMeasurementSystem);
  const returnPath =
    readMarketplaceListingComposerReturnTo(searchParams.get('returnTo')) ??
    readMarketplaceListingComposerReturnTo(peekListingComposerReturnTo());
  const [canContinue, setCanContinue] = useState(false);

  useEffect(() => {
    if (returnPath) rememberListingComposerReturnTo(returnPath);
  }, [returnPath]);

  useEffect(() => {
    if (!returnPath || !currentUserPubky) {
      setCanContinue(false);
      return;
    }
    let active = true;
    void CommerceController.getSellerPaymentConfig(currentUserPubky)
      .then((config) => {
        if (active) setCanContinue(availablePaymentMethods(config).length > 0);
      })
      .catch(() => {
        if (active) setCanContinue(false);
      });
    return () => {
      active = false;
    };
  }, [currentUserPubky, returnPath]);

  const resumeComposer = () => {
    if (!returnPath) return;
    consumeListingComposerReturnTo();
    router.push(returnPath);
  };

  const onPaymentSaved = (config: SellerPaymentConfigOwnView) => {
    if (!returnPath) return;
    if (ownViewLooksBuyerPayable(config)) {
      setCanContinue(true);
      resumeComposer();
    }
  };

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
        <Link
          href={returnPath ?? APP_ROUTES.MARKETPLACE}
          overrideDefaults
          className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground"
        >
          <ArrowLeft className="size-4" />
          {returnPath ? 'Back to listing' : 'Marketplace'}
        </Link>
        <div>
          <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
            How you get paid
          </Heading>
          <Typography as="p" className="mt-2 text-muted-foreground">
            Set up the methods buyers can use at checkout.
          </Typography>
        </div>

        {returnPath ? (
          <div
            data-testid="listing-composer-return"
            className="flex flex-col gap-3 rounded-xl border border-border p-4 sm:flex-row sm:items-center sm:justify-between"
          >
            <Typography as="p" className="text-sm text-muted-foreground">
              After at least one payment method is configured, continue creating your listing.
            </Typography>
            <Button className="shrink-0 rounded-full" disabled={!canContinue} onClick={resumeComposer}>
              Continue creating listing
            </Button>
          </div>
        ) : null}

        <MarketplaceGetPaidSettings locksConnect={locksConnect} onSaved={onPaymentSaved} />

        <Card className="border">
          <CardContent className="flex flex-col gap-3 px-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-3">
              <Store className="mt-1 size-5 text-brand" />
              <div>
                <Typography as="h2" className="font-semibold">
                  Looking for your shop name and policies?
                </Typography>
                <Typography as="p" className="text-sm text-muted-foreground">
                  Storefront settings live under My shop, next to your listings.
                </Typography>
              </div>
            </div>
            <Button asChild variant="secondary" className="shrink-0 rounded-full">
              <Link href={MARKETPLACE_ROUTES.MY_SHOP} overrideDefaults>
                Open My shop
              </Link>
            </Button>
          </CardContent>
        </Card>

        <Card className="border">
          <CardContent className="grid gap-5 px-6">
            <div className="flex gap-3">
              <SlidersHorizontal className="mt-1 size-5 text-brand" />
              <div>
                <Typography as="h2" className="font-semibold">
                  Display preferences
                </Typography>
                <Typography as="p" className="text-sm text-muted-foreground">
                  How prices and package details render for you, stored on this device. Neither setting changes any
                  listing record or payment amount.
                </Typography>
              </div>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="marketplace-fx-estimate" className="font-medium">
                  Approximate price conversions
                </Label>
                <Typography as="p" className="text-sm text-muted-foreground">
                  Show &ldquo;≈&rdquo; estimates beside prices (fiat ↔ bitcoin) at the current exchange rate. Indicative
                  only — payments always settle in the listing&rsquo;s own pricing asset.
                </Typography>
              </div>
              <Switch
                id="marketplace-fx-estimate"
                checked={showFxEstimate}
                onCheckedChange={setShowFxEstimate}
                aria-label="Show approximate price conversions"
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="marketplace-measurement-system" className="font-medium">
                  Measurement system
                </Label>
                <Typography as="p" className="text-sm text-muted-foreground">
                  Units for package dimensions and weight. Records always store exact millimeters and grams.
                </Typography>
              </div>
              <Select
                value={measurementSystem ?? 'auto'}
                onValueChange={(value) =>
                  setMeasurementSystem(value === 'auto' ? null : (value as 'metric' | 'imperial'))
                }
              >
                <SelectTrigger
                  id="marketplace-measurement-system"
                  className="h-11 w-56 shrink-0 rounded-md border px-3"
                  aria-label="Measurement system"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Automatic (from locale)</SelectItem>
                  <SelectItem value="metric">Metric (cm, g)</SelectItem>
                  <SelectItem value="imperial">Imperial (in, oz)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {isSocialLinkOutEnabled() && <MarketplaceSignOutCard />}
      </Container>
    </ContentLayout>
  );
}
