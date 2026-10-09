import type { LucideIcon } from 'lucide-react';
import { APP_ROUTES } from '@/app/routes';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';

export function MarketplaceEmptyState({
  icon: Icon,
  title,
  description,
  surface,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  surface?: string;
}) {
  return (
    <Card className="rounded-md p-0" data-surface={surface}>
      <CardContent className="p-6">
        <div className="flex min-h-48 flex-col items-center justify-center rounded-md bg-card/40 p-6 text-center">
          <Icon className="mb-4 size-10 text-muted-foreground" aria-hidden="true" />
          <Heading level={2} size="md">
            {title}
          </Heading>
          <Typography as="p" className="mt-2 text-muted-foreground">
            {description}
          </Typography>
          <Button asChild variant="secondary" className="mt-6 rounded-full">
            <Link href={APP_ROUTES.MARKETPLACE} overrideDefaults>
              Browse marketplace
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
