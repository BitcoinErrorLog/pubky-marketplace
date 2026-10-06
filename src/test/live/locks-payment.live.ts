// The application layer persists the buyer's Locks correlation in Dexie;
// Node has no IndexedDB, so the shim must load before any app module.
import 'fake-indexeddb/auto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * LIVE end-to-end proof of the buyer purchase flow over the REAL composed
 * payment stack (plan tasks 4.6–4.8 verification):
 *
 *   checkout (durable transaction service, `locks-paykit` mode)
 *     -> buyer proof bundle to the Lock Server (real Paykit invoice)
 *     -> `payment.register_locks` correlation (client never advances anything)
 *     -> private Payment Request received by `paykit-reader-demo`
 *        (the wallet's protocol role — Bitkit's simulator, not a stub)
 *     -> on-chain payment from the regtest node -> 1 block mined
 *     -> the transaction service's worker independently verifies the Locks
 *        lifecycle and confirms the payment exactly once
 *     -> order `paid`, durable receipt issued
 *     -> the buyer unlocks the guarded digital content and its BLAKE3 hash
 *        matches the listing record.
 *
 * Requirements (fails loudly, never skips or mocks):
 *   - the composed payments environment running (payments-env `scripts/up.sh`;
 *     override its checkout dir with PAYMENTS_ENV_DIR, default ../payments-env)
 *   - the marketplace transaction service on MARKETPLACE_SERVICE_URL
 *     (default http://127.0.0.1:8080) started with LOCKS_SERVER_URL and both
 *     LOCKS_* keys, per docs/ecommerce/RUNNING.md
 *   - network access to the Pubky HTTP relay for the AuthToken session flows.
 */

const SERVICE_URL = process.env.MARKETPLACE_SERVICE_URL ?? 'http://127.0.0.1:8080';
const LOCKS_URL = process.env.PAYMENTS_ENV_LOCKS_URL ?? 'http://localhost:13000';
const PAYKIT_URL = process.env.PAYMENTS_ENV_PAYKIT_URL ?? 'http://localhost:13001';
// The environment checkout is either the compose project itself or the
// umbrella repository that nests it one level down (`payments-env/payments-env`).
function resolvePaymentsEnvDir(): string {
  const base = path.resolve(process.env.PAYMENTS_ENV_DIR ?? path.join(process.cwd(), '..', 'payments-env'));
  if (existsSync(path.join(base, 'docker-compose.yml'))) return base;
  const nested = path.join(base, 'payments-env');
  if (existsSync(path.join(nested, 'docker-compose.yml'))) return nested;
  throw new Error(
    `No payments-env compose project found at ${base}. Check out the composed payment environment ` +
      'and point PAYMENTS_ENV_DIR at it (see docs/ecommerce/RUNNING.md).',
  );
}
const PAYMENTS_ENV_DIR = resolvePaymentsEnvDir();
const AMOUNT_SATS = 15_000;

// Runtime config must exist before any app module import. locks-paykit mode
// requires every payment-rail URL to be EXPLICITLY set (fail-closed
// activation) — which this suite therefore also exercises.
process.env.PUBKY_RUNTIME_COMMERCE_ADAPTER_MODE = 'locks-paykit';
process.env.PUBKY_RUNTIME_MARKETPLACE_URL = SERVICE_URL;
process.env.PUBKY_RUNTIME_LOCKS_URL = LOCKS_URL;
process.env.PUBKY_RUNTIME_PAYKIT_SETUP_URL = `${PAYKIT_URL}/setup`;
process.env.PUBKY_RUNTIME_TESTNET = 'false';
process.env.NEXT_PUBLIC_APP_VERSION ??= '0.0.0-live';
process.env.NEXT_PUBLIC_DB_VERSION ??= '3';
process.env.NEXT_PUBLIC_DEBUG_MODE ??= 'false';

// ---------------------------------------------------------------------------
// Environment orchestration helpers (docker compose against payments-env),
// playing the parts the browser client cannot: the seller's environment-side
// tooling and the wallet simulators.
// ---------------------------------------------------------------------------

function run(
  command: string,
  args: string[],
  options: { input?: string; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? PAYMENTS_ENV_DIR });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${stderr || stdout}`));
    });
    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}

function compose(args: string[], options: { input?: string } = {}) {
  return run('docker', ['compose', ...args], options);
}

async function bitcoinCli(args: string[], wallet?: string): Promise<string> {
  const walletArg = wallet ? [`-rpcwallet=${wallet}`] : [];
  const { stdout } = await compose([
    'exec',
    '-T',
    'bitcoind',
    'bitcoin-cli',
    '-regtest',
    '-rpcuser=paykitregtest',
    '-rpcpassword=paykitregtestpass',
    ...walletArg,
    ...args,
  ]);
  return stdout.trim();
}

async function ensureWallet(name: string): Promise<void> {
  await bitcoinCli(['createwallet', name]).catch(() =>
    bitcoinCli(['loadwallet', name]).catch(() => {
      // Already loaded.
    }),
  );
}

function unescapeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

async function waitFor<T>(description: string, timeoutMs: number, intervalMs: number, probe: () => Promise<T | null>) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${description}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

type AppModules = {
  CommerceApplication: typeof import('@/application/commerce/commerce').CommerceApplication;
  LocksGatewayService: typeof import('@/services/locks/locks').LocksGatewayService;
  MarketplaceGatewayService: typeof import('@/services/marketplace/marketplace').MarketplaceGatewayService;
  MarketplaceSessionService: typeof import('@/services/marketplace/marketplace-session').MarketplaceSessionService;
  sdk: typeof import('@synonymdev/pubky');
};

describe('locks-paykit live purchase (composed environment)', () => {
  let modules: AppModules;

  beforeAll(async () => {
    const [service, locks, paykit] = await Promise.all([
      fetch(`${SERVICE_URL}/health`).catch(() => null),
      fetch(`${LOCKS_URL}/readyz`).catch(() => null),
      fetch(`${PAYKIT_URL}/health/ready`).catch(() => null),
    ]);
    if (!service?.ok || !locks?.ok || !paykit?.ok) {
      throw new Error(
        `The live stack is not reachable (service ${SERVICE_URL}: ${service?.status ?? 'down'}, ` +
          `locks ${LOCKS_URL}: ${locks?.status ?? 'down'}, paykit ${PAYKIT_URL}: ${paykit?.status ?? 'down'}). ` +
          'Start payments-env (scripts/up.sh) and the marketplace service with LOCKS_* configured — ' +
          'see docs/ecommerce/RUNNING.md.',
      );
    }
    // The Locks SDK is wasm-pack `--target web`: its default init fetches the
    // .wasm by URL, which Node's fetch cannot do. Pre-initialize it here with
    // the vendored bytes; init is idempotent, so the service's own lazy
    // `sdk.default()` becomes a no-op against the same module instance.
    const { readFile } = await import('node:fs/promises');
    const locksSdk = await import('locks-sdk-wasm');
    await locksSdk.default({
      module_or_path: await readFile(new URL('../../../vendor/locks-sdk-wasm/locks_sdk_wasm_bg.wasm', import.meta.url)),
    });
    const [
      { CommerceApplication },
      { LocksGatewayService },
      { MarketplaceGatewayService },
      { MarketplaceSessionService },
      sdk,
    ] = await Promise.all([
      import('@/application/commerce/commerce'),
      import('@/services/locks/locks'),
      import('@/services/marketplace/marketplace'),
      import('@/services/marketplace/marketplace-session'),
      import('@synonymdev/pubky'),
    ]);
    modules = { CommerceApplication, LocksGatewayService, MarketplaceGatewayService, MarketplaceSessionService, sdk };
  });

  async function establishSessionFor(keypair: import('@synonymdev/pubky').Keypair): Promise<string> {
    const { MarketplaceSessionService, sdk } = modules;
    const flow = MarketplaceSessionService.beginSessionFlow();
    const signerSdk = new sdk.Pubky();
    await signerSdk.signer(keypair).approveAuthRequest(flow.authorizationUrl);
    const session = await flow.awaitSession();
    return session.pubky;
  }

  it('drives a real purchase end to end: proof bundle, register_locks, on-chain payment, worker confirmation, receipt, guarded content', async () => {
    const { CommerceApplication, LocksGatewayService, MarketplaceGatewayService, MarketplaceSessionService, sdk } =
      modules;
    const runId = Date.now().toString(36);

    // --- 1. Regtest funding ------------------------------------------------
    await ensureWallet('miner');
    const minerAddress = await bitcoinCli(['getnewaddress'], 'miner');
    const height = Number(await bitcoinCli(['getblockcount']));
    if (height < 101) await bitcoinCli(['generatetoaddress', String(101 - height), minerAddress], 'miner');

    // --- 2. Seller identity = the environment's Locks creator ---------------
    await waitFor('creator-demo identity', 180_000, 2_000, async () =>
      compose(['exec', '-T', 'creator-demo', 'test', '-f', '/workspace/.local/content-creator/profile.json'])
        .then(() => true)
        .catch(() => null),
    );
    const creatorIdentity = JSON.parse(
      (await compose(['exec', '-T', 'creator-demo', 'node', '/overlay-js/creator-secret.mjs'])).stdout,
    ) as { pubky: string; secret: string };
    const sellerKeypair = sdk.Keypair.fromSecret(new Uint8Array(Buffer.from(creatorIdentity.secret, 'base64url')));
    const seller = sellerKeypair.publicKey.z32();

    // The testnet DHT is in-memory: a creator identity created before the
    // current testnet boot has no resolvable PKARR record until republished,
    // and the demo helpers only republish on fresh signup. Force it so the
    // legacy-connect signin below can resolve the creator's homeserver.
    await compose([
      'exec',
      '-T',
      'creator-demo',
      'node',
      '--input-type=module',
      '-e',
      [
        "import { loadRoleKeypair, pubkyForConfig, homeserverPublicKey } from '/workspace/examples/js-sdk/scripts/lib/pubky.mjs';",
        "import { readDemoConfig, withInternalServiceUrls } from '/workspace/examples/js-sdk/scripts/lib/config.mjs';",
        'const config = withInternalServiceUrls(await readDemoConfig());',
        "const keypair = await loadRoleKeypair('content-creator');",
        'const signer = pubkyForConfig(config).signer(keypair);',
        'await signer.pkdns.publishHomeserverForce(homeserverPublicKey(config));',
      ].join('\n'),
    ]);

    // --- 3. Locks creator authority via hosted legacy-connect ---------------
    // The connect approval happens on the seller's signer (the js-sdk demo
    // plays Pubky Ring); the completion code exchange happens through the
    // CLIENT's own LocksGatewayService.createFrontendSession — the same code
    // path the seller setup page runs.
    const state = `live-${runId}`;
    const connectHtml = await (
      await fetch(`${LOCKS_URL}/connect?return_to=${encodeURIComponent('http://localhost:8080/done')}&state=${state}`)
    ).text();
    const connectFlow = /action="\/connect\/([^"/]+)\/complete"/.exec(connectHtml)?.[1];
    const connectAuthUrl = /href="([^"]+)"/.exec(connectHtml)?.[1];
    if (!connectFlow || !connectAuthUrl) throw new Error('The Locks connect shell did not include a flow or auth URL.');
    await compose([
      'exec',
      '-T',
      'creator-demo',
      'npm',
      '--prefix',
      'examples/js-sdk',
      'run',
      '--silent',
      'authenticate',
      '--',
      '--role',
      'content-creator',
      '--auth',
      unescapeHtml(connectAuthUrl),
    ]);
    const completion = await fetch(`${LOCKS_URL}/connect/${connectFlow}/complete`, {
      method: 'POST',
      redirect: 'manual',
    });
    expect(completion.status).toBe(303);
    const code = new URL(completion.headers.get('location') ?? '').searchParams.get('code');
    expect(code).toBeTruthy();
    const frontendSession = await LocksGatewayService.createFrontendSession(code!, state);
    const creatorLocksForm = frontendSession.creator; // `pubky<z32>` wire form
    expect(creatorLocksForm).toBe(`pubky${seller}`);
    const creatorSessionToken = frontendSession.session_token;

    // --- 4. Paykit creator setup: watch-only companion claim ----------------
    // `paykit-companion-auth` plays Bitkit's approval role with the same
    // claim format (watch-only-account-v1). The tpub comes from a real
    // bitcoind descriptor wallet; Paykit Server never receives spending keys.
    await ensureWallet('paykit_creator');
    const descriptors = JSON.parse(await bitcoinCli(['listdescriptors'], 'paykit_creator')) as {
      descriptors: { desc: string; internal: boolean }[];
    };
    const bip84 = descriptors.descriptors.find(
      ({ desc, internal }) => !internal && desc.startsWith('wpkh(') && /\/84.?\/1.?\/0.?\]/.test(desc),
    );
    const tpub = bip84 ? /\]([a-zA-Z0-9]+)\//.exec(bip84.desc)?.[1] : undefined;
    if (!tpub?.startsWith('tpub')) throw new Error('Could not extract a BIP84 account tpub from bitcoind.');

    const setupHtml = await (
      await fetch(`${PAYKIT_URL}/setup?return_to=${encodeURIComponent('http://localhost:8080')}&state=${state}`)
    ).text();
    const setupFlow = JSON.parse(/const flowId=("(?:[^"\\]|\\.)*");/.exec(setupHtml)?.[1] ?? 'null') as string | null;
    const setupAuthUrl = /<code>([^<]+)<\/code>/.exec(setupHtml)?.[1];
    if (!setupFlow || !setupAuthUrl) throw new Error('The Paykit setup shell did not include a flow or auth URL.');
    const companion = JSON.parse(
      (
        await compose(['exec', '-T', 'paykit-server', 'paykit-companion-auth'], {
          input: JSON.stringify({
            version: 1,
            auth_url: unescapeHtml(setupAuthUrl),
            creator_secret: creatorIdentity.secret,
            account_xpub: tpub,
            account_index: 0,
          }),
        })
      ).stdout,
    ) as { status: string };
    expect(companion.status).toBe('approved');
    await waitFor(`Paykit setup completion for flow ${setupFlow}`, 120_000, 2_000, async () => {
      const poll = await fetch(`${PAYKIT_URL}/setup/${setupFlow}/complete`, { method: 'POST' });
      return poll.status === 200 ? true : null;
    });

    // --- 5. Guarded content + paykit-payment content lock --------------------
    const lockServerPubky = (
      await compose(['exec', '-T', 'locks-server', 'cat', '/paykit-shared/lock_server_public_key'])
    ).stdout.trim();
    const configured = await fetch(`${LOCKS_URL}/creator/lock-service-config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${creatorSessionToken}` },
      body: JSON.stringify({ default_lock_server: lockServerPubky }),
    });
    expect(configured.ok).toBe(true);

    const contentPath = `marketplace-${runId}.txt`;
    const guardedBytes = new TextEncoder().encode(`paid marketplace bytes ${runId}`);
    const resourceHash = bytesToHex(blake3(guardedBytes));
    const uploaded = await fetch(`${LOCKS_URL}/creator/priv-resources/content/${contentPath}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain', authorization: `Bearer ${creatorSessionToken}` },
      body: guardedBytes,
    });
    expect(uploaded.ok).toBe(true);
    const uploadBody = (await uploaded.json()) as { guarded_resource: unknown };

    const lockCreated = await fetch(`${LOCKS_URL}/creator/content-locks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${creatorSessionToken}` },
      body: JSON.stringify({
        primary_resource: uploadBody.guarded_resource,
        secondary_resources: {},
        criteria: [
          {
            criterion_id: 'criterion-1',
            verifier_type: 'paykit-payment',
            params: { recipient_pubky: creatorLocksForm, amount: String(AMOUNT_SATS), asset: 'BTC' },
          },
        ],
        lock_logic: { type: 'all', criteria: ['criterion-1'] },
        access_policy: { requested_credential_ttl_seconds: 900 },
        lock_server: { override: lockServerPubky },
      }),
    });
    expect(lockCreated.ok).toBe(true);
    const { content_lock_path: contentLockPath } = (await lockCreated.json()) as { content_lock_path: string };
    const policyUri = `pubky://${seller}${contentLockPath}`;

    // --- 6. Fresh buyer = fresh Paykit reader (Bitkit's protocol role) -------
    // A fresh reader per run, per the environment's documented reader-reuse
    // pitfall: an invoice binds to its reader, so exactly one Payment Request
    // must be actionable.
    const buyerKeypair = sdk.Keypair.random();
    const buyer = buyerKeypair.publicKey.z32();
    const buyerSecret = Buffer.from(buyerKeypair.secret()).toString('base64url');
    await compose(['exec', '-T', 'creator-demo', 'rm', '-rf', '/workspace/.local/paykit-reader']);
    await compose(['exec', '-T', 'paykit-reader', 'rm', '-f', '/reader-state/state.bin']);
    await compose(
      [
        'exec',
        '-T',
        'creator-demo',
        'sh',
        '-c',
        'umask 077 && mkdir -p /workspace/.local/paykit-reader && cat > /workspace/.local/paykit-reader/secret.b64url',
      ],
      { input: buyerSecret },
    );
    const readerIdentity = JSON.parse(
      (await compose(['exec', '-T', 'creator-demo', 'node', '/overlay-js/create-reader.mjs'])).stdout,
    ) as { pubky: string };
    expect(readerIdentity.pubky.replace(/^pubky/, '')).toBe(buyer);
    const prepared = JSON.parse(
      (
        await compose(
          ['exec', '-e', `PAYKIT_READER_SERVER_PUBKY=${creatorLocksForm}`, '-T', 'paykit-reader', 'paykit-reader-demo'],
          { input: JSON.stringify({ version: 1, operation: 'prepare', reader_secret: buyerSecret }) },
        )
      ).stdout,
    ) as { status: string };
    expect(prepared.status).toBe('prepared');

    // --- 7. Marketplace: seller registers the digital listing ----------------
    await establishSessionFor(sellerKeypair);
    const listingId = `live_${runId}`;
    const aggregateId = `listing:${seller}_${listingId}`;
    const registered = await MarketplaceGatewayService.execute(seller, {
      version: 1 as const,
      commandId: crypto.randomUUID(),
      aggregateId,
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'listing.register' as const,
      payload: {
        sellerPubky: seller,
        listingId,
        title: 'Live locks-paykit digital listing',
        listingRevision: 1,
        contentHash: resourceHash,
        quantity: 3,
        unitPrice: { amountMinor: AMOUNT_SATS, currency: 'BTC', exponent: 8 },
        shippingMinor: 0,
        saleFormat: 'fixed_price' as const,
        fulfillmentMethods: ['shipping'] as ('shipping' | 'pickup')[],
      },
    });
    expect(registered).toMatchObject({ ok: true, revision: 1 });

    // --- 8. Buyer: checkout creates the order + awaiting_entitlement payment --
    const buyerActor = await establishSessionFor(buyerKeypair);
    expect(buyerActor).toBe(buyer);
    const listingProjection = await MarketplaceGatewayService.getListing(buyer, aggregateId);
    const checkoutCommandId = crypto.randomUUID();
    const checkedOut = await MarketplaceGatewayService.execute(buyer, {
      version: 1 as const,
      commandId: checkoutCommandId,
      aggregateId: `checkout:${checkoutCommandId}`,
      expectedRevision: 0,
      issuedAt: new Date().toISOString(),
      kind: 'checkout.create' as const,
      payload: {
        lines: [{ listingAggregateId: aggregateId, expectedRevision: listingProjection!.serverRevision, quantity: 1 }],
        deliveryAddress: {
          name: 'Live Buyer',
          line1: '1 Regtest Way',
          line2: '',
          city: 'Lisbon',
          region: 'Lisboa',
          postalCode: '1000-001',
          countryCode: 'PT',
        },
        guaranteePolicyVersion: 1 as const,
      },
    });
    expect(checkedOut).toMatchObject({ ok: true, result: { kind: 'checkout' } });

    const orders = await MarketplaceGatewayService.getOrders(buyer);
    const order = orders.find(({ lines }) => lines.some((line) => line.listingAggregateId === aggregateId));
    expect(order).toBeDefined();
    expect(order).toMatchObject({ state: 'pending_payment', receiptId: null });
    expect(order!.payment).toMatchObject({ adapter: 'sandbox', state: 'awaiting_entitlement' });

    // --- 9. Buyer purchase flow through the client application ---------------
    // Proof bundle to the Lock Server (which signs and sends the real Paykit
    // invoice request), then `payment.register_locks` with the fresh revision.
    const begun = await CommerceApplication.beginMarketplaceLocksPayment({
      buyerPubky: buyer,
      order: order!,
      payment: order!.payment!,
      digitalLock: {
        policyUri,
        criterionId: 'criterion-1',
        contentPath,
        resourceHash,
        minimumConfirmations: 1,
      },
    });
    expect(begun.ok).toBe(true);
    if (begun.ok) {
      expect(begun.result).toMatchObject({ kind: 'payment', verification: { state: 'pending' } });
    }

    // Registration flipped the adapter and did NOT advance the payment.
    const afterRegister = await MarketplaceGatewayService.getOrder(buyer, order!.id);
    expect(afterRegister!.payment).toMatchObject({ adapter: 'locks', state: 'awaiting_entitlement' });
    // The bundle id (bearer material) never appears in any projection.
    expect(afterRegister!.payment).not.toHaveProperty('locksBundleId');
    const storedCorrelation = await CommerceApplication.getMarketplaceLocksCorrelation(buyer, order!.paymentId);
    expect(storedCorrelation).toMatchObject({ registered: true, content_path: contentPath });

    // The client refuses to simulate against the durable service, and the
    // service refuses sandbox advancement of a locks-adapter payment anyway.
    await expect(
      MarketplaceGatewayService.execute(buyer, {
        version: 1 as const,
        commandId: crypto.randomUUID(),
        aggregateId: `payment:${order!.paymentId}`,
        expectedRevision: afterRegister!.payment!.revision,
        issuedAt: new Date().toISOString(),
        kind: 'payment.sandbox_advance' as const,
        payload: { paymentId: order!.paymentId, target: 'confirmed' as const, confirmations: 1 },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // --- 10. The wallet simulator receives the private Payment Request -------
    const received = JSON.parse(
      (
        await compose(
          ['exec', '-e', `PAYKIT_READER_SERVER_PUBKY=${creatorLocksForm}`, '-T', 'paykit-reader', 'paykit-reader-demo'],
          { input: JSON.stringify({ version: 1, operation: 'receive', reader_secret: buyerSecret }) },
        )
      ).stdout,
    ) as { address: string; amount_sats: number | string };
    expect(received.address.startsWith('bcrt1')).toBe(true);
    expect(Number(received.amount_sats)).toBe(AMOUNT_SATS);

    // The unique BIP84 invoice address is independently re-derivable from the
    // watch-only account tpub (external chain scan) — the address really
    // belongs to the seller's wallet, not to any service.
    const descriptorInfo = JSON.parse(await bitcoinCli(['getdescriptorinfo', `wpkh(${tpub}/0/*)`])) as {
      descriptor: string;
    };
    const derived = JSON.parse(await bitcoinCli(['deriveaddresses', descriptorInfo.descriptor, '[0,50]'])) as string[];
    expect(derived).toContain(received.address);

    // --- 11. Pay on-chain from the regtest node (wallet execution role) ------
    const amountBtc = (AMOUNT_SATS / 1e8).toFixed(8);
    const txid = await bitcoinCli(['sendtoaddress', received.address, amountBtc], 'miner');
    expect(txid).toMatch(/^[0-9a-f]{64}$/);

    // Mempool payment alone must not confirm anything (minimum_confirmations=1
    // upstream; the marketplace worker only reacts to a COMPLETED lifecycle).
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    const beforeBlock = await MarketplaceGatewayService.getOrder(buyer, order!.id);
    expect(beforeBlock!.payment!.state).toBe('awaiting_entitlement');
    expect(beforeBlock!.state).toBe('pending_payment');

    // --- 12. One block -> Locks completes -> the WORKER confirms -------------
    await bitcoinCli(['generatetoaddress', '1', minerAddress], 'miner');
    const confirmedOrder = await waitFor(
      'the transaction service worker to verify the Locks lifecycle and confirm the payment',
      240_000,
      5_000,
      async () => {
        const current = await MarketplaceGatewayService.getOrder(buyer, order!.id);
        return current?.payment?.state === 'confirmed' ? current : null;
      },
    );
    expect(confirmedOrder).toMatchObject({ state: 'paid' });
    expect(confirmedOrder.payment).toMatchObject({ adapter: 'locks', state: 'confirmed' });
    expect(confirmedOrder.receiptId).toBeTruthy();

    // The durable receipt was issued exactly once by the confirmation.
    const receipt = await MarketplaceGatewayService.getReceipt(buyer, confirmedOrder.receiptId!);
    expect(receipt).toMatchObject({
      orderId: order!.id,
      paymentId: order!.paymentId,
      recipientPubky: buyer,
      issuerPubky: seller,
    });
    expect(receipt!.contentHash).toMatch(/^[a-f0-9]{64}$/);

    // --- 13. Digital delivery: credential + guarded read + hash verification --
    const unlocked = await CommerceApplication.unlockMarketplaceLocksContent(buyer, order!.paymentId);
    expect(unlocked.contentPath).toBe(contentPath);
    expect(Buffer.from(unlocked.bytes).equals(Buffer.from(guardedBytes))).toBe(true);

    // Observed facts of this run, for the record (no bearer material).
    const summary = {
      ran_at: new Date().toISOString(),
      seller,
      buyer,
      listing_aggregate: aggregateId,
      lock_resource: policyUri,
      order_id: order!.id,
      payment_id: order!.paymentId,
      invoice_address: received.address,
      amount_sats: AMOUNT_SATS,
      payment_txid: txid,
      order_state: confirmedOrder.state,
      payment: { adapter: confirmedOrder.payment!.adapter, state: confirmedOrder.payment!.state },
      receipt_id: confirmedOrder.receiptId,
      receipt_content_hash: receipt!.contentHash,
      guarded_bytes_verified: true,
    };
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir('.live-out', { recursive: true });
    await writeFile(`.live-out/locks-payment-${runId}.json`, `${JSON.stringify(summary, null, 2)}\n`);

    MarketplaceSessionService.clearSession();
  });
});
