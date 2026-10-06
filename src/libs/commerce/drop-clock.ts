/**
 * Server-corrected drop clock (ADR 0026, client engineering notes).
 *
 * Countdowns must never trust the device clock: the transaction service's
 * public drop projection carries `serverTime`, and the client renders every
 * drop countdown from `deviceNow + offset` where the offset was measured at
 * fetch time. The projection's `state` remains the only authority for
 * `live`/ended — the clock phases here drive RENDERING (countdown targets,
 * T-0 polling windows), never claims.
 */

/** Milliseconds the device clock differs from the service clock. */
export function dropClockOffsetMs(serverTimeIso: string, fetchedAtDeviceMs: number): number {
  return Date.parse(serverTimeIso) - fetchedAtDeviceMs;
}

export type DropClockPhase = 'before_start' | 'window_open' | 'after_end';

export type DropClockReading = {
  phase: DropClockPhase;
  /** Corrected "now" in epoch ms (device now + measured offset). */
  correctedNowMs: number;
  /** ms until startsAt; 0 once reached. */
  msUntilStart: number;
  /** ms until endsAt; null when the drop has no schedule end. */
  msUntilEnd: number | null;
};

export function readDropClock(
  deviceNowMs: number,
  offsetMs: number,
  startsAtIso: string,
  endsAtIso?: string | null,
): DropClockReading {
  const correctedNowMs = deviceNowMs + offsetMs;
  const startMs = Date.parse(startsAtIso);
  const endMs = endsAtIso ? Date.parse(endsAtIso) : null;
  const phase: DropClockPhase =
    correctedNowMs < startMs ? 'before_start' : endMs !== null && correctedNowMs >= endMs ? 'after_end' : 'window_open';
  return {
    phase,
    correctedNowMs,
    msUntilStart: Math.max(0, startMs - correctedNowMs),
    msUntilEnd: endMs === null ? null : Math.max(0, endMs - correctedNowMs),
  };
}

/**
 * Tick cadence for a countdown render loop: tight only inside the small
 * window around T-0 (the reload-free transition), one second otherwise, and
 * a lazy minute when the moment is far away. Bounded by design — no
 * background daemons, ticking only while the surface is mounted/visible.
 */
export function dropClockTickMs(reading: DropClockReading): number {
  const nearest = reading.phase === 'before_start' ? reading.msUntilStart : (reading.msUntilEnd ?? Infinity);
  if (nearest <= 10_000) return 250;
  if (nearest <= 60 * 60_000) return 1_000;
  return 60_000;
}

/** Formats a remaining-ms span as a compact `2d 04:11:09` / `04:11:09` label. */
export function formatDropCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  const clock = `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
  return days > 0 ? `${days}d ${clock}` : clock;
}
