/**
 * Client-side ICS (RFC 5545) export for a drop's start moment — the
 * "remind me" path that needs no server and no daemon: the buyer's own
 * calendar fires the alert. The event time is the CORRECTED start (the
 * service-enforced `startsAt` from the projection when registered, the
 * seller's stated intent otherwise — callers pass whichever they honestly
 * hold).
 */

const CRLF = '\r\n';

/** Escapes TEXT property values per RFC 5545 §3.3.11. */
function escapeIcsText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll(';', '\\;').replaceAll(',', '\\,').replaceAll('\n', '\\n');
}

/** RFC 5545 lines fold at 75 octets; a space continues the line. */
function foldIcsLine(line: string): string {
  if (line.length <= 75) return line;
  const chunks: string[] = [line.slice(0, 75)];
  for (let index = 75; index < line.length; index += 74) {
    chunks.push(` ${line.slice(index, index + 74)}`);
  }
  return chunks.join(CRLF);
}

/** Epoch ms → ICS UTC basic format (`20260101T120000Z`). */
export function formatIcsUtc(epochMs: number): string {
  return new Date(epochMs)
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

export interface DropCalendarEventInput {
  /** Stable per-drop identifier, e.g. `{sellerPubky}:{dropId}`. */
  uid: string;
  title: string;
  description: string;
  /** Corrected drop start in epoch ms. */
  startsAtMs: number;
  /** Optional schedule end in epoch ms. */
  endsAtMs?: number | null;
  /** Absolute URL of the drop page. */
  url: string;
  /** "Now" for DTSTAMP; injectable for deterministic tests. */
  nowMs?: number;
}

/**
 * Builds a single-VEVENT ICS document with a 10-minute display alarm before
 * the drop starts. Pure string building — the Blob/anchor download lives in
 * the UI layer.
 */
export function buildDropCalendarIcs(input: DropCalendarEventInput): string {
  const nowMs = input.nowMs ?? Date.now();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Pubky Marketplace//Drops//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${escapeIcsText(input.uid)}@marketplace.pubky.app`,
    `DTSTAMP:${formatIcsUtc(nowMs)}`,
    `DTSTART:${formatIcsUtc(input.startsAtMs)}`,
    ...(typeof input.endsAtMs === 'number' ? [`DTEND:${formatIcsUtc(input.endsAtMs)}`] : []),
    `SUMMARY:${escapeIcsText(input.title)}`,
    `DESCRIPTION:${escapeIcsText(input.description)}`,
    `URL:${escapeIcsText(input.url)}`,
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    `DESCRIPTION:${escapeIcsText(input.title)}`,
    'TRIGGER:-PT10M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(foldIcsLine).join(CRLF) + CRLF;
}
