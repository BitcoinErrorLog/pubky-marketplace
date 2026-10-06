import { Card, CardContent } from '@/atoms/Card/Card';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';

/** Mirrors the cart two-column layout (items left, checkout panel right) while rows load. */
export function MarketplaceCartSkeleton() {
  return (
    <div data-testid="marketplace-cart-skeleton" className="grid gap-6 lg:grid-cols-[1fr_420px]">
      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Card key={index} className="border py-4">
            <CardContent className="flex items-center gap-4 px-4">
              <Skeleton className="size-20 shrink-0 rounded-xl" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-3/5" />
                <Skeleton className="h-3 w-1/3" />
                <Skeleton className="h-4 w-24" />
              </div>
              <Skeleton className="h-8 w-28" />
            </CardContent>
          </Card>
        ))}
      </div>
      <Card className="h-fit border">
        <CardContent className="grid gap-4 px-6">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-11 w-full rounded-full" />
        </CardContent>
      </Card>
    </div>
  );
}
