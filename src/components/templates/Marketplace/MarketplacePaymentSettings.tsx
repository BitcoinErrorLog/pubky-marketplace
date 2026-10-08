'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowRight, SlidersHorizontal } from 'lucide-react';
import { readMarketplaceListingComposerReturnTo } from '@/app/routes';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
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
import { BackToMyShop } from '@/molecules/Marketplace/BackToMyShop';
import { SettingsSectionContent } from '@/molecules/Settings/SettingsSectionContent/SettingsSectionContent';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { MarketplaceGetPaidSettings } from '@/organisms/Marketplace/MarketplaceGetPaidSettings';
import { MarketplaceSectionNav } from '@/organisms/Marketplace/MarketplaceSectionNav';
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
    >
      <Container overrideDefaults className="flex w-full flex-col gap-6">
        <MarketplaceSectionNav />
        <BackToMyShop />
        <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
              Payment settings
            </Heading>
            <Typography as="p" className="mt-2 text-muted-foreground">
              Manage your payment methods and preferences.
            </Typography>
          </div>
          {returnPath && (
            <div data-testid="listing-composer-return" className="shrink-0">
              {canContinue ? (
                <Button onClick={resumeComposer}>
                  Continue listing
                  <ArrowRight className="size-4" />
                </Button>
              ) : (
                <Button asChild variant="secondary" className="w-fit">
                  <Link href={returnPath} overrideDefaults>
                    <ArrowLeft className="size-4" />
                    Back to listing
                  </Link>
                </Button>
              )}
            </div>
          )}
        </div>

        <MarketplaceGetPaidSettings locksConnect={locksConnect} onSaved={onPaymentSaved} />

        <Card className="rounded-md p-0 shadow-lg">
          <CardContent className="grid gap-6 p-6">
            <div className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-x-3">
              <SlidersHorizontal className="size-6 shrink-0 text-brand" />
              <Heading level={2} size="md">
                Display preferences
              </Heading>
              <Typography as="p" className="col-start-2 text-sm text-muted-foreground">
                Saved on this device.
              </Typography>
            </div>

            <SettingsSectionContent>
              <div className="flex items-center justify-between gap-4">
                <div>
                  <Typography as="label" htmlFor="marketplace-fx-estimate" className="block text-sm font-semibold">
                    Approximate price conversions
                  </Typography>
                  <Typography as="p" className="text-sm text-muted-foreground">
                    Show estimated conversions. Your payment currency stays the same.
                  </Typography>
                </div>
                <Switch
                  id="marketplace-fx-estimate"
                  checked={showFxEstimate}
                  onCheckedChange={setShowFxEstimate}
                  aria-label="Show approximate price conversions"
                />
              </div>

              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <Typography
                    as="label"
                    htmlFor="marketplace-measurement-system"
                    className="block text-sm font-semibold"
                  >
                    Measurement system
                  </Typography>
                  <Typography as="p" className="text-sm text-muted-foreground">
                    Units for package size and weight.
                  </Typography>
                </div>
                <Select
                  value={measurementSystem ?? 'auto'}
                  onValueChange={(value) =>
                    setMeasurementSystem(value === 'auto' ? null : (value as 'metric' | 'imperial'))
                  }
                >
                  <SelectTrigger
                    theme="secondary"
                    id="marketplace-measurement-system"
                    className="w-full shrink-0 sm:w-56"
                    aria-label="Measurement system"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Automatic</SelectItem>
                    <SelectItem value="metric">Metric (cm, g)</SelectItem>
                    <SelectItem value="imperial">Imperial (in, oz)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </SettingsSectionContent>
          </CardContent>
        </Card>

        {isSocialLinkOutEnabled() && <MarketplaceSignOutCard />}
      </Container>
    </ContentLayout>
  );
}
