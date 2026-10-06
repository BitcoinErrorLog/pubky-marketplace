'use client';

import { ArrowLeft, CalendarClock, SearchX } from 'lucide-react';
import { APP_ROUTES } from '@/app/routes';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Typography } from '@/atoms/Typography/Typography';
import { isDurableCommerceMode } from '@/config/commerce';
import type { DropStreamBucket, NexusDropStreamEntry } from '@/hooks/useMarketplaceDrops/drops-stream';
import { useMarketplaceDrops } from '@/hooks/useMarketplaceDrops/useMarketplaceDrops';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { DropCard } from '@/organisms/Marketplace/DropCard';

const SECTION_TITLES: Record<DropStreamBucket, string> = {
  upcoming: 'Upcoming',
  live: 'Start time passed',
  ended: 'End time passed',
};

const SECTION_ORDER: DropStreamBucket[] = ['live', 'upcoming', 'ended'];

export const DROPS_INDEX_CAVEAT = 'Discover timed, limited releases. Open a drop to check availability.';

/**
 * The drops calendar (drops design, "Discovery and hype surfaces"): indexed
 * drops in estimate buckets, cards that carry estimate-labeled countdowns,
 * and an honest empty state when the deployment's Nexus does not index
 * drops yet. Nothing here ever claims `live` — the drop page hydrates the
 * authoritative service projection on open.
 */
export function MarketplaceDrops() {
  const { buckets, isIndexed, isLoading, error, adapterMode } = useMarketplaceDrops();
  const totalCount = SECTION_ORDER.reduce((count, bucket) => count + buckets[bucket].length, 0);

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      className="pb-28 lg:pb-16"
      classNameWrapperContent="max-w-7xl"
    >
      <Container
        overrideDefaults
        data-surface="marketplace-drops"
        className="flex w-full flex-col gap-6 px-4 sm:px-6 lg:px-8"
      >
        <Link
          href={APP_ROUTES.MARKETPLACE}
          overrideDefaults
          className="inline-flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          Marketplace
        </Link>
        <div>
          <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
            Drops
          </Heading>
          <Typography as="p" className="mt-2 max-w-2xl text-muted-foreground">
            {DROPS_INDEX_CAVEAT}
          </Typography>
        </div>

        {!isDurableCommerceMode(adapterMode) ? (
          <EmptyState
            icon={<CalendarClock className="mb-3 size-10 text-muted-foreground" />}
            title="Drops are not available here"
            body="Drops are unavailable here."
          />
        ) : isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Skeleton className="h-64 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
        ) : error ? (
          <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-amber-200">
            {error}
          </div>
        ) : !isIndexed ? (
          <EmptyState
            icon={<SearchX className="mb-3 size-10 text-muted-foreground" />}
            title="Drop discovery isn't indexed on this deployment yet"
            body="The Nexus here does not serve the drops stream, so there is no calendar to show — open a drop by link and it works normally, including the live claim."
          />
        ) : totalCount === 0 ? (
          <EmptyState
            icon={<CalendarClock className="mb-3 size-10 text-muted-foreground" />}
            title="No drops indexed yet"
            body="When sellers announce drops, they appear here — upcoming first."
          />
        ) : (
          SECTION_ORDER.map((bucket) => <DropSection key={bucket} bucket={bucket} entries={buckets[bucket]} />)
        )}
      </Container>
    </ContentLayout>
  );
}

function DropSection({ bucket, entries }: { bucket: DropStreamBucket; entries: NexusDropStreamEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <section aria-label={SECTION_TITLES[bucket]} className="flex flex-col gap-3">
      <Heading level={2} size="md">
        {SECTION_TITLES[bucket]}
      </Heading>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry) => (
          <DropCard key={`${entry.owner_id}:${entry.id}`} entry={entry} bucket={bucket} />
        ))}
      </div>
    </section>
  );
}

function EmptyState({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-xl border border-dashed bg-card/40 p-8 text-center">
      {icon}
      <Heading level={2} size="md">
        {title}
      </Heading>
      <Typography as="p" className="mt-2 max-w-lg text-sm text-muted-foreground">
        {body}
      </Typography>
    </div>
  );
}
