'use client';

import { MapPin, Store } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/atoms/Badge/Badge';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Heading } from '@/atoms/Heading/Heading';
import { Typography } from '@/atoms/Typography/Typography';

export type ShopProfileCardVariant = 'full' | 'mini';

export interface ShopProfileCardProps {
  name: string;
  bio: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  location?: { countryCode: string; region?: string };
  vacation?: boolean;
  /**
   * `full` is the public storefront. `mini` is the editor's live preview,
   * using the same dimensions with a subordinate heading.
   */
  variant: ShopProfileCardVariant;
  bannerAlt: string;
  avatarAlt: string;
  onBannerError?: () => void;
  onAvatarError?: () => void;
  /** Inline with location (community tags). */
  locationExtras?: ReactNode;
  /** Below the location row (reputation header on the public shop). */
  afterLocation?: ReactNode;
  aside?: ReactNode;
  testId?: string;
}

const STOREFRONT_STYLE = {
  banner: 'h-28 w-full object-cover object-center sm:h-40',
  bannerFallback: 'h-28 bg-linear-to-br from-brand/24 to-brand/8 sm:h-40',
  content: 'flex flex-col gap-4 p-6 sm:flex-row sm:items-end sm:justify-between',
  avatarLift: '-mt-16',
  avatar:
    'mb-4 flex size-20 items-center justify-center overflow-hidden rounded-2xl border-4 border-card bg-brand text-primary-foreground shadow-lg',
  storeIcon: 'size-9',
  headingSize: 'xl',
  headingClass: 'text-3xl sm:text-5xl',
  bio: 'mt-2 max-w-2xl text-muted-foreground',
  wrapLocationRow: true,
} as const;

const VARIANT = {
  full: {
    ...STOREFRONT_STYLE,
    headingLevel: 1,
    alwaysShowLocation: true,
  },
  mini: {
    ...STOREFRONT_STYLE,
    headingLevel: 2,
    alwaysShowLocation: false,
  },
} as const;

export function ShopProfileCard({
  name,
  bio,
  avatarUrl,
  bannerUrl,
  location,
  vacation = false,
  variant,
  bannerAlt,
  avatarAlt,
  onBannerError,
  onAvatarError,
  locationExtras,
  afterLocation,
  aside,
  testId,
}: ShopProfileCardProps) {
  const tokens = VARIANT[variant];
  const region = location?.region?.trim() ?? '';
  const countryCode = location?.countryCode?.trim() ?? '';
  const locationLabel = `${region ? `${region}, ` : ''}${countryCode}`;
  const showLocation = tokens.alwaysShowLocation || Boolean(countryCode || region);

  const locationRow = showLocation ? (
    <Typography as="p" className="flex items-center gap-2 text-sm text-muted-foreground">
      <MapPin className="size-4" aria-hidden="true" />
      {locationLabel}
    </Typography>
  ) : null;

  return (
    <Card className="overflow-hidden rounded-md p-0" data-testid={testId}>
      {bannerUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- homeserver media and object URLs bypass Next image optimization
        <img src={bannerUrl} alt={bannerAlt} className={tokens.banner} onError={onBannerError} />
      ) : (
        <div className={tokens.bannerFallback} />
      )}
      <CardContent className={tokens.content}>
        <div className={tokens.avatarLift}>
          <div className={tokens.avatar}>
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- homeserver media and object URLs bypass Next image optimization
              <img
                src={avatarUrl}
                alt={avatarAlt}
                className="size-full object-cover object-center"
                onError={onAvatarError}
              />
            ) : (
              <Store className={tokens.storeIcon} aria-hidden="true" />
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Heading level={tokens.headingLevel} size={tokens.headingSize} className={tokens.headingClass}>
              {name}
            </Heading>
            {vacation && <Badge variant="secondary">Vacation mode</Badge>}
          </div>
          <Typography as="p" className={tokens.bio}>
            {bio}
          </Typography>
          {tokens.wrapLocationRow ? (
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
              {locationRow}
              {locationExtras}
            </div>
          ) : locationRow ? (
            <div className="mt-3">{locationRow}</div>
          ) : null}
          {afterLocation}
        </div>
        {aside}
      </CardContent>
    </Card>
  );
}
