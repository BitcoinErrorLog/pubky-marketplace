import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';

// -----------------------------------------------------------------------------
// Digital delivery files (digital-delivery-design.md §2 "How a file is
// stored", §3.4). The seller's browser encrypts the file with a fresh
// AES-256-GCM key; only the ciphertext goes to the seller's homeserver, and
// the key reaches the marketplace sealed. The buyer's browser reverses it
// from the entitled read. Pure WebCrypto and BLAKE3: nothing here stores,
// logs or caches a key or plaintext.
// -----------------------------------------------------------------------------

/** Associated-data prefix, distinct from every service-side sealed family (§4.1). */
export const DIGITAL_DELIVERABLE_AAD_PREFIX = 'pubky-marketplace-deliverable/v1';
/** Where a seller's encrypted deliverables live on their homeserver. Nexus skips this prefix (§6 A15). */
export const DIGITAL_DELIVERABLES_PATH = '/pub/pubky.app/marketplace/v1/deliverables/';
/** The path recorded in logs and error context instead of an unpublished deliverable path. */
export const DIGITAL_DELIVERABLE_LOG_PATH = `${DIGITAL_DELIVERABLES_PATH}<deliverable>`;
/** AES-256-GCM tag length: the ciphertext is the plaintext length plus this. */
export const AES_GCM_TAG_BYTES = 16;

const KEY_BYTES = 32;
const IV_BYTES = 12;
const DELIVERABLE_ID_BYTES = 16;
const HEX = /^[0-9a-f]+$/;

function isLowerHex(value: string, length: number): boolean {
  return value.length === length && HEX.test(value);
}

/** A fresh random deliverable id: 32 lowercase hex characters, in no public record. */
export function newDigitalDeliverableId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(DELIVERABLE_ID_BYTES)));
}

export function isDigitalDeliverableId(value: string): boolean {
  return isLowerHex(value, DELIVERABLE_ID_BYTES * 2);
}

/** `pubky-marketplace-deliverable/v1|{seller_pubky}|{deliverable_id}|{version}` as UTF-8. */
export function digitalDeliverableAad(
  sellerPubky: string,
  deliverableId: string,
  version: number,
): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${DIGITAL_DELIVERABLE_AAD_PREFIX}|${sellerPubky}|${deliverableId}|${version}`);
}

export function digitalDeliverablePath(deliverableId: string, version: number): string {
  return `${DIGITAL_DELIVERABLES_PATH}${deliverableId}/${version}`;
}

/** The ciphertext length for a plaintext of `sizeBytes`: AES-GCM appends a 16-byte tag. */
export function digitalCiphertextBytes(sizeBytes: number): number {
  return sizeBytes + AES_GCM_TAG_BYTES;
}

export function digitalDeliverableUrl(sellerPubky: string, deliverableId: string, version: number): string {
  return `pubky://${sellerPubky}${digitalDeliverablePath(deliverableId, version)}`;
}

export type EncryptedDigitalDeliverable = {
  /** The bytes written to the homeserver. */
  ciphertext: Uint8Array<ArrayBuffer>;
  /** The AES-256 key, 64 lowercase hex characters. Sent once, to the service, which seals it. */
  key: string;
  /** The 12-byte GCM IV, 24 lowercase hex characters. */
  iv: string;
  ciphertextBlake3: string;
  plaintextBlake3: string;
  sizeBytes: number;
};

/**
 * Encrypts one deliverable version with a fresh key and IV, bound to the
 * seller, deliverable and version through the GCM associated data.
 */
export async function encryptDigitalDeliverable(input: {
  plaintext: Uint8Array<ArrayBuffer>;
  sellerPubky: string;
  deliverableId: string;
  version: number;
}): Promise<EncryptedDigitalDeliverable> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  try {
    const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: digitalDeliverableAad(input.sellerPubky, input.deliverableId, input.version),
          tagLength: AES_GCM_TAG_BYTES * 8,
        },
        cryptoKey,
        input.plaintext,
      ),
    );
    return {
      ciphertext,
      key: bytesToHex(keyBytes),
      iv: bytesToHex(iv),
      ciphertextBlake3: bytesToHex(blake3(ciphertext)),
      plaintextBlake3: bytesToHex(blake3(input.plaintext)),
      sizeBytes: input.plaintext.byteLength,
    };
  } finally {
    keyBytes.fill(0);
  }
}

/** Why a downloaded deliverable was not released to the buyer. */
export type DigitalDeliverableOpenFailure = 'ciphertext_mismatch' | 'decrypt_failed' | 'plaintext_mismatch';

export type DigitalDeliverableOpenResult =
  | { ok: true; plaintext: Uint8Array }
  | { ok: false; reason: DigitalDeliverableOpenFailure };

/**
 * Verifies the downloaded ciphertext against the pinned length and BLAKE3,
 * decrypts it with the pinned key, IV and associated data, and verifies the
 * plaintext BLAKE3. Nothing is returned unless all three hold.
 */
export async function openDigitalDeliverable(input: {
  ciphertext: Uint8Array<ArrayBuffer>;
  key: string;
  iv: string;
  ciphertextBlake3: string;
  plaintextBlake3: string;
  sizeBytes: number;
  sellerPubky: string;
  deliverableId: string;
  version: number;
}): Promise<DigitalDeliverableOpenResult> {
  if (
    input.ciphertext.byteLength !== input.sizeBytes + AES_GCM_TAG_BYTES ||
    bytesToHex(blake3(input.ciphertext)) !== input.ciphertextBlake3
  ) {
    return { ok: false, reason: 'ciphertext_mismatch' };
  }
  if (!isLowerHex(input.key, KEY_BYTES * 2) || !isLowerHex(input.iv, IV_BYTES * 2)) {
    return { ok: false, reason: 'decrypt_failed' };
  }
  const keyBytes = hexToBytes(input.key);
  let plaintext: Uint8Array;
  try {
    const cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: new Uint8Array(hexToBytes(input.iv)),
          additionalData: digitalDeliverableAad(input.sellerPubky, input.deliverableId, input.version),
          tagLength: AES_GCM_TAG_BYTES * 8,
        },
        cryptoKey,
        input.ciphertext,
      ),
    );
  } catch {
    return { ok: false, reason: 'decrypt_failed' };
  } finally {
    keyBytes.fill(0);
  }
  if (bytesToHex(blake3(plaintext)) !== input.plaintextBlake3) {
    plaintext.fill(0);
    return { ok: false, reason: 'plaintext_mismatch' };
  }
  return { ok: true, plaintext };
}

const CONTENT_TYPE_TOKEN = /^[A-Za-z0-9!#$&^_.+-]+$/;
/** Longest MIME type the service accepts. */
export const DIGITAL_CONTENT_TYPE_MAX_CHARS = 127;
/** Longest file name the service accepts. */
export const DIGITAL_FILE_NAME_MAX_CHARS = 255;
const FALLBACK_CONTENT_TYPE = 'application/octet-stream';
const FALLBACK_FILE_NAME = 'download';

/**
 * A MIME type exactly as the service accepts one (`is_valid_content_type` in
 * the domain commands): `type/subtype`, each of letters, digits and
 * `!#$&^_.+-`, no parameters, at most 127 characters.
 */
export function isDigitalContentType(value: string): boolean {
  const [kind, subtype, ...rest] = value.split('/');
  return (
    rest.length === 0 &&
    value.length <= DIGITAL_CONTENT_TYPE_MAX_CHARS &&
    kind !== undefined &&
    subtype !== undefined &&
    CONTENT_TYPE_TOKEN.test(kind) &&
    CONTENT_TYPE_TOKEN.test(subtype)
  );
}

/** The browser's MIME type if the service would accept it, else `application/octet-stream`. */
export function digitalFileContentType(browserType: string): string {
  const value = browserType.split(';')[0].trim().toLowerCase();
  return isDigitalContentType(value) ? value : FALLBACK_CONTENT_TYPE;
}

/**
 * The name buyers save the file as, in the form the service accepts: the
 * last path segment, without control characters, trimmed, at most 255
 * characters, never `.` or `..`.
 */
export function digitalFileName(browserName: string): string {
  const lastSegment = browserName.split(/[/\\]/).pop() ?? '';
  const cleaned = Array.from(lastSegment.replace(/\p{Cc}/gu, ''))
    .slice(0, DIGITAL_FILE_NAME_MAX_CHARS)
    .join('')
    .trim();
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? FALLBACK_FILE_NAME : cleaned;
}
