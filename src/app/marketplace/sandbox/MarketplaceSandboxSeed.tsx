'use client';

import { useState } from 'react';
import { ArrowLeft, Database } from 'lucide-react';
import { APP_ROUTES } from '@/app/routes';
import { Button } from '@/atoms/Button/Button';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import { CommerceController } from '@/controllers/commerce/commerce';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';

type SeedState = 'idle' | 'seeding' | 'seeded' | 'error';

export function MarketplaceSandboxSeed() {
  const [seedState, setSeedState] = useState<SeedState>('idle');

  const seedCatalog = async () => {
    setSeedState('seeding');
    try {
      await CommerceController.initializeSandboxCatalog();
      setSeedState('seeded');
    } catch {
      setSeedState('error');
    }
  };

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      className="pb-28"
      classNameWrapperContent="max-w-4xl"
    >
      <Container overrideDefaults className="flex w-full flex-col gap-6 px-4 sm:px-6">
        <Link href={APP_ROUTES.MARKETPLACE} overrideDefaults className="inline-flex w-fit items-center gap-2 text-sm">
          <ArrowLeft className="size-4" />
          Marketplace
        </Link>
        <div>
          <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
            Sandbox demo data
          </Heading>
          <Typography as="p" className="mt-2 text-muted-foreground">
            This deployment runs the marketplace in simulated sandbox mode. Seeding loads a fictional demo catalog (fake
            sellers, fake listings) into this browser and registers it with the sandbox transaction service. No real
            sellers, payments, or funds are involved.
          </Typography>
        </div>

        <div className="flex flex-col items-start gap-3">
          <Button onClick={seedCatalog} disabled={seedState === 'seeding'} className="gap-2">
            <Database className="size-4" />
            {seedState === 'seeding' ? 'Seeding…' : 'Seed sandbox catalog'}
          </Button>

          {seedState === 'seeded' && (
            <div
              role="status"
              className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-emerald-200"
            >
              Sandbox catalog seeded. Browse the marketplace to see the demo listings.
            </div>
          )}
          {seedState === 'error' && (
            <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-foreground">
              Seeding failed. Check that the sandbox transaction service is running and reachable.
            </div>
          )}
        </div>
      </Container>
    </ContentLayout>
  );
}
