// The client's core modules persist through Dexie; Node has no IndexedDB,
// so the shim must load before any app module.
import 'fake-indexeddb/auto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * LIVE durability probe for the staging homeserver's /priv storage.
 *
 * Motivation (status ledger, wallet-leg row): a day-old guarded upload under
 * `/priv/locks.app/content/` answered 404 despite a valid credential. The
 * Lock Server persists guarded bytes to the creator's homeserver and
 * re-reads them at serve time, so the loss points at either (a) staging
 * homeserver /priv data durability or (b) the Lock Server's imported
 * creator session. This probe isolates suspect (a) directly: it writes
 * probe files to this identity's OWN /priv tree and re-reads them later,
 * verifying byte-for-byte content by BLAKE3 hash.
 *
 * Diagnostic contract: if this probe stays green across days while another
 * guarded-content loss occurs, the homeserver layer is exonerated and the
 * investigation moves to the Lock Server's imported-session/serve layer.
 * (The probe writes under /priv/pubky.app/ — the session's grant — not
 * /priv/locks.app/; it tests the storage engine's durability, not the locks
 * subtree specifically.)
 *
 * Modes (PROBE_MODE):
 * - `seed`: write 3 probe files, verify immediate readback, persist their
 *   URLs + hashes + timestamp to PROBE_STATE_FILE.
 * - `check`: re-read every seeded file and verify content; reports age.
 *
 * Run:
 *   MARKETPLACE_STAGING_DROP_IDENTITIES_FILE=... PROBE_MODE=seed \
 *     npx vitest run --config vitest.durability.config.ts
 *   ... then re-run with PROBE_MODE=check at T+1h and T+1day.
 */

process.env.PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE ??= 'transaction-service';
process.env.NEXT_PUBLIC_APP_VERSION ??= '0.0.0-live';
process.env.NEXT_PUBLIC_DB_VERSION ??= '1';
process.env.NEXT_PUBLIC_DEBUG_MODE ??= 'false';

const MODE = process.env.PROBE_MODE ?? 'check';
const IDENTITIES_FILE = process.env.MARKETPLACE_STAGING_DROP_IDENTITIES_FILE ?? '';
const STATE_FILE = process.env.PROBE_STATE_FILE ?? `${process.env.HOME}/work/.priv-durability-probe.json`;
const PROBE_DIR = 'priv/pubky.app/durability-probe';
const PROBE_FILE_COUNT = 3;

interface ProbeState {
  pubky: string;
  seededAt: string;
  files: { url: string; blake3Hex: string; bytesLength: number }[];
}

type AppModules = {
  HomeserverService: typeof import('@/services/homeserver/homeserver').HomeserverService;
  CommerceHomeserverService: typeof import('@/services/homeserver/commerce/commerce').CommerceHomeserverService;
  useAuthStore: typeof import('@/stores/auth/auth.store').useAuthStore;
  sdk: typeof import('@synonymdev/pubky');
  blake3: typeof import('@noble/hashes/blake3.js').blake3;
  bytesToHex: typeof import('@noble/hashes/utils.js').bytesToHex;
};

let modules: AppModules;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

describe(`staging /priv durability probe (${MODE})`, () => {
  beforeAll(async () => {
    modules = {
      HomeserverService: (await import('@/services/homeserver/homeserver')).HomeserverService,
      CommerceHomeserverService: (await import('@/services/homeserver/commerce/commerce')).CommerceHomeserverService,
      useAuthStore: (await import('@/stores/auth/auth.store')).useAuthStore,
      sdk: await import('@synonymdev/pubky'),
      blake3: (await import('@noble/hashes/blake3.js')).blake3,
      bytesToHex: (await import('@noble/hashes/utils.js')).bytesToHex,
    };
  });

  it(`${MODE === 'seed' ? 'seeds probe files and verifies immediate readback' : 'verifies seeded files survived'}`, async () => {
    expect(existsSync(IDENTITIES_FILE), 'MARKETPLACE_STAGING_DROP_IDENTITIES_FILE must exist').toBe(true);
    const saved = JSON.parse(readFileSync(IDENTITIES_FILE, 'utf8')) as Record<string, string>;
    const secretHex = saved.buyerA ?? Object.values(saved)[0];
    expect(secretHex, 'a saved identity secret is required').toBeTruthy();

    const { HomeserverService, CommerceHomeserverService, sdk, blake3, bytesToHex } = modules;
    const keypair = sdk.Keypair.fromSecret(hexToBytes(secretHex));
    const pubky = keypair.publicKey.z32();
    const signedIn = await HomeserverService.signIn({ keypair });
    expect(signedIn, 'homeserver sign-in must succeed').not.toBeNull();
    // Install the session where the app's services resolve it (what the
    // browser's auth flow does; drops-race's actAs() in Node).
    modules.useAuthStore.setState({ session: signedIn!.session, currentUserPubky: pubky });
    console.info(`[durability-probe] signed in as ${pubky}`);

    if (MODE === 'seed') {
      const seededAt = new Date().toISOString();
      const files: ProbeState['files'] = [];
      for (let index = 0; index < PROBE_FILE_COUNT; index++) {
        const payload = { probe: 'priv-durability', seededAt, index, nonce: crypto.randomUUID() };
        const body = new TextEncoder().encode(JSON.stringify(payload));
        const url = `pubky://${pubky}/${PROBE_DIR}/${Date.parse(seededAt)}-${index}.json`;
        await CommerceHomeserverService.putJson(url, payload);
        // Immediate readback: a seed that cannot read its own write proves
        // nothing later. Content is compared as parsed VALUES (the transport
        // may re-serialize); the durability baseline is the hash of the
        // SERVED canonical form, so later checks detect any change in what
        // the homeserver returns.
        const readBack = (await CommerceHomeserverService.fetchJson(url)) as Record<string, unknown>;
        expect(readBack.nonce).toBe(payload.nonce);
        expect(readBack.seededAt).toBe(payload.seededAt);
        const canonical = new TextEncoder().encode(JSON.stringify(readBack));
        const hash = bytesToHex(blake3(canonical));
        files.push({ url, blake3Hex: hash, bytesLength: body.length });
        console.info(`[durability-probe] seeded + verified ${url}`);
      }
      writeFileSync(STATE_FILE, `${JSON.stringify({ pubky, seededAt, files } satisfies ProbeState, null, 2)}\n`, {
        mode: 0o600,
      });
      console.info(
        `[durability-probe] state written to ${STATE_FILE}; re-run with PROBE_MODE=check at T+1h and T+1day`,
      );
      return;
    }

    expect(existsSync(STATE_FILE), `no probe state at ${STATE_FILE} — run PROBE_MODE=seed first`).toBe(true);
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as ProbeState;
    const ageHours = (Date.now() - Date.parse(state.seededAt)) / 3_600_000;
    console.info(`[durability-probe] checking ${state.files.length} file(s) seeded ${ageHours.toFixed(1)}h ago`);

    const losses: string[] = [];
    for (const file of state.files) {
      try {
        const readBack = await CommerceHomeserverService.fetchJson(file.url);
        const canonical = new TextEncoder().encode(JSON.stringify(readBack));
        const hash = modules.bytesToHex(modules.blake3(canonical));
        if (hash !== file.blake3Hex) {
          losses.push(`${file.url}: content changed (hash mismatch, ${canonical.length} bytes)`);
        } else {
          console.info(`[durability-probe] intact: ${file.url}`);
        }
      } catch (error) {
        losses.push(`${file.url}: ${String(error)}`);
      }
    }

    // Layer naming on failure: these are DIRECT owner-session reads of
    // /priv — a loss here is the staging homeserver's storage layer, not
    // the Lock Server. Green here + a guarded-content loss elsewhere points
    // the investigation at the Lock Server's imported-session/serve layer.
    expect(losses, `STAGING HOMESERVER /priv DATA LOSS at T+${ageHours.toFixed(1)}h:\n${losses.join('\n')}`).toEqual(
      [],
    );
    console.info(`[durability-probe] all ${state.files.length} file(s) intact at T+${ageHours.toFixed(1)}h`);
  }, 120_000);
});
