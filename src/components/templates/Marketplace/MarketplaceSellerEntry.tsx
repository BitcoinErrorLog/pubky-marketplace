'use client';

import { ArrowLeft, CreditCard, Store } from 'lucide-react';
import { APP_ROUTES, MARKETPLACE_ROUTES } from '@/app/routes';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';

export function MarketplaceSellerEntry() {
  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      className="pb-28 lg:pb-16"
      classNameWrapperContent="max-w-7xl"
    >
      <Container overrideDefaults className="flex w-full flex-col gap-6 px-4 sm:px-6 lg:px-8">
        <Link
          href={APP_ROUTES.MARKETPLACE}
          overrideDefaults
          className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Marketplace
        </Link>

        <Card className="border-dashed">
          <CardContent className="flex min-h-80 flex-col items-center justify-center gap-5 p-8 text-center">
            <Store className="size-12 text-brand" />
            <div>
              <Heading level={1} size="lg">
                Set up your seller account to start listing
              </Heading>
              <Typography as="p" className="mt-2 max-w-xl text-muted-foreground">
                Add payment settings and shop details before sending buyers to your seller page.
              </Typography>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button asChild className="rounded-full">
                <Link href={MARKETPLACE_ROUTES.SETTINGS} overrideDefaults>
                  <CreditCard className="mr-2 size-4" />
                  Payment settings
                </Link>
              </Button>
              <Button asChild variant="secondary" className="rounded-full">
                <Link href={MARKETPLACE_ROUTES.MY_SHOP} overrideDefaults>
                  <Store className="mr-2 size-4" />
                  My Shop
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      </Container>
    </ContentLayout>
  );
}
