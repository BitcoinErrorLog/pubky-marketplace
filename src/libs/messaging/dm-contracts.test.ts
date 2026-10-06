import { describe, expect, it } from 'vitest';
import { PAYKIT_NOISE_MESSAGE_MAX_BYTES } from '@/libs/commerce/messaging-contracts';
import { asInvalid } from '@/test-utils/type-assertions';
import {
  buildDmConversationId,
  buildDmMessage,
  decodeDmMessage,
  dmBodyBudget,
  parseDmConversationId,
  PUBKY_APP_DM_KIND,
} from './dm-contracts';
import { PAM_SENT_AT_UNIX_MS_EMIT_MAX, PAM_SENT_AT_UNIX_MS_PLACEHOLDER } from './pam-sent-at';

const COUNTERPARTY = 'z'.repeat(52);
const EVENT_ID = '5b3f9a0e-8f2c-4f4e-9d35-1c2b4a6d8e01';
const SENT_AT = 1_756_742_400_000;
const LEGACY_ISO_SENT_AT = '2026-08-21T10:00:00.000Z';
const LEGACY_ISO_SENT_AT_MS = Date.parse(LEGACY_ISO_SENT_AT);

function build(body: string) {
  return buildDmMessage({ eventId: EVENT_ID, sentAt: SENT_AT, body });
}

describe('pubky_app.dm.v0 direct message contract', () => {
  it('builds a valid envelope and reports its true serialized size', () => {
    const { message, json, byteSize } = build('hey — are you going on saturday?');
    expect(message.kind).toBe(PUBKY_APP_DM_KIND);
    expect(message.version).toBe(1);
    expect(message.sent_at).toBe(SENT_AT);
    expect(typeof JSON.parse(json).sent_at).toBe('number');
    expect(JSON.parse(json)).toEqual(message);
    expect(byteSize).toBe(new TextEncoder().encode(json).byteLength);
    expect(byteSize).toBeLessThanOrEqual(PAYKIT_NOISE_MESSAGE_MAX_BYTES);
  });

  it('carries no listing or conversation field — the link names the counterparty', () => {
    const { message } = build('identity is the link');
    expect(Object.keys(message).sort()).toEqual(['body', 'event_id', 'kind', 'sent_at', 'version']);
  });

  it('trims the body and rejects whitespace-only messages', () => {
    expect(build('  hello  ').message.body).toBe('hello');
    expect(() => build('   ')).toThrow();
  });

  it('accepts a body exactly at the budget and rejects one byte over', () => {
    const budget = dmBodyBudget();
    const exact = 'a'.repeat(budget);
    expect(build(exact).byteSize).toBe(PAYKIT_NOISE_MESSAGE_MAX_BYTES);
    expect(() => build(`${exact}a`)).toThrow(/too long/);
  });

  it('counts JSON escaping and multi-byte UTF-8 against the budget, not characters', () => {
    const budget = dmBodyBudget();
    const quotes = '"'.repeat(budget); // each quote serializes as two bytes (\")
    expect(() => build(quotes)).toThrow(/too long/);
  });

  it('keeps the budget stable across event ids and timestamps (fixed-width fields)', () => {
    const budget = dmBodyBudget();
    const withOtherIds = buildDmMessage({
      eventId: crypto.randomUUID(),
      sentAt: Date.now(),
      body: 'x'.repeat(budget),
    });
    expect(withOtherIds.byteSize).toBe(PAYKIT_NOISE_MESSAGE_MAX_BYTES);
  });

  it('emits the maximum 13-digit timestamp at the placeholder envelope length', () => {
    const maximum = buildDmMessage({
      eventId: EVENT_ID,
      sentAt: PAM_SENT_AT_UNIX_MS_EMIT_MAX,
      body: 'x',
    });
    const placeholder = buildDmMessage({
      eventId: EVENT_ID,
      sentAt: PAM_SENT_AT_UNIX_MS_PLACEHOLDER,
      body: 'x',
    });
    expect(maximum.message.sent_at).toBe(PAM_SENT_AT_UNIX_MS_EMIT_MAX);
    expect(maximum.byteSize).toBe(placeholder.byteSize);
    expect(() =>
      buildDmMessage({
        eventId: EVENT_ID,
        sentAt: PAM_SENT_AT_UNIX_MS_EMIT_MAX + 1,
        body: 'x',
      }),
    ).toThrow();
  });

  it('rejects ISO-8601 sent_at on the send path', () => {
    expect(() =>
      buildDmMessage({
        eventId: EVENT_ID,
        sentAt: asInvalid<number>(LEGACY_ISO_SENT_AT),
        body: 'no iso on emit',
      }),
    ).toThrow();
  });

  it('round-trips through decode and skips foreign or malformed payloads', () => {
    const { json, message } = build('round trip');
    expect(decodeDmMessage(json)).toEqual(message);
    expect(decodeDmMessage('not json at all')).toBeNull();
    // The marketplace kind rides the SAME link and must be skipped here, not errored.
    expect(decodeDmMessage(JSON.stringify({ ...message, kind: 'marketplace.chat_message.v0' }))).toBeNull();
    expect(decodeDmMessage(JSON.stringify({ ...message, event_id: 'not-a-uuid' }))).toBeNull();
  });

  it('accepts a Unix-ms sent_at on inbound decode', () => {
    const { message } = build('unix-ms inbound');
    expect(decodeDmMessage(JSON.stringify(message))).toEqual(message);
  });

  it('accepts a legacy ISO-8601 sent_at on inbound decode and normalizes to Unix-ms', () => {
    const { message } = build('legacy iso inbound');
    const decoded = decodeDmMessage(JSON.stringify({ ...message, sent_at: LEGACY_ISO_SENT_AT }));
    expect(decoded).toEqual({ ...message, sent_at: LEGACY_ISO_SENT_AT_MS });
    expect(typeof decoded?.sent_at).toBe('number');
  });

  it('rejects missing or invalid inbound sent_at', () => {
    const { message } = build('invalid sent_at');
    expect(decodeDmMessage(JSON.stringify({ ...message, sent_at: undefined }))).toBeNull();
    expect(decodeDmMessage(JSON.stringify({ ...message, sent_at: '1756742400000' }))).toBeNull();
    expect(decodeDmMessage(JSON.stringify({ ...message, sent_at: 1756742400.5 }))).toBeNull();
    expect(decodeDmMessage(JSON.stringify({ ...message, sent_at: 0 }))).toBeNull();
    expect(decodeDmMessage(JSON.stringify({ ...message, sent_at: null }))).toBeNull();
    expect(decodeDmMessage(JSON.stringify({ ...message, sent_at: 1e30 }))).toBeNull();
    expect(decodeDmMessage(JSON.stringify({ ...message, sent_at: 8.64e15 + 1 }))).toBeNull();
    expect(decodeDmMessage(JSON.stringify({ ...message, sent_at: 2 ** 53 + 1 }))).toBeNull();
  });

  it('decodes a Hypercolor-shaped pubky_app.dm.v0 envelope', () => {
    const envelope = {
      version: 1,
      kind: PUBKY_APP_DM_KIND,
      event_id: EVENT_ID,
      sent_at: 1_756_742_400_000,
      body: 'hello',
    };
    expect(decodeDmMessage(JSON.stringify(envelope))).toEqual(envelope);
  });

  it('builds and parses dm conversation ids keyed by counterparty', () => {
    const conversationId = buildDmConversationId(COUNTERPARTY);
    expect(conversationId).toBe(`dm:${COUNTERPARTY}`);
    expect(parseDmConversationId(conversationId)).toEqual({ counterpartyPubky: COUNTERPARTY });
    expect(parseDmConversationId(`conversation:${COUNTERPARTY}`)).toBeNull();
    expect(parseDmConversationId('dm:short')).toBeNull();
  });
});
