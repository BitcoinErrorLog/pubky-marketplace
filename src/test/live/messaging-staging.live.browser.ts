// LIVE two-party proof of encrypted marketplace messaging against the REAL
// staging network — the exact topology of the deployed app
// (PUBKY_RUNTIME_TESTNET=false): the official staging homeserver reached
// through the public pkarr relays. Nothing is mocked below the module seam:
// real vendored WASM crypto, real public-relay pkarr resolution, real
// staging-homeserver reads/writes, real IndexedDB persistence.
//
// Alice runs the app's FULL PaykitMessagingService stack. With
// `getTestnet() === false` the service constructs `new PubkyClient()`
// (mainnet defaults: https://pkarr.pubky.app, https://pkarr.pubky.org) — this
// suite therefore proves the exact client the deployed app would use. Bob is
// the counterparty on the raw binding, also on a mainnet-defaults client.
//
// The staging homeserver requires SINGLE-USE signup tokens; see
// vitest.messaging.staging.config.ts for how to pass them and how to re-run
// with saved identity secrets if tokens were already consumed.

import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  marketplaceConversationHref,
  reportRejectedConversationQuery,
  resolveMarketplaceConversationQuery,
} from '@/libs/commerce/marketplace-conversation-query';
import { buildChatMessage, decodeChatMessage } from '@/libs/commerce/messaging-contracts';
import {
  buildMarketplaceConversationAggregateId,
  buildMarketplaceListingAggregateId,
} from '@/libs/commerce/transaction-commands';
import { Logger } from '@/libs/logger/logger';
import { LocalMessagingService } from '@/services/local/messaging/messaging';
import { PaykitMessagingService, setPaykitWasmModuleForTests } from '@/services/paykit/paykit-messaging';
import { ADMIT_ALL_GATE } from '@/test-utils/messaging-gate';

// Self-contained factories, hoisted by vitest above the imports (browser-mode
// mocking cannot use importActual here): the messaging service imports exactly
// these members from each module, so nothing else in its graph is affected.
vi.mock('@/config/commerce', () => ({
  getCommerceAdapterMode: () => 'transaction-service' as const,
  isDurableCommerceMode: (mode: string) => mode === 'transaction-service' || mode === 'locks-paykit',
  COMMERCE_CONTRACT_VERSION: 1 as const,
}));

vi.mock('@/libs/runtime-config/runtime-config', () => ({
  // THE point of this suite: testnet=false, as on the staging deployment.
  getTestnet: () => false,
  // messaging-contracts imports CAPABILITIES from config/app, which reads this.
  getSingleApprovalSignIn: () => true,
  // Imported by the error factories' Sentry capture path; disabled here.
  getSentryDsn: () => undefined,
  getSentryEnvironment: () => undefined,
  getSentryTracesSampleRate: () => 0,
}));

// Injected by vitest.messaging.staging.config.ts `define` at build time.
declare const __STAGING_SIGNUP_TOKEN_A__: string;
declare const __STAGING_SIGNUP_TOKEN_B__: string;
declare const __STAGING_SECRET_A__: string;
declare const __STAGING_SECRET_B__: string;

type PaykitWasmModule = typeof import('paykit-wasm');
type SessionHandle = import('paykit-wasm').SessionHandle;

const STAGING_HOMESERVER_PUBKY = 'ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy';
const PUBLIC_PKARR_RELAY = 'https://pkarr.pubky.app';
const RECEIVER_PATH = 'marketplace/wallet';
const LISTING_ID = '0033GVVN22HJ0FYQGZZS8R2BFC';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

let wasm: PaykitWasmModule;

function randomIdentitySecret(): Uint8Array {
  const secret = new Uint8Array(32);
  crypto.getRandomValues(secret);
  return secret;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Signs up with a single-use staging token, or — when a saved identity secret
 * is provided (re-run after tokens were consumed) — signs back in instead.
 * Always logs the secret so a failed partial run stays recoverable; these are
 * throwaway staging test identities, not real users.
 */
async function stagingSession(
  label: string,
  savedSecretHex: string,
  signupToken: string,
): Promise<{ session: SessionHandle; pubky: string; secret: Uint8Array }> {
  const client = new wasm.PubkyClient();
  if (savedSecretHex) {
    const secret = hexToBytes(savedSecretHex);
    const session = (await client.signinWithSecret(secret)) as SessionHandle;
    console.info(`[staging-live] ${label}: signed back in as ${session.pubky()}`);
    return { session, pubky: session.pubky(), secret };
  }
  if (!signupToken) {
    throw new Error(
      `Missing credentials for ${label}: pass PAYKIT_STAGING_SIGNUP_TOKEN_${label} (single-use signup token) or PAYKIT_STAGING_SECRET_${label} (identity secret hex from a previous run).`,
    );
  }
  const secret = randomIdentitySecret();
  console.info(`[staging-live] ${label}: identity secret (save for re-runs): ${bytesToHex(secret)}`);
  const session = (await client.signupWithSecret(secret, STAGING_HOMESERVER_PUBKY, signupToken)) as SessionHandle;
  console.info(`[staging-live] ${label}: signed up as ${session.pubky()}`);
  return { session, pubky: session.pubky(), secret };
}

describe('encrypted marketplace messaging — live two-party proof on STAGING (public network)', () => {
  beforeAll(async () => {
    // Reachability of the public relay, via a real pkarr read of the staging
    // homeserver's record — the same resolution the binding performs.
    const response = await fetch(`${PUBLIC_PKARR_RELAY}/${STAGING_HOMESERVER_PUBKY}`);
    if (!response.ok) {
      throw new Error(
        `The public pkarr relay ${PUBLIC_PKARR_RELAY} did not serve the staging homeserver record (status ${response.status}). This live proof needs the public staging network to be reachable.`,
      );
    }
    wasm = await import('paykit-wasm');
    await wasm.default();
    // Inject the already-initialized REAL module so the service does not
    // re-initialize it. Same artifact, same crypto.
    setPaykitWasmModuleForTests(wasm);
  });

  it('runs enrollment, handshake, bidirectional chat, and snapshot-restore against the staging homeserver via public relays', async () => {
    // --- Bob (counterparty, raw binding, mainnet-defaults client) ----------
    const bob = await stagingSession('B', __STAGING_SECRET_B__, __STAGING_SIGNUP_TOKEN_B__);

    // --- Alice (the app's full service stack, getTestnet() === false) ------
    const alice = await stagingSession('A', __STAGING_SECRET_A__, __STAGING_SIGNUP_TOKEN_A__);
    const enabled = await PaykitMessagingService.enableWithSessionForTests(alice.session);
    expect(enabled.pubky).toBe(alice.pubky);
    expect(enabled.receiverPath).toBe(RECEIVER_PATH);
    expect(PaykitMessagingService.hasActiveSession(alice.pubky)).toBe(true);

    // Only two single-use tokens exist, so the not-enrolled truth is proven
    // against Bob BEFORE he publishes his marker: honestly not-enrolled,
    // nothing starts. (Skipped when re-running with saved secrets, since a
    // prior run may already have published Bob's marker.)
    if (!__STAGING_SECRET_B__) {
      await expect(PaykitMessagingService.getCounterpartyMarker(bob.pubky)).resolves.toBeNull();
      await expect(PaykitMessagingService.ensureLink(alice.pubky, bob.pubky)).resolves.toEqual({
        status: 'not-enrolled',
      });
    }

    // Bob enrolls with the raw binding.
    const bobNoiseSecret = wasm.generateNoiseSecretKey();
    await wasm.publishReceiverMarker(
      bob.session,
      RECEIVER_PATH,
      wasm.noisePublicKeyFromSecret(bobNoiseSecret),
      true,
      false,
      false,
      false,
    );

    // Alice's marker is publicly discoverable through the public relays
    // (Bob's independent mainnet-defaults client reads it).
    const bobClient = new wasm.PubkyClient();
    const aliceMarker = (await wasm.getReceiverMarker(bobClient, alice.pubky, RECEIVER_PATH)) as {
      receiverPath: string;
      noisePublicKey: string;
    };
    expect(aliceMarker).toBeTruthy();
    expect(aliceMarker.noisePublicKey).toBe(enabled.noisePublicKey);

    // --- Handshake over the live staging homeserver -------------------------
    let aliceState = await PaykitMessagingService.ensureLink(alice.pubky, bob.pubky);
    if (aliceState.status !== 'ready') {
      expect(aliceState).toEqual({ status: 'handshaking', role: 'initiator' });
    }

    const bobHandshake = wasm.acceptEncryptedLink(
      bob.session,
      bobNoiseSecret,
      alice.pubky,
      aliceMarker.noisePublicKey,
      RECEIVER_PATH,
      aliceMarker.receiverPath,
      bobClient,
    );
    let bobLink: import('paykit-wasm').EncryptedLinkHandle | null = null;
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline && (aliceState.status !== 'ready' || !bobLink)) {
      if (!bobLink) {
        const progress = (await bobHandshake.advance()) as {
          status: string;
          link?: import('paykit-wasm').EncryptedLinkHandle;
        };
        if (progress.status === 'complete' && progress.link) bobLink = progress.link;
      }
      if (aliceState.status !== 'ready') {
        aliceState = await PaykitMessagingService.ensureLink(alice.pubky, bob.pubky);
      }
      if (aliceState.status !== 'ready' || !bobLink) await sleep(1000);
    }
    expect(aliceState).toEqual({ status: 'ready' });
    expect(bobLink).toBeTruthy();

    // --- Alice -> Bob chat message through the service ----------------------
    const conversationId = buildMarketplaceConversationAggregateId(bob.pubky, alice.pubky, LISTING_ID);
    expect(
      resolveMarketplaceConversationQuery({ values: [conversationId], currentUserPubky: alice.pubky }).status,
    ).toBe('open');
    expect(resolveMarketplaceConversationQuery({ values: [conversationId], currentUserPubky: bob.pubky }).status).toBe(
      'open',
    );
    expect(
      resolveMarketplaceConversationQuery({ values: ['not-a-conversation'], currentUserPubky: alice.pubky }).status,
    ).toBe('invalid');
    expect(
      resolveMarketplaceConversationQuery({ values: [`dm:${bob.pubky}`], currentUserPubky: alice.pubky }).status,
    ).toBe('invalid');
    const hrefValues = new URL(
      marketplaceConversationHref(conversationId),
      'https://shop.pubky.app',
    ).searchParams.getAll('conversation');
    expect(resolveMarketplaceConversationQuery({ values: hrefValues, currentUserPubky: alice.pubky }).status).toBe(
      'open',
    );
    const warn = vi.spyOn(Logger, 'warn');
    reportRejectedConversationQuery();
    const serializedWarn = JSON.stringify(warn.mock.calls);
    expect(serializedWarn).toContain('invalid_conversation_query');
    expect(serializedWarn).not.toContain(conversationId);
    expect(serializedWarn).not.toContain(alice.pubky);
    expect(serializedWarn).not.toContain(bob.pubky);
    warn.mockRestore();

    const listingRef = buildMarketplaceListingAggregateId(bob.pubky, LISTING_ID);
    const sent = await PaykitMessagingService.sendChatMessage(alice.pubky, bob.pubky, {
      conversationId,
      listingRef,
      body: 'Is this still available? (staging live proof, Alice -> Bob)',
    });

    let bobInbox: { rawJson: string }[] = [];
    const receiveDeadline = Date.now() + 60_000;
    while (Date.now() < receiveDeadline && bobInbox.length === 0) {
      bobInbox = (await bobLink!.receivePrivateApplicationMessages()) as { rawJson: string }[];
      if (bobInbox.length === 0) await sleep(1000);
    }
    expect(bobInbox).toHaveLength(1);
    const bobReceived = decodeChatMessage(bobInbox[0].rawJson);
    expect(bobReceived).toEqual(sent);

    // --- Bob -> Alice, received and persisted by the service ---------------
    const reply = buildChatMessage({
      eventId: crypto.randomUUID(),
      conversationId,
      listingRef,
      sentAt: Date.now(),
      body: 'Yes, still available. (staging live proof, Bob -> Alice)',
    });
    await bobLink!.sendPrivateApplicationMessageJson(reply.json);

    let aliceReceived: Awaited<ReturnType<typeof PaykitMessagingService.receiveMessages>> = [];
    const aliceDeadline = Date.now() + 60_000;
    while (Date.now() < aliceDeadline && aliceReceived.length === 0) {
      aliceReceived = await PaykitMessagingService.receiveMessages(alice.pubky, bob.pubky, ADMIT_ALL_GATE);
      if (aliceReceived.length === 0) await sleep(1000);
    }
    expect(aliceReceived).toHaveLength(1);
    expect(aliceReceived[0].body).toBe(reply.message.body);

    const persisted = await LocalMessagingService.getMessages(alice.pubky, conversationId);
    expect(persisted.map(({ direction, body }) => ({ direction, body }))).toEqual([
      { direction: 'sent', body: sent.body },
      { direction: 'received', body: reply.message.body },
    ]);

    // --- Snapshot restore through the service -------------------------------
    // Simulate a reload: in-memory handles die, IndexedDB rows survive, a
    // fresh session is signed in, and the link restores from its persisted
    // snapshot — then still receives a message Bob sent in the meantime.
    PaykitMessagingService.clearSession();
    expect(PaykitMessagingService.hasActiveSession(alice.pubky)).toBe(false);

    const secondReply = buildChatMessage({
      eventId: crypto.randomUUID(),
      conversationId,
      listingRef,
      sentAt: Date.now(),
      body: 'Sent while Alice was away. (staging live proof, snapshot restore)',
    });
    await bobLink!.sendPrivateApplicationMessageJson(secondReply.json);

    const aliceSessionAgain = (await new wasm.PubkyClient().signinWithSecret(alice.secret)) as SessionHandle;
    await PaykitMessagingService.enableWithSessionForTests(aliceSessionAgain);

    const restoredState = await PaykitMessagingService.ensureLink(alice.pubky, bob.pubky);
    expect(restoredState).toEqual({ status: 'ready' });

    let afterRestore: Awaited<ReturnType<typeof PaykitMessagingService.receiveMessages>> = [];
    const restoreDeadline = Date.now() + 60_000;
    while (Date.now() < restoreDeadline && afterRestore.length === 0) {
      afterRestore = await PaykitMessagingService.receiveMessages(alice.pubky, bob.pubky, ADMIT_ALL_GATE);
      if (afterRestore.length === 0) await sleep(1000);
    }
    expect(afterRestore).toHaveLength(1);
    expect(afterRestore[0].body).toBe(secondReply.message.body);

    // The restored link can also SEND (outbound counters survived).
    const postRestore = await PaykitMessagingService.sendChatMessage(alice.pubky, bob.pubky, {
      conversationId,
      listingRef,
      body: 'Back online after restore. (staging live proof, Alice -> Bob)',
    });
    let bobInboxAfterRestore: { rawJson: string }[] = [];
    const bobDeadline = Date.now() + 60_000;
    while (Date.now() < bobDeadline && bobInboxAfterRestore.length === 0) {
      bobInboxAfterRestore = (await bobLink!.receivePrivateApplicationMessages()) as { rawJson: string }[];
      if (bobInboxAfterRestore.length === 0) await sleep(1000);
    }
    expect(bobInboxAfterRestore).toHaveLength(1);
    expect(decodeChatMessage(bobInboxAfterRestore[0].rawJson)).toEqual(postRestore);
  }, 480_000);
});
