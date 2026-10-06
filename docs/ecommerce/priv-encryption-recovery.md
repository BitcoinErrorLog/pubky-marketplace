# Reading encrypted marketplace data without the marketplace

The Shop encrypts your watchlist, order receipts, badge checkpoints and the people you muted in messages before they reach your homeserver. The key is a random 32-byte data key that the marketplace service holds sealed and releases only to your signed-in session. **Settings → Privacy and Safety → Export recovery key** downloads that key. With the file and your homeserver data, you can read everything offline, even if the marketplace service no longer exists.

Anyone who has the file can read the same data. Keep it offline.

## The recovery key file

```json
{
  "format": "pubky-priv-recovery-key/v1",
  "enc": "pubky-priv-aead/v1",
  "owner": "<your pubky>",
  "currentKeyId": "<32 hex>",
  "keys": [{ "keyId": "<32 hex>", "key": "<32 bytes, base64url without padding>" }]
}
```

`keys` is oldest first. Records name the key they were sealed under by `keyId`. Keys are only ever added: the first key is never retired, because every path is derived from it.

The file opens every private marketplace record you have. Store it like a seed phrase. It carries no signature or checksum, so load it only from storage you trust.

## Where the data is

Encrypted records live under `/priv/pubky.app/marketplace/v2/s/` on your homeserver. Only your own session can list or read `/priv`. Each record is a JSON envelope:

```json
{ "enc": "pubky-priv-aead/v1", "kid": "<keyId>", "nonce": "<24 bytes, base64url>", "ct": "<ciphertext, base64url>" }
```

## The recipe

The normative definition, with a test vector, is the "Encrypted Private Records (`pubky-priv-aead/v1`)" section of `SPEC.md` in [BitcoinErrorLog/pubky-app-specs](https://github.com/BitcoinErrorLog/pubky-app-specs). The summary below matches it.

For each data key:

```
record key = HKDF-SHA256(ikm = data key, salt = "pubky-priv-aead/v1", info = "record", length = 32)
path key   = HKDF-SHA256(ikm = data key, salt = "pubky-priv-aead/v1", info = "path",   length = 32)
```

Paths use the path key of the **first** key in `keys`:

```
family segment = base64url(HMAC-SHA256(path key, "family|" + family))
entry segment  = base64url(HMAC-SHA256(path key, "id|" + family + "|" + id))
path           = /priv/pubky.app/marketplace/v2/s/{family segment}/{entry name}
```

| Record                    | family                    | entry name                                |
| ------------------------- | ------------------------- | ----------------------------------------- |
| Watchlist                 | `watchlist`               | entry segment for id `watchlist`          |
| Order receipt             | `order_receipt`           | entry segment for the receipt id (a UUID) |
| Activity badge checkpoint | `attention_seen/activity` | a random 32-character lowercase hex name  |
| Orders badge checkpoint   | `attention_seen/orders`   | a random 32-character lowercase hex name  |
| Messaging mute changes    | `messaging_mutes`         | a random 32-character lowercase hex name  |

A badge checkpoint's plaintext is `{ "version": 1, "seenAt": <ms> }`; the checkpoint is the largest `seenAt`.

Each mute change's plaintext is `{ "version": 1, "kind": "pubky_app.messaging_mute_change.v0", "owner_pubky": <your pubky>, "counterparty_pubky": <pubky>, "muted": <bool>, "changed_at": <ms> }`. List the family and open every entry; per person the change with the largest `changed_at` applies, and a mute wins a tie. An older list may also exist as one entry named by the entry segment for id `mutes`, with plaintext `{ "version": 1, "kind": "pubky_app.messaging_mutes.v0", "owner_pubky": <your pubky>, "entries": { <pubky>: { "muted": <bool>, "changed_at": <ms> } } }`; count each of its entries as one more change.

To open a record, find the key whose `keyId` equals the envelope's `kid`. Decrypt `ct` with XChaCha20-Poly1305 under that key's record key, the envelope's `nonce`, and associated data built from the entry's own name (the last segment of its path):

```
{owner}|{family}|{entry name}|{kid}
```

The plaintext is the UTF-8 JSON of the original document: a watchlist record, or an order receipt with its `pubky-order-receipt+v1` attestation. Verify the receipt attestation offline with the receipt-verification recipe in the specs.

You do not need to know any receipt id. List the `order_receipt` family directory and open each entry by its name. The decrypted receipt carries its `receiptId`; check that the entry segment of that id equals the name you read it from, and discard the entry if it does not.

## Example (Node.js 20+)

```js
import { createHmac, hkdfSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';

const recovery = JSON.parse(readFileSync('pubky-marketplace-recovery-key.json', 'utf8'));
const subkey = (key, info) =>
  new Uint8Array(hkdfSync('sha256', Buffer.from(key, 'base64url'), 'pubky-priv-aead/v1', info, 32));
const pathKey = subkey(recovery.keys[0].key, 'path');
const segment = (input) => createHmac('sha256', pathKey).update(input).digest('base64url');
const familyPath = (family) => `/priv/pubky.app/marketplace/v2/s/${segment(`family|${family}`)}/`;

// `name` is the last segment of the path the envelope was read from.
function open(envelope, family, name) {
  const entry = recovery.keys.find((k) => k.keyId === envelope.kid);
  const aad = new TextEncoder().encode(`${recovery.owner}|${family}|${name}|${envelope.kid}`);
  const plaintext = xchacha20poly1305(
    subkey(entry.key, 'record'),
    Buffer.from(envelope.nonce, 'base64url'),
    aad,
  ).decrypt(Buffer.from(envelope.ct, 'base64url'));
  return JSON.parse(new TextDecoder().decode(plaintext));
}

const watchlistPath = `${familyPath('watchlist')}${segment('id|watchlist|watchlist')}`;

// Receipts: `names` is the listing of familyPath('order_receipt') on your homeserver.
// An entry that does not open, or whose receipt id does not derive its name, is skipped.
function openReceipts(names, readEnvelope) {
  return names.flatMap((name) => {
    try {
      const receipt = open(readEnvelope(name), 'order_receipt', name);
      return segment(`id|order_receipt|${receipt.receiptId}`) === name ? [receipt] : [];
    } catch {
      return [];
    }
  });
}
```
