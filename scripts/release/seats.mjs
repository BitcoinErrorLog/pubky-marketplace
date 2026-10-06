// Shared setup for the release proof scripts: proof seats, evidence folder, and the Shop's sign-in capabilities.
//
// Seats come from the environment only. Each seat is either a hex secret or an encrypted pubky.org/recovery
// backup file plus its passphrase:
//   PROOF_SEAT_SECRET_HEX | PROOF_SELLER_RECOVERY_FILE   seller seat
//   PROOF_BUYER_SECRET_HEX | PROOF_BUYER_RECOVERY_FILE   buyer seat
//   PROOF_RECOVERY_PASSPHRASE                            passphrase for the backup files
//   PROOF_SELLER_PREFIX, PROOF_BUYER_PREFIX              optional: the run stops unless the seat's pubky starts with it
// Seat files and secrets never live in this repository.
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const repoRequire = createRequire(resolve(REPO_ROOT, 'package.json'));

export const prefix = (z32) => `${String(z32 ?? '').slice(0, 8)}…`;

// The proof must assert the capabilities the checked-out release requests, so it reads them from source.
export function shopCapabilities() {
  if (process.env.PROOF_CAPABILITIES) return process.env.PROOF_CAPABILITIES;
  const source = readFileSync(resolve(REPO_ROOT, 'src/config/app.ts'), 'utf8');
  const match = source.match(/export const CAPABILITIES = '([^']+)'/);
  if (!match) throw new Error('CAPABILITIES not found in src/config/app.ts; set PROOF_CAPABILITIES');
  return match[1];
}

const lexists = (path) => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

// Resolves symlinks in the longest existing prefix of `path`, following dangling links to where mkdir would
// create them; the missing tail is appended unchanged.
export function realpathAllowingMissing(path, depth = 0) {
  if (depth > 40) throw new Error(`too many symlinks resolving ${path}`);
  let existing = resolve(path);
  const tail = [];
  while (!lexists(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    tail.unshift(basename(existing));
    existing = parent;
  }
  try {
    return resolve(realpathSync(existing), ...tail);
  } catch {
    const target = resolve(dirname(existing), readlinkSync(existing));
    return resolve(realpathAllowingMissing(target, depth + 1), ...tail);
  }
}

// True only when `path`, after resolving symlinks, lies outside `root`. A child named `..x` is inside.
export function isOutside(path, root) {
  const rel = relative(realpathAllowingMissing(root), realpathAllowingMissing(path));
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

// Evidence holds screenshots and network logs, so it stays outside the checkout.
export function evidenceDir() {
  const value = process.env.PROOF_EVIDENCE;
  if (!value) throw new Error('set PROOF_EVIDENCE to a release evidence folder outside this repository');
  if (!isOutside(value, REPO_ROOT)) {
    throw new Error(`PROOF_EVIDENCE must be outside the repository (${REPO_ROOT}), symlinks resolved`);
  }
  return realpathAllowingMissing(value);
}

function loadSeat(role, hexVar, fileVar, prefixVar) {
  const { Keypair } = repoRequire('@synonymdev/pubky');
  let keypair;
  if (process.env[hexVar]) {
    keypair = Keypair.fromSecret(new Uint8Array(Buffer.from(process.env[hexVar], 'hex')));
  } else if (process.env[fileVar]) {
    const passphrase = process.env.PROOF_RECOVERY_PASSPHRASE;
    if (!passphrase) throw new Error(`set PROOF_RECOVERY_PASSPHRASE to open ${fileVar}`);
    keypair = Keypair.fromRecoveryFile(new Uint8Array(readFileSync(process.env[fileVar])), passphrase);
  } else {
    throw new Error(`set ${hexVar} or ${fileVar} for the ${role} seat`);
  }
  const expected = process.env[prefixVar];
  const pubky = keypair.publicKey.z32();
  if (expected && !pubky.startsWith(expected))
    throw new Error(`${role} seat is ${prefix(pubky)}, expected ${expected}`);
  return keypair;
}

export const loadSellerSeat = () =>
  loadSeat('seller', 'PROOF_SEAT_SECRET_HEX', 'PROOF_SELLER_RECOVERY_FILE', 'PROOF_SELLER_PREFIX');
export const loadBuyerSeat = () =>
  loadSeat('buyer', 'PROOF_BUYER_SECRET_HEX', 'PROOF_BUYER_RECOVERY_FILE', 'PROOF_BUYER_PREFIX');
export const seatSource = () => (process.env.PROOF_SEAT_SECRET_HEX ? 'hex secret' : 'recovery file');
