# Private data keys wrapped under the user's signer (`/priv` Phase 4)

The Shop encrypts the watchlist, order receipts, badge checkpoints and muted
people before they reach the user's homeserver (see
[priv-encryption-recovery.md](priv-encryption-recovery.md)). The records are
sealed under a random per-user data key. Until Phase 4 the marketplace service
holds that key and could decrypt the records.

Phase 4 moves the key to the user. When the user's signer delivers scoped
encryption keys, the Shop wraps the data key under a key that only the signer
can derive, stores the wrapped copy on the user's homeserver, and has the
service drop its copy. The service can no longer decrypt. The data key does not
change, so no record is re-encrypted and no record path moves.

## What the Shop asks the signer for

The grant sign-in (Bitkit, Pubky Passport) adds one scope:

```
/pub/pubky.app/:rw,/pub/paykit/:rw,/priv/pubky.app/:rw,/priv/pubky.app/marketplace/:rwe
```

with `approvalFormat: "signedApprovalV1"`. `e` is on that one scope and no other.
It grants no storage access of its own and delivers keys for the Shop's own
private tree only. The Ring cookie sign-in and every other request are
unchanged: a cookie session cannot carry keys.

A signer may approve storage and decline `e` (the scope then comes back as
`/priv/pubky.app/marketplace/:rw`, or without it). That session is a full Shop
session, holds no keys, and keeps using the service-held key.

## Gate

The request for `e` is off by default and is made only when both hold:

- `PUBKY_RUNTIME_PRIV_ENCRYPTION_KEYS=true`, and
- the deploy's homeserver (`PUBKY_RUNTIME_HOMESERVER`) is listed in
  `PUBKY_RUNTIME_PRIV_ENCRYPTION_KEYS_HOMESERVERS` (a JSON array).

A homeserver without scoped-key support rejects any grant containing `e` after
the user approved it, and `/info` does not advertise the capability, so the
operator lists a homeserver once it runs a release that has it. Signers that
predate `e` cannot parse the link. While the gate is open, the Bitkit option
offers "Sign in without them" beside its QR code: the same grant without `e`
and without a signed approval, the separate sign-in without keys. With the gate
closed, which is the default, the Shop's requests are byte for byte what they
were before.

## The wrapped file

One file per data key:

```
/priv/pubky.app/marketplace/v2/keys/{key id}.json
```

```json
{ "enc": "pubky-priv-dek-wrap/v1", "kid": "<key id>", "nonce": "<24 bytes, base64url>", "ct": "<base64url>" }
```

```
file key     = EncryptionKeys.deriveForPath(path)             (the SDK, one stable key per file path)
wrapping key = HKDF-SHA256(ikm = file key, salt = "pubky-priv-dek-wrap/v1", info = "wrap", length = 32)
ct           = XChaCha20-Poly1305(wrapping key, nonce, aad = "pubky-priv-dek-wrap/v1|{owner}|{path}|{key id}")
plaintext    = {"version":1,"generation":<1-based>,"key":"<data key, base64url>"}
```

The associated data binds the owner, the path and the key id, so a file moved
to another owner, path or key id does not open. `generation` numbers the user's
keys in the order the service released them; the first key names every record
path, so a set with a gap or a repeat is refused rather than opened with the
wrong first key.

The data key is random and only wrapped, so it can still be rotated. The
wrapping key is derived on demand and never stored.

## Flow

On the first read of private data in a session that holds scoped keys reaching
`/priv/pubky.app/marketplace/` (`CommercePrivKeyringApplication`):

1. List `/priv/pubky.app/marketplace/v2/keys/` and open every file that opens.
2. Read the keys from the service (`GET /v1/me/priv-keys`).
3. For each key the service holds, make sure a wrapped file exists that opens to
   the same bytes; write it, read it back and open it again if not.
4. Only then ask the service to drop its copies
   (`POST /v1/me/priv-keys/release`, naming every key id). The service refuses
   with `key_set_changed` if its set differs, and the Shop reads again.

| State                                                                                    | Result                                                                                                          |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Session with keys, wrapped files exist, service still holds keys (an unfinished release) | Missing files are written, the release is retried.                                                              |
| Session with keys, wrapped files exist, service released, down, or refusing the session  | The wrapped files are the keys.                                                                                 |
| Session with keys, no wrapped file, service holds keys                                   | Wrap, verify, release (first keyed sign-in).                                                                    |
| Session with keys, nothing wrapped, service released                                     | No keys: "unavailable". Nothing is written.                                                                     |
| Session without keys (cookie, bare grant, `e` declined), service holds keys              | The service copy, as before.                                                                                    |
| Session without keys, service released                                                   | "Unavailable". The service never makes a replacement key.                                                       |
| A write or read-back fails                                                               | The error surfaces and the service keeps its copy.                                                              |
| The release fails or is refused                                                          | The verified wrapped keys are used; custody stays with the service and the release is retried on the next read. |

Existing records are never re-encrypted. A user's records written under the
service-held key stay exactly where they are.

## Recovery

The wrapped files restore from the user's pubky backup (the signer derives the
same file keys) plus the `/priv` ciphertext at its original paths. "Export
recovery key" keeps working for any session that holds the keys.
