import { z } from 'zod';
import { base64UrlToBytes, isPrivKeyId, PRIV_DATA_KEY_BYTES, type PrivKeyring } from './priv-envelope';

/**
 * `GET /v1/me/priv-keys` (marketplace-service, camel-cased): the session
 * owner's data keys, oldest first, and the id of the current one. Unknown
 * fields pass through so a later service field does not break the read.
 */
export const marketplacePrivKeysSchema = z
  .object({
    schemaVersion: z.literal(1),
    owner: z.string().min(1),
    currentKeyId: z.string().refine(isPrivKeyId),
    keys: z
      .array(
        z
          .object({
            keyId: z.string().refine(isPrivKeyId),
            key: z.string().min(1),
            createdAt: z.string().min(1),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

export type MarketplacePrivKeys = z.infer<typeof marketplacePrivKeysSchema>;

/** What the key read returned. `needs_reauth` and `unavailable` carry no key material. */
export type MarketplacePrivKeysResult =
  | { kind: 'keys'; keyring: PrivKeyring }
  | { kind: 'needs_reauth' }
  | { kind: 'unavailable' };

/**
 * Turns a parsed response into a keyring for `expectedOwner`, or null when
 * the response names another owner, repeats a key id, carries a key that is
 * not 32 bytes, or names a current key it does not include.
 */
export function privKeyringFromResponse(response: MarketplacePrivKeys, expectedOwner: string): PrivKeyring | null {
  if (response.owner !== expectedOwner) return null;
  const seen = new Set<string>();
  const keys: PrivKeyring['keys'] = [];
  for (const entry of response.keys) {
    if (seen.has(entry.keyId)) return null;
    seen.add(entry.keyId);
    let key: Uint8Array;
    try {
      key = base64UrlToBytes(entry.key);
    } catch {
      return null;
    }
    if (key.length !== PRIV_DATA_KEY_BYTES) return null;
    keys.push({ keyId: entry.keyId, key });
  }
  if (!seen.has(response.currentKeyId)) return null;
  return { ownerPubky: expectedOwner, currentKeyId: response.currentKeyId, keys };
}
