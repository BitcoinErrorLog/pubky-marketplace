'use client';

import { LogOut } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Heading } from '@/atoms/Heading/Heading';
import { Typography } from '@/atoms/Typography/Typography';
import { useSignOut } from '@/hooks/useSignOut/useSignOut';
import { useSignOutCopy } from '@/hooks/useSignOutCopy/useSignOutCopy';

/**
 * Shop sign-out for social link-out builds, where `/settings/account` (the
 * social settings page that otherwise holds sign-out) belongs to the social host.
 * Copy matches the account settings sign-out section.
 */
export function MarketplaceSignOutCard() {
  const { handleSignOut, isLoading } = useSignOut();
  const { title, description } = useSignOutCopy();

  return (
    <Card className="rounded-md p-0" data-testid="marketplace-sign-out-card">
      <CardContent className="flex flex-col gap-6 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-x-3">
          <LogOut className="size-6 shrink-0 text-brand" />
          <Heading level={2} size="md">
            {title}
          </Heading>
          <Typography as="p" className="col-start-2 text-sm text-muted-foreground">
            {description}
          </Typography>
        </div>
        <Button
          id="sign-out-btn"
          variant="secondary"
          className="w-fit shrink-0"
          disabled={isLoading}
          onClick={handleSignOut}
        >
          <LogOut className="size-4" />
          {isLoading ? 'Signing out...' : 'Sign out'}
        </Button>
      </CardContent>
    </Card>
  );
}
