/** @vitest-environment node */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { marketplaceSessionIdSchema } from './marketplace-session-id';

function migration0035SessionId(tokenHashHex: string): string {
  const hex = createHash('md5').update(tokenHashHex).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Same formatter as marketplace-service migration 0035. Version nibble `a` matches the 17–20 Sep capture. */
const legacySessionIds = [
  migration0035SessionId('0'.repeat(64)),
  migration0035SessionId('f'.repeat(64)),
  migration0035SessionId((43).toString(16).padStart(64, '0')),
];

describe('marketplace session id', () => {
  it('revert-fail: shared schema accepts migration-0035 ids that z.uuid() rejects', () => {
    expect(legacySessionIds[2]?.[14]).toBe('a');
    for (const id of legacySessionIds) {
      expect(z.uuid().safeParse(id).success, id).toBe(false);
      expect(marketplaceSessionIdSchema.safeParse(id).success, id).toBe(true);
    }
  });

  it.each([
    ['plain string', 'shop-session-id-plain-string-1234567'],
    ['uppercase', 'C91AC604-4109-A63D-AB8B-327FC9DECD05'],
    ['without hyphens', 'c91ac6044109a63dab8b327fc9decd05'],
    ['empty', ''],
    ['oversized', `${'a'.repeat(8)}-${'a'.repeat(4)}-${'a'.repeat(4)}-${'a'.repeat(4)}-${'a'.repeat(13)}`],
    ['newline', 'abc\n'],
    ['nul', 'ab\u0000c'],
    ['del', 'ab\u007Fc'],
  ])('rejects a session id that is %s', (_label, id) => {
    expect(marketplaceSessionIdSchema.safeParse(id).success).toBe(false);
  });
});
