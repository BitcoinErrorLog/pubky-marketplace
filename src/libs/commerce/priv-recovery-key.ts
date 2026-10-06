import { assertPrivKeyringLive, bytesToBase64Url, PRIV_ENVELOPE_ENC, type PrivKeyring } from './priv-envelope';

/**
 * The downloadable recovery key: every data key the owner holds, enough to
 * read their encrypted marketplace records offline with the recipe in
 * `docs/ecommerce/priv-encryption-recovery.md`.
 */
export const PRIV_RECOVERY_KEY_FORMAT = 'pubky-priv-recovery-key/v1';

export type PrivRecoveryKeyFile = {
  fileName: string;
  contents: string;
};

export type PrivRecoveryKeyExport =
  | { kind: 'file'; file: PrivRecoveryKeyFile }
  | { kind: 'needs_reauth' }
  | { kind: 'unavailable' };

export function buildPrivRecoveryKeyFile(keyring: PrivKeyring): PrivRecoveryKeyFile {
  assertPrivKeyringLive(keyring);
  const document = {
    format: PRIV_RECOVERY_KEY_FORMAT,
    enc: PRIV_ENVELOPE_ENC,
    owner: keyring.ownerPubky,
    currentKeyId: keyring.currentKeyId,
    keys: keyring.keys.map(({ keyId, key }) => ({ keyId, key: bytesToBase64Url(key) })),
  };
  return {
    fileName: `pubky-marketplace-recovery-key-${keyring.ownerPubky.slice(0, 8)}.json`,
    contents: `${JSON.stringify(document, null, 2)}\n`,
  };
}
