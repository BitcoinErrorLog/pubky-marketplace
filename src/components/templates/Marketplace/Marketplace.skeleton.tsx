import { Card, CardContent } from '@/atoms/Card/Card';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { COMMERCE_CATALOG_SKELETON_COUNT } from '@/config/commerce';

export function MarketplaceSkeleton({ count = COMMERCE_CATALOG_SKELETON_COUNT }: { count?: number }) {
  return (
    <div data-testid="marketplace-skeleton" className="grid grid-cols-2 gap-6 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: count }, (_, index) => (
        <Card key={index} className="gap-0 overflow-hidden py-0">
          <Skeleton className="aspect-[4/5] w-full rounded-none" />
          <CardContent className="flex flex-col gap-3 p-4">
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

/** Mirrors the listing detail layout (media pane beside title/price/actions) while the record loads. */
export function MarketplaceListingDetailSkeleton() {
  return (
    <div data-testid="marketplace-listing-skeleton" className="grid gap-6 lg:grid-cols-2 lg:gap-10">
      <div className="flex flex-col gap-3">
        <Skeleton className="aspect-[4/3] w-full rounded-xl" />
        <div className="flex gap-2">
          <Skeleton className="size-16 rounded-lg" />
          <Skeleton className="size-16 rounded-lg" />
          <Skeleton className="size-16 rounded-lg" />
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <Skeleton className="h-5 w-24" />
        <Skeleton className="h-9 w-4/5" />
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-2/5" />
        <div className="mt-2 flex flex-col gap-2">
          <Skeleton className="h-11 w-full rounded-full" />
          <Skeleton className="h-11 w-full rounded-full" />
        </div>
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    </div>
  );
}
