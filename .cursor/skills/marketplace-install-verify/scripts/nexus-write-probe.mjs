// Nexus write probe: one short post by a probe identity on the homeserver the Nexus watches,
// observed in the Nexus API, then deleted and observed gone. A profile is written only when the
// identity has none, and is deleted with the post. A throwaway identity's secret is kept in a
// mode-600 file under --out until teardown is verified, then removed.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { requireOptional } from './resolve-deps.mjs';

const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

function decodeSecret(text) {
  const value = text.trim();
  if (/^[0-9a-f]{64}$/i.test(value)) return new Uint8Array(Buffer.from(value, 'hex'));
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== 32) throw new Error('probe secret must be 32 bytes as hex or base64url');
  return new Uint8Array(bytes);
}

async function waitForStatus(target, wanted, timeoutMs) {
  const started = Date.now();
  let last = 0;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(10_000) });
      last = response.status;
      await response.arrayBuffer();
      if (response.status === wanted) return { ok: true, ms: Date.now() - started };
    } catch {
      last = 0;
    }
    await sleep(3_000);
  }
  return { ok: false, ms: Date.now() - started, last };
}

export async function runNexusWriteProbe({ get, nexusUrl, out, runCommand, record }) {
  const id = 'write.nexus';
  if (!nexusUrl) return record(id, 'FAIL', 'Nexus indexes a fresh write', 'NEXUS_URL unset', 'set NEXUS_URL');
  let sdk;
  let specs;
  try {
    sdk = requireOptional(get, '@synonymdev/pubky');
    specs = requireOptional(get, 'pubky-app-specs');
  } catch (error) {
    return record(id, 'FAIL', 'Nexus indexes a fresh write', error.message, 'install the repository dependencies');
  }
  const { Keypair, Pubky, PublicKey } = sdk;
  const timeoutMs = Number(get('NEXUS_PROBE_TIMEOUT_S') ?? 180) * 1000;
  const pubky = new Pubky();
  let keypair;
  let secretFile = null;
  if (get('NEXUS_PROBE_SECRET_FILE')) {
    keypair = Keypair.fromSecret(decodeSecret(readFileSync(get('NEXUS_PROBE_SECRET_FILE'), 'utf8')));
  } else if (get('NEXUS_PROBE_HOMESERVER') && (get('NEXUS_PROBE_SIGNUP_TOKEN') || get('NEXUS_PROBE_SIGNUP_TOKEN_CMD'))) {
    if (!out)
      return record(id, 'FAIL', 'Nexus indexes a fresh write', 'a throwaway identity needs --out', 'rerun with --out <dir>: its secret is kept there until cleanup is verified');
    let token = get('NEXUS_PROBE_SIGNUP_TOKEN');
    if (!token) {
      const result = await runCommand(get('NEXUS_PROBE_SIGNUP_TOKEN_CMD'));
      token = result.stdout.match(/[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/)?.[0];
      if (!token) return record(id, 'FAIL', 'probe signup token minted', `command exit ${result.code}`, 'fix NEXUS_PROBE_SIGNUP_TOKEN_CMD');
    }
    keypair = Keypair.random();
    secretFile = join(out, 'probe-seat.secret');
    writeFileSync(secretFile, Buffer.from(keypair.secret()).toString('hex'), { mode: 0o600 });
    await pubky.signer(keypair).signup(PublicKey.from(get('NEXUS_PROBE_HOMESERVER')), token);
    record('write.seat', 'INFO', 'throwaway probe identity signed up', `${keypair.publicKey.z32().slice(0, 8)}…`);
  } else {
    return record(id, 'SKIP', 'Nexus indexes a fresh write', 'set NEXUS_PROBE_SECRET_FILE, or NEXUS_PROBE_HOMESERVER plus NEXUS_PROBE_SIGNUP_TOKEN[_CMD]');
  }
  const author = keypair.publicKey.z32();
  const session = await pubky.signer(keypair).signinCookie();
  const profilePath = '/pub/pubky.app/profile.json';
  const profileExists = await pubky.publicStorage.exists(`pubky${author}${profilePath}`);
  const builder = new specs.PubkySpecsBuilder(author);
  const created = builder.createPost(
    `install-verify probe ${new Date().toISOString()} (deleted automatically)`,
    specs.PubkyAppPostKind.Short,
  );
  const postId = created.meta.id;
  const postPath = created.meta.path;
  const nexusPost = `${nexusUrl}/v0/post/${author}/${postId}`;
  const residue = [];
  const remove = async (path) => {
    try {
      await session.storage.delete(path);
    } catch (error) {
      if (!/404/.test(String(error.message))) residue.push(`${path}: ${String(error.message).slice(0, 80)}`);
    }
    if (await pubky.publicStorage.exists(`pubky${author}${path}`).catch(() => true)) residue.push(`${path} still stored`);
  };
  let wroteProfile = false;
  let wrotePost = false;
  try {
    if (!profileExists) {
      await session.storage.putJson(profilePath, {
        name: 'Install verify',
        bio: 'Temporary probe identity; removed automatically.',
        image: null,
        links: [],
        status: null,
      });
      wroteProfile = true;
    }
    await session.storage.putJson(postPath, created.post.toJson());
    wrotePost = true;
    const indexed = await waitForStatus(nexusPost, 200, timeoutMs);
    if (indexed.ok) record(id, 'PASS', 'Nexus indexes a fresh write', `post visible after ${Math.round(indexed.ms / 1000)} s`);
    else
      record(id, 'FAIL', 'Nexus indexes a fresh write', `not visible after ${Math.round(indexed.ms / 1000)} s (last HTTP ${indexed.last})`, 'the watcher is not processing this homeserver: check NEXUS_HOMESERVER and the nexusd log');
    if (indexed.ok) {
      await remove(postPath);
      wrotePost = false;
      const removed = await waitForStatus(nexusPost, 404, timeoutMs);
      if (removed.ok) record('write.nexus.delete', 'PASS', 'Nexus indexes the delete', `post gone after ${Math.round(removed.ms / 1000)} s`);
      else
        record('write.nexus.delete', 'FAIL', 'Nexus indexes the delete', `post still served after ${Math.round(removed.ms / 1000)} s (HTTP ${removed.last})`, 'the watcher applies PUT but not DEL events: read the nexusd log for the DEL of this post');
    }
  } finally {
    if (wrotePost) await remove(postPath);
    if (wroteProfile) await remove(profilePath);
    session.free?.();
  }
  if (residue.length) {
    record('write.nexus.cleanup', 'FAIL', 'probe data removed from the homeserver', residue.join('; '), `remove it with the identity ${author.slice(0, 8)}…${secretFile ? ` (secret kept in ${secretFile})` : ''}`);
  } else {
    record('write.nexus.cleanup', 'PASS', 'probe data removed from the homeserver', wroteProfile ? 'post and profile' : 'post');
    if (secretFile && existsSync(secretFile)) rmSync(secretFile);
  }
}
