'use client';

import { BellRing, CalendarPlus, LoaderCircle } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Typography } from '@/atoms/Typography/Typography';
import { useCommerceShopFollow } from '@/hooks/useCommerceShopFollow/useCommerceShopFollow';
import { buildDropCalendarIcs } from '@/hooks/useMarketplaceDrop/drop-ics';
import type { CommerceDropRecord } from '@/libs/commerce/marketplace-records';
import type { MarketplacePublicDrop } from '@/services/marketplace/marketplace';

export interface DropRemindMeProps {
  record: CommerceDropRecord;
  /** Authoritative schedule when registered; the ICS uses it over the record. */
  projection: MarketplacePublicDrop | null;
  /** Absolute URL of this drop page for the calendar event. */
  dropUrl: string;
}

/**
 * "Remind me" without a daemon and without pretending (drops design,
 * "Before the drop"): a client-built ICS export whose event time is the
 * service-enforced schedule when the drop is registered (the seller's
 * stated intent otherwise), plus the existing shop-follow so this seller's
 * listings surface on the followed-shops shelf. The drop watchlist itself
 * is listing-keyed by spec, so drops deliberately do NOT write fake
 * watchlist entries — the honest affordances are the calendar and the
 * follow.
 */
export function DropRemindMe({ record, projection, dropUrl }: DropRemindMeProps) {
  const follow = useCommerceShopFollow(record.ownerPubky);

  const downloadCalendarFile = () => {
    const startsAtIso = projection?.startsAt ?? record.startsAt;
    const endsAtIso = projection?.endsAt ?? record.endsAt ?? null;
    const ics = buildDropCalendarIcs({
      uid: `${record.ownerPubky}:${record.dropId}`,
      title: `Drop: ${record.title}`,
      description: `${record.title} starts. ${dropUrl}`,
      startsAtMs: Date.parse(startsAtIso),
      endsAtMs: endsAtIso ? Date.parse(endsAtIso) : null,
      url: dropUrl,
    });
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = objectUrl;
    anchor.download = `drop-${record.dropId}.ics`;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
  };

  return (
    <section aria-label="Remind me" className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" className="rounded-full" onClick={downloadCalendarFile}>
          <CalendarPlus className="mr-2 size-4" />
          Add to calendar (.ics)
        </Button>
        <Button
          variant={follow.isFollowing ? 'default' : 'secondary'}
          size="sm"
          className="rounded-full"
          aria-pressed={follow.isFollowing}
          disabled={follow.isMutating}
          onClick={() => void follow.toggle()}
        >
          {follow.isMutating ? (
            <LoaderCircle className="mr-2 size-4 animate-spin" />
          ) : (
            <BellRing className="mr-2 size-4" />
          )}
          {follow.isFollowing ? 'Watching this seller' : 'Watch this seller'}
        </Button>
      </div>
      <Typography as="p" className="text-xs text-muted-foreground">
        The calendar alert fires from your own calendar
        {projection ? ' at the service-enforced start time' : ' at the seller’s stated start time (not yet registered)'}
        . Watching the seller surfaces their shop on your followed-shops shelf — this app runs no background
        notification daemon and will never pretend to.
      </Typography>
    </section>
  );
}
