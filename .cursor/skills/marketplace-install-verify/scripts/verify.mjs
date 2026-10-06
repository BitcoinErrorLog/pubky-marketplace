#!/usr/bin/env node
// Verifies a Pubky Marketplace installation (Shop, marketplace service, Paykit server, Locks
// server, marketplace Nexus, optional fiat verifier) end to end from the outside.
//
//   node verify.mjs --config <stack.env> [--only <sections>] [--out <dir>]
//                   [--flow-probes] [--write-probe] [--browser] [--deep] [--strict]
//
// Default checks are read-only: GET/OPTIONS requests, POSTs that the server must reject before
// doing any work (unsigned or unauthenticated), TLS handshakes, read-only SQL in a READ ONLY
// transaction, and operator-supplied status commands. The opt-in probes write only data that
// expires or is removed and verified gone before the run ends; see SKILL.md for each probe's
// exact footprint. No payment is created, and no secret value is printed or written.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import {
  compareMigrations,
  expectedMigration,
  extractRuntimeConfig,
  frameAncestorsAllow,
  isTruthy,
  missingOrigins,
  normalizeBase,
  parseEnvFile,
  parseJsonLenient,
  parseList,
  parseMigrationRows,
  parseSourceRef,
  parseTomlFlat,
  redact,
  short,
} from './lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const USER_AGENT = 'pubky-marketplace-install-verify/1';
const SECTIONS = ['config', 'tls', 'shop', 'service', 'paykit', 'locks', 'fiat', 'nexus', 'wiring', 'version', 'db'];
const PROBE_SECTIONS = ['flow', 'write', 'browser', 'deep'];
const PROBE_ORIGIN = 'https://install-verify.invalid';
const MIGRATION_DIRS = {
  service: 'crates/service/migrations',
  paykit: 'paykit-server/migrations',
  locks: 'locks-service/migrations',
};

// ---------- arguments and configuration ----------

function parseArgs(argv) {
  const args = { only: null, skip: [], out: null, config: null, flags: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--config') args.config = argv[(i += 1)];
    else if (arg === '--out') args.out = argv[(i += 1)];
    else if (arg === '--only') args.only = parseList(argv[(i += 1)]);
    else if (arg === '--skip') args.skip = parseList(argv[(i += 1)]);
    else if (['--flow-probes', '--write-probe', '--browser', '--deep', '--strict', '--json'].includes(arg))
      args.flags.add(arg.slice(2));
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || !args.config) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).join('\n'));
  process.exit(args.help ? 0 : 2);
}
function loadConfig(path) {
  try {
    return parseEnvFile(readFileSync(path, 'utf8'));
  } catch (error) {
    console.error(`config error in ${path}: ${error.code ?? error.message}`);
    process.exit(2);
  }
}
const mainConfig = loadConfig(resolve(args.config));
// MIV_INCLUDE lists further config files (relative to this one); the main file's values win.
const fileConfig = {
  ...Object.assign(
    {},
    ...parseList(mainConfig.MIV_INCLUDE).map((file) => loadConfig(resolve(dirname(resolve(args.config)), file))),
  ),
  ...mainConfig,
};
const get = (key) => {
  const value = process.env[key] ?? fileConfig[key];
  return value === undefined || value === '' ? undefined : value;
};
const commandEnv = { ...fileConfig, ...process.env, MIV_SCRIPTS: HERE };
const ENV = get('MIV_ENV');
if (ENV !== 'staging' && ENV !== 'production') {
  console.error('MIV_ENV must be "staging" or "production"');
  process.exit(2);
}
const PRODUCTION = ENV === 'production';
const wants = (section) => {
  if (args.skip.includes(section)) return false;
  if (PROBE_SECTIONS.includes(section)) {
    const flag = { flow: 'flow-probes', write: 'write-probe', browser: 'browser', deep: 'deep' }[section];
    return args.flags.has(flag) && (!args.only || args.only.includes(section) || args.only.includes(flag));
  }
  return !args.only || args.only.includes(section);
};
const OUT = args.out ? resolve(args.out) : null;
if (OUT) mkdirSync(OUT, { recursive: true });

const url = (key) => {
  const value = get(key);
  return value ? value.replace(/\/+$/, '') : undefined;
};
const SHOP_ORIGINS = parseList(get('SHOP_ORIGINS')).map((o) => o.replace(/\/+$/, ''));
const SERVICE = url('SERVICE_URL');
const PAYKIT = url('PAYKIT_URL');
const LOCKS = url('LOCKS_URL');
const NEXUS = url('NEXUS_URL');
const FIAT = url('FIAT_VERIFIER_URL');
const FORBIDDEN_HOSTS = parseList(get('FORBIDDEN_HOSTS')).map((h) => h.toLowerCase());

// Config facts: from the rendered config files when given, else from explicit keys.
const paykitToml = get('PAYKIT_CONFIG_FILE') ? parseTomlFlat(readFileSync(get('PAYKIT_CONFIG_FILE'), 'utf8')) : {};
const locksToml = get('LOCKS_CONFIG_FILE') ? parseTomlFlat(readFileSync(get('LOCKS_CONFIG_FILE'), 'utf8')) : {};
const facts = {
  paykitTrustedLocksKey: get('PAYKIT_TRUSTED_LOCKS_KEY') ?? paykitToml['locks.trusted_public_key'],
  paykitSetupOrigins: get('PAYKIT_SETUP_ALLOWED_ORIGINS') ?? paykitToml['setup.allowed_origins'],
  paykitLogAuthorizationUrl: get('PAYKIT_LOG_AUTHORIZATION_URL') ?? paykitToml['setup.log_authorization_url'],
  paykitBitcoinNetwork: get('PAYKIT_BITCOIN_NETWORK') ?? paykitToml['bitcoin.network'],
  locksPublicKey: get('LOCKS_PUBLIC_KEY') ?? locksToml['credentials.lock_server_public_key'],
  locksPaykitServerUrl: get('LOCKS_PAYKIT_SERVER_URL') ?? locksToml['paykit.server_url'],
  locksReturnOrigins:
    get('LOCKS_ALLOWED_RETURN_ORIGINS') ?? locksToml['creator_authority_acquisition.legacy_connect.allowed_return_origins'],
  locksRuntimeEnvironment: get('LOCKS_RUNTIME_ENVIRONMENT') ?? locksToml['runtime.environment'],
  servicePaykitUrl: get('SERVICE_PAYKIT_SERVER_URL'),
  serviceLocksUrl: get('SERVICE_LOCKS_SERVER_URL'),
  serviceAllowedOrigins: get('SERVICE_ALLOWED_ORIGINS'),
  serviceSandboxPayments: get('SERVICE_SANDBOX_PAYMENTS_ENABLED'),
  fiatPaykitUrl: get('FIAT_PAYKIT_SERVER_URL'),
  fiatTrustedLocksKey: get('FIAT_TRUSTED_LOCKS_KEY'),
  fiatReturnOrigins: get('FIAT_BUYER_RETURN_ORIGINS'),
};

// ---------- results ----------

const results = [];
const counts = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0, INFO: 0 };
const state = {};
const COLORS = { PASS: '\x1b[32m', FAIL: '\x1b[31m', WARN: '\x1b[33m', SKIP: '\x1b[90m', INFO: '\x1b[36m' };
const tty = process.stdout.isTTY && !args.flags.has('json');

function record(id, status, title, detail = '', hint = '') {
  const entry = { id, status, title, detail: redact(detail), hint: status === 'FAIL' || status === 'WARN' ? hint : '' };
  results.push(entry);
  counts[status] += 1;
  if (args.flags.has('json')) return;
  const tag = tty ? `${COLORS[status]}${status.padEnd(4)}\x1b[0m` : status.padEnd(4);
  console.log(`${tag}  ${id.padEnd(38)} ${title}${entry.detail ? ` — ${entry.detail}` : ''}`);
  if (entry.hint) console.log(`      fix: ${entry.hint}`);
}
const pass = (id, title, detail) => record(id, 'PASS', title, detail);
const fail = (id, title, detail, hint) => record(id, 'FAIL', title, detail, hint);
const warn = (id, title, detail, hint) => record(id, 'WARN', title, detail, hint);
const skip = (id, title, detail) => record(id, 'SKIP', title, detail);
const info = (id, title, detail) => record(id, 'INFO', title, detail);
const check = (id, ok, title, detail, hint) => {
  if (ok) pass(id, title, detail);
  else fail(id, title, detail, hint);
  return Boolean(ok);
};
const heading = (name) => {
  if (!args.flags.has('json')) console.log(`\n== ${name}`);
};

// ---------- I/O helpers ----------

async function http(target, { method = 'GET', headers = {}, body, timeoutMs = 20_000, redirect = 'follow' } = {}) {
  const started = Date.now();
  try {
    const response = await fetch(target, {
      method,
      headers: { 'user-agent': USER_AGENT, ...headers },
      body,
      redirect,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, text, ms: Date.now() - started };
  } catch (error) {
    return { status: 0, headers: new Headers(), text: '', ms: Date.now() - started, error: error.cause?.code ?? error.name };
  }
}
const jsonOf = (response) => {
  try {
    return parseJsonLenient(response.text);
  } catch {
    return null;
  }
};
const describe = (response) =>
  response.status ? `HTTP ${response.status} in ${response.ms} ms` : `no response (${response.error})`;

function runCommand(command, { input = '', timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn('/bin/sh', ['-c', command], { env: commandEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const lines = redact(stderr)
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !/^at |^\^|^Node\.js v|^[{}]$/.test(line));
      resolvePromise({ code, signal, stdout, stderr: lines.slice(0, 3).join(' | ').slice(0, 300) });
    });
    child.stdin.end(input);
  });
}

function isPrivateHost(hostname) {
  if (/\.internal$|\.local$|^localhost$/i.test(hostname)) return true;
  if (!net.isIP(hostname)) return false;
  return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|fc|fd)/i.test(hostname);
}

async function githubFetch(path) {
  const headers = { accept: 'application/vnd.github+json' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await http(`https://api.github.com/${path}`, { headers });
  if (response.status !== 200) throw new Error(`GitHub ${path.split('?')[0]}: ${describe(response)}`);
  return JSON.parse(response.text);
}

const resolvedRefs = new Map();
async function resolveCommit(source) {
  const ref = parseSourceRef(source);
  if (!ref) throw new Error(`not owner/repo@ref: ${source}`);
  if (/^[0-9a-f]{40}$/.test(ref.ref)) return ref.ref;
  const key = `${ref.owner}/${ref.repo}@${ref.ref}`;
  if (!resolvedRefs.has(key)) {
    const commit = await githubFetch(`repos/${ref.owner}/${ref.repo}/commits/${encodeURIComponent(ref.ref)}`);
    resolvedRefs.set(key, commit.sha);
  }
  return resolvedRefs.get(key);
}

async function expectedMigrations(service) {
  const override = get(`${service.toUpperCase()}_MIGRATIONS_DIR`);
  if (override && existsSync(override)) {
    return readdirSync(override)
      .sort()
      .map((name) => expectedMigration(name, readFileSync(join(override, name))))
      .filter(Boolean);
  }
  const source = get(`${service.toUpperCase()}_SOURCE`);
  const ref = parseSourceRef(source);
  if (!ref) return null;
  const sha = await resolveCommit(source);
  const dir = override ?? MIGRATION_DIRS[service];
  const listing = await githubFetch(`repos/${ref.owner}/${ref.repo}/contents/${dir}?ref=${sha}`);
  const migrations = [];
  for (const entry of listing.filter((item) => item.type === 'file' && item.name.endsWith('.sql'))) {
    const raw = await fetch(entry.download_url, { signal: AbortSignal.timeout(20_000) });
    if (!raw.ok) throw new Error(`download ${entry.name}: HTTP ${raw.status}`);
    const migration = expectedMigration(entry.name, Buffer.from(await raw.arrayBuffer()));
    if (migration) migrations.push(migration);
  }
  return migrations.sort((a, b) => a.version - b.version);
}

function tlsHandshake(host) {
  return new Promise((resolvePromise) => {
    const socket = tls.connect({ host, port: 443, servername: host, timeout: 15_000 }, () => {
      const cert = socket.getPeerCertificate();
      resolvePromise({
        authorized: socket.authorized,
        error: socket.authorizationError,
        protocol: socket.getProtocol(),
        validTo: cert.valid_to ? new Date(cert.valid_to) : null,
        issuer: cert.issuer?.O ?? cert.issuer?.CN ?? '?',
      });
      socket.end();
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolvePromise({ authorized: false, error: 'timeout' });
    });
    socket.on('error', (error) => resolvePromise({ authorized: false, error: error.code ?? error.message }));
  });
}

async function preflight(target, origin, method, requestHeaders) {
  return http(target, {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': method,
      ...(requestHeaders ? { 'access-control-request-headers': requestHeaders } : {}),
    },
  });
}

function needs(id, title, keys) {
  const missing = keys.filter((key) => !get(key));
  if (!missing.length) return true;
  fail(id, title, `${missing.join(', ')} not set`, `set ${missing.join(', ')} in ${args.config}`);
  return false;
}

// ---------- sections ----------

async function sectionConfig() {
  heading('config');
  info('config.env', `environment ${ENV}`, `config ${args.config}`);
  const urls = { SERVICE_URL: SERVICE, PAYKIT_URL: PAYKIT, LOCKS_URL: LOCKS, NEXUS_URL: NEXUS };
  const missing = Object.entries(urls)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (!SHOP_ORIGINS.length) missing.unshift('SHOP_ORIGINS');
  check(
    'config.required',
    !missing.length,
    'required endpoints configured',
    missing.length ? `missing ${missing.join(', ')}` : `${SHOP_ORIGINS.length} Shop origin(s), 4 services`,
    `set ${missing.join(', ')}`,
  );
  const all = [...SHOP_ORIGINS, SERVICE, PAYKIT, LOCKS, NEXUS, FIAT].filter(Boolean);
  const plain = all.filter((value) => !value.startsWith('https://'));
  if (plain.length && get('ALLOW_HTTP') !== '1')
    fail('config.https', 'every public endpoint uses https', plain.join(', '), 'serve every public endpoint over HTTPS');
  else pass('config.https', 'every public endpoint uses https');
}

async function sectionTls() {
  heading('tls');
  const hosts = [...new Set([...SHOP_ORIGINS, SERVICE, PAYKIT, LOCKS, NEXUS, FIAT].filter(Boolean))]
    .filter((value) => value.startsWith('https://'))
    .map((value) => new URL(value).hostname);
  const minDays = Number(get('TLS_MIN_DAYS') ?? 21);
  for (const host of [...new Set(hosts)]) {
    const result = await tlsHandshake(host);
    const id = `tls.${host}`;
    if (!result.authorized) {
      fail(id, 'certificate trusted', String(result.error), 'install a publicly trusted certificate for this exact host name');
      continue;
    }
    const days = Math.floor((result.validTo - Date.now()) / 86_400_000);
    const detail = `${result.protocol}, ${result.issuer}, expires ${result.validTo.toISOString().slice(0, 10)} (${days} d)`;
    if (!['TLSv1.2', 'TLSv1.3'].includes(result.protocol))
      fail(id, 'TLS 1.2 or newer', detail, 'disable TLS < 1.2 on the load balancer');
    else if (days < 7) fail(id, 'certificate valid', detail, 'renew the certificate now; check the renewal job');
    else if (days < minDays) warn(id, 'certificate valid', detail, 'renewal should have happened by now; check the renewal job');
    else pass(id, 'certificate valid', detail);
    const plain = await http(`http://${host}/`, { redirect: 'manual', timeoutMs: 10_000 });
    const location = plain.headers.get('location') ?? '';
    if (plain.status >= 300 && plain.status < 400 && location.startsWith('https://'))
      pass(`${id}.redirect`, 'plain HTTP redirects to HTTPS', `${plain.status}`);
    else if (!plain.status) pass(`${id}.redirect`, 'plain HTTP not served', `port 80 ${plain.error}`);
    else warn(`${id}.redirect`, 'plain HTTP redirects to HTTPS', describe(plain), 'redirect port 80 to HTTPS (301/308)');
  }
}

async function sectionShop() {
  heading('shop');
  if (!SHOP_ORIGINS.length) return fail('shop.origins', 'Shop origins configured', '', 'set SHOP_ORIGINS');
  const path = get('SHOP_PATH') ?? '/marketplace';
  for (const origin of SHOP_ORIGINS) {
    const host = new URL(origin).host;
    const page = await http(`${origin}${path}`);
    const isHtml = (page.headers.get('content-type') ?? '').includes('text/html');
    if (!check(`shop.page.${host}`, page.status === 200 && isHtml, `${path} loads`, describe(page), 'check the Shop deployment and its logs')) continue;
    const hsts = page.headers.get('strict-transport-security');
    if (hsts) pass(`shop.hsts.${host}`, 'HSTS header', hsts);
    else warn(`shop.hsts.${host}`, 'HSTS header', 'missing', 'send Strict-Transport-Security: max-age=63072000');
    let runtime = null;
    try {
      runtime = extractRuntimeConfig(page.text);
    } catch (error) {
      runtime = null;
      info(`shop.runtime.${host}`, 'runtime config parse error', error.message);
    }
    if (!check(`shop.runtime.${host}`, Boolean(runtime), 'runtime config present', runtime ? '' : 'no __PUBKY_CONFIG__ in page', 'the Shop image must render window.__PUBKY_CONFIG__; check the build')) continue;
    state.shopRuntime ??= runtime;
    const same = (a, b) => normalizeBase(a) === normalizeBase(b);
    const pairs = [
      ['marketplaceUrl', SERVICE, 'PUBKY_RUNTIME_MARKETPLACE_URL'],
      ['marketplaceNexusUrl', NEXUS, 'PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL'],
      ['locksUrl', LOCKS, 'PUBKY_RUNTIME_LOCKS_URL'],
      ['paykitSetupUrl', PAYKIT && `${PAYKIT}/setup`, 'PUBKY_RUNTIME_PAYKIT_SETUP_URL'],
    ];
    for (const [key, expected, envName] of pairs) {
      if (!expected) continue;
      check(
        `shop.runtime.${host}.${key}`,
        same(runtime[key], expected),
        `${key} points at this stack`,
        `${runtime[key] ?? 'unset'}`,
        `set ${envName}=${expected} on the Shop and redeploy (runtime values change only on restart)`,
      );
    }
    const expectations = [
      ['deployEnv', get('EXPECT_SHOP_DEPLOY_ENV'), 'PUBKY_RUNTIME_ENV'],
      ['testnet', get('EXPECT_SHOP_TESTNET'), 'PUBKY_RUNTIME_TESTNET'],
      ['homeserver', get('EXPECT_HOMESERVER'), 'PUBKY_RUNTIME_HOMESERVER'],
    ];
    for (const [key, expected, envName] of expectations) {
      if (expected === undefined) continue;
      check(
        `shop.runtime.${host}.${key}`,
        String(runtime[key]) === expected,
        `${key} is ${expected}`,
        String(runtime[key]),
        `set ${envName}=${expected} on the Shop`,
      );
    }
    const serialized = JSON.stringify(runtime).toLowerCase();
    const leftovers = FORBIDDEN_HOSTS.filter((h) => serialized.includes(h));
    if (FORBIDDEN_HOSTS.length)
      check(
        `shop.runtime.${host}.forbidden`,
        !leftovers.length,
        'no retired hosts in runtime config',
        leftovers.join(', '),
        'replace every retired host in the Shop PUBKY_RUNTIME_* values',
      );
    const llms = await http(`${origin}/llms.txt`);
    const index = llms.text.match(/^INDEX\s*=\s*(\S+)/m)?.[1];
    if (llms.status !== 200) warn(`shop.llms.${host}`, '/llms.txt served', describe(llms), 'check the Shop route /llms.txt');
    else if (!index) warn(`shop.llms.${host}`, '/llms.txt names the index', 'no INDEX line', 'check the llms.txt template');
    else
      check(
        `shop.llms.${host}`,
        !NEXUS || same(index, NEXUS),
        '/llms.txt advertises this Nexus',
        index,
        'set PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL on the Shop; /llms.txt reads it',
      );
  }
}

async function sectionService() {
  heading('service');
  if (!needs('service.url', 'marketplace service configured', ['SERVICE_URL'])) return;
  const ready = await http(`${SERVICE}/ready`);
  check('service.ready', ready.status === 200 && jsonOf(ready)?.status === 'ready', '/ready', describe(ready), 'readiness fails on DB access, refusal-audit readiness or an overdue email purge; read the service log');
  const health = await http(`${SERVICE}/health`);
  const body = jsonOf(health);
  if (!check('service.health', health.status === 200 && body?.status === 'ok', '/health', describe(health), 'read the service log')) return;
  info('service.capabilities', 'capabilities', `pickup ${body.pickup_available}, digital ${body.digital_delivery_available}, priv_keys ${body.priv_keys_available}`);
  const rail = body.paykit_rail ?? {};
  if (rail.age_seconds === null || rail.age_seconds === undefined)
    warn('service.paykit-rail', 'service polls Paykit', 'no rail sample yet', 'normal for a minute after start; otherwise check PAYKIT_SERVER_URL and the signing key on the service');
  else if (rail.age_seconds > 300)
    fail('service.paykit-rail', 'service polls Paykit', `last sample ${rail.age_seconds} s ago`, 'the service cannot reach Paykit /health/ready; check PAYKIT_SERVER_URL and egress');
  else pass('service.paykit-rail', 'service polls Paykit', `sample ${rail.age_seconds} s old, bitcoin_offer_available=${rail.bitcoin_offer_available}`);
  const expectOffer = get('EXPECT_BITCOIN_OFFER');
  if (expectOffer !== undefined)
    check('service.bitcoin-offer', String(rail.bitcoin_offer_available) === expectOffer, `bitcoin_offer_available is ${expectOffer}`, String(rail.bitcoin_offer_available), 'Paykit /health/ready must report bitcoin_offer_available; check Electrum and bitcoin.creation_enabled');
  for (const origin of SHOP_ORIGINS) {
    const response = await preflight(`${SERVICE}/v1/auth/sessions`, origin, 'POST', 'authorization,content-type');
    const allowed = response.headers.get('access-control-allow-origin');
    const headers = (response.headers.get('access-control-allow-headers') ?? '').toLowerCase();
    check(
      `service.cors.${new URL(origin).host}`,
      allowed === origin && headers.includes('authorization'),
      'CORS allows the Shop',
      `allow-origin ${allowed ?? 'none'}`,
      `add ${origin} to ALLOWED_ORIGINS on the service`,
    );
  }
  const foreign = await preflight(`${SERVICE}/v1/auth/sessions`, PROBE_ORIGIN, 'POST');
  check('service.cors.foreign', !foreign.headers.get('access-control-allow-origin'), 'CORS refuses other origins', `allow-origin ${foreign.headers.get('access-control-allow-origin') ?? 'none'}`, 'ALLOWED_ORIGINS must list exact Shop origins, never *');
  const unknownSeller = 'y'.repeat(52);
  const config = await http(`${SERVICE}/v0/sellers/${unknownSeller}/payment-config`);
  check('service.public-read', config.status === 200 && 'paypal_available' in (jsonOf(config) ?? {}), 'public payment-config read (database path)', describe(config), 'read the service log for the database error');
  const orders = await http(`${SERVICE}/v1/orders`);
  check('service.auth-required', orders.status === 401, 'protected routes require a session', describe(orders), 'the session middleware is not in front of /v1/orders; check the build');
}

async function sectionPaykit() {
  heading('paykit');
  if (!needs('paykit.url', 'Paykit server configured', ['PAYKIT_URL'])) return;
  const live = await http(`${PAYKIT}/health/live`);
  check('paykit.live', live.status === 200 && jsonOf(live)?.status === 'live', '/health/live', describe(live), 'the process is not serving; read its log');
  const ready = await http(`${PAYKIT}/health/ready`);
  const body = jsonOf(ready) ?? {};
  state.paykitFlavor = 'stack_id' in body ? 'fork' : 'upstream';
  info('paykit.flavor', `${state.paykitFlavor} server`, state.paykitFlavor === 'fork' ? 'BitcoinErrorLog fork (stack_id present)' : 'upstream pubky/paykit-server');
  const electrum = typeof body.electrum === 'object' ? body.electrum?.state : body.electrum;
  const parts = ['postgres', 'paykit_delivery', 'outbox'].map((k) => `${k} ${body[k]}`).concat(`electrum ${electrum}`);
  if (body.status === 'ready') pass('paykit.ready', '/health/ready', parts.join(', '));
  else if (body.status === 'degraded') warn('paykit.ready', '/health/ready', `degraded: ${parts.join(', ')}`, 'a component is degraded; the Electrum endpoint is the usual cause');
  else fail('paykit.ready', '/health/ready', `${describe(ready)} ${parts.join(', ')}`, 'check PAYKIT_DATABASE_URL, the Electrum endpoint and the log');
  const chain = (name) => ({ mainnet: 'bitcoin' })[name] ?? name;
  const network = get('EXPECT_BITCOIN_NETWORK') && chain(get('EXPECT_BITCOIN_NETWORK'));
  const tip = body.electrum_tip_height ?? body.electrum?.tip_height;
  if (network === 'bitcoin' && typeof tip === 'number')
    // Mainnet is near 1M blocks; testnet3 is past 4M; testnet4, signet and regtest are far below 800k.
    check('paykit.electrum-chain', tip > 800_000 && tip < 2_000_000, 'Electrum serves mainnet', `tip ${tip}`, 'the Electrum endpoint is not a mainnet server');
  else if (typeof tip === 'number') info('paykit.electrum-chain', 'Electrum tip', `height ${tip}`);
  const tipAge = body.electrum_tip_age_seconds ?? body.electrum?.tip_age_secs;
  if (typeof tipAge === 'number' && tipAge > 7200)
    warn('paykit.electrum-tip-age', 'Electrum tip is recent', `last block ${Math.round(tipAge / 60)} min ago`, 'the Electrum server may be stuck or behind; compare its tip with a block explorer');
  if (network && facts.paykitBitcoinNetwork)
    check('paykit.bitcoin-network', chain(facts.paykitBitcoinNetwork) === network, `bitcoin.network is ${network}`, facts.paykitBitcoinNetwork, 'set [bitcoin] network in the Paykit config');
  const signed =
    state.paykitFlavor === 'fork'
      ? ['/invoices', '/transactions/status', '/v0/payment-requests']
      : ['/invoices', '/transactions/status', '/setup/status', '/payment-requests/status', '/connections/status'];
  const garbage = Buffer.alloc(64).toString('base64url');
  const payload = JSON.stringify({ bundle_id: 'install-verify', creator: 'install-verify' });
  for (const route of signed) {
    const unsigned = await http(`${PAYKIT}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    const forged = await http(`${PAYKIT}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-paykit-signature': garbage },
      body: payload,
    });
    check(
      `paykit.auth${route.replace(/\//g, '.')}`,
      unsigned.status === 401 && forged.status === 401,
      `${route} rejects unsigned and forged calls`,
      `unsigned ${unsigned.status || unsigned.error}, forged ${forged.status || forged.error}`,
      unsigned.status === 404 ? 'route missing: this build is not the expected Paykit release' : 'signed routes must answer 401 without a valid X-Paykit-Signature',
    );
  }
  if (facts.paykitLogAuthorizationUrl !== undefined)
    check('paykit.log-authorization-url', String(facts.paykitLogAuthorizationUrl) !== 'true', 'setup authorization URLs are not logged', `log_authorization_url=${facts.paykitLogAuthorizationUrl}`, 'set [setup] log_authorization_url = false: each logged URL is a bearer secret');
  const countCommand = get('PAYKIT_INSTANCE_COUNT_CMD');
  if (!countCommand) {
    warn('paykit.single-instance', 'exactly one Paykit process', 'not verified', 'set PAYKIT_INSTANCE_COUNT_CMD to a command that prints how many Paykit processes can serve (see SKILL.md)');
  } else {
    const result = await runCommand(countCommand);
    const count = Number(result.stdout.trim().split(/\s+/).pop());
    check('paykit.single-instance', result.code === 0 && count === 1, 'exactly one Paykit process', result.code === 0 ? `${count} running` : `command exit ${result.code}: ${result.stderr}`, 'run one replica, min=max=1, no rolling or blue-green overlap: a second process restoring the same grant invalidates the first');
  }
}

async function sectionLocks() {
  heading('locks');
  if (!needs('locks.url', 'Locks server configured', ['LOCKS_URL'])) return;
  const health = await http(`${LOCKS}/healthz`);
  check('locks.healthz', health.status === 200 && jsonOf(health)?.status === 'ok', '/healthz', describe(health), 'the process is not serving; read its log');
  const ready = await http(`${LOCKS}/readyz`);
  const body = jsonOf(ready) ?? {};
  check('locks.readyz', ready.status === 200 && body.status === 'ready', '/readyz', `${describe(ready)}, storage ${body.runtime_storage}, worker ${body.worker_enabled}`, 'check PUBKY_LOCK_DATABASE_URL and the log');
  check('locks.storage', body.runtime_storage === 'persisted', 'Postgres-backed state', String(body.runtime_storage), 'configure [database] url_env: in-memory storage loses every task on restart');
  check('locks.worker', body.worker_enabled === true, 'verification worker enabled', String(body.worker_enabled), 'set [worker] enabled = true');
  const wellKnown = await http(`${LOCKS}/.well-known/locks-server`);
  const identity = jsonOf(wellKnown) ?? {};
  state.lockServerKey = identity.lock_server;
  if (check('locks.identity', wellKnown.status === 200 && identity.service === 'pubky-locks-server' && Boolean(identity.lock_server), 'Lock Server identity published', `${short(identity.lock_server)} api ${identity.api_version}`, 'check credentials.lock_server_public_key')) {
    const expected = get('EXPECT_LOCK_SERVER_KEY');
    if (expected)
      check('locks.identity.carried-over', identity.lock_server === expected, 'Lock Server identity is the carried-over key', `${short(identity.lock_server)} vs expected ${short(expected)}`, 'install the existing lock_server_secret_key: a new key makes every seller republish their locks');
    if (facts.locksPublicKey)
      check('locks.identity.config', facts.locksPublicKey === identity.lock_server, 'published identity matches config', short(facts.locksPublicKey), 'restart Locks after changing its credentials');
  }
  // GET never reaches the POST handler: 405 means the route exists, 404 means it does not.
  const devRoute = await http(`${LOCKS}/verification-task-completions`);
  check('locks.dev-route-closed', devRoute.status === 404, 'development completion route is not exposed', describe(devRoute), 'set [runtime] environment to a non-development value: this route completes verification tasks without payment');
  if (facts.locksRuntimeEnvironment !== undefined)
    check('locks.runtime-environment', facts.locksRuntimeEnvironment !== 'development', 'runtime environment is not development', String(facts.locksRuntimeEnvironment), 'set [runtime] environment = "production" (or "staging")');
  for (const origin of SHOP_ORIGINS) {
    const response = await preflight(`${LOCKS}/creator/authority-status`, origin, 'GET', 'authorization');
    const allowed = response.headers.get('access-control-allow-origin');
    check(`locks.cors.${new URL(origin).host}`, allowed === origin || allowed === '*', 'CORS allows the Shop', `allow-origin ${allowed ?? 'none'}`, 'the Shop calls Locks from the browser; allow its origin');
  }
}

async function sectionFiat() {
  heading('fiat');
  if (!FIAT) return skip('fiat', 'fiat verifier not configured', 'FIAT_VERIFIER_URL unset');
  const health = await http(`${FIAT}/health`);
  const body = jsonOf(health) ?? {};
  check('fiat.health', health.status === 200 && body.status === 'ok' && body.database === true, '/health', `${describe(health)}, database ${body.database}, version ${body.version}`, 'check FIAT_DATABASE_URL and the log');
  for (const processor of ['stripe', 'paypal']) {
    if (!body[`${processor}_enabled`]) continue;
    if (body[`${processor}_webhook_configured`]) pass(`fiat.${processor}`, `${processor} enabled with a webhook`);
    else warn(`fiat.${processor}`, `${processor} enabled with a webhook`, 'webhook secret not configured', `set the ${processor} webhook secret, or payments settle only by polling`);
  }
  for (const route of ['/invoices', '/transactions/status']) {
    const unsigned = await http(`${FIAT}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"bundle_id":"install-verify"}' });
    check(`fiat.auth${route.replace(/\//g, '.')}`, unsigned.status === 401, `${route} rejects unsigned calls`, describe(unsigned), 'signed routes must answer 401 without a valid X-Paykit-Signature');
  }
}

async function nexusListings(base) {
  const rows = new Map();
  for (let skipCount = 0; skipCount <= 5000; skipCount += 50) {
    const page = await http(`${base}/v0/stream/listings?limit=50&skip=${skipCount}`);
    if (page.status !== 200) throw new Error(`${base} listings ${describe(page)}`);
    const items = parseJsonLenient(page.text);
    if (!Array.isArray(items) || !items.length) break;
    const before = rows.size;
    for (const item of items) rows.set(`${item.owner_id}/${item.id}`, { key: `${item.owner_id}/${item.id}`, revision: item.revision, state: item.state });
    if (rows.size === before) break;
  }
  return [...rows.values()];
}

async function sectionNexus() {
  heading('nexus');
  if (!needs('nexus.url', 'Nexus configured', ['NEXUS_URL'])) return;
  const infoResponse = await http(`${NEXUS}/v0/info`);
  const body = jsonOf(infoResponse) ?? {};
  if (!check('nexus.info', infoResponse.status === 200 && Boolean(body.version), '/v0/info', `${describe(infoResponse)}, version ${body.version}`, 'the API is not serving; read the nexusd log')) return;
  if (!/^[0-9a-f]{40}$/.test(body.commit_hash ?? ''))
    fail('nexus.commit', 'build reports its source commit', `commit_hash "${body.commit_hash ?? ''}"`, 'build from a git checkout with .git in the Docker context: nexus-webapi/build.rs runs git rev-parse');
  else if (get('NEXUS_SOURCE')) {
    const expected = await resolveCommit(get('NEXUS_SOURCE'));
    check('nexus.commit', body.commit_hash === expected, 'running the pinned commit', `${body.commit_hash.slice(0, 12)} vs ${expected.slice(0, 12)}`, 'rebuild and redeploy from the pinned commit');
  } else info('nexus.commit', 'running commit', body.commit_hash);
  const snapshot = body.last_index_snapshot ? new Date(`${body.last_index_snapshot.replace(' ', 'T')}Z`) : null;
  const ageMinutes = snapshot ? Math.round((Date.now() - snapshot) / 60_000) : null;
  if (ageMinutes === null) warn('nexus.snapshot', 'index snapshot is current', 'no last_index_snapshot', 'check the watcher');
  else if (ageMinutes > Number(get('NEXUS_MAX_SNAPSHOT_AGE_MIN') ?? 30))
    warn('nexus.snapshot', 'index snapshot is current', `${ageMinutes} min old`, 'the watcher may be stalled; read the nexusd log for "Processing N event lines" and panics');
  else pass('nexus.snapshot', 'index snapshot is current', `${ageMinutes} min old`);
  let listings = [];
  try {
    listings = await nexusListings(NEXUS);
    const minimum = Number(get('EXPECT_MIN_LISTINGS') ?? 1);
    if (listings.length >= minimum) pass('nexus.listings', '/v0/stream/listings', `${listings.length} listings`);
    else warn('nexus.listings', '/v0/stream/listings', `${listings.length} listings, expected at least ${minimum}`, 'a fresh index fills during the full replay; rerun after it finishes');
  } catch (error) {
    fail('nexus.listings', '/v0/stream/listings', error.message, 'this must be the marketplace Nexus (pubky/marketplace-nexus), not the social Nexus');
  }
  const reference = url('REFERENCE_NEXUS_URL');
  if (reference && listings.length) {
    try {
      const old = await nexusListings(reference);
      const mine = new Map(listings.map((row) => [row.key, row]));
      const theirs = new Map(old.map((row) => [row.key, row]));
      const missing = [...theirs.keys()].filter((key) => !mine.has(key));
      const extra = [...mine.keys()].filter((key) => !theirs.has(key));
      const drift = [...mine.values()].filter((row) => theirs.has(row.key) && (theirs.get(row.key).revision !== row.revision || theirs.get(row.key).state !== row.state));
      check(
        'nexus.parity',
        !missing.length && !extra.length && !drift.length,
        'listings match the reference Nexus',
        `${listings.length} vs ${old.length}; missing ${missing.length}, extra ${extra.length}, revision/state drift ${drift.length}${missing.length ? `; first missing ${short(missing[0])}` : ''}`,
        'wait for the replay to finish, then compare again; a persistent gap means the watcher skipped events',
      );
    } catch (error) {
      warn('nexus.parity', 'listings match the reference Nexus', error.message, 'check REFERENCE_NEXUS_URL');
    }
  }
  for (const origin of SHOP_ORIGINS) {
    const response = await preflight(`${NEXUS}/v0/stream/listings`, origin, 'GET');
    const allowed = response.headers.get('access-control-allow-origin');
    check(`nexus.cors.${new URL(origin).host}`, allowed === origin || allowed === '*', 'CORS allows the Shop', `allow-origin ${allowed ?? 'none'}`, 'allow the Shop origin on the Nexus API (or its proxy)');
  }
}

async function reachable(target) {
  for (const path of ['/health/live', '/health', '/healthz']) {
    const response = await http(`${target}${path}`, { timeoutMs: 10_000 });
    if (response.status === 200) return { ok: true, detail: `${path} 200` };
  }
  return { ok: false };
}

// A configured upstream URL must answer. Private addresses are tested from inside the caller's
// network with the operator's <KEY>_REACH_CMD (for example `docker exec locks wget -qO- <url>/health`).
async function checkReach(id, title, target, commandKey) {
  const command = get(commandKey);
  if (command) {
    const result = await runCommand(command, { timeoutMs: 60_000 });
    return check(id, result.code === 0, `${title} (from inside its network)`, `${commandKey} exit ${result.code}`, `open the network path to ${target}`);
  }
  const reach = await reachable(target);
  if (reach.ok) return pass(id, title, reach.detail);
  if (isPrivateHost(new URL(target).hostname))
    return warn(id, title, 'private address, not reachable from here', `set ${commandKey} to a command run inside the caller's network that fetches ${target}/health…`);
  return fail(id, title, 'no health endpoint answered', `fix the URL or the network path to ${target}`);
}

async function sectionWiring() {
  heading('wiring');
  // Where Locks-gated Bitcoin invoices land. A Lock Server shared from another environment by design
  // (LOCKS_SHARED_FROM) sends them to that environment's Paykit; the check names the route either way.
  const bitcoinRoute = (id, title, target, expectedKey, hint) => {
    if ([PAYKIT, get(expectedKey)].filter(Boolean).map(normalizeBase).includes(target)) return pass(id, title, target);
    const detail = `Locks-gated Bitcoin goes to ${target}, not this stack’s Paykit ${PAYKIT ?? "(PAYKIT_URL unset)"}`;
    const shared = get('LOCKS_SHARED_FROM');
    if (!shared) return fail(id, title, detail, `${hint}; if the Lock Server is shared from another environment by design, declare LOCKS_SHARED_FROM=<environment>`);
    const declared = `${detail} (declared: Lock Server shared from ${shared})`;
    if (!PRODUCTION) return info(id, title, declared);
    return warn(id, title, declared, `accepted only as a pre-launch exception: Locks-gated purchases settle on ${shared}’s Paykit, while seller-direct Bitcoin checkout uses ${PAYKIT}; a production install points Locks at its own Paykit`);
  };
  const configHint = (key, file) => `set ${key}${file ? ` or ${file}` : ''} in ${args.config} to check this`;
  if (!state.lockServerKey && LOCKS) state.lockServerKey = jsonOf(await http(`${LOCKS}/.well-known/locks-server`))?.lock_server;
  if (!facts.paykitTrustedLocksKey) skip('wiring.paykit-trusts-locks', 'Paykit trusts the Lock Server key', configHint('PAYKIT_TRUSTED_LOCKS_KEY', 'PAYKIT_CONFIG_FILE'));
  else
    check('wiring.paykit-trusts-locks', facts.paykitTrustedLocksKey === state.lockServerKey, 'Paykit trusts the Lock Server key', `trusted ${short(facts.paykitTrustedLocksKey)}, Locks ${short(state.lockServerKey)}`, 'set [locks] trusted_public_key in the Paykit config to the value of LOCKS_URL/.well-known/locks-server "lock_server", then restart Paykit');
  const originCheck = (id, title, allowed, key, file) => {
    if (allowed === undefined) return skip(id, title, configHint(key, file));
    const list = parseList(allowed);
    if (list.includes('*')) {
      const hint = 'list the exact Shop origins instead of *';
      return PRODUCTION ? fail(id, title, 'wildcard *', hint) : warn(id, title, 'wildcard *', hint);
    }
    const missing = missingOrigins(list, SHOP_ORIGINS);
    check(id, !missing.length, title, missing.length ? `missing ${missing.join(', ')}` : `${list.length} origin(s)`, `add ${missing.join(', ')}`);
  };
  originCheck('wiring.paykit-setup-origins', 'Paykit setup allows the Shop origins', facts.paykitSetupOrigins, 'PAYKIT_SETUP_ALLOWED_ORIGINS', 'PAYKIT_CONFIG_FILE');
  originCheck('wiring.locks-return-origins', 'Locks connect allows the Shop origins', facts.locksReturnOrigins, 'LOCKS_ALLOWED_RETURN_ORIGINS', 'LOCKS_CONFIG_FILE');
  originCheck('wiring.service-allowed-origins', 'service ALLOWED_ORIGINS lists the Shop origins', facts.serviceAllowedOrigins, 'SERVICE_ALLOWED_ORIGINS');
  if (!facts.locksPaykitServerUrl) skip('wiring.locks-paykit-url', 'Locks [paykit] server_url', configHint('LOCKS_PAYKIT_SERVER_URL', 'LOCKS_CONFIG_FILE'));
  else {
    const target = normalizeBase(facts.locksPaykitServerUrl);
    const known = [PAYKIT, FIAT, get('LOCKS_PAYKIT_EXPECTED_URL')].filter(Boolean).map(normalizeBase);
    if (known.includes(target)) pass('wiring.locks-paykit-url', 'Locks points at this stack’s Paykit (or the fiat gateway)', target);
    else bitcoinRoute('wiring.locks-paykit-url', 'Locks points at this stack’s Paykit (or the fiat gateway)', target, 'LOCKS_PAYKIT_EXPECTED_URL', 'set [paykit] server_url to PAYKIT_URL, the fiat verifier, or their private address (declare it as LOCKS_PAYKIT_EXPECTED_URL)');
    await checkReach('wiring.locks-paykit-reachable', 'Locks [paykit] server_url answers', target, 'LOCKS_PAYKIT_REACH_CMD');
  }
  const upstreamUrl = async (name, fact, envName, expectedKeys, reachKey) => {
    if (!fact) return skip(`wiring.${name}`, `service ${envName}`, configHint(`SERVICE_${envName}`));
    const target = normalizeBase(fact);
    const known = expectedKeys.map(get).filter(Boolean).map(normalizeBase);
    check(`wiring.${name}`, known.includes(target), `service ${envName} is this stack’s`, target, `set ${envName} on the service (declare a private address as ${expectedKeys[1]})`);
    await checkReach(`wiring.${name}-reachable`, `service ${envName} answers`, target, reachKey);
  };
  await upstreamUrl('service-paykit-url', facts.servicePaykitUrl, 'PAYKIT_SERVER_URL', ['PAYKIT_URL', 'SERVICE_PAYKIT_EXPECTED_URL'], 'SERVICE_PAYKIT_REACH_CMD');
  await upstreamUrl('service-locks-url', facts.serviceLocksUrl, 'LOCKS_SERVER_URL', ['LOCKS_URL', 'SERVICE_LOCKS_EXPECTED_URL'], 'SERVICE_LOCKS_REACH_CMD');
  if (facts.serviceSandboxPayments !== undefined) {
    const on = isTruthy(facts.serviceSandboxPayments);
    if (PRODUCTION) check('wiring.service-sandbox', !on, 'sandbox payments off in production', `SANDBOX_PAYMENTS_ENABLED=${facts.serviceSandboxPayments}`, 'unset SANDBOX_PAYMENTS_ENABLED on the production service');
    else info('wiring.service-sandbox', 'sandbox payments', `SANDBOX_PAYMENTS_ENABLED=${facts.serviceSandboxPayments}`);
  }
  if (FIAT) {
    if (facts.fiatTrustedLocksKey)
      check('wiring.fiat-trusts-locks', facts.fiatTrustedLocksKey === state.lockServerKey, 'fiat verifier trusts the Lock Server key', short(facts.fiatTrustedLocksKey), 'set FIAT_TRUSTED_LOCKS_PUBLIC_KEY to the Lock Server key');
    else skip('wiring.fiat-trusts-locks', 'fiat verifier trusts the Lock Server key', configHint('FIAT_TRUSTED_LOCKS_KEY'));
    if (facts.fiatPaykitUrl) {
      const target = normalizeBase(facts.fiatPaykitUrl);
      bitcoinRoute('wiring.fiat-paykit-url', 'fiat verifier forwards Bitcoin to this Paykit', target, 'FIAT_PAYKIT_EXPECTED_URL', 'set FIAT_PAYKIT_SERVER_URL to this stack’s Paykit (declare a private address as FIAT_PAYKIT_EXPECTED_URL)');
      await checkReach('wiring.fiat-paykit-reachable', 'fiat verifier’s Paykit answers', target, 'FIAT_PAYKIT_REACH_CMD');
    } else skip('wiring.fiat-paykit-url', 'fiat verifier forwards Bitcoin to this Paykit', configHint('FIAT_PAYKIT_SERVER_URL'));
    originCheck('wiring.fiat-return-origins', 'fiat checkout returns to the Shop origins', facts.fiatReturnOrigins, 'FIAT_BUYER_RETURN_ORIGINS');
  }
  if (state.shopRuntime && state.paykitFlavor) {
    const wanted = state.paykitFlavor === 'fork';
    check('wiring.shop-setup-creator-param', state.shopRuntime.paykitSetupCreatorParam === wanted, `Shop sends creator to Paykit /setup: ${wanted}`, `paykitSetupCreatorParam=${state.shopRuntime.paykitSetupCreatorParam}`, `set PUBKY_RUNTIME_PAYKIT_SETUP_CREATOR_PARAM=${wanted} on the Shop: the ${state.paykitFlavor} server ${wanted ? 'requires' : 'rejects'} it`);
  }
}

async function sectionVersion() {
  heading('version');
  for (const [name, label] of [['SHOP', 'Shop'], ['SERVICE', 'marketplace service'], ['PAYKIT', 'Paykit server'], ['LOCKS', 'Locks server'], ['FIAT', 'fiat verifier']]) {
    const id = `version.${name.toLowerCase()}`;
    if (name === 'FIAT' && !FIAT) continue;
    // A wrapper build (for example pubky-payment-rails around Locks) labels its own commit.
    const source = get(`${name}_BUILD_SOURCE`) ?? get(`${name}_SOURCE`);
    const command = get(`${name}_RUNNING_COMMIT_CMD`);
    if (!source) {
      skip(id, `${label} source pin`, `set ${name}_SOURCE=owner/repo@<commit>`);
      continue;
    }
    let expected;
    try {
      expected = await resolveCommit(source);
    } catch (error) {
      fail(id, `${label} source pin resolves`, error.message, `check ${name}_SOURCE`);
      continue;
    }
    if (!command) {
      skip(id, `${label} runs ${expected.slice(0, 12)}`, `the build commit is not published over HTTP; set ${name}_RUNNING_COMMIT_CMD`);
      continue;
    }
    const result = await runCommand(command);
    const running = result.stdout.trim().split(/\s+/).pop() ?? '';
    if (result.code !== 0 || !/^[0-9a-f]{7,40}$/.test(running))
      fail(id, `${label} running commit`, `command exit ${result.code}: ${result.stderr || 'no commit printed'}`, `fix ${name}_RUNNING_COMMIT_CMD; the image may lack the org.opencontainers.image.revision label`);
    else check(id, expected.startsWith(running), `${label} runs the pinned commit`, `${running.slice(0, 12)} vs ${expected.slice(0, 12)}`, `rebuild from ${source} and redeploy`);
  }
}

const MIGRATION_SQL = [
  '\\pset tuples_only on',
  '\\pset format unaligned',
  'BEGIN READ ONLY;',
  "SELECT 'MIV|' || version || '|' || success || '|' || encode(checksum, 'hex') FROM _sqlx_migrations ORDER BY version;",
  'ROLLBACK;',
  '',
].join('\n');

async function sectionDb() {
  heading('db');
  for (const [name, label] of [['SERVICE', 'marketplace service'], ['PAYKIT', 'Paykit'], ['LOCKS', 'Locks']]) {
    const id = `db.${name.toLowerCase()}.migrations`;
    const command = get(`${name}_DB_SQL_CMD`);
    if (!command) {
      skip(id, `${label} migrations applied`, `set ${name}_DB_SQL_CMD (a psql-compatible command reading SQL on stdin)`);
      continue;
    }
    const result = await runCommand(command, { input: MIGRATION_SQL, timeoutMs: 180_000 });
    const applied = parseMigrationRows(result.stdout);
    if (!applied.length) {
      fail(id, `${label} migrations applied`, `no _sqlx_migrations rows (exit ${result.code}${result.stderr ? `: ${result.stderr}` : ''})`, 'the server has not migrated this database: start it once with run-migrations-on-startup, or the command points at the wrong database');
      continue;
    }
    let expected = null;
    try {
      expected = await expectedMigrations(name.toLowerCase());
    } catch (error) {
      warn(id, `${label} migrations match the source`, error.message, 'set GITHUB_TOKEN if the GitHub API rate limit was hit');
    }
    if (!expected) {
      const failed = applied.filter((row) => !row.success).map((row) => row.version);
      check(`${id}-applied`, !failed.length, `${label} migrations applied without failures`, `${applied.length} applied, last ${applied.at(-1).version}${failed.length ? `, failed ${failed.join(',')}` : ''}`, 'a failed migration blocks startup; read the server log');
      skip(id, `${label} migrations match the source exactly`, `set ${name}_SOURCE (or ${name}_MIGRATIONS_DIR) to compare checksums`);
      continue;
    }
    const diff = compareMigrations(expected, applied);
    const parts = [`${applied.length} applied of ${expected.length}`];
    if (diff.missing.length) parts.push(`missing ${diff.missing.join(',')}`);
    if (diff.failed.length) parts.push(`failed ${diff.failed.join(',')}`);
    if (diff.mismatched.length) parts.push(`checksum differs ${diff.mismatched.join(',')}`);
    if (diff.extra.length) parts.push(`not in source ${diff.extra.join(',')}`);
    check(id, diff.ok, `${label} migrations match the source exactly`, parts.join('; '), diff.extra.length || diff.mismatched.length ? 'this database was migrated by a different build (for example the fork): use a fresh database for this release' : 'restart the server so it applies its migrations, then read its log');
  }
}

// ---------- opt-in probes ----------

async function probeFlows() {
  heading('flow probes');
  if (PAYKIT && !state.paykitFlavor) {
    const ready = jsonOf(await http(`${PAYKIT}/health/ready`));
    if (ready) state.paykitFlavor = 'stack_id' in ready ? 'fork' : 'upstream';
  }
  if (PAYKIT && !state.paykitFlavor) fail('flow.paykit-setup', 'Paykit setup page frames the Shop', 'Paykit /health/ready did not answer', 'fix Paykit first');
  else if (PAYKIT) {
    if (state.paykitFlavor === 'fork') skip('flow.paykit-setup', 'Paykit setup page frames the Shop', 'the fork’s /setup needs a seller key; config check covers it');
    else {
      for (const origin of SHOP_ORIGINS) {
        const page = await http(`${PAYKIT}/setup?return_to=${encodeURIComponent(`${origin}/marketplace`)}&state=install-verify`);
        const csp = page.headers.get('content-security-policy') ?? '';
        check(`flow.paykit-setup.${new URL(origin).host}`, page.status === 200 && frameAncestorsAllow(csp, origin), 'Paykit setup page frames the Shop', `${describe(page)}, ${csp || 'no CSP'}`, `add ${origin} to [setup] allowed_origins`);
      }
      const foreign = await http(`${PAYKIT}/setup?return_to=${encodeURIComponent(`${PROBE_ORIGIN}/x`)}&state=install-verify`);
      if (foreign.status === 400) pass('flow.paykit-setup.foreign', 'Paykit setup refuses other origins', describe(foreign));
      else
        (PRODUCTION ? fail : warn)('flow.paykit-setup.foreign', 'Paykit setup refuses other origins', describe(foreign), 'list the exact Shop origins in [setup] allowed_origins instead of *');
    }
  }
  if (LOCKS) {
    for (const origin of SHOP_ORIGINS) {
      const page = await http(`${LOCKS}/connect?return_to=${encodeURIComponent(`${origin}/marketplace`)}&state=install-verify&delivery=postmessage`);
      const csp = page.headers.get('content-security-policy') ?? '';
      check(`flow.locks-connect.${new URL(origin).host}`, page.status === 200 && frameAncestorsAllow(csp, origin), 'Locks connect page frames the Shop', `${describe(page)}, ${csp || 'no CSP'}`, `add ${origin} to [creator_authority_acquisition.legacy_connect] allowed_return_origins`);
    }
    const foreign = await http(`${LOCKS}/connect?return_to=${encodeURIComponent(`${PROBE_ORIGIN}/x`)}&state=install-verify&delivery=postmessage`);
    check('flow.locks-connect.foreign', foreign.status === 400, 'Locks connect refuses other origins', describe(foreign), 'allowed_return_origins must list exact origins');
  }
}

async function probeWrite() {
  heading('nexus write probe');
  if (PRODUCTION && get('ALLOW_PRODUCTION_WRITE_PROBE') !== '1')
    return skip('write.nexus', 'Nexus indexes a fresh write', 'production: set ALLOW_PRODUCTION_WRITE_PROBE=1 to write and delete one post');
  const { runNexusWriteProbe } = await import('./nexus-write-probe.mjs');
  await runNexusWriteProbe({ get, nexusUrl: NEXUS, out: OUT, runCommand, record });
}

async function probeBrowser() {
  heading('browser');
  const { runShopBrowserProbe } = await import('./shop-browser-probe.mjs');
  for (const origin of SHOP_ORIGINS)
    await runShopBrowserProbe({ get, origin, path: get('SHOP_PATH') ?? '/marketplace', service: SERVICE, nexus: NEXUS, forbiddenHosts: FORBIDDEN_HOSTS, out: OUT, record });
}

async function probeDeep() {
  heading('deep (staging only)');
  if (PRODUCTION) return fail('deep', 'deep proofs refused in production', 'MIV_ENV=production', 'run --deep only against staging');
  const names = parseList(get('DEEP_PROOFS'));
  if (!names.length) return skip('deep', 'no deep proofs configured', 'set DEEP_PROOFS and DEEP_<NAME>_CMD');
  const productionHosts = parseList(get('PRODUCTION_HOSTS')).map((h) => h.toLowerCase());
  for (const name of names) {
    const key = name.toUpperCase();
    const command = get(`DEEP_${key}_CMD`);
    const marker = new RegExp(get(`DEEP_${key}_PASS`) ?? '^PASS$', 'm');
    if (!command) {
      fail(`deep.${name}`, `${name} configured`, `DEEP_${key}_CMD unset`, `set DEEP_${key}_CMD`);
      continue;
    }
    const touched = productionHosts.filter((host) => command.toLowerCase().includes(host));
    if (touched.length) {
      fail(`deep.${name}`, `${name} targets staging`, `command names production host ${touched.join(', ')}`, 'point the deep proof at staging');
      continue;
    }
    const result = await runCommand(command, { timeoutMs: Number(get(`DEEP_${key}_TIMEOUT_S`) ?? 900) * 1000 });
    if (OUT) writeFileSync(join(OUT, `deep-${name}.log`), redact(`${result.stdout}\n--- stderr ---\n${result.stderr}`), { mode: 0o600 });
    check(`deep.${name}`, result.code === 0 && marker.test(result.stdout), `${name} passed`, `exit ${result.code}${OUT ? `, log deep-${name}.log` : ''}`, `read ${OUT ? join(OUT, `deep-${name}.log`) : 'its output'} for the failing step`);
  }
}

// ---------- main ----------

const started = new Date();
if (!args.flags.has('json')) console.log(`Pubky Marketplace install verification — ${ENV} — ${started.toISOString()}`);
const plan = [
  ['config', sectionConfig],
  ['tls', sectionTls],
  ['shop', sectionShop],
  ['service', sectionService],
  ['paykit', sectionPaykit],
  ['locks', sectionLocks],
  ['fiat', sectionFiat],
  ['nexus', sectionNexus],
  ['wiring', sectionWiring],
  ['version', sectionVersion],
  ['db', sectionDb],
  ['flow', probeFlows],
  ['write', probeWrite],
  ['browser', probeBrowser],
  ['deep', probeDeep],
];
for (const [name, run] of plan) {
  if (!wants(name)) continue;
  try {
    await run();
  } catch (error) {
    fail(`${name}.error`, `${name} section completed`, error.message, 'unexpected error; rerun with --only to isolate');
  }
}
for (const unknown of [...(args.only ?? []), ...args.skip].filter((s) => ![...SECTIONS, ...PROBE_SECTIONS, 'flow-probes', 'write-probe'].includes(s)))
  warn('args', 'known section name', unknown, `sections: ${[...SECTIONS, ...PROBE_SECTIONS].join(', ')}`);

const failed = counts.FAIL > 0 || (args.flags.has('strict') && counts.WARN > 0);
const summary = {
  environment: ENV,
  started: started.toISOString(),
  finished: new Date().toISOString(),
  counts,
  verdict: failed ? 'FAIL' : 'PASS',
  results,
};
if (OUT) {
  writeFileSync(join(OUT, 'results.json'), `${JSON.stringify(summary, null, 2)}\n`);
  const lines = [
    `# Install verification: ${ENV}`,
    '',
    `${summary.started} · verdict **${summary.verdict}** · ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`,
    '',
    '| Status | Check | Result | Fix |',
    '| --- | --- | --- | --- |',
    ...results.map((r) => `| ${r.status} | \`${r.id}\` | ${`${r.title}${r.detail ? ` — ${r.detail}` : ''}`.replace(/\|/g, '\\|')} | ${r.hint.replace(/\|/g, '\\|')} |`),
    '',
  ];
  writeFileSync(join(OUT, 'report.md'), lines.join('\n'));
}
if (args.flags.has('json')) console.log(JSON.stringify(summary, null, 2));
else {
  console.log(`\nRESULT ${summary.verdict}  ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join('  ')}${OUT ? `  (${join(OUT, 'report.md')})` : ''}`);
  const problems = results.filter((r) => r.status === 'FAIL' || r.status === 'WARN');
  if (problems.length) {
    console.log('\nTo fix:');
    for (const r of problems) console.log(`  ${r.status} ${r.id}: ${r.hint}`);
  }
}
process.exit(failed ? 1 : 0);
