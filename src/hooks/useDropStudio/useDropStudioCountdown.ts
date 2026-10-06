'use client';

import { useEffect, useState } from 'react';
import { type DropClockReading, dropClockTickMs, formatDropCountdown, readDropClock } from '@/libs/commerce/drop-clock';

export interface DropStudioCountdown {
  reading: DropClockReading;
  /** Ticking `2d 04:11:09`-style label for the nearest boundary (start, then end). */
  label: string;
  /**
   * Minute-granular label for `aria-live` announcements — screen readers get
   * "2d 04:11 remaining" once a minute, never a value shouted every second
   * (client engineering notes: timers are announced at sensible intervals).
   */
  announcedLabel: string;
}

/**
 * Server-corrected countdown for a drop schedule, ticking only while the
 * consuming surface is mounted (bounded by design — no daemons). `offsetMs`
 * comes from `dropClockOffsetMs` measured at projection fetch time; pass 0
 * for a schedule PREVIEW where no service clock exists yet. Under
 * `prefers-reduced-motion` the tick never goes sub-second — the T-0 fast
 * cadence is a visual flourish the reduced-motion variant drops.
 */
export function useDropStudioCountdown(
  startsAtIso: string,
  endsAtIso: string | null,
  offsetMs: number,
): DropStudioCountdown {
  const [reading, setReading] = useState<DropClockReading>(() =>
    readDropClock(Date.now(), offsetMs, startsAtIso, endsAtIso),
  );

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let active = true;
    const prefersReducedMotion =
      typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const tick = () => {
      if (!active) return;
      const next = readDropClock(Date.now(), offsetMs, startsAtIso, endsAtIso);
      setReading(next);
      const cadence = Math.max(dropClockTickMs(next), prefersReducedMotion ? 1_000 : 0);
      timer = setTimeout(tick, cadence);
    };
    tick();

    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [startsAtIso, endsAtIso, offsetMs]);

  const targetMs = reading.phase === 'before_start' ? reading.msUntilStart : (reading.msUntilEnd ?? 0);
  const label = formatDropCountdown(targetMs);
  const announcedLabel = formatDropCountdown(Math.floor(targetMs / 60_000) * 60_000);

  return { reading, label, announcedLabel };
}
