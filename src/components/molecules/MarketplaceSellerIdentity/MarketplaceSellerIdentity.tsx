'use client';

import { Store } from 'lucide-react';
import type { CommerceSellerReputationOverview } from '@/application/commerce/commerce';
import { Typography } from '@/atoms/Typography/Typography';
import { MarketplaceStarRating } from '@/molecules/MarketplaceStarRating/MarketplaceStarRating';

export interface MarketplaceSellerIdentityProps {
  sellerPubky: string;
  displayName: string;
  avatarUrl?: string | null;
  avatarAlt?: string;
  reputation: CommerceSellerReputationOverview | { status: 'loading' };
  onAvatarError?: () => void;
  variant?: 'default' | 'card';
}

export function MarketplaceSellerIdentity({
  displayName,
  avatarUrl,
  avatarAlt,
  reputation,
  onAvatarError,
  variant = 'default',
}: MarketplaceSellerIdentityProps) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      {avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- homeserver media bypasses Next image optimization
        <img
          src={avatarUrl}
          alt={avatarAlt ?? `${displayName} avatar`}
          className="size-12 shrink-0 rounded-md object-cover"
          onError={onAvatarError}
        />
      ) : (
        <div className="flex size-12 shrink-0 items-center justify-center rounded-md bg-background text-muted-foreground">
          <Store className="size-5" aria-hidden="true" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <Typography
          as="p"
          className={variant === 'card' ? 'text-sm leading-5 font-semibold break-words' : 'font-semibold break-words'}
        >
          {displayName}
        </Typography>
        {reputation.status === 'rated' && reputation.summary.count > 0 ? (
          <MarketplaceStarRating
            rating={reputation.summary.avg}
            count={reputation.summary.count}
            verifiedCount={reputation.summary.verifiedCount}
            size="sm"
            className="mt-1"
          />
        ) : (
          <Typography
            as="p"
            className={
              variant === 'card'
                ? 'mt-1 text-sm leading-5 font-medium text-muted-foreground'
                : 'mt-1 text-xs text-muted-foreground'
            }
          >
            No rating yet
          </Typography>
        )}
      </div>
    </div>
  );
}
