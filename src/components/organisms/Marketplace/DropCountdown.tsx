'use client';

import { useEffect, useMemo, useState } from 'react';
import { useReducedMotion } from 'motion/react';
import { Typography } from '@/atoms/Typography/Typography';
import { dropClockTickMs, formatDropCountdown, readDropClock } from '@/libs/commerce/drop-clock';
import { cn } from '@/libs/utils/utils';

export interface DropCountdownProps {
  /** ISO start; the projection's when registered, the record's otherwise. */
  startsAt: string;
  endsAt?: string | null;
  /**
   * Device-vs-service offset measured at projection fetch time. Null when
   * only the seller's record is available — the countdown then renders from
   * the device clock and MUST be labeled an estimate by the caller.
   */
  clockOffsetMs: number | null;
  /** Caption under the number, e.g. "Starts in" / "Ends in". */
  phaseLabel: string;
  /** Card-sized rendering (smaller number, no pulse dot). */
  compact?: boolean;
  className?: string;
  hideWhenExpired?: boolean;
  announcePhaseLabel?: boolean;
}

/**
 * Server-corrected countdown (drops design, "Clock"). Renders remaining
 * time to `startsAt` (or `endsAt` once the window opened) from
 * `deviceNow + offset` — never the device clock alone when an offset was
 * measured. Ticks only while mounted, at `dropClockTickMs` cadence.
 *
 * Never a state claim: at zero the copy says "Waiting for the service…" —
 * the page swaps to live/ended ONLY when the projection says so.
 *
 * A11y: the per-second text is `aria-hidden`; a visually-hidden
 * `aria-live="polite"` region announces at MINUTE granularity only. Reduced
 * motion drops the pulse dot and renders static text updated per tick.
 */
export function DropCountdown({
  startsAt,
  endsAt,
  clockOffsetMs,
  phaseLabel,
  compact,
  className,
  hideWhenExpired,
  announcePhaseLabel = true,
}: DropCountdownProps) {
  const reducedMotion = useReducedMotion();
  const offset = clockOffsetMs ?? 0;
  const [nowMs, setNowMs] = useState(() => Date.now());

  const reading = useMemo(() => readDropClock(nowMs, offset, startsAt, endsAt), [nowMs, offset, startsAt, endsAt]);
  const remainingMs = reading.phase === 'before_start' ? reading.msUntilStart : (reading.msUntilEnd ?? 0);

  useEffect(() => {
    const tick = dropClockTickMs(readDropClock(Date.now(), offset, startsAt, endsAt));
    const timer = window.setTimeout(() => setNowMs(Date.now()), tick);
    return () => window.clearTimeout(timer);
  }, [nowMs, offset, startsAt, endsAt]);

  const label = formatDropCountdown(remainingMs);
  const wholeMinutes = Math.floor(remainingMs / 60_000);
  const announcement =
    remainingMs <= 0
      ? `${phaseLabel}: now`
      : wholeMinutes === 0
        ? `${announcePhaseLabel ? `${phaseLabel}: ` : ''}under a minute`
        : `${announcePhaseLabel ? `${phaseLabel}: ` : ''}about ${wholeMinutes} ${
            wholeMinutes === 1 ? 'minute' : 'minutes'
          }`;

  if (remainingMs <= 0 && hideWhenExpired) return null;

  if (remainingMs <= 0) {
    return (
      <div className={className}>
        <Typography as="p" className="text-sm text-muted-foreground" role="status">
          Checking availability…
        </Typography>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      {reducedMotion || compact ? (
        <Typography
          as="p"
          aria-hidden="true"
          className={cn('font-semibold tabular-nums', compact ? 'text-sm' : 'text-2xl')}
        >
          {phaseLabel} {label}
        </Typography>
      ) : (
        <div aria-hidden="true" className="flex items-baseline gap-3">
          <span className="relative flex size-2.5 self-center">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand/60" />
            <span className="relative inline-flex size-2.5 rounded-full bg-brand" />
          </span>
          <Typography as="p" className="text-sm text-muted-foreground">
            {phaseLabel}
          </Typography>
          <Typography as="p" className="text-3xl font-bold tabular-nums">
            {label}
          </Typography>
        </div>
      )}
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}
