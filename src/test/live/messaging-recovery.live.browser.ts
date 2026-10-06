// LIVE proof that Encrypted Link recovery keeps the pair intact, in a real
// Chromium page against a live local Pubky testnet: real vendored WASM
// crypto, real homeserver slots, real IndexedDB persistence, real session
// restore after a simulated reload.
//
// Alice runs the app's full PaykitMessagingService stack; Bob is the
// counterparty on the raw binding. Each row drives Alice into a recovery
// branch and then proves that the peer's handshake still completes and that
// a message Bob sends is delivered. Deleting Alice's handshake row or her
// outbox slots during recovery, or refusing to advance a handshake whose
// counterparty key changed, fails these rows. Retries follow the service's
// backoff, so each row polls for up to a minute.
//
// Requires a running local testnet on the stock ports (pkarr relay 15411,
// homeserver 6286, admin 6288). Run with: npm run test:marketplace:messaging

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { buildDmMessage } from '@/libs/messaging/dm-contracts';
import { LocalMessagingService } from '@/services/local/messaging/messaging';
import {
  MESSAGING_SESSION_STORAGE_KEY,
  type MessagingProbeState,
  PaykitMessagingService,
  setPaykitWasmModuleForTests,
} from '@/services/paykit/paykit-messaging';
import { ADMIT_ALL_GATE } from '@/test-utils/messaging-gate';

vi.mock('@/config/commerce', () => ({
  getCommerceAdapterMode: () => 'transaction-service' as const,
  isDurableCommerceMode: (mode: string) => mode === 'transaction-service' || mode === 'locks-paykit',
  COMMERCE_CONTRACT_VERSION: 1 as const,
}));

vi.mock('@/libs/runtime-config/runtime-config', () => ({
  getTestnet: () => true,
  getSingleApprovalSignIn: () => true,
  getSentryDsn: () => undefined,
  getSentryEnvironment: () => undefined,
  getSentryTracesSampleRate: () => 0,
}));

type PaykitWasmModule = typeof import('paykit-wasm');
type SessionHandle = import('paykit-wasm').SessionHandle;
type EncryptedLinkHandle = import('paykit-wasm').EncryptedLinkHandle;
type LinkHandshakeHandle = import('paykit-wasm').LinkHandshakeHandle;

const HOMESERVER_PUBKY = '8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo';
const RECEIVER_PATH = 'marketplace/wallet';
const STEP_MS = 400;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let wasm: PaykitWasmModule;

async function preflight(url: string, what: string): Promise<void> {
  try {
    const response = await fetch(url, { method: 'GET' });
    if (!response.ok && response.status !== 404) throw new Error(`status ${response.status}`);
  } catch (error) {
    throw new Error(
      `${what} is not reachable at ${url}. This live proof needs a local Pubky testnet on the stock ports (pkarr relay 15411, homeserver 6286). Cause: ${String(error)}`,
    );
  }
}

async function signup(): Promise<{ session: SessionHandle; pubky: string }> {
  const tokenResponse = await fetch('http://localhost:6288/generate_signup_token', {
    headers: { 'X-Admin-Password': 'admin' },
  });
  if (!tokenResponse.ok) throw new Error(`Could not mint a testnet signup token (status ${tokenResponse.status}).`);
  const secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  const client = wasm.PubkyClient.testnet();
  const session = (await client.signupWithSecret(
    secret,
    HOMESERVER_PUBKY,
    (await tokenResponse.text()).trim(),
  )) as SessionHandle;
  return { session, pubky: session.pubky() };
}

type Bob = Awaited<ReturnType<typeof signup>> & { client: import('paykit-wasm').PubkyClient; noiseSecret: Uint8Array };

async function enrolledBob(): Promise<Bob> {
  const bob = await signup();
  const noiseSecret = wasm.generateNoiseSecretKey();
  await wasm.publishReceiverMarker(
    bob.session,
    RECEIVER_PATH,
    wasm.noisePublicKeyFromSecret(noiseSecret),
    true,
    false,
    false,
    false,
  );
  return { ...bob, client: wasm.PubkyClient.testnet(), noiseSecret };
}

async function publishBobKey(bob: Bob, noiseSecret: Uint8Array): Promise<void> {
  await wasm.publishReceiverMarker(
    bob.session,
    RECEIVER_PATH,
    wasm.noisePublicKeyFromSecret(noiseSecret),
    true,
    false,
    false,
    false,
  );
}

/** A reload: every in-memory handle dies; IndexedDB rows, the exported session metadata, and the cookie survive. */
async function reloadAlice(alicePubky: string): Promise<void> {
  const exported = window.localStorage.getItem(MESSAGING_SESSION_STORAGE_KEY);
  expect(exported).not.toBeNull();
  PaykitMessagingService.clearSession();
  window.localStorage.setItem(MESSAGING_SESSION_STORAGE_KEY, exported!);
  await expect(PaykitMessagingService.restorePersistedSession(alicePubky)).resolves.toBe(true);
}

/** Advances Bob's raw handshake one step; returns the link once complete. */
async function stepBob(handshake: LinkHandshakeHandle): Promise<EncryptedLinkHandle | null> {
  const progress = (await handshake.advance()) as { status: string; link?: EncryptedLinkHandle };
  return progress.status === 'complete' && progress.link ? progress.link : null;
}

async function drainAlice(alicePubky: string, bobPubky: string, deadlineMs: number) {
  const deadline = Date.now() + deadlineMs;
  let state: MessagingProbeState = await PaykitMessagingService.ensureLink(alicePubky, bobPubky);
  while (Date.now() < deadline && state.status !== 'ready') {
    await sleep(STEP_MS);
    state = await PaykitMessagingService.ensureLink(alicePubky, bobPubky);
  }
  const received: Awaited<ReturnType<typeof PaykitMessagingService.receiveMessages>> = [];
  while (state.status === 'ready' && Date.now() < deadline && received.length === 0) {
    received.push(...(await PaykitMessagingService.receiveMessages(alicePubky, bobPubky, ADMIT_ALL_GATE)));
    if (received.length === 0) await sleep(STEP_MS);
  }
  return { state, received };
}

describe('encrypted link recovery — live pair survival', () => {
  beforeAll(async () => {
    await preflight('http://localhost:15411/', 'The pkarr relay');
    await preflight('http://localhost:6286/', 'The Pubky homeserver');
    wasm = await import('paykit-wasm');
    await wasm.default();
  });

  it('a failed handshake restore keeps the pair: the completed peer still delivers its unread message', async () => {
    setPaykitWasmModuleForTests(wasm);
    PaykitMessagingService.clearSession();
    const bob = await enrolledBob();
    const alice = await signup();
    const enabled = await PaykitMessagingService.enableWithSessionForTests(alice.session);

    // Bob initiates; Alice's inbox sync answers. Bob reads Alice's reply and
    // completes, while Alice still waits for Bob's final handshake message.
    const bobHandshake = wasm.initiateEncryptedLink(
      bob.session,
      bob.noiseSecret,
      alice.pubky,
      enabled.noisePublicKey,
      RECEIVER_PATH,
      RECEIVER_PATH,
      bob.client,
    );
    let bobLink: EncryptedLinkHandle | null = null;
    let aliceState: MessagingProbeState = { status: 'none' };
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !bobLink) {
      bobLink = await stepBob(bobHandshake);
      if (!bobLink && aliceState.status === 'none') {
        aliceState = await PaykitMessagingService.probeCounterparty(alice.pubky, bob.pubky);
      }
      if (!bobLink) await sleep(STEP_MS);
    }
    expect(bobLink).toBeTruthy();
    expect(aliceState).toEqual({ status: 'handshaking', role: 'responder' });
    await expect(LocalMessagingService.getLink(alice.pubky, bob.pubky)).resolves.toMatchObject({
      role: 'responder',
      status: 'handshaking',
    });

    const unread = buildDmMessage({
      eventId: crypto.randomUUID(),
      sentAt: Date.now(),
      body: 'Sent before Alice recovered (live recovery proof).',
    });
    await bobLink!.sendPrivateApplicationMessageJson(unread.json);

    await reloadAlice(alice.pubky);
    setPaykitWasmModuleForTests({
      ...wasm,
      restoreEncryptedLinkHandshake: () => Promise.reject(new Error('network error (injected once)')),
    });
    const failed = await PaykitMessagingService.ensureLink(alice.pubky, bob.pubky);
    setPaykitWasmModuleForTests(wasm);

    expect.soft(failed).toEqual({ status: 'recovery-needed', reason: 'handshake-restore-failed' });
    expect.soft(await LocalMessagingService.getLink(alice.pubky, bob.pubky)).toMatchObject({
      role: 'responder',
      status: 'handshaking',
    });

    const { state, received } = await drainAlice(alice.pubky, bob.pubky, 45_000);
    expect(state).toEqual({ status: 'ready' });
    expect(received.map((message) => message.body)).toEqual([unread.message.body]);
  }, 180_000);

  it('a counterparty key flip holds the pair: the original device still completes the pinned handshake, and nothing is sent', async () => {
    setPaykitWasmModuleForTests(wasm);
    PaykitMessagingService.clearSession();
    const bob = await enrolledBob();
    const alice = await signup();
    const enabled = await PaykitMessagingService.enableWithSessionForTests(alice.session);
    const pinnedKey = wasm.noisePublicKeyFromSecret(bob.noiseSecret);

    // Alice initiates toward Bob's first device.
    const first = await PaykitMessagingService.ensureLink(alice.pubky, bob.pubky);
    expect(first).toEqual({ status: 'handshaking', role: 'initiator' });

    // Bob's second device publishes its own key over the shared marker path
    // before the first device has answered; Alice reloads and sees it.
    const secondSecret = wasm.generateNoiseSecretKey();
    await publishBobKey(bob, secondSecret);
    await reloadAlice(alice.pubky);
    const flipped = await PaykitMessagingService.ensureLink(alice.pubky, bob.pubky);
    expect.soft(flipped).toEqual({
      status: 'key-changed',
      pinnedKey,
      observedKey: wasm.noisePublicKeyFromSecret(secondSecret),
    });

    // Bob's first device answers the handshake it can still read. The other
    // key stays published throughout, so Alice stays held while her
    // handshake on the pinned key completes.
    const bobHandshake = wasm.acceptEncryptedLink(
      bob.session,
      bob.noiseSecret,
      alice.pubky,
      enabled.noisePublicKey,
      RECEIVER_PATH,
      RECEIVER_PATH,
      bob.client,
    );
    let bobLink: EncryptedLinkHandle | null = null;
    let aliceState: MessagingProbeState = flipped;
    const established = async () =>
      (await LocalMessagingService.getLink(alice.pubky, bob.pubky))?.status === 'established';
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && (!bobLink || !(await established()))) {
      if (!bobLink) bobLink = await stepBob(bobHandshake);
      // An open conversation restarts the pair's retries while it is visible.
      PaykitMessagingService.restartLinkRetries(alice.pubky, bob.pubky);
      aliceState = await PaykitMessagingService.ensureLink(alice.pubky, bob.pubky);
      if (!bobLink || !(await established())) await sleep(STEP_MS);
    }
    expect(bobLink).toBeTruthy();
    await expect(established()).resolves.toBe(true);
    expect(aliceState).toMatchObject({ status: 'key-changed', pinnedKey });

    // The pinned link receives.
    const reply = buildDmMessage({
      eventId: crypto.randomUUID(),
      sentAt: Date.now(),
      body: 'Delivered on the pinned key while held (live recovery proof).',
    });
    await bobLink!.sendPrivateApplicationMessageJson(reply.json);
    const received: Awaited<ReturnType<typeof PaykitMessagingService.receiveMessages>> = [];
    const receiveDeadline = Date.now() + 30_000;
    while (Date.now() < receiveDeadline && received.length === 0) {
      received.push(...(await PaykitMessagingService.receiveMessages(alice.pubky, bob.pubky, ADMIT_ALL_GATE)));
      if (received.length === 0) await sleep(STEP_MS);
    }
    expect(received.map((message) => message.body)).toEqual([reply.message.body]);

    // Nothing is sent while held.
    await expect(
      PaykitMessagingService.sendDmMessage(alice.pubky, bob.pubky, { body: 'must not leave' }),
    ).rejects.toMatchObject({ context: { linkStatus: 'key-changed' } });
  }, 180_000);
});
