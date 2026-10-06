import { describe, expect, it } from 'vitest';
import { buildDropCalendarIcs, formatIcsUtc } from './drop-ics';

const SELLER = 's'.repeat(52);

describe('formatIcsUtc', () => {
  it('formats epoch ms as ICS UTC basic format', () => {
    expect(formatIcsUtc(Date.UTC(2026, 8, 1, 17, 0, 0))).toBe('20260901T170000Z');
  });
});

describe('buildDropCalendarIcs', () => {
  const input = {
    uid: `${SELLER}:drop1`,
    title: 'Field Recordings; Vol 1, launch',
    description: 'Drop starts.\nOne per checkout.',
    startsAtMs: Date.UTC(2026, 8, 1, 17, 0, 0),
    endsAtMs: Date.UTC(2026, 8, 1, 19, 0, 0),
    url: 'https://app.example/marketplace/drop/x/y',
    nowMs: Date.UTC(2026, 7, 23, 12, 0, 0),
  };

  it('carries the corrected start time, the end time, and a pre-start alarm', () => {
    const ics = buildDropCalendarIcs(input);
    expect(ics).toContain('DTSTART:20260901T170000Z');
    expect(ics).toContain('DTEND:20260901T190000Z');
    expect(ics).toContain('DTSTAMP:20260823T120000Z');
    expect(ics).toContain('TRIGGER:-PT10M');
    expect(ics).toContain('URL:https://app.example/marketplace/drop/x/y');
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('escapes TEXT values per RFC 5545', () => {
    const ics = buildDropCalendarIcs(input);
    expect(ics).toContain('SUMMARY:Field Recordings\\; Vol 1\\, launch');
    expect(ics).toContain('DESCRIPTION:Drop starts.\\nOne per checkout.');
  });

  it('omits DTEND when the drop has no schedule end', () => {
    const ics = buildDropCalendarIcs({ ...input, endsAtMs: null });
    expect(ics).not.toContain('DTEND');
  });

  it('folds lines longer than 75 octets with a leading-space continuation', () => {
    const ics = buildDropCalendarIcs({ ...input, description: 'x'.repeat(200) });
    const folded = ics.split('\r\n').filter((line) => line.startsWith(' '));
    expect(folded.length).toBeGreaterThan(0);
    expect(ics.split('\r\n').every((line) => line.length <= 75)).toBe(true);
  });
});
