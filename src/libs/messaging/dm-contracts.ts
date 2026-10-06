import { z } from 'zod';
import { PAYKIT_NOISE_MESSAGE_MAX_BYTES } from '@/libs/commerce/messaging-contracts';
import { ValidationErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';
import { PAM_SENT_AT_UNIX_MS_PLACEHOLDER, pamSentAtEmitSchema, parsePamSentAt } from '@/libs/messaging/pam-sent-at';

/**
 * Private Application Message kind for a general direct message between two
 * users. Follows the `marketplace.chat_message.v0` precedent on the SAME
 * Encrypted Link infrastructure: one link per counterparty pair carries both
 * kinds, and the kind decides which conversation a message lands in.
 */
export const PUBKY_APP_DM_KIND = 'pubky_app.dm.v0';

/**
 * `pubky_app.dm.v0` — one direct message, carried as a Paykit Private
 * Application Message (Encrypted Link, Noise XX). Deliberately smaller than
 * the marketplace envelope: a DM has NO listing reference and NO conversation
 * id field, because the conversation identity IS the counterparty pubky — the
 * authenticated link direction already names both participants, and any
 * in-band identity field would be spoofable where the link is not.
 *
 * - `version`/`kind`: the Paykit envelope contract (unknown kinds are legal
 *   on a shared link and are skipped by receivers).
 * - `event_id`: sender-minted UUID; receivers dedupe by it (crash replay
 *   after a restored snapshot is expected and must be idempotent).
 * - `sent_at`: sender's wall clock, Unix-millisecond integer. Display
 *   ordering only. Emitters MUST write a JSON number; ISO-8601 is invalid
 *   on the send path.
 * - `body`: the message text, trimmed, non-empty.
 */
export const dmMessageSchema = z.object({
  version: z.literal(1),
  kind: z.literal(PUBKY_APP_DM_KIND),
  event_id: z.uuid(),
  sent_at: pamSentAtEmitSchema,
  body: z.string().min(1),
});

export type PubkyAppDmMessage = z.infer<typeof dmMessageSchema>;

const utf8 = new TextEncoder();

/**
 * Builds and validates a sendable DM envelope, enforcing the 1000-byte Noise
 * ceiling on the SERIALIZED size (JSON escaping and multi-byte UTF-8 count
 * against the budget). Throws on oversize instead of truncating — the
 * composer shows the live budget and the send path never silently drops
 * content. Same contract as `buildChatMessage`. `sentAt` MUST be a Unix-ms
 * integer; ISO-8601 strings are rejected here.
 */
export function buildDmMessage(input: { eventId: string; sentAt: number; body: string }): {
  message: PubkyAppDmMessage;
  json: string;
  byteSize: number;
} {
  const candidate = {
    version: 1 as const,
    kind: PUBKY_APP_DM_KIND,
    event_id: input.eventId,
    sent_at: input.sentAt,
    body: input.body.trim(),
  };
  const parsed = dmMessageSchema.safeParse(candidate);
  if (!parsed.success) {
    throw Err.validation(ValidationErrorCode.INVALID_INPUT, 'Direct message envelope is invalid.', {
      service: ErrorService.Paykit,
      operation: 'buildDmMessage',
      context: { issues: parsed.error.issues.map(({ path, code }) => `${path.join('.')}:${code}`) },
    });
  }
  const json = JSON.stringify(parsed.data);
  const byteSize = utf8.encode(json).byteLength;
  if (byteSize > PAYKIT_NOISE_MESSAGE_MAX_BYTES) {
    throw Err.validation(
      ValidationErrorCode.INVALID_INPUT,
      `Message is too long: ${byteSize} bytes serialized, limit ${PAYKIT_NOISE_MESSAGE_MAX_BYTES}.`,
      {
        service: ErrorService.Paykit,
        operation: 'buildDmMessage',
        context: { byteSize, limit: PAYKIT_NOISE_MESSAGE_MAX_BYTES },
      },
    );
  }
  return { message: parsed.data, json, byteSize };
}

/**
 * The byte budget available for a DM body: the Noise ceiling minus the
 * serialized envelope with an empty body. Every field outside the body is
 * fixed-width (UUID 36 chars, `sent_at` a 13-digit Unix-ms integer), so the
 * budget is a stable constant while typing.
 */
export function dmBodyBudget(): number {
  const envelope: PubkyAppDmMessage = {
    version: 1,
    kind: PUBKY_APP_DM_KIND,
    event_id: '00000000-0000-4000-8000-000000000000',
    sent_at: PAM_SENT_AT_UNIX_MS_PLACEHOLDER,
    body: '',
  };
  return PAYKIT_NOISE_MESSAGE_MAX_BYTES - utf8.encode(JSON.stringify(envelope)).byteLength;
}

/**
 * Decodes one received Private Application Message as a DM. Returns `null`
 * for payloads that are not a valid `pubky_app.dm.v0` (unknown kinds are
 * legal on a shared link and are skipped, never treated as an error).
 *
 * Inbound `sent_at` accepts a Unix-ms integer or a legacy ISO-8601 string
 * and always normalizes to a Unix-ms number, so already-stored marketplace
 * DMs and in-flight ISO envelopes still decode during migration.
 */
export function decodeDmMessage(rawJson: string): PubkyAppDmMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const sentAt = parsePamSentAt((value as { sent_at?: unknown }).sent_at);
  if (sentAt === null) return null;
  const parsed = dmMessageSchema.safeParse({ ...value, sent_at: sentAt });
  return parsed.success ? parsed.data : null;
}

const DM_CONVERSATION_PREFIX = 'dm:';
const PUBKY_LENGTH = 52;

/**
 * Local conversation id for the DM thread with one counterparty. There is
 * exactly one DM conversation per counterparty pair per device — the
 * counterparty pubky IS the conversation identity.
 */
export function buildDmConversationId(counterpartyPubky: string): string {
  return `${DM_CONVERSATION_PREFIX}${counterpartyPubky}`;
}

/** Splits a `dm:{counterpartyPubky}` conversation id; `null` when the shape does not match. */
export function parseDmConversationId(conversationId: string): { counterpartyPubky: string } | null {
  if (!conversationId.startsWith(DM_CONVERSATION_PREFIX)) return null;
  const counterpartyPubky = conversationId.slice(DM_CONVERSATION_PREFIX.length);
  if (counterpartyPubky.length !== PUBKY_LENGTH) return null;
  return { counterpartyPubky };
}
