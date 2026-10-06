'use client';

import { ArrowLeft, ExternalLink, LayoutDashboard, Package } from 'lucide-react';
import { useWatch } from 'react-hook-form';
import { getMarketplaceShopRoute, MARKETPLACE_ROUTES } from '@/app/routes';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import { useMarketplaceShopSettings } from '@/hooks/useMarketplaceShopSettings/useMarketplaceShopSettings';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { MarketplaceSectionNav } from '@/organisms/Marketplace/MarketplaceSectionNav';
import { MarketplaceShopSettingsFormView } from '@/organisms/Marketplace/MarketplaceShopSettingsForm';
import { ShopProfileCard } from '@/organisms/Marketplace/ShopProfileCard/ShopProfileCard';
import { useAuthStore } from '@/stores/auth/auth.store';

export function MarketplaceMyShop() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const settings = useMarketplaceShopSettings();
  const [name, bio, countryCode, region, vacationMode] = useWatch({
    control: settings.form.control,
    name: ['name', 'bio', 'countryCode', 'region', 'vacationMode'],
  });
  const previewName = String(name ?? '').trim() || 'Your shop name';
  const previewBio = String(bio ?? '').trim() || 'Your shop bio will appear here as buyers see it.';
  const previewCountryCode = String(countryCode ?? '')
    .trim()
    .toUpperCase();
  const previewRegion = String(region ?? '').trim();

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
        <Link
          href={MARKETPLACE_ROUTES.DASHBOARD}
          overrideDefaults
          className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Seller studio
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Badge className="mb-4">Seller studio</Badge>
            <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
              My shop
            </Heading>
            <Typography as="p" className="mt-2 max-w-xl text-muted-foreground">
              Your public storefront: the name, bio, and policies buyers see on your shop page and from every listing
              you publish.
            </Typography>
          </div>
          <div className="flex flex-wrap gap-2">
            {currentUserPubky && (
              <Button asChild variant="secondary" className="rounded-full">
                <Link href={getMarketplaceShopRoute(currentUserPubky)} overrideDefaults>
                  View public shop page
                  <ExternalLink className="ml-2 size-4" />
                </Link>
              </Button>
            )}
            <Button asChild variant="ghost" className="rounded-full">
              <Link href={MARKETPLACE_ROUTES.SETTINGS_SHIPPING} overrideDefaults>
                <Package className="mr-2 size-4" />
                Shipping presets
              </Link>
            </Button>
            <Button asChild variant="ghost" className="rounded-full">
              <Link href={MARKETPLACE_ROUTES.DASHBOARD} overrideDefaults>
                <LayoutDashboard className="mr-2 size-4" />
                Dashboard
              </Link>
            </Button>
          </div>
        </div>

        <ShopProfileCard
          variant="mini"
          name={previewName}
          bio={previewBio}
          avatarUrl={settings.avatar.previewUrl}
          bannerUrl={settings.banner.previewUrl}
          location={{ countryCode: previewCountryCode, region: previewRegion }}
          vacation={Boolean(vacationMode)}
          bannerAlt={`${previewName} banner preview`}
          avatarAlt={`${previewName} avatar preview`}
          testId="shop-live-preview"
        />

        <MarketplaceShopSettingsFormView settings={settings} />
      </Container>
    </ContentLayout>
  );
}
