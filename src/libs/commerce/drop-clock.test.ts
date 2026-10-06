import { describe, expect, it } from 'vitest';
import { dropClockOffsetMs, dropClockTickMs, formatDropCountdown, readDropClock } from './drop-clock';

const STARTS_AT = '2026-09-01T17:00:00.000Z';
const ENDS_AT = '2026-09-01T19:00:00.000Z';
const START_MS = Date.parse(STARTS_AT);

describe('drop clock', () => {
  it('measures the device-to-server offset at fetch time', () => {
    // Device clock 90s behind the service clock.
    expect(dropClockOffsetMs('2026-09-01T16:00:00.000Z', Date.parse('2026-09-01T15:58:30.000Z'))).toBe(90_000);
  });

  it('derives phases from the CORRECTED clock, not the device clock', () => {
    const offset = 90_000;
    // Device thinks the drop hasn't started; corrected clock says it has.
    const deviceJustBeforeCorrectedStart = START_MS - offset + 1;
    expect(readDropClock(deviceJustBeforeCorrectedStart, offset, STARTS_AT, ENDS_AT).phase).toBe('window_open');
    expect(readDropClock(deviceJustBeforeCorrectedStart, 0, STARTS_AT, ENDS_AT).phase).toBe('before_start');
  });

  it('reports window_open forever when the drop has no schedule end', () => {
    const reading = readDropClock(START_MS + 1_000_000_000, 0, STARTS_AT, null);
    expect(reading.phase).toBe('window_open');
    expect(reading.msUntilEnd).toBeNull();
  });

  it('clamps countdown targets at zero and reports after_end past endsAt', () => {
    const reading = readDropClock(Date.parse(ENDS_AT) + 5_000, 0, STARTS_AT, ENDS_AT);
    expect(reading.phase).toBe('after_end');
    expect(reading.msUntilStart).toBe(0);
    expect(reading.msUntilEnd).toBe(0);
  });

  it('ticks tightly only near a boundary', () => {
    expect(dropClockTickMs(readDropClock(START_MS - 5_000, 0, STARTS_AT, ENDS_AT))).toBe(250);
    expect(dropClockTickMs(readDropClock(START_MS - 30 * 60_000, 0, STARTS_AT, ENDS_AT))).toBe(1_000);
    expect(dropClockTickMs(readDropClock(START_MS - 3 * 86_400_000, 0, STARTS_AT, ENDS_AT))).toBe(60_000);
    // Inside an endless window there is no boundary to chase.
    expect(dropClockTickMs(readDropClock(START_MS + 1_000, 0, STARTS_AT, null))).toBe(60_000);
  });

  it('formats countdowns compactly', () => {
    expect(formatDropCountdown(0)).toBe('00:00:00');
    expect(formatDropCountdown(59_000)).toBe('00:00:59');
    expect(formatDropCountdown(3 * 3_600_000 + 61_000)).toBe('03:01:01');
    expect(formatDropCountdown(2 * 86_400_000 + 4 * 3_600_000 + 11 * 60_000 + 9_000)).toBe('2d 04:11:09');
  });
});
