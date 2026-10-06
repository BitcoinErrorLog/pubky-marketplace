import type { SpanJSON, TransactionEvent } from '@sentry/core';
import type * as Sentry from '@sentry/nextjs';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { ErrorService } from '@/libs/error/error.types';
import { HttpStatusCode } from '@/libs/http/http.types';
import {
  EMAIL_PATTERN,
  EMAIL_REDACTED,
  NEXUS_POST_TAGS_PATH_PATTERN,
  PHONE_PATTERN,
  PHONE_REDACTED,
  PUBKY_COMPACT_URI_PATTERN,
  PUBKY_HTTP_HOST_PATTERN,
  PUBKY_IDENTIFIER_KEYS,
  PUBKY_REDACTED,
  PUBKY_URI_PATTERN,
  RAW_PUBKY_PATTERN,
  SENSITIVE_CONTEXT_KEYS,
  SENSITIVE_VALUE_REDACTED,
  SENTRY_LIMIT_REDACTED,
  SENTRY_REDACTION_MAX_DEPTH,
  SENTRY_REDACTION_MAX_NODES,
  SENTRY_REDACTION_MAX_STRING_LENGTH,
} from './sentry.constants';

type NormalizedContextKey = {
  containsNonAscii: boolean;
  value: string;
};

function isZeroWidthCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x200b || codePoint === 0x200c || codePoint === 0x200d || codePoint === 0x2060 || codePoint === 0xfeff
  );
}

function normalizeContextKey(key: string): NormalizedContextKey {
  let containsNonAscii = false;
  let value = '';

  for (const character of key.normalize('NFKC').normalize('NFD')) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || isZeroWidthCodePoint(codePoint) || /\p{Mark}/u.test(character)) {
      continue;
    }
    if (codePoint > 0x7f) {
      containsNonAscii = true;
      continue;
    }
    const lowerCodePoint = codePoint >= 0x41 && codePoint <= 0x5a ? codePoint + 0x20 : codePoint;
    if ((lowerCodePoint >= 0x61 && lowerCodePoint <= 0x7a) || (lowerCodePoint >= 0x30 && lowerCodePoint <= 0x39)) {
      value += String.fromCodePoint(lowerCodePoint);
    }
  }

  return { containsNonAscii, value };
}

function isSensitiveContextKey(key: string): boolean {
  if (key.length > SENTRY_REDACTION_MAX_STRING_LENGTH) return true;

  const normalizedKey = normalizeContextKey(key);
  return (
    normalizedKey.containsNonAscii ||
    SENSITIVE_CONTEXT_KEYS.has(normalizedKey.value) ||
    PUBKY_IDENTIFIER_KEYS.has(normalizedKey.value)
  );
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Drop `conversation=` from a URL or query string. Wave A listing thread ids
 * put two pubkys plus a listing id in the address bar; they must not reach Sentry.
 */
export function stripConversationQueryParam(value: string): string {
  if (!value.toLowerCase().includes('conversation=')) return value;

  const stripped = value.replace(/(?:[?&]|^)conversation=[^&#]*/gi, (match) =>
    match.startsWith('?') || match.startsWith('&') ? match[0] : '',
  );

  return stripped.replace(/\?&+/g, '?').replace(/&&+/g, '&').replace(/\?#/g, '#').replace(/[?&]$/g, '');
}

function scrubSensitiveStringPatterns(value: string): string {
  if (value.length > SENTRY_REDACTION_MAX_STRING_LENGTH) return SENTRY_LIMIT_REDACTED;

  const scrubbed = stripConversationQueryParam(value)
    .replace(PUBKY_URI_PATTERN, PUBKY_REDACTED)
    .replace(PUBKY_HTTP_HOST_PATTERN, PUBKY_REDACTED)
    .replace(PUBKY_COMPACT_URI_PATTERN, PUBKY_REDACTED)
    .replace(RAW_PUBKY_PATTERN, PUBKY_REDACTED)
    .replace(EMAIL_PATTERN, EMAIL_REDACTED)
    .replace(PHONE_PATTERN, PHONE_REDACTED);

  return scrubbed;
}

function scrubRequestConversationQuery(request: Sentry.ErrorEvent['request'] | TransactionEvent['request']): void {
  if (!request) return;
  if (typeof request.url === 'string') {
    request.url = stripConversationQueryParam(request.url);
  }
  const queryString = request.query_string;
  if (typeof queryString === 'string') {
    request.query_string = stripConversationQueryParam(queryString);
  } else if (queryString && typeof queryString === 'object' && !Array.isArray(queryString)) {
    const record = queryString as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key.toLowerCase() === 'conversation') delete record[key];
    }
  }
}

function getEndpointPath(endpoint: unknown): string | null {
  if (typeof endpoint !== 'string') return null;

  try {
    return new URL(endpoint).pathname;
  } catch {
    return endpoint.startsWith('/') ? endpoint.split('?')[0] : null;
  }
}

type AppErrorDropRule = {
  name: string;
  reason: string;
  matches: (error: AppError) => boolean;
};

function matchesEndpointPath(error: AppError, pattern: RegExp): boolean {
  const endpointPath = getEndpointPath(error.context?.endpoint);
  return endpointPath ? pattern.test(endpointPath) : false;
}

const APP_ERROR_DROP_RULES: AppErrorDropRule[] = [
  {
    name: 'nexus-post-tags-404',
    reason: 'Low-value post-tags telemetry; Nexus retry behavior is preserved and other Nexus errors stay reportable.',
    matches: (error) =>
      error.service === ErrorService.Nexus &&
      error.operation === 'fetchNexus' &&
      error.code === ClientErrorCode.NOT_FOUND &&
      error.context?.statusCode === HttpStatusCode.NOT_FOUND &&
      matchesEndpointPath(error, NEXUS_POST_TAGS_PATH_PATTERN),
  },
];

export function shouldDropAppErrorFromSentry(error: AppError): boolean {
  return APP_ERROR_DROP_RULES.some((rule) => rule.matches(error));
}

function isSensitiveFieldValue(parent: Record<string, unknown>, key: string): boolean {
  if (normalizeContextKey(key).value !== 'value') return false;
  if (typeof parent.field !== 'string') return false;
  return isSensitiveContextKey(parent.field);
}

type SanitizationState = {
  active: WeakSet<object>;
  nodes: number;
  sanitized: WeakMap<object, unknown>;
};

class SentrySanitizationError extends Error {}

function readEnumerableKeys(value: Record<string, unknown>): string[] {
  try {
    return Object.keys(value);
  } catch {
    throw new SentrySanitizationError('Unable to read telemetry payload');
  }
}

function readProperty(value: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !('value' in descriptor)) {
      throw new SentrySanitizationError('Telemetry payload contains an accessor');
    }
    return value[key];
  } catch (error) {
    if (error instanceof SentrySanitizationError) throw error;
    throw new SentrySanitizationError('Unable to read telemetry property');
  }
}

function sanitizeString(value: string, state: SanitizationState, depth: number): string {
  if (value.length > SENTRY_REDACTION_MAX_STRING_LENGTH) return SENTRY_LIMIT_REDACTED;

  const scrubbed = scrubSensitiveStringPatterns(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return scrubbed;
  }
  if (parsed === null || typeof parsed !== 'object') return scrubbed;

  const sanitized = sanitizeRecursively(parsed, state, depth + 1);
  if (sanitized === SENTRY_LIMIT_REDACTED) return SENTRY_LIMIT_REDACTED;
  try {
    const serialized = JSON.stringify(sanitized);
    return serialized.length > SENTRY_REDACTION_MAX_STRING_LENGTH ? SENTRY_LIMIT_REDACTED : serialized;
  } catch {
    throw new SentrySanitizationError('Unable to serialize telemetry payload');
  }
}

function sanitizeRecursively(value: unknown, state: SanitizationState, depth: number): unknown {
  if (depth > SENTRY_REDACTION_MAX_DEPTH || state.nodes >= SENTRY_REDACTION_MAX_NODES) {
    return SENTRY_LIMIT_REDACTED;
  }
  state.nodes += 1;

  if (typeof value === 'string') {
    return sanitizeString(value, state, depth);
  }

  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    return SENSITIVE_VALUE_REDACTED;
  }

  if (typeof value !== 'object' || value === null) {
    return value;
  }

  if (state.active.has(value)) {
    return '[redacted: circular reference]';
  }

  if (state.sanitized.has(value)) {
    return state.sanitized.get(value);
  }

  let isArray: boolean;
  try {
    isArray = Array.isArray(value);
  } catch {
    throw new SentrySanitizationError('Unable to inspect telemetry payload');
  }

  if (isArray) {
    const arrayValue = value as unknown[];
    if (arrayValue.length > SENTRY_REDACTION_MAX_NODES - state.nodes) {
      state.nodes = SENTRY_REDACTION_MAX_NODES;
      state.sanitized.set(value, SENTRY_LIMIT_REDACTED);
      return SENTRY_LIMIT_REDACTED;
    }

    const sanitized: unknown[] = [];
    state.sanitized.set(value, sanitized);
    state.active.add(value);
    for (const item of arrayValue) {
      sanitized.push(sanitizeRecursively(item, state, depth + 1));
    }
    state.active.delete(value);
    return sanitized;
  }

  if (!isPlainObject(value)) {
    return SENSITIVE_VALUE_REDACTED;
  }

  const keys = readEnumerableKeys(value);
  if (keys.length > SENTRY_REDACTION_MAX_NODES - state.nodes) {
    state.nodes = SENTRY_REDACTION_MAX_NODES;
    state.sanitized.set(value, SENTRY_LIMIT_REDACTED);
    return SENTRY_LIMIT_REDACTED;
  }

  const sanitized: Record<string, unknown> = {};
  state.sanitized.set(value, sanitized);
  state.active.add(value);
  for (const key of keys) {
    const item = readProperty(value, key);
    const sanitizedItem =
      isSensitiveContextKey(key) || isSensitiveFieldValue(value as Record<string, unknown>, key)
        ? SENSITIVE_VALUE_REDACTED
        : sanitizeRecursively(item, state, depth + 1);
    Object.defineProperty(sanitized, key, {
      configurable: true,
      enumerable: true,
      value: sanitizedItem,
      writable: true,
    });
  }
  state.active.delete(value);

  return sanitized;
}

function createSanitizationState(): SanitizationState {
  return {
    active: new WeakSet<object>(),
    nodes: 0,
    sanitized: new WeakMap<object, unknown>(),
  };
}

function sanitizeForSentryHook(value: unknown, state = createSanitizationState()): unknown {
  return sanitizeRecursively(value, state, 0);
}

export function sanitizeForSentry(value: unknown): unknown {
  try {
    return sanitizeForSentryHook(value);
  } catch {
    return SENSITIVE_VALUE_REDACTED;
  }
}

/**
 * Removes sensitive values from Sentry's last-chance hook input.
 *
 * Sentry invokes `beforeSend` after integrations and event processors. Values they already copied
 * from the hint are protected by the event scrub below, while this hint scrub protects retained
 * carriers and removes attachments before Sentry builds the outgoing envelope.
 */
function scrubSensitiveEventHint(hint: Sentry.EventHint | undefined, state: SanitizationState): void {
  if (!hint) return;

  if (hint.data !== undefined) {
    hint.data = sanitizeForSentryHook(hint.data, state);
  }

  if (hint.captureContext !== undefined) {
    hint.captureContext = sanitizeForSentryHook(hint.captureContext, state) as Sentry.EventHint['captureContext'];
  }

  if (hint.originalException !== undefined) {
    hint.originalException = sanitizeForSentryHook(hint.originalException, state);
  }

  // Attachments are opaque uploads whose filename and payload are both user-controlled.
  // They cannot be inspected safely (payloads may be binary), so fail closed by dropping them.
  if (hint.attachments !== undefined) {
    hint.attachments = [];
  }

  // Error is a non-plain object and its message/stack can contain secrets. The event already
  // contains the sanitized exception details, so the safest hint representation is no exception.
  if (hint.syntheticException !== undefined) {
    hint.syntheticException = null;
  }
}

const STRUCTURAL_NAME_CONTEXTS = new Set(['browser', 'device', 'gpu', 'os', 'runtime']);

function scrubEventContexts(
  contexts: Sentry.ErrorEvent['contexts'],
  state: SanitizationState,
): Sentry.ErrorEvent['contexts'] {
  if (!contexts) return contexts;

  const sanitized: NonNullable<Sentry.ErrorEvent['contexts']> = {};
  for (const [name, context] of Object.entries(contexts)) {
    if (context === undefined) continue;

    const sanitizedContext = sanitizeForSentryHook(context, state) as Sentry.Context;

    // SDK-owned contexts use `name` structurally. Apply keyed redaction to every context first,
    // then restore only this documented field after pattern-scrubbing its string value.
    if (
      STRUCTURAL_NAME_CONTEXTS.has(name) &&
      typeof context.name === 'string' &&
      sanitizedContext &&
      typeof sanitizedContext === 'object'
    ) {
      sanitizedContext.name = scrubSensitiveStringPatterns(context.name);
    }
    sanitized[name] = sanitizedContext;
  }
  return sanitized;
}

const ADDITIONAL_EVENT_CARRIERS = ['tags', 'fingerprint', 'threads', 'measurements'] as const;

function scrubAdditionalEventCarriers(event: Sentry.ErrorEvent | TransactionEvent, state: SanitizationState): void {
  const carriers = event as unknown as Record<string, unknown>;
  for (const key of ADDITIONAL_EVENT_CARRIERS) {
    if (carriers[key] !== undefined) {
      carriers[key] = sanitizeForSentryHook(carriers[key], state);
    }
  }
}

/**
 * Defensive PII filter — redacts user-provided identifiers across application-owned
 * event surfaces (messages, exception values, breadcrumb data, extras, and AppError context).
 *
 * The browser/server initializers also set sendDefaultPii: false; this hook is a
 * second line of defense for application payloads we attach ourselves.
 */
export function scrubSensitiveData(event: Sentry.ErrorEvent, hint?: Sentry.EventHint): Sentry.ErrorEvent | null {
  try {
    const state = createSanitizationState();
    scrubSensitiveEventHint(hint, state);

    event.message = event.message ? (sanitizeForSentryHook(event.message, state) as string) : event.message;

    if (event.exception) {
      event.exception = sanitizeForSentryHook(event.exception, state) as Sentry.ErrorEvent['exception'];
    }

    if (event.breadcrumbs) {
      event.breadcrumbs = event.breadcrumbs.flatMap((breadcrumb) => {
        const sanitized = scrubBreadcrumbStrict(breadcrumb, state);
        return sanitized ? [sanitized] : [];
      });
    }

    if (event.contexts) {
      event.contexts = scrubEventContexts(event.contexts, state);
    }

    if (event.extra) {
      event.extra = sanitizeForSentryHook(event.extra, state) as Record<string, unknown>;
    }

    if (event.request) {
      event.request = sanitizeForSentryHook(event.request, state) as Sentry.ErrorEvent['request'];
      scrubRequestConversationQuery(event.request);
    }

    if (event.user) {
      event.user = sanitizeForSentryHook(event.user, state) as Sentry.ErrorEvent['user'];
    }

    scrubAdditionalEventCarriers(event, state);

    return event;
  } catch {
    return null;
  }
}

/**
 * Last-chance breadcrumb ingress filter. Breadcrumb data is application-controlled and can
 * contain arbitrary nested values, so it uses the same fail-closed recursive redactor as events.
 */
function scrubBreadcrumbStrict(breadcrumb: Sentry.Breadcrumb, state: SanitizationState): Sentry.Breadcrumb | null {
  const sanitized = sanitizeForSentryHook(breadcrumb, state);
  return sanitized !== null && typeof sanitized === 'object' && isPlainObject(sanitized)
    ? (sanitized as Sentry.Breadcrumb)
    : null;
}

export function scrubBreadcrumb(breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb | null {
  try {
    return scrubBreadcrumbStrict(breadcrumb, createSanitizationState());
  } catch {
    return null;
  }
}

/**
 * Defensive PII filter for transaction events.
 *
 * `event.transaction` is a structural string and receives pattern scrubbing. Request data,
 * breadcrumbs, application contexts, extra/user data, and trace data can contain arbitrary
 * application values, so they receive recursive pattern and keyed redaction.
 *
 * SDK-structural context fields keep their schema (for example `browser.name`); their strings
 * are still pattern-scrubbed. `event.spans[]` is handled per-span by `beforeSendSpan`.
 */
export function scrubTransactionEvent(event: TransactionEvent): TransactionEvent | null {
  try {
    const state = createSanitizationState();
    if (typeof event.transaction === 'string') {
      event.transaction = sanitizeForSentryHook(event.transaction, state) as string;
    }

    if (event.request) {
      event.request = sanitizeForSentryHook(event.request, state) as typeof event.request;
      scrubRequestConversationQuery(event.request);
    }

    if (event.breadcrumbs) {
      event.breadcrumbs = event.breadcrumbs.flatMap((breadcrumb) => {
        const sanitized = scrubBreadcrumbStrict(breadcrumb, state);
        return sanitized ? [sanitized] : [];
      });
    }

    if (event.contexts) {
      event.contexts = scrubEventContexts(event.contexts, state);
    }

    if (event.extra) {
      event.extra = sanitizeForSentryHook(event.extra, state) as typeof event.extra;
    }

    if (event.user) {
      event.user = sanitizeForSentryHook(event.user, state) as typeof event.user;
    }

    scrubAdditionalEventCarriers(event, state);

    return event;
  } catch {
    return null;
  }
}

/**
 * Defensive PII filter for span events.
 *
 * Span `description` (often a URL) receives pattern scrubbing. `span.data` can contain
 * arbitrary application attributes, so it receives recursive pattern and keyed redaction.
 * The same span object is returned, as required by the v10.51 hook contract.
 */
export function scrubSpanJson(span: SpanJSON): SpanJSON {
  if (typeof span.description === 'string') {
    span.description = scrubSensitiveStringPatterns(span.description);
  }

  if (span.data) {
    span.data = sanitizeForSentry(span.data) as SpanJSON['data'];
  }

  return span;
}
