/**
 * Wire-casing conversion for the Marketplace Transaction Service boundary.
 *
 * The client's internal TypeScript contracts are camelCase (matching the sandbox
 * prototype engine), while the durable Rust service speaks snake_case per
 * ADR-0019 §3. Conversion happens exactly once, at the transport boundary:
 * outgoing command envelopes go through {@link toSnakeCaseWire}, incoming
 * responses through {@link toCamelCaseWire}. Only object KEYS are converted —
 * values (aggregate ids, command kinds like `auction.place_bid`, enum states)
 * are wire payload and pass through untouched.
 */

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function camelToSnakeKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function snakeToCamelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

function convertKeysDeep(value: unknown, convertKey: (key: string) => string): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => convertKeysDeep(item, convertKey));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        convertKey(key),
        convertKeysDeep(entry, convertKey),
      ]),
    );
  }
  return value as JsonValue;
}

/** Converts all object keys from camelCase to snake_case, recursively. */
export function toSnakeCaseWire(value: unknown): JsonValue {
  return convertKeysDeep(value, camelToSnakeKey);
}

/** Converts all object keys from snake_case to camelCase, recursively. */
export function toCamelCaseWire(value: unknown): JsonValue {
  return convertKeysDeep(value, snakeToCamelKey);
}
