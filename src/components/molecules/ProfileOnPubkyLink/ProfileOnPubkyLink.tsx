'use client';

import { ExternalLink } from 'lucide-react';
import { getProfileRoute, PROFILE_ROUTES } from '@/app/routes';
import { getSocialHostUrl } from '@/config/social';
import { useIsEmbedded } from '@/hooks/useIsEmbedded/useIsEmbedded';
import { cn } from '@/libs/utils/utils';

export interface ProfileOnPubkyLinkProps {
  pubky: string;
  className?: string;
}

/** Small off-site link to a user's profile on the social host. Renders nothing while link-out is off. */
export function ProfileOnPubkyLink({ pubky, className }: ProfileOnPubkyLinkProps) {
  const isEmbedded = useIsEmbedded();
  const href = getSocialHostUrl(getProfileRoute(PROFILE_ROUTES.PROFILE, pubky));
  if (!href) return null;
  return (
    <a
      href={href}
      target={isEmbedded ? '_top' : undefined}
      data-cy="profile-on-pubky-link"
      className={cn(
        'inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground hover:underline',
        className,
      )}
    >
      Profile on Pubky
      <ExternalLink className="size-3" aria-hidden />
    </a>
  );
}
