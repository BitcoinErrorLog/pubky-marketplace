// Orchestration tests for PaykitMessagingService: session lifecycle, receiver
// provisioning + marker publish, the link-establishment state machine
// (initiate / inbound adoption / restore), send/receive persistence mapping
// and ordering, and size enforcement.
//
// The wasm binding is replaced here by a purpose-built fake injected through
// the service's test seam, so these tests exercise the SERVICE's logic (state
// transitions, persistence, argument mapping) — the cryptography itself is
// proven with the real compiled artifact in paykit-messaging.realcrypto.test.ts
// and scripts/paykit-wasm-smoke.mjs, and the homeserver flows by the binding's
// browser e2e at the pinned commit.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MESSAGING_PLAINTEXT_SWEEP_INTERVAL_MS,
  MESSAGING_PLAINTEXT_SWEEP_WAIT_MS,
  MessagingApplication,
} from '@/application/messaging/messaging';
import { DB_NAME } from '@/config/database';
import { resumePendingMessagingTeardown } from '@/database/franky/franky.helpers';
import {
  buildMarketplaceConversationAggregateId,
  buildMarketplaceListingAggregateId,
} from '@/libs/commerce/transaction-commands';
import { dropCachedWrappingKeyForTests, resetMessagingKeyringForTests } from '@/libs/crypto/messaging-keyring';
import { WRAP_IV_BYTES, WRAP_VERSION_AES_GCM_256 } from '@/libs/crypto/secret-wrapping';
import { Logger } from '@/libs/logger/logger';
import { MESSAGING_RETRY_POLICY } from '@/libs/messaging/retry-backoff';
import { CommerceMessagingLinkModel, CommerceMessagingMessageModel } from '@/models/messaging/messaging.models';
import {
  CommerceMessagingConversationModel,
  CommerceMessagingOutboxModel,
  CommerceMessagingReceiverModel,
  CommerceMessagingUnprocessedModel,
} from '@/models/messaging/messaging.models';
import { LocalMessagingService } from '@/services/local/messaging/messaging';
import { ADMIT_ALL_GATE, ADMIT_ALL_POLICY, policyMuting } from '@/test-utils/messaging-gate';
import { asOpaque } from '@/test-utils/type-assertions';
import { installRefusingWebLocks, installWebLocks, removeWebLocks } from '@/test-utils/web-locks';
import { PaykitMessagingService, setPaykitWasmModuleForTests } from './paykit-messaging';

// Verbatim from the vendored binding on the production Pubky network: a
// counterparty whose homeserver does not resolve, 2026-09-29
// (.evidence/issue59-receiver-marker/probe-marker-read.log). The binding
// rejects with a plain Error carrying only this text.
const RAW_MARKER_TRANSPORT_ERROR =
  'failed to fetch receiver marker: transport error: get_paykit_receiver_marker: fetch Paykit receiver marker';
const RAW_MARKER_INVALID_DATA_ERROR =
  'failed to fetch receiver marker: invalid data: get_paykit_receiver_marker: Paykit receiver marker JSON is invalid: expected value at line 1 column 1';

const advanceClock = (ms: number) => vi.setSystemTime(Date.now() + ms);
const TEARDOWN_PENDING = 'pubky-messaging-keys-teardown-pending';
const POLL_MS = 2_000;

const OWNER = 'a'.repeat(52);
const COUNTERPARTY = 'z'.repeat(52);
const LISTING_ID = '0033GVVN22HJ0FYQGZZS8R2BFC';
const CONVERSATION_ID = buildMarketplaceConversationAggregateId(COUNTERPARTY, OWNER, LISTING_ID);
const LISTING_REF = buildMarketplaceListingAggregateId(COUNTERPARTY, LISTING_ID);

const config = vi.hoisted(() => ({ mode: 'transaction-service' as string }));

vi.mock('@/config/commerce', async () => {
  const actual = await vi.importActual<typeof import('@/config/commerce')>('@/config/commerce');
  return { ...actual, getCommerceAdapterMode: () => config.mode };
});

vi.mock('@/libs/runtime-config/runtime-config', async () => {
  const actual = await vi.importActual<typeof import('@/libs/runtime-config/runtime-config')>(
    '@/libs/runtime-config/runtime-config',
  );
  return { ...actual, getTestnet: () => true };
});

/**
 * In-memory stand-in for the wasm binding with recorded calls. Handshakes are
 * scripted per test through `world`:
 * - `world.markers` — who has published a receiver marker.
 * - `world.inboundFrom` — counterparties with a queued inbound handshake
 *   (an accept-probe makes progress: its snapshot changes on advance).
 * - `world.advanceScript` — outcomes for successive initiator advances.
 */
function createFakeWorld() {
  const world = {
    markers: new Map<string, { receiverPath: string; noisePublicKey: string }>(),
    // Public receiver trees for `listPaykitReceiverPaths`: owner → path → marker.
    receiverTrees: new Map<string, Map<string, { capabilities: Record<string, boolean> }>>(),
    receiverListFails: false,
    inboundFrom: new Set<string>(),
    advanceScript: [] as ('pending' | 'complete' | 'error')[],
    calls: [] as string[],
    lastPublishedMarker: null as null | { path: string; noisePublicKey: string; capabilities: boolean[] },
    links: [] as FakeLink[],
    nextApprovalPubky: OWNER,
    // Scripted `restoreSession` behavior: reject (cookie expired/revoked at
    // the homeserver) or resolve with the pubky embedded in the export blob.
    restoreRejects: false,
    restoredPubkyOverride: null as string | null,
    // Runs while `restoreSession` is in flight: another tab acting meanwhile.
    duringRestore: null as (() => void) | null,
    // Scripted `resumeSessionFromCookie` behavior. Default 'unauthorized':
    // the browser holds no homeserver cookie for the requested pubky (the
    // binding's SessionResumeUnauthorized), which mirrors the signed-out
    // baseline every pre-existing test assumes.
    cookieResume: 'unauthorized' as 'success' | 'unauthorized' | 'scope-missing',
    cookieResumePubkyOverride: null as string | null,
    // Scripted marker-publish failures (consumed one per publish attempt).
    publishMarkerFailures: 0,
    publishMarkerFailureStatus: null as number | null,
    publishMarkerRetryAfterSeconds: 0,
    // How long successive marker publishes take before the homeserver
    // accepts them (consumed one per publish; 0 when empty).
    publishAcceptDelays: [] as number[],
    // When set, a marker publish waits on it before the homeserver accepts it.
    publishHold: null as Promise<void> | null,
    // Scripted `restoreEncryptedLinkHandshake` rejections (consumed one per call).
    restoreHandshakeFailures: 0,
    // Scripted `restoreEncryptedLink` rejections (consumed one per call).
    restoreLinkFailures: 0,
    // Every send counter any link used, in order, across restores.
    sentCounters: [] as number[],
    // Scripted send failures after the counter was spent (consumed one per send).
    sendFailures: 0,
    // Scripted receive failures after the read position moved (consumed one per receive).
    receiveFailures: 0,
    // When set, a receive waits on it after draining.
    receiveHold: null as Promise<void> | null,
    // When set, a send waits on it before it spends a counter.
    sendHold: null as Promise<void> | null,
    // Counterparties whose inbound handshake completes on the responder's first advance.
    responderCompletes: new Set<string>(),
    // Scripted marker read rejections per owner: the binding's own message text,
    // for `remaining` reads (Infinity = every read).
    markerReadFailures: new Map<string, { message: string; remaining: number }>(),
    // When set, a marker read waits on it before it answers.
    markerReadHold: null as Promise<void> | null,
    // When set, every link reports this counterparty key instead of the one it was created with.
    linkKeyOverride: null as string | null,
  };

  let keyCounter = 0;
  // Like the binding, a handshake or link carries the counterparty key it was
  // created with, in memory and in its snapshot, and a restore reads it back.
  const withKey = (header: number[], remoteKey: string) =>
    new Uint8Array([...header, ...new TextEncoder().encode(remoteKey)]);
  const keyOf = (snapshot: Uint8Array) => new TextDecoder().decode(snapshot.subarray(3));

  class FakeSessionHandle {
    constructor(private readonly owner: string) {}
    pubky() {
      return this.owner;
    }
    // Mirrors the binding: secret-free metadata identifying the session owner.
    exportSession() {
      return `exported-session:${this.owner}`;
    }
    free() {}
  }

  // Models the binding's send counter (the Noise nonce): every send uses the
  // next value, the snapshot carries it, and a restore resumes from it.
  class FakeLink {
    sent: string[] = [];
    inboundQueue: { version: number; kind: string; rawJson: string }[] = [];
    snapshotCounter = 0;
    constructor(
      public readonly counterparty: string,
      public readonly remoteKey: string,
      public sendCounter = 0,
    ) {
      world.links.push(this);
    }
    remoteNoisePublicKey() {
      return world.linkKeyOverride ?? this.remoteKey;
    }
    async sendPrivateApplicationMessageJson(rawJson: string) {
      if (new TextEncoder().encode(rawJson).byteLength > 1000) throw new Error('exceeds max Noise message size');
      world.calls.push('link.send');
      if (world.sendHold) await world.sendHold;
      const counter = this.sendCounter;
      this.sendCounter += 1;
      world.sentCounters.push(counter);
      if (world.sendFailures > 0) {
        // The ciphertext was built under this counter before the upload
        // failed, so the counter is spent either way.
        world.sendFailures -= 1;
        throw new Error('outbox upload failed (scripted transient homeserver error)');
      }
      this.sent.push(rawJson);
    }
    setMaxSendRetries(max: number) {
      world.calls.push(`link.setMaxSendRetries:${max}`);
    }
    async receivePrivateApplicationMessages() {
      world.calls.push('link.receive');
      const drained = [...this.inboundQueue];
      this.inboundQueue = [];
      if (world.receiveHold) await world.receiveHold;
      if (world.receiveFailures > 0) {
        world.receiveFailures -= 1;
        throw new Error('outbox read failed (scripted transient homeserver error)');
      }
      return drained;
    }
    snapshot() {
      this.snapshotCounter += 1;
      return withKey([76, this.snapshotCounter, this.sendCounter], this.remoteKey);
    }
    closed = false;
    async close() {
      this.closed = true;
    }
    free() {}
  }

  class FakeHandshake {
    private advanced = 0;
    constructor(
      private readonly role: 'initiator' | 'responder',
      private readonly counterparty: string,
      private readonly remoteKey: string,
    ) {}
    async advance() {
      world.calls.push(`handshake.advance:${this.role}`);
      if (this.role === 'responder') {
        // An accept-probe only progresses when an inbound handshake exists.
        if (!world.inboundFrom.has(this.counterparty)) return { status: 'pending' };
        if (world.responderCompletes.has(this.counterparty)) {
          return { status: 'complete', link: new FakeLink(this.counterparty, this.remoteKey) };
        }
        this.advanced += 1;
        return { status: 'pending' };
      }
      const outcome = world.advanceScript.shift() ?? 'pending';
      if (outcome === 'error') throw new Error('handshake step failed (scripted transient homeserver error)');
      if (outcome === 'complete') return { status: 'complete', link: new FakeLink(this.counterparty, this.remoteKey) };
      return { status: 'pending' };
    }
    snapshot() {
      // Progress must be visible in snapshot bytes (the service's probe
      // detector compares them).
      return withKey([72, this.role === 'initiator' ? 1 : 2, this.advanced], this.remoteKey);
    }
    setMaxRecoveryAttempts(max: number) {
      world.calls.push(`handshake.setMaxRecoveryAttempts:${max}`);
    }
    free() {}
  }

  class FakePubkyClient {
    static testnet() {
      return new FakePubkyClient();
    }
    startAuthFlow(capabilities: string) {
      world.calls.push(`startAuthFlow:${capabilities}`);
      return {
        authorizationUrl: () => `pubkyauth://signin?caps=${capabilities}&secret=fake`,
        awaitApproval: async () => new FakeSessionHandle(world.nextApprovalPubky),
      };
    }
    async restoreSession(exported: string) {
      world.calls.push('restoreSession');
      await Promise.resolve();
      world.duringRestore?.();
      if (world.restoreRejects) throw new Error('session restore failed: RequestExpired');
      const owner = world.restoredPubkyOverride ?? exported.replace('exported-session:', '');
      return new FakeSessionHandle(owner);
    }
    // Mirrors the binding: typed rejections carry a stable Error.name.
    async resumeSessionFromCookie(pubky: string) {
      world.calls.push('resumeSessionFromCookie');
      if (world.cookieResume === 'unauthorized') {
        const error = new Error('cookie resume failed: no valid session behind the browser cookies');
        error.name = 'SessionResumeUnauthorized';
        throw error;
      }
      if (world.cookieResume === 'scope-missing') {
        const error = new Error('cookie resume failed: session scope does not grant /pub/paykit/ read+write');
        error.name = 'SessionResumeScopeMissing';
        throw error;
      }
      return new FakeSessionHandle(world.cookieResumePubkyOverride ?? pubky);
    }
  }

  const fakeModule = {
    PubkyClient: FakePubkyClient,
    generateNoiseSecretKey: () => {
      world.calls.push('generateNoiseSecretKey');
      keyCounter += 1;
      return new Uint8Array(32).fill(keyCounter);
    },
    noisePublicKeyFromSecret: (secret: Uint8Array) => `${'n'.repeat(50)}${String(secret[0]).padStart(2, '0')}`,
    publishReceiverMarker: async (
      _session: unknown,
      path: string,
      noisePublicKey: string,
      ...capabilities: boolean[]
    ) => {
      world.calls.push('publishReceiverMarker');
      if (world.publishMarkerFailures > 0) {
        world.publishMarkerFailures -= 1;
        throw Object.assign(new Error('marker publish failed (scripted transient homeserver error)'), {
          data:
            world.publishMarkerFailureStatus === null
              ? undefined
              : {
                  statusCode: world.publishMarkerFailureStatus,
                  retryAfterSeconds: world.publishMarkerRetryAfterSeconds,
                },
        });
      }
      const acceptDelay = world.publishAcceptDelays.shift() ?? 0;
      if (acceptDelay > 0) await new Promise((resolve) => setTimeout(resolve, acceptDelay));
      if (world.publishHold) await world.publishHold;
      world.lastPublishedMarker = { path, noisePublicKey, capabilities };
      world.markers.set((_session as FakeSessionHandle).pubky(), { receiverPath: path, noisePublicKey });
    },
    getReceiverMarker: async (_client: unknown, ownerPubky: string, path?: string) => {
      world.calls.push(`getReceiverMarker:${ownerPubky.slice(0, 4)}`);
      if (world.markerReadHold) await world.markerReadHold;
      const scripted = world.markerReadFailures.get(ownerPubky);
      if (scripted && scripted.remaining > 0) {
        scripted.remaining -= 1;
        throw new Error(scripted.message);
      }
      const tree = world.receiverTrees.get(ownerPubky);
      if (tree && path !== undefined) return tree.get(path);
      return world.markers.get(ownerPubky);
    },
    listPaykitReceiverPaths: async (_client: unknown, ownerPubky: string) => {
      if (world.receiverListFails) throw new Error('homeserver unreachable (scripted)');
      return [...(world.receiverTrees.get(ownerPubky)?.keys() ?? [])].sort();
    },
    removeReceiverMarker: async () => {
      world.calls.push('removeReceiverMarker');
    },
    initiateEncryptedLink: (...args: unknown[]) => {
      world.calls.push('initiateEncryptedLink');
      const counterparty = args[2] as string;
      return new FakeHandshake('initiator', counterparty, args[3] as string);
    },
    acceptEncryptedLink: (...args: unknown[]) => {
      world.calls.push('acceptEncryptedLink');
      const counterparty = args[2] as string;
      return new FakeHandshake('responder', counterparty, args[3] as string);
    },
    restoreEncryptedLink: async (...args: unknown[]) => {
      world.calls.push('restoreEncryptedLink');
      if (world.restoreLinkFailures > 0) {
        world.restoreLinkFailures -= 1;
        throw new Error('link restore failed (scripted transient homeserver error)');
      }
      const counterparty = args[2] as string;
      const snapshot = args[6] as Uint8Array;
      return new FakeLink(counterparty, keyOf(snapshot), snapshot[2] ?? 0);
    },
    restoreEncryptedLinkHandshake: async (...args: unknown[]) => {
      world.calls.push('restoreEncryptedLinkHandshake');
      if (world.restoreHandshakeFailures > 0) {
        world.restoreHandshakeFailures -= 1;
        throw new Error('handshake restore failed (scripted transient homeserver error)');
      }
      const counterparty = args[2] as string;
      return new FakeHandshake('initiator', counterparty, keyOf(args[6] as Uint8Array));
    },
    clearEncryptedLinkOutbox: async () => {
      world.calls.push('clearEncryptedLinkOutbox');
      return 0;
    },
    maxNoiseMessageLen: () => 1000,
    noiseTagLen: () => 16,
  };

  return { world, module: asOpaque<typeof import('paykit-wasm')>(fakeModule) };
}

async function enableMessaging(world: ReturnType<typeof createFakeWorld>['world']) {
  world.nextApprovalPubky = OWNER;
  const flow = await PaykitMessagingService.beginEnableFlow(OWNER);
  return await flow.awaitEnabled();
}

describe('PaykitMessagingService', () => {
  let world: ReturnType<typeof createFakeWorld>['world'];
  let wasm: ReturnType<typeof createFakeWorld>['module'];

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const fake = createFakeWorld();
    world = fake.world;
    wasm = fake.module;
    setPaykitWasmModuleForTests(fake.module);
    installWebLocks();
    window.localStorage.removeItem(TEARDOWN_PENDING);
    config.mode = 'transaction-service';
    PaykitMessagingService.clearSession();
    await Promise.all([
      CommerceMessagingReceiverModel.clear(),
      CommerceMessagingLinkModel.clear(),
      CommerceMessagingConversationModel.clear(),
      CommerceMessagingMessageModel.clear(),
      CommerceMessagingUnprocessedModel.clear(),
    ]);
  });

  afterEach(() => {
    PaykitMessagingService.clearSession();
    setPaykitWasmModuleForTests(null);
    removeWebLocks();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('buyer payment-request wallet', () => {
    const BUYER = 'b'.repeat(52);
    const messagingOnly = { capabilities: { privatePayments: true, paymentRequests: false } };
    const bitkitWallet = { capabilities: { privatePayments: true, paymentRequests: true } };

    it('does not count the messaging-only receiver as a payable wallet', async () => {
      world.receiverTrees.set(BUYER, new Map([['marketplace/wallet', messagingOnly]]));
      await expect(PaykitMessagingService.hasPaymentRequestReceiver(BUYER)).resolves.toBe(false);
    });

    it('reports no wallet when nothing is published', async () => {
      await expect(PaykitMessagingService.hasPaymentRequestReceiver(BUYER)).resolves.toBe(false);
    });

    it('finds a payment-request receiver next to the messaging one', async () => {
      world.receiverTrees.set(
        BUYER,
        new Map([
          ['bitkit/wallet', bitkitWallet],
          ['marketplace/wallet', messagingOnly],
        ]),
      );
      await expect(PaykitMessagingService.hasPaymentRequestReceiver(BUYER)).resolves.toBe(true);
    });

    it('rejects when the receiver list cannot be read, never reporting "no wallet"', async () => {
      world.receiverListFails = true;
      await expect(PaykitMessagingService.hasPaymentRequestReceiver(BUYER)).rejects.toThrow();
    });
  });

  describe('session lifecycle and receiver provisioning', () => {
    it('is independent of the commerce adapter mode (general DMs never gate on commerce)', async () => {
      config.mode = 'sandbox';
      const enabled = await enableMessaging(world);
      expect(enabled.pubky).toBe(OWNER);
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(true);
    });

    it('asks Ring for the whole Ring cookie set and publishes a messaging-only marker', async () => {
      const enabled = await enableMessaging(world);

      // The whole set on purpose: the homeserver holds one session cookie per
      // user, so the messaging session must carry every scope the Shop and
      // pubky.app sign-ins hold or approving it breaks their writes (see
      // messaging-contracts).
      expect(world.calls).toContain(
        'startAuthFlow:/pub/pubky.app/:rw,/pub/paykit/:rw,/priv/pubky.app/:rw,/priv/social/:rw,/priv/app.locks/content/:r',
      );
      expect(enabled.pubky).toBe(OWNER);
      expect(enabled.receiverPath).toBe('marketplace/wallet');
      expect(world.lastPublishedMarker).toEqual({
        path: 'marketplace/wallet',
        noisePublicKey: enabled.noisePublicKey,
        // privatePayments (the Encrypted Link capability) only — never the payment capabilities.
        capabilities: [true, false, false, false],
      });
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(true);
      await expect(PaykitMessagingService.isReceiverProvisioned(OWNER)).resolves.toBe(true);

      const receiver = await LocalMessagingService.getReceiver(OWNER);
      expect(receiver?.noise_secret).toHaveLength(32);
      expect(receiver?.marker_published).toBe(true);
    });

    it('retries a rate-limited receiver marker before reporting it published', async () => {
      world.publishMarkerFailures = 1;
      world.publishMarkerFailureStatus = 429;

      await enableMessaging(world);

      expect(world.calls.filter((call) => call === 'publishReceiverMarker')).toHaveLength(2);
      await expect(PaykitMessagingService.isReceiverProvisioned(OWNER)).resolves.toBe(true);
    });

    it('revert-fail: releases the receiver lock instead of honoring a long Retry-After inside it', async () => {
      world.publishMarkerFailures = 1;
      world.publishMarkerFailureStatus = 429;
      world.publishMarkerRetryAfterSeconds = 30;

      await expect(enableMessaging(world)).rejects.toThrow('marker publish failed');
      expect(world.calls.filter((call) => call === 'publishReceiverMarker')).toHaveLength(1);

      await expect(enableMessaging(world)).resolves.toMatchObject({ pubky: OWNER });
      expect(world.calls.filter((call) => call === 'publishReceiverMarker')).toHaveLength(2);
    });

    it('rejects an approval from a different identity than the signed-in user', async () => {
      world.nextApprovalPubky = COUNTERPARTY;
      const flow = await PaykitMessagingService.beginEnableFlow(OWNER);
      await expect(flow.awaitEnabled()).rejects.toThrow(/different identity/);
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(false);
    });

    it('drops a cancelled flow even if the signer approves later', async () => {
      const flow = await PaykitMessagingService.beginEnableFlow(OWNER);
      flow.cancel();
      await expect(flow.awaitEnabled()).rejects.toThrow(/cancelled/);
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(false);
    });

    it('reuses the persisted receiver key on re-enable (fresh key would orphan every link)', async () => {
      await enableMessaging(world);
      const first = await LocalMessagingService.getReceiver(OWNER);
      PaykitMessagingService.clearSession();
      await enableMessaging(world);
      const second = await LocalMessagingService.getReceiver(OWNER);
      expect(second?.noise_secret).toEqual(first?.noise_secret);
    });

    it('requires a session for link operations and clears it on teardown', async () => {
      await enableMessaging(world);
      PaykitMessagingService.clearSession();
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(false);
      await expect(PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY)).rejects.toThrow(
        /No active messaging session/,
      );
    });
  });

  describe('link establishment state machine', () => {
    beforeEach(async () => {
      await enableMessaging(world);
    });

    it('reports not-enrolled when the counterparty has no marker, and starts nothing', async () => {
      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
      expect(state).toEqual({ status: 'not-enrolled' });
      expect(world.calls).not.toContain('initiateEncryptedLink');
      expect(world.calls).not.toContain('acceptEncryptedLink');
    });

    it('initiates toward an enrolled counterparty and persists the handshaking row', async () => {
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });

      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'handshaking', role: 'initiator' });
      expect(world.calls).toContain('initiateEncryptedLink');
      const row = await LocalMessagingService.getLink(OWNER, COUNTERPARTY);
      expect(row).toMatchObject({
        role: 'initiator',
        status: 'handshaking',
        remote_noise_public_key: 'p'.repeat(52),
        local_receiver_path: 'marketplace/wallet',
        remote_receiver_path: 'marketplace/wallet',
      });
    });

    it('completes the handshake on a later poll and flips the row to established', async () => {
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      world.advanceScript.push('complete');
      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'ready' });
      const row = await LocalMessagingService.getLink(OWNER, COUNTERPARTY);
      expect(row?.status).toBe('established');
    });

    it('adopts a queued inbound handshake instead of initiating (responder role)', async () => {
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });
      world.inboundFrom.add(COUNTERPARTY);

      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'handshaking', role: 'responder' });
      expect(world.calls).toContain('acceptEncryptedLink');
      expect(world.calls).not.toContain('initiateEncryptedLink');
      const row = await LocalMessagingService.getLink(OWNER, COUNTERPARTY);
      expect(row?.role).toBe('responder');
    });

    it('probeCounterparty never initiates: no state plus no inbound stays none', async () => {
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });

      const state = await PaykitMessagingService.probeCounterparty(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'none' });
      expect(world.calls).toContain('acceptEncryptedLink');
      expect(world.calls).not.toContain('initiateEncryptedLink');
      await expect(LocalMessagingService.getLink(OWNER, COUNTERPARTY)).resolves.toBeNull();
    });

    it('resumes a mid-handshake snapshot after a reload when the counterparty key is unchanged', async () => {
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      // Simulate a reload mid-handshake: in-memory handles die, the Dexie row survives.
      PaykitMessagingService.clearSession();
      await enableMessaging(world);
      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'handshaking', role: 'initiator' });
      expect(world.calls).toContain('restoreEncryptedLinkHandshake');
      expect(world.calls).not.toContain('clearEncryptedLinkOutbox');
    });

    describe('recovery never deletes link state', () => {
      const P_KEY = 'p'.repeat(52);
      const Q_KEY = 'q'.repeat(52);

      async function reloadMidHandshake() {
        world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: P_KEY });
        await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
        const before = await LocalMessagingService.getLink(OWNER, COUNTERPARTY);
        PaykitMessagingService.clearSession();
        await enableMessaging(world);
        world.calls = [];
        return before!;
      }

      async function expectRowKept(before: NonNullable<Awaited<ReturnType<typeof LocalMessagingService.getLink>>>) {
        const row = await LocalMessagingService.getLink(OWNER, COUNTERPARTY);
        expect(row).toMatchObject({
          role: before.role,
          status: before.status,
          local_receiver_path: before.local_receiver_path,
          remote_receiver_path: before.remote_receiver_path,
          remote_noise_public_key: before.remote_noise_public_key,
        });
        expect([...(row?.snapshot ?? [])]).toEqual([...before.snapshot]);
      }

      function expectNothingDestroyed() {
        for (const call of [
          'clearEncryptedLinkOutbox',
          'initiateEncryptedLink',
          'generateNoiseSecretKey',
          'publishReceiverMarker',
          'removeReceiverMarker',
        ]) {
          expect(world.calls).not.toContain(call);
        }
      }

      it('advances the kept handshake first, then holds the pair for the changed key without deleting anything', async () => {
        const before = await reloadMidHandshake();
        world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: Q_KEY });

        const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

        expect(state).toEqual({ status: 'key-changed', pinnedKey: P_KEY, observedKey: Q_KEY });
        await expect(LocalMessagingService.getPeerKeyPin(OWNER, COUNTERPARTY)).resolves.toMatchObject({
          pinnedKey: P_KEY,
          observedKey: Q_KEY,
        });
        expect(world.calls.indexOf('restoreEncryptedLinkHandshake')).toBeGreaterThanOrEqual(0);
        expect(world.calls.indexOf('handshake.advance:initiator')).toBeGreaterThan(
          world.calls.indexOf('restoreEncryptedLinkHandshake'),
        );
        expectNothingDestroyed();
        await expectRowKept(before);
      });

      it('completes a kept handshake the original peer device answers, even while another key is published', async () => {
        await reloadMidHandshake();
        world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: Q_KEY });
        world.advanceScript.push('complete');

        const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

        expect(state).toEqual({ status: 'ready' });
        await expect(LocalMessagingService.getLink(OWNER, COUNTERPARTY)).resolves.toMatchObject({
          status: 'established',
        });
        expectNothingDestroyed();
      });

      it('inbox sync reports the same key change and starts nothing', async () => {
        const before = await reloadMidHandshake();
        world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: Q_KEY });

        const state = await PaykitMessagingService.probeCounterparty(OWNER, COUNTERPARTY);

        expect(state).toEqual({ status: 'key-changed', pinnedKey: P_KEY, observedKey: Q_KEY });
        expect(world.calls).not.toContain('acceptEncryptedLink');
        expectNothingDestroyed();
        await expectRowKept(before);
      });

      it('resumes the kept handshake on its next spaced attempt once it can complete', async () => {
        await reloadMidHandshake();
        world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: Q_KEY });
        await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

        world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: P_KEY });
        world.advanceScript.push('complete');
        advanceClock(MESSAGING_RETRY_POLICY.baseMs);
        const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

        expect(state).toEqual({ status: 'ready' });
        expect(world.calls.filter((call) => call === 'restoreEncryptedLinkHandshake')).toHaveLength(2);
        expectNothingDestroyed();
      });

      it('keeps the handshake row and the remote outbox when a snapshot restore fails, then retries it once due', async () => {
        const before = await reloadMidHandshake();
        world.restoreHandshakeFailures = 1;

        const failed = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

        expect(failed).toEqual({ status: 'recovery-needed', reason: 'handshake-restore-failed' });
        expectNothingDestroyed();
        await expectRowKept(before);

        advanceClock(POLL_MS);
        await expect(PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY)).resolves.toEqual(failed);
        expect(world.calls.filter((call) => call === 'restoreEncryptedLinkHandshake')).toHaveLength(1);

        advanceClock(MESSAGING_RETRY_POLICY.baseMs);
        const retried = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

        expect(retried).toEqual({ status: 'handshaking', role: 'initiator' });
        expect(world.calls.filter((call) => call === 'restoreEncryptedLinkHandshake')).toHaveLength(2);
        expectNothingDestroyed();
      });

      it('keeps an established link row whose snapshot fails to restore, and retries it on the backoff', async () => {
        world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: P_KEY });
        await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
        world.advanceScript.push('complete');
        await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
        const before = await reloadMidHandshake().then(() => LocalMessagingService.getLink(OWNER, COUNTERPARTY));
        world.restoreLinkFailures = 1;

        const failed = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
        advanceClock(POLL_MS);
        const waiting = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
        advanceClock(MESSAGING_RETRY_POLICY.baseMs);
        const restored = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

        expect(failed).toEqual({ status: 'recovery-needed', reason: 'link-restore-failed' });
        expect(waiting).toEqual(failed);
        expect(restored).toEqual({ status: 'ready' });
        expect(world.calls.filter((call) => call === 'restoreEncryptedLink')).toHaveLength(2);
        await expect(LocalMessagingService.getLink(OWNER, COUNTERPARTY)).resolves.toMatchObject({
          status: 'established',
          snapshot: before!.snapshot,
        });
        expectNothingDestroyed();
      });

      it('spaces a failed handshake step instead of re-restoring it on every poll', async () => {
        world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: P_KEY });
        await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
        world.advanceScript.push('error');
        world.calls = [];

        const failed = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
        advanceClock(POLL_MS);
        await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

        expect(failed).toEqual({ status: 'handshaking', role: 'initiator' });
        expect(world.calls.filter((call) => call.startsWith('handshake.advance'))).toHaveLength(1);
        expect(world.calls).not.toContain('restoreEncryptedLinkHandshake');

        advanceClock(MESSAGING_RETRY_POLICY.baseMs);
        await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
        expect(world.calls).toContain('restoreEncryptedLinkHandshake');
      });
    });

    describe('recovery retries are spaced, capped, and never crowd out healthy links', () => {
      const P_KEY = 'p'.repeat(52);
      const Q_KEY = 'q'.repeat(52);
      const THIRTY_MINUTES = 30 * 60_000;
      // Worst case with the minimum jitter: attempts at 0, 2.5 s, 7.5 s, ... then
      // every 300 s once the 600 s ceiling applies — 12 inside 30 minutes.
      const MAX_ATTEMPTS_IN_THIRTY_MINUTES = 12;

      function attemptTimes(times: number[]) {
        return times.slice(1).map((time, index) => time - times[index]);
      }

      it.each([
        [
          'key-changed',
          () => world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: Q_KEY }),
          { status: 'key-changed', pinnedKey: P_KEY, observedKey: Q_KEY },
          // A held pair is re-checked by reading the marker again.
          `getReceiverMarker:${COUNTERPARTY.slice(0, 4)}`,
        ],
        [
          'handshake-restore-failed',
          () => (world.restoreHandshakeFailures = Number.POSITIVE_INFINITY),
          { status: 'recovery-needed', reason: 'handshake-restore-failed' },
          'restoreEncryptedLinkHandshake',
        ],
      ] as const)(
        'an open conversation polled every 2 s retries a %s link on a capped exponential schedule',
        async (_label, breakLink, expected, attemptCall) => {
          vi.spyOn(Math, 'random').mockReturnValue(0);
          world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: P_KEY });
          await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
          PaykitMessagingService.clearSession();
          await enableMessaging(world);
          breakLink();
          world.calls = [];

          const start = Date.now();
          const attempts: number[] = [];
          for (let elapsed = 0; elapsed <= THIRTY_MINUTES; elapsed += POLL_MS) {
            const before = world.calls.filter((call) => call === attemptCall).length;
            const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
            expect(state).toEqual(expected);
            if (world.calls.filter((call) => call === attemptCall).length > before) {
              attempts.push(Date.now() - start);
            }
            advanceClock(POLL_MS);
          }

          expect(attempts.length).toBeGreaterThanOrEqual(8);
          expect(attempts.length).toBeLessThanOrEqual(MAX_ATTEMPTS_IN_THIRTY_MINUTES);
          const gaps = attemptTimes(attempts);
          for (const [index, gap] of gaps.entries()) {
            expect(gap).toBeGreaterThanOrEqual(MESSAGING_RETRY_POLICY.baseMs / 2);
            expect(gap).toBeLessThanOrEqual(MESSAGING_RETRY_POLICY.maxMs + POLL_MS);
            if (index > 0) expect(gap).toBeGreaterThanOrEqual(gaps[index - 1]);
          }
          const markerReads = world.calls.filter((call) => call.startsWith('getReceiverMarker')).length;
          expect(markerReads).toBeLessThanOrEqual(2 * MAX_ATTEMPTS_IN_THIRTY_MINUTES);
        },
      );

      it('inbox sync over 25 recovering pairs runs at most 3 due retries per pass and still drains a healthy link every pass', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const recovering = Array.from({ length: 25 }, (_, index) =>
          `r${String(index).padStart(2, '0')}`.padEnd(52, 'x'),
        );
        const HEALTHY = 'h'.repeat(52);
        for (const counterparty of [...recovering, HEALTHY]) {
          world.markers.set(counterparty, { receiverPath: 'marketplace/wallet', noisePublicKey: P_KEY });
          await PaykitMessagingService.ensureLink(OWNER, counterparty);
        }
        world.advanceScript.push('complete');
        await PaykitMessagingService.ensureLink(OWNER, HEALTHY);
        PaykitMessagingService.clearSession();
        await enableMessaging(world);
        for (const counterparty of recovering) {
          world.markers.set(counterparty, { receiverPath: 'marketplace/wallet', noisePublicKey: Q_KEY });
        }
        world.calls = [];

        const FIVE_MINUTES = 5 * 60_000;
        const restoresPerPass: number[] = [];
        const markerReadsPerPass: number[] = [];
        const receivesPerPass: number[] = [];
        const recoveringMarkerReads = () => world.calls.filter((call) => call.startsWith('getReceiverMarker:r')).length;
        for (let elapsed = 0; elapsed <= FIVE_MINUTES; elapsed += POLL_MS) {
          const restoresBefore = world.calls.filter((call) => call === 'restoreEncryptedLinkHandshake').length;
          const receivesBefore = world.calls.filter((call) => call === 'link.receive').length;
          const markerReadsBefore = recoveringMarkerReads();
          await MessagingApplication.syncCounterparties(OWNER, [...recovering, HEALTHY], { policy: ADMIT_ALL_POLICY });
          restoresPerPass.push(
            world.calls.filter((call) => call === 'restoreEncryptedLinkHandshake').length - restoresBefore,
          );
          markerReadsPerPass.push(recoveringMarkerReads() - markerReadsBefore);
          receivesPerPass.push(world.calls.filter((call) => call === 'link.receive').length - receivesBefore);
          advanceClock(POLL_MS);
        }

        // The first pass after a reload knows no failures yet, so recovering pairs
        // share the healthy budget once — behind the established link.
        expect(restoresPerPass[0]).toBeLessThanOrEqual(25);
        expect(Math.max(...restoresPerPass.slice(1))).toBeLessThanOrEqual(3);
        // Each retry reads the counterparty marker at most twice (crossed-handshake probe, key check).
        expect(Math.max(...markerReadsPerPass.slice(1))).toBeLessThanOrEqual(2 * 3);
        // At most 7 spaced attempts per pair fit in 5 minutes (0, 4, 10, 20, 40, 80, 160 s).
        expect(markerReadsPerPass.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(2 * 25 * 7);
        const total = restoresPerPass.reduce((sum, count) => sum + count, 0);
        expect(total).toBeLessThanOrEqual(25 * 7);
        expect(receivesPerPass.every((count) => count === 1)).toBe(true);
      }, 60_000);
    });

    it('restores an established link from the persisted snapshot after a reload', async () => {
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
      world.advanceScript.push('complete');
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      // Simulate a reload: in-memory handles die, Dexie rows survive.
      PaykitMessagingService.clearSession();
      await enableMessaging(world);
      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'ready' });
      expect(world.calls).toContain('restoreEncryptedLink');
    });
  });

  describe('counterparty receiver marker reads', () => {
    const P_KEY = 'p'.repeat(52);
    const OTHER = 'h'.repeat(52);
    let sleeps: number[];

    beforeEach(async () => {
      await enableMessaging(world);
      sleeps = [];
      PaykitMessagingService.setMarkerReadSleepForTests(async (ms) => {
        sleeps.push(ms);
      });
    });

    afterEach(() => {
      PaykitMessagingService.setMarkerReadSleepForTests(null);
    });

    const markerReads = (pubky: string) =>
      world.calls.filter((call) => call === `getReceiverMarker:${pubky.slice(0, 4)}`);

    it('reports an unreachable counterparty as a state, never as the raw binding error', async () => {
      world.markerReadFailures.set(COUNTERPARTY, { message: RAW_MARKER_TRANSPORT_ERROR, remaining: Infinity });

      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'unreachable', reason: 'unreachable' });
      expect(world.calls).not.toContain('initiateEncryptedLink');
    });

    it('retries a transient read failure a bounded number of times, then stops', async () => {
      world.markerReadFailures.set(COUNTERPARTY, { message: RAW_MARKER_TRANSPORT_ERROR, remaining: Infinity });

      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(markerReads(COUNTERPARTY)).toHaveLength(3);
      expect(sleeps).toEqual([300, 900]);
    });

    it('recovers within a single call when the second read succeeds', async () => {
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: P_KEY });
      world.markerReadFailures.set(COUNTERPARTY, { message: RAW_MARKER_TRANSPORT_ERROR, remaining: 1 });

      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'handshaking', role: 'initiator' });
      // Two reads to discover the counterparty, one more for the initiator's crossed-handshake probe.
      expect(markerReads(COUNTERPARTY)).toHaveLength(3);
      expect(sleeps).toEqual([300]);
    });

    it('keeps an unreachable pair off the network until its backoff is due, then tries again', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      world.markerReadFailures.set(COUNTERPARTY, { message: RAW_MARKER_TRANSPORT_ERROR, remaining: Infinity });
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
      const readsAfterFirst = markerReads(COUNTERPARTY).length;

      advanceClock(POLL_MS);
      const waiting = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
      expect(waiting).toEqual({ status: 'unreachable', reason: 'unreachable' });
      expect(markerReads(COUNTERPARTY)).toHaveLength(readsAfterFirst);
      expect(PaykitMessagingService.linkRetryStatus(OWNER, COUNTERPARTY)).toBe('waiting');

      advanceClock(MESSAGING_RETRY_POLICY.baseMs);
      world.markerReadFailures.delete(COUNTERPARTY);
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: P_KEY });
      const recovered = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
      expect(recovered).toEqual({ status: 'handshaking', role: 'initiator' });
    });

    it('treats a genuinely absent marker as not-enrolled with one read and no retry', async () => {
      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'not-enrolled' });
      expect(markerReads(COUNTERPARTY)).toHaveLength(1);
      expect(sleeps).toEqual([]);
      expect(PaykitMessagingService.linkRetryStatus(OWNER, COUNTERPARTY)).toBe('none');
    });

    it('does not retry a marker whose content is unusable, and reports it apart from unreachable', async () => {
      world.markerReadFailures.set(COUNTERPARTY, { message: RAW_MARKER_INVALID_DATA_ERROR, remaining: Infinity });

      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'unreachable', reason: 'unreadable' });
      expect(markerReads(COUNTERPARTY)).toHaveLength(1);
      expect(sleeps).toEqual([]);
    });

    it('rethrows a rejection that is not a marker read failure', async () => {
      world.markerReadFailures.set(COUNTERPARTY, { message: 'something else entirely', remaining: Infinity });

      await expect(PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY)).rejects.toThrow('something else entirely');
    });

    it('inbox sync skips an unreachable counterparty and still drains a healthy one', async () => {
      world.markerReadFailures.set(COUNTERPARTY, { message: RAW_MARKER_TRANSPORT_ERROR, remaining: Infinity });
      world.markers.set(OTHER, { receiverPath: 'marketplace/wallet', noisePublicKey: P_KEY });
      world.inboundFrom.add(OTHER);
      world.responderCompletes.add(OTHER);

      await expect(
        MessagingApplication.syncCounterparties(OWNER, [COUNTERPARTY, OTHER], { policy: ADMIT_ALL_POLICY }),
      ).resolves.toBeUndefined();

      expect(await LocalMessagingService.getLink(OWNER, OTHER)).toMatchObject({ status: 'established' });
      expect(PaykitMessagingService.linkRetryStatus(OWNER, COUNTERPARTY)).toBe('waiting');
    });

    it('a repeated inbox sync does not re-read an unreachable counterparty before its backoff is due', async () => {
      world.markerReadFailures.set(COUNTERPARTY, { message: RAW_MARKER_TRANSPORT_ERROR, remaining: Infinity });
      await MessagingApplication.syncCounterparties(OWNER, [COUNTERPARTY], { policy: ADMIT_ALL_POLICY });
      const reads = markerReads(COUNTERPARTY).length;

      advanceClock(POLL_MS);
      await MessagingApplication.syncCounterparties(OWNER, [COUNTERPARTY], { policy: ADMIT_ALL_POLICY });

      expect(markerReads(COUNTERPARTY)).toHaveLength(reads);
    });

    it('a public marker lookup fails with a marker read failure, not the binding text', async () => {
      world.markerReadFailures.set(COUNTERPARTY, { message: RAW_MARKER_TRANSPORT_ERROR, remaining: Infinity });

      await expect(PaykitMessagingService.getCounterpartyMarker(COUNTERPARTY)).rejects.toMatchObject({
        name: 'MarkerReadFailure',
        reason: 'unreachable',
        message: 'The messaging setup of this account could not be reached.',
      });
    });

    it('a crossed-handshake probe that cannot read the marker leaves the pending handshake pending', async () => {
      // OWNER ('a…') < COUNTERPARTY ('z…'): the owner is the side that probes for a crossed handshake.
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: P_KEY });
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
      world.markerReadFailures.set(COUNTERPARTY, { message: RAW_MARKER_TRANSPORT_ERROR, remaining: Infinity });
      advanceClock(POLL_MS);

      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'handshaking', role: 'initiator' });
    });

    describe('a surface someone is looking at restarts the backoff', () => {
      /** Five spaced failed attempts (minimum jitter): the next one waits 40 s. */
      async function backOffFiveTimes(counterparty: string) {
        world.markerReadFailures.set(counterparty, { message: RAW_MARKER_TRANSPORT_ERROR, remaining: Infinity });
        for (let failure = 1; failure <= 5; failure += 1) {
          if (failure > 1) advanceClock((MESSAGING_RETRY_POLICY.baseMs * 2 ** (failure - 2)) / 2);
          await expect(PaykitMessagingService.ensureLink(OWNER, counterparty)).resolves.toEqual({
            status: 'unreachable',
            reason: 'unreachable',
          });
        }
      }

      beforeEach(() => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
      });

      it('without a restart (hidden page) the pair keeps waiting out its backoff', async () => {
        await backOffFiveTimes(COUNTERPARTY);
        const reads = markerReads(COUNTERPARTY).length;

        for (let elapsed = POLL_MS; elapsed < 40_000; elapsed += POLL_MS) {
          advanceClock(POLL_MS);
          await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
        }

        expect(markerReads(COUNTERPARTY)).toHaveLength(reads);
        expect(PaykitMessagingService.linkRetryStatus(OWNER, COUNTERPARTY)).toBe('waiting');
      });

      it('a restart retries the pair on the next poll and delivers once the marker reads again', async () => {
        await backOffFiveTimes(COUNTERPARTY);
        world.markerReadFailures.delete(COUNTERPARTY);
        world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: P_KEY });
        advanceClock(POLL_MS);
        expect(PaykitMessagingService.linkRetryStatus(OWNER, COUNTERPARTY)).toBe('waiting');

        MessagingApplication.restartRetries(OWNER, COUNTERPARTY);

        expect(PaykitMessagingService.linkRetryStatus(OWNER, COUNTERPARTY)).toBe('due');
        await expect(PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY)).resolves.toEqual({
          status: 'handshaking',
          role: 'initiator',
        });
        expect(PaykitMessagingService.linkRetryStatus(OWNER, COUNTERPARTY)).toBe('none');
      });

      it('a restarted pair that fails again waits the first delay, not the escalated one', async () => {
        await backOffFiveTimes(COUNTERPARTY);
        MessagingApplication.restartRetries(OWNER, COUNTERPARTY);
        const reads = markerReads(COUNTERPARTY).length;

        await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
        expect(markerReads(COUNTERPARTY).length).toBeGreaterThan(reads);
        const afterRetry = markerReads(COUNTERPARTY).length;

        advanceClock(POLL_MS);
        await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
        expect(markerReads(COUNTERPARTY)).toHaveLength(afterRetry);
        advanceClock(MESSAGING_RETRY_POLICY.baseMs / 2 - POLL_MS);
        await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
        expect(markerReads(COUNTERPARTY).length).toBeGreaterThan(afterRetry);
      });

      it('a conversation restart touches only its pair; an inbox restart covers every pair of the account', async () => {
        await backOffFiveTimes(COUNTERPARTY);
        await backOffFiveTimes(OTHER);

        MessagingApplication.restartRetries(OWNER, COUNTERPARTY);
        expect(PaykitMessagingService.linkRetryStatus(OWNER, COUNTERPARTY)).toBe('due');
        expect(PaykitMessagingService.linkRetryStatus(OWNER, OTHER)).toBe('waiting');

        MessagingApplication.restartRetries(OWNER);
        expect(PaykitMessagingService.linkRetryStatus(OWNER, OTHER)).toBe('due');
      });

      it('inbox sync keeps restarted pairs in the recovery budget of 3 per pass, behind healthy links', async () => {
        const recovering = Array.from({ length: 5 }, (_, index) => `r${index}`.padEnd(52, 'x'));
        for (const counterparty of recovering) await backOffFiveTimes(counterparty);
        world.markers.set(OTHER, { receiverPath: 'marketplace/wallet', noisePublicKey: P_KEY });
        world.inboundFrom.add(OTHER);
        world.responderCompletes.add(OTHER);
        MessagingApplication.restartRetries(OWNER);
        world.calls = [];

        await MessagingApplication.syncCounterparties(OWNER, [...recovering, OTHER], { policy: ADMIT_ALL_POLICY });

        const retried = recovering.filter((pubky) => markerReads(pubky).length > 0);
        expect(retried).toHaveLength(3);
        expect(await LocalMessagingService.getLink(OWNER, OTHER)).toMatchObject({ status: 'established' });
        const firstRecoveryRead = world.calls.findIndex((call) => call.startsWith('getReceiverMarker:r'));
        const healthyRead = world.calls.findIndex((call) => call === `getReceiverMarker:${OTHER.slice(0, 4)}`);
        expect(healthyRead).toBeLessThan(firstRecoveryRead);
      });

      describe('restarted queued-message flushes', () => {
        async function establishWithFailedFlush(counterparty: string) {
          world.markers.set(counterparty, { receiverPath: 'marketplace/wallet', noisePublicKey: P_KEY });
          await PaykitMessagingService.ensureLink(OWNER, counterparty);
          world.advanceScript.push('complete');
          await expect(PaykitMessagingService.ensureLink(OWNER, counterparty)).resolves.toEqual({ status: 'ready' });
          await LocalMessagingService.enqueueOutboxMessage({
            id: crypto.randomUUID(),
            owner_pubky: OWNER,
            counterparty_pubky: counterparty,
            kind: 'dm',
            conversation_id: null,
            listing_ref: null,
            body: `queued for ${counterparty.slice(0, 2)}`,
            queued_at: Date.now(),
            attempts: 0,
            last_attempt_at: null,
            last_error: null,
          });
          world.sendFailures = 1;
          await expect(MessagingApplication.flushOutbox(OWNER, counterparty, ADMIT_ALL_POLICY)).resolves.toEqual({
            delivered: 0,
            remaining: 1,
          });
        }
        const callIndexes = (name: string) => world.calls.flatMap((call, index) => (call === name ? [index] : []));

        it('inbox sync runs at most 3 restarted flushes per pass, after every ready link has received', async () => {
          const pairs = Array.from({ length: 5 }, (_, index) => `d${index}`.padEnd(52, 'x'));
          for (const counterparty of pairs) await establishWithFailedFlush(counterparty);
          MessagingApplication.restartRetries(OWNER);
          world.calls = [];

          await MessagingApplication.syncCounterparties(OWNER, pairs, { policy: ADMIT_ALL_POLICY });

          const sends = callIndexes('link.send');
          const receives = callIndexes('link.receive');
          expect(sends).toHaveLength(3);
          expect(receives).toHaveLength(5);
          expect(Math.max(...receives)).toBeLessThan(Math.min(...sends));

          world.calls = [];
          advanceClock(POLL_MS);
          await MessagingApplication.syncCounterparties(OWNER, pairs, { policy: ADMIT_ALL_POLICY });

          expect(callIndexes('link.send')).toHaveLength(2);
          for (const counterparty of pairs) {
            await expect(LocalMessagingService.getQueuedMessages(OWNER, counterparty)).resolves.toEqual([]);
          }
        });

        it('restarted flushes and restarted link retries share the same 3 recovery slots per pass', async () => {
          const flushing = Array.from({ length: 4 }, (_, index) => `f${index}`.padEnd(52, 'x'));
          const recovering = Array.from({ length: 2 }, (_, index) => `r${index}`.padEnd(52, 'x'));
          for (const counterparty of flushing) await establishWithFailedFlush(counterparty);
          for (const counterparty of recovering) await backOffFiveTimes(counterparty);
          MessagingApplication.restartRetries(OWNER);
          world.calls = [];

          await MessagingApplication.syncCounterparties(OWNER, [...flushing, ...recovering], {
            policy: ADMIT_ALL_POLICY,
          });

          const linkRetried = recovering.filter((pubky) => markerReads(pubky).length > 0);
          expect(callIndexes('link.send').length + linkRetried.length).toBe(3);
          expect(callIndexes('link.send')).toHaveLength(2);
          expect(linkRetried).toHaveLength(1);
          expect(callIndexes('link.receive')).toHaveLength(4);
        });
      });

      it('a restart with nothing backing off changes nothing and makes no request', async () => {
        world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: P_KEY });
        await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
        const calls = [...world.calls];

        MessagingApplication.restartRetries(OWNER, COUNTERPARTY);
        MessagingApplication.restartRetries(OWNER);

        expect(world.calls).toEqual(calls);
        expect(PaykitMessagingService.linkRetryStatus(OWNER, COUNTERPARTY)).toBe('none');
      });
    });
  });

  describe('send/receive mapping and persistence ordering', () => {
    beforeEach(async () => {
      await enableMessaging(world);
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });
      world.advanceScript.push('complete');
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
    });

    it('sends a valid envelope and persists the sent row plus a fresh snapshot', async () => {
      const message = await PaykitMessagingService.sendChatMessage(OWNER, COUNTERPARTY, {
        conversationId: CONVERSATION_ID,
        listingRef: LISTING_REF,
        body: 'Is this still available?',
      });

      const link = world.links.at(-1)!;
      expect(link.sent).toHaveLength(1);
      expect(JSON.parse(link.sent[0])).toMatchObject({
        version: 1,
        kind: 'marketplace.chat_message.v0',
        conversation_id: CONVERSATION_ID,
        listing_ref: LISTING_REF,
        body: 'Is this still available?',
      });
      expect(typeof JSON.parse(link.sent[0]).sent_at).toBe('number');

      const rows = await LocalMessagingService.getMessages(OWNER, CONVERSATION_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        direction: 'sent',
        body: 'Is this still available?',
        id: `${OWNER}:${message.event_id}`,
      });

      const conversations = await LocalMessagingService.getConversationsByOwner(OWNER);
      expect(conversations).toHaveLength(1);
      expect(conversations[0].counterparty_pubky).toBe(COUNTERPARTY);
    });

    it('rejects an oversize body before anything reaches the link, keeping no row', async () => {
      await expect(
        PaykitMessagingService.sendChatMessage(OWNER, COUNTERPARTY, {
          conversationId: CONVERSATION_ID,
          listingRef: LISTING_REF,
          body: 'a'.repeat(2000),
        }),
      ).rejects.toThrow(/too long/);
      expect(world.links.at(-1)!.sent).toHaveLength(0);
      await expect(LocalMessagingService.getMessages(OWNER, CONVERSATION_ID)).resolves.toHaveLength(0);
    });

    it('persists received chat messages, keeps foreign kinds out of history, and dedupes replays by event id', async () => {
      const eventId = crypto.randomUUID();
      const rawJson = JSON.stringify({
        version: 1,
        kind: 'marketplace.chat_message.v0',
        event_id: eventId,
        conversation_id: CONVERSATION_ID,
        listing_ref: LISTING_REF,
        sent_at: '2026-08-21T10:00:00.000Z',
        body: 'hello from the counterparty',
      });
      const foreign = JSON.stringify({ version: 1, kind: 'paykit.payment_request.v0', amount: 1 });
      const link = world.links.at(-1)!;
      link.inboundQueue.push(
        { version: 1, kind: 'marketplace.chat_message.v0', rawJson },
        { version: 1, kind: 'paykit.payment_request.v0', rawJson: foreign },
      );

      const received = await PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY, ADMIT_ALL_GATE);
      expect(received).toHaveLength(1);
      expect(received[0].body).toBe('hello from the counterparty');
      expect(received[0].sent_at).toBe(Date.parse('2026-08-21T10:00:00.000Z'));

      // Replay the same event (expected after a snapshot restore): no duplicate.
      link.inboundQueue.push({ version: 1, kind: 'marketplace.chat_message.v0', rawJson });
      await PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY, ADMIT_ALL_GATE);

      const rows = await LocalMessagingService.getMessages(OWNER, CONVERSATION_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ direction: 'received', id: `${OWNER}:${eventId}` });
    });

    it('persists received messages BEFORE the advanced link snapshot', async () => {
      const order: string[] = [];
      const insertSpy = vi.spyOn(LocalMessagingService, 'insertReceivedMessage');
      const snapshotSpy = vi.spyOn(LocalMessagingService, 'updateLinkSnapshot');
      insertSpy.mockImplementation(async () => {
        order.push('message');
        return { status: 'inserted' };
      });
      snapshotSpy.mockImplementation(async () => {
        order.push('snapshot');
      });

      world.links.at(-1)!.inboundQueue.push({
        version: 1,
        kind: 'marketplace.chat_message.v0',
        rawJson: JSON.stringify({
          version: 1,
          kind: 'marketplace.chat_message.v0',
          event_id: crypto.randomUUID(),
          conversation_id: CONVERSATION_ID,
          listing_ref: LISTING_REF,
          sent_at: '2026-08-21T10:00:00.000Z',
          body: 'ordering matters',
        }),
      });

      await PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY, ADMIT_ALL_GATE);
      expect(order).toEqual(['message', 'snapshot']);
    });

    describe('events this build cannot interpret', () => {
      const payment = JSON.stringify({ version: 1, kind: 'paykit.private_payment_list.v0', endpoints: ['secret-ish'] });
      const futureChat = JSON.stringify({
        version: 2,
        kind: 'marketplace.chat_message.v0',
        event_id: crypto.randomUUID(),
        conversation_id: CONVERSATION_ID,
        listing_ref: LISTING_REF,
        sent_at: 1_787_565_600_000,
        body: 'from a newer client',
      });

      it('stores them, sealed at rest, before the advanced snapshot, and keeps them out of history', async () => {
        const order: string[] = [];
        const store = LocalMessagingService.storeUnprocessed.bind(LocalMessagingService);
        vi.spyOn(LocalMessagingService, 'storeUnprocessed').mockImplementation(async (event) => {
          order.push('store');
          return await store(event);
        });
        const snapshot = LocalMessagingService.updateLinkSnapshot.bind(LocalMessagingService);
        vi.spyOn(LocalMessagingService, 'updateLinkSnapshot').mockImplementation(async (...args) => {
          order.push('snapshot');
          await snapshot(...args);
        });
        world.links
          .at(-1)!
          .inboundQueue.push(
            { version: 1, kind: 'paykit.private_payment_list.v0', rawJson: payment },
            { version: 2, kind: 'marketplace.chat_message.v0', rawJson: futureChat },
          );

        await expect(PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY, ADMIT_ALL_GATE)).resolves.toEqual([]);

        expect(order).toEqual(['store', 'store', 'snapshot']);
        const stored = await LocalMessagingService.getUnprocessed(OWNER, COUNTERPARTY);
        expect(stored.map(({ kind, version, rawJson }) => ({ kind, version, rawJson }))).toEqual([
          { kind: 'paykit.private_payment_list.v0', version: 1, rawJson: payment },
          { kind: 'marketplace.chat_message.v0', version: 2, rawJson: futureChat },
        ]);
        const rows = await CommerceMessagingUnprocessedModel.table.toArray();
        for (const row of rows) {
          expect(Object.keys(row).sort()).toEqual([
            'counterparty_pubky',
            'id',
            'owner_id',
            'payload',
            'position',
            'received_at',
            'wrap_version',
          ]);
          for (const plaintext of ['secret-ish', 'newer client', 'paykit', 'chat_message']) {
            expect(new TextDecoder().decode(row.payload)).not.toContain(plaintext);
          }
        }
        await expect(LocalMessagingService.getMessages(OWNER, CONVERSATION_ID)).resolves.toEqual([]);
      });

      it('never advances past an event it could not store', async () => {
        const snapshotSpy = vi.spyOn(LocalMessagingService, 'updateLinkSnapshot');
        vi.spyOn(LocalMessagingService, 'storeUnprocessed').mockRejectedValue(new Error('disk full'));
        world.links.at(-1)!.inboundQueue.push({ version: 1, kind: 'paykit.private_payment_list.v0', rawJson: payment });

        await expect(PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY, ADMIT_ALL_GATE)).rejects.toThrow();

        expect(snapshotSpy).not.toHaveBeenCalled();
      });

      it('never advances past one on a database without the table (NEXT_PUBLIC_DB_VERSION below 8)', async () => {
        vi.spyOn(CommerceMessagingUnprocessedModel, 'isAvailable').mockReturnValue(false);
        const snapshotSpy = vi.spyOn(LocalMessagingService, 'updateLinkSnapshot');
        world.links.at(-1)!.inboundQueue.push({ version: 1, kind: 'paykit.private_payment_list.v0', rawJson: payment });

        await expect(PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY, ADMIT_ALL_GATE)).rejects.toThrow(
          /cannot keep messages/,
        );
        expect(snapshotSpy).not.toHaveBeenCalled();
      });

      it('stores a redelivered event once and does not put it to the gate again', async () => {
        const gate = { admit: vi.fn(ADMIT_ALL_GATE.admit) };
        world.links.at(-1)!.inboundQueue.push({ version: 1, kind: 'paykit.private_payment_list.v0', rawJson: payment });
        await PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY, gate);
        world.links.at(-1)!.inboundQueue.push({ version: 1, kind: 'paykit.private_payment_list.v0', rawJson: payment });
        await PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY, gate);

        expect(gate.admit).toHaveBeenCalledOnce();
        await expect(LocalMessagingService.getUnprocessed(OWNER, COUNTERPARTY)).resolves.toHaveLength(1);
      });

      it('stores nothing from a muted person', async () => {
        world.links.at(-1)!.inboundQueue.push({ version: 1, kind: 'paykit.private_payment_list.v0', rawJson: payment });

        await PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY, policyMuting(COUNTERPARTY).gate);

        await expect(LocalMessagingService.getUnprocessed(OWNER, COUNTERPARTY)).resolves.toEqual([]);
      });

      it('keeps them across a restart until a build that understands them processes them', async () => {
        world.links.at(-1)!.inboundQueue.push({ version: 2, kind: 'marketplace.chat_message.v0', rawJson: futureChat });
        await PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY, ADMIT_ALL_GATE);

        // Restart: every in-memory handle is gone and the link restores from its snapshot.
        PaykitMessagingService.clearSession();
        world.cookieResume = 'success';
        await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
        await PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY, ADMIT_ALL_GATE);
        await expect(LocalMessagingService.getUnprocessed(OWNER, COUNTERPARTY)).resolves.toHaveLength(1);

        // A later build learns version 2 of the chat kind.
        const parsed = JSON.parse(futureChat) as { event_id: string; body: string; sent_at: number };
        const later = asOpaque<{ classifyInbound: (item: { rawJson: string }) => unknown }>(PaykitMessagingService);
        const original = later.classifyInbound.bind(PaykitMessagingService);
        vi.spyOn(later, 'classifyInbound').mockImplementation((item: { rawJson: string }, ...rest: unknown[]) =>
          item.rawJson === futureChat
            ? {
                type: 'message',
                message: {
                  kind: 'listing',
                  event_id: parsed.event_id,
                  conversation_id: CONVERSATION_ID,
                  listing_ref: LISTING_REF,
                  sent_at: parsed.sent_at,
                  body: parsed.body,
                  counterpartyPubky: COUNTERPARTY,
                },
              }
            : (original as (...args: unknown[]) => unknown)(item, ...rest),
        );

        const received = await PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY, ADMIT_ALL_GATE);

        expect(received.map((message) => message.body)).toEqual(['from a newer client']);
        await expect(LocalMessagingService.getMessages(OWNER, CONVERSATION_ID)).resolves.toHaveLength(1);
        await expect(LocalMessagingService.getUnprocessed(OWNER, COUNTERPARTY)).resolves.toEqual([]);
      });
    });

    describe('intake gate', () => {
      const chatRaw = (body: string, eventId = crypto.randomUUID()) => ({
        version: 1,
        kind: 'marketplace.chat_message.v0',
        rawJson: JSON.stringify({
          version: 1,
          kind: 'marketplace.chat_message.v0',
          event_id: eventId,
          conversation_id: CONVERSATION_ID,
          listing_ref: LISTING_REF,
          sent_at: 1_787_565_600_000,
          body,
        }),
      });

      it('stores nothing the gate refuses, yet still advances past it', async () => {
        const snapshotSpy = vi.spyOn(LocalMessagingService, 'updateLinkSnapshot');
        const gate = { admit: vi.fn(async () => ({ store: false as const, reason: 'muted' as const })) };
        world.links.at(-1)!.inboundQueue.push(chatRaw('from a muted person'));

        await expect(PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY, gate)).resolves.toEqual([]);

        expect(gate.admit).toHaveBeenCalledWith({
          counterpartyPubky: COUNTERPARTY,
          kind: 'listing',
          conversationId: CONVERSATION_ID,
        });
        await expect(LocalMessagingService.getMessages(OWNER, CONVERSATION_ID)).resolves.toEqual([]);
        expect(snapshotSpy).toHaveBeenCalledOnce();
        await expect(PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY, ADMIT_ALL_GATE)).resolves.toEqual([]);
      });

      it('files a new thread under the origin the gate decides', async () => {
        await CommerceMessagingConversationModel.clear();
        world.links.at(-1)!.inboundQueue.push(chatRaw('hello stranger'));

        await PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY, {
          admit: async () => ({ store: true, origin: 'request' }),
        });

        await expect(LocalMessagingService.getConversation(OWNER, CONVERSATION_ID)).resolves.toMatchObject({
          origin: 'request',
        });
      });

      it('does not put a redelivered message to the gate again', async () => {
        const eventId = crypto.randomUUID();
        const gate = { admit: vi.fn(ADMIT_ALL_GATE.admit) };
        world.links.at(-1)!.inboundQueue.push(chatRaw('once', eventId));
        await PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY, gate);
        world.links.at(-1)!.inboundQueue.push(chatRaw('once', eventId));
        await PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY, gate);

        expect(gate.admit).toHaveBeenCalledOnce();
      });
    });

    it('sends a DM with the pubky_app.dm.v0 kind into the counterparty-keyed conversation', async () => {
      const message = await PaykitMessagingService.sendDmMessage(OWNER, COUNTERPARTY, { body: 'hi — direct' });

      const link = world.links.at(-1)!;
      expect(link.sent).toHaveLength(1);
      expect(JSON.parse(link.sent[0])).toMatchObject({
        version: 1,
        kind: 'pubky_app.dm.v0',
        body: 'hi — direct',
      });
      expect(typeof JSON.parse(link.sent[0]).sent_at).toBe('number');
      expect(JSON.parse(link.sent[0])).not.toHaveProperty('listing_ref');

      const rows = await LocalMessagingService.getMessages(OWNER, `dm:${COUNTERPARTY}`);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        direction: 'sent',
        listing_ref: null,
        id: `${OWNER}:${message.event_id}`,
      });
      const conversations = await LocalMessagingService.getConversationsByOwner(OWNER);
      expect(conversations.find((row) => row.conversation_id === `dm:${COUNTERPARTY}`)).toMatchObject({
        kind: 'dm',
        listing_ref: null,
      });
    });

    it('routes one inbound drain into BOTH conversations by kind (shared link)', async () => {
      const link = world.links.at(-1)!;
      const chatRaw = JSON.stringify({
        version: 1,
        kind: 'marketplace.chat_message.v0',
        event_id: crypto.randomUUID(),
        conversation_id: CONVERSATION_ID,
        listing_ref: LISTING_REF,
        sent_at: '2026-08-21T10:00:00.000Z',
        body: 'about the listing',
      });
      const dmRaw = JSON.stringify({
        version: 1,
        kind: 'pubky_app.dm.v0',
        event_id: crypto.randomUUID(),
        sent_at: '2026-08-21T10:00:01.000Z',
        body: 'and a personal note',
      });
      link.inboundQueue.push(
        { version: 1, kind: 'marketplace.chat_message.v0', rawJson: chatRaw },
        { version: 1, kind: 'pubky_app.dm.v0', rawJson: dmRaw },
      );

      const received = await PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY, ADMIT_ALL_GATE);

      expect(received.map((entry) => entry.kind)).toEqual(['listing', 'dm']);
      await expect(LocalMessagingService.getMessages(OWNER, CONVERSATION_ID)).resolves.toHaveLength(1);
      await expect(LocalMessagingService.getMessages(OWNER, `dm:${COUNTERPARTY}`)).resolves.toHaveLength(1);
      const conversations = await LocalMessagingService.getConversationsByOwner(OWNER);
      expect(conversations.map((row) => row.kind).sort()).toEqual(['dm', 'listing']);
    });
  });

  // The link authenticates exactly two pubkys: OWNER and the counterparty the
  // handshake was bound to. Here that counterparty is ATTACKER, a contact with
  // a ready link who tries to file text inside OWNER's thread with VICTIM.
  describe('a send counter is never used twice', () => {
    const MARKER = { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) };
    const sendChat = (body: string, eventId?: string) =>
      PaykitMessagingService.sendChatMessage(OWNER, COUNTERPARTY, {
        conversationId: CONVERSATION_ID,
        listingRef: LISTING_REF,
        body,
        eventId,
      });
    const reload = async () => {
      MessagingApplication.clearMessagingSession();
      await enableMessaging(world);
    };
    const expectNoCounterReused = () => expect(new Set(world.sentCounters).size).toBe(world.sentCounters.length);
    const queueChat = async (body: string) => {
      const id = crypto.randomUUID();
      await LocalMessagingService.enqueueOutboxMessage({
        id,
        owner_pubky: OWNER,
        counterparty_pubky: COUNTERPARTY,
        kind: 'chat',
        conversation_id: CONVERSATION_ID,
        listing_ref: LISTING_REF,
        body,
        queued_at: Date.now(),
        attempts: 0,
        last_attempt_at: null,
        last_error: null,
      });
      return id;
    };

    beforeEach(async () => {
      MessagingApplication.clearMessagingSession();
      await CommerceMessagingOutboxModel.clear();
      await enableMessaging(world);
      world.markers.set(COUNTERPARTY, MARKER);
    });

    describe('on an established link', () => {
      beforeEach(async () => {
        world.advanceScript.push('complete');
        await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
      });

      it('revert-fail: defers binding retries until after the pair lock is released', () => {
        expect(world.calls).toContain('handshake.setMaxRecoveryAttempts:0');
        expect(world.calls).toContain('link.setMaxSendRetries:0');
      });

      it('marks the link as sending before the ciphertext leaves, and the saved snapshot clears the mark', async () => {
        const markSendPending = LocalMessagingService.markSendPending.bind(LocalMessagingService);
        vi.spyOn(LocalMessagingService, 'markSendPending').mockImplementation(async (owner, counterparty) => {
          world.calls.push('markSendPending');
          await markSendPending(owner, counterparty);
          const row = await LocalMessagingService.getLink(owner, counterparty);
          world.calls.push(`pending:${String(row?.send_pending)}`);
        });

        await sendChat('first');

        const order = world.calls.filter((call) => ['markSendPending', 'pending:true', 'link.send'].includes(call));
        expect(order).toEqual(['markSendPending', 'pending:true', 'link.send']);
        await expect(LocalMessagingService.getLink(OWNER, COUNTERPARTY)).resolves.toMatchObject({
          send_pending: false,
        });
      });

      it('sends nothing when the mark cannot be written', async () => {
        vi.spyOn(LocalMessagingService, 'markSendPending').mockRejectedValueOnce(new Error('disk full'));

        await expect(sendChat('first')).rejects.toThrow('disk full');

        expect(world.sentCounters).toEqual([]);
        expect(world.calls).not.toContain('link.send');
      });

      it('saves the snapshot after a failed send, so a restore resumes past its counter', async () => {
        world.sendFailures = 1;
        await expect(sendChat('first')).rejects.toThrow(/outbox upload failed/);
        await expect(LocalMessagingService.getLink(OWNER, COUNTERPARTY)).resolves.toMatchObject({
          send_pending: false,
        });

        await reload();
        await expect(PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY)).resolves.toEqual({ status: 'ready' });
        await sendChat('second');

        expect(world.sentCounters).toEqual([0, 1]);
      });

      it('in the same tab, saves the unsaved send before the next send and never reuses its counter', async () => {
        vi.spyOn(LocalMessagingService, 'updateLinkSnapshot').mockRejectedValueOnce(new Error('disk full'));
        await expect(sendChat('first')).rejects.toThrow('disk full');
        await expect(LocalMessagingService.getLink(OWNER, COUNTERPARTY)).resolves.toMatchObject({
          send_pending: true,
        });

        await sendChat('second');
        await expect(LocalMessagingService.getLink(OWNER, COUNTERPARTY)).resolves.toMatchObject({
          send_pending: false,
        });

        await reload();
        await expect(PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY)).resolves.toEqual({ status: 'ready' });
        await sendChat('third');

        expect(world.sentCounters).toEqual([0, 1, 2]);
        expectNoCounterReused();
      });

      it('refuses to send or receive while the unsaved send still cannot be saved', async () => {
        vi.spyOn(LocalMessagingService, 'updateLinkSnapshot')
          .mockRejectedValueOnce(new Error('disk full'))
          .mockRejectedValueOnce(new Error('disk full'))
          .mockRejectedValueOnce(new Error('disk full'))
          .mockRejectedValueOnce(new Error('disk full'));
        await expect(sendChat('first')).rejects.toThrow('disk full');

        await expect(sendChat('second')).rejects.toThrow('disk full');
        await expect(
          PaykitMessagingService.sendDmMessage(OWNER, COUNTERPARTY, { body: 'a direct message' }),
        ).rejects.toThrow('disk full');
        await expect(PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY, ADMIT_ALL_GATE)).rejects.toThrow(
          'disk full',
        );

        expect(world.sentCounters).toEqual([0]);
        expect(world.calls).not.toContain('link.receive');
      });

      it('after a restart, never sends from a snapshot saved before a send finished: the counter cannot be reused', async () => {
        vi.spyOn(LocalMessagingService, 'updateLinkSnapshot').mockRejectedValueOnce(new Error('disk full'));
        await expect(sendChat('first')).rejects.toThrow('disk full');
        const queuedId = await queueChat('queued before the restart');

        await reload();
        const restoresBefore = world.calls.filter((call) => call === 'restoreEncryptedLink').length;
        await expect(PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY)).resolves.toEqual({
          status: 'recovery-needed',
          reason: 'send-state-unknown',
        });
        await expect(sendChat('second')).rejects.toThrow();
        const flushed = await MessagingApplication.flushOutbox(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY);

        expect(flushed).toEqual({ delivered: 0, remaining: 1 });
        expect(world.calls.filter((call) => call === 'restoreEncryptedLink')).toHaveLength(restoresBefore);
        expect(world.sentCounters).toEqual([0]);
        expectNoCounterReused();
        // Nothing is deleted: the link row and the queued message stay.
        await expect(LocalMessagingService.getLink(OWNER, COUNTERPARTY)).resolves.toMatchObject({
          status: 'established',
          send_pending: true,
        });
        const queued = await LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY);
        expect(queued.map((row) => row.id)).toEqual([queuedId]);
      });

      it('a failed queued send waits its backoff until the conversation restarts it', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        await queueChat('queued');
        const sends = () => world.calls.filter((call) => call === 'link.send').length;
        const before = sends();
        world.sendFailures = 1;
        await expect(MessagingApplication.flushOutbox(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY)).resolves.toEqual({
          delivered: 0,
          remaining: 1,
        });

        advanceClock(POLL_MS);
        await expect(MessagingApplication.flushOutbox(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY)).resolves.toEqual({
          delivered: 0,
          remaining: 1,
        });
        expect(sends() - before).toBe(1);

        MessagingApplication.restartRetries(OWNER, COUNTERPARTY);
        await expect(MessagingApplication.flushOutbox(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY)).resolves.toEqual({
          delivered: 1,
          remaining: 0,
        });
        expect(sends() - before).toBe(2);
      });

      it('a queued send whose snapshot is not saved stays queued, and its retry uses the next counter', async () => {
        const queuedId = await queueChat('queued');
        vi.spyOn(LocalMessagingService, 'updateLinkSnapshot').mockRejectedValueOnce(new Error('disk full'));

        await expect(MessagingApplication.flushOutbox(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY)).resolves.toEqual({
          delivered: 0,
          remaining: 1,
        });

        advanceClock(MESSAGING_RETRY_POLICY.maxMs);
        await expect(MessagingApplication.flushOutbox(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY)).resolves.toEqual({
          delivered: 1,
          remaining: 0,
        });

        const link = world.links.at(-1)!;
        expect(link.sent.map((json) => JSON.parse(json).event_id)).toEqual([queuedId, queuedId]);
        expect(world.sentCounters).toEqual([0, 1]);
        expectNoCounterReused();
        await expect(LocalMessagingService.getLink(OWNER, COUNTERPARTY)).resolves.toMatchObject({
          send_pending: false,
        });
      });

      it('a sign-in waits for a receive the signed-out session still holds, then keeps its new handle', async () => {
        let release!: () => void;
        world.receiveHold = new Promise<void>((resolve) => {
          release = resolve;
        });
        world.receiveFailures = 1;
        const heldReceive = PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY, ADMIT_ALL_GATE);
        await vi.waitFor(() => expect(world.calls).toContain('link.receive'));

        await reload();
        const restoresBefore = world.calls.filter((call) => call === 'restoreEncryptedLink').length;
        let signedInReady = false;
        const signedIn = PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY).then((state) => {
          signedInReady = true;
          return state;
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(signedInReady).toBe(false);
        expect(world.calls.filter((call) => call === 'restoreEncryptedLink')).toHaveLength(restoresBefore);

        world.receiveHold = null;
        release();
        await expect(heldReceive).rejects.toThrow(/outbox read failed/);
        await expect(signedIn).resolves.toEqual({ status: 'ready' });
        const replacement = world.links.at(-1)!;

        await sendChat('after sign-in');
        expect(replacement.sent).toHaveLength(1);
        expect(replacement.closed).toBe(false);
      });
    });

    it('registers a completed handshake only after its snapshot is saved', async () => {
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
      world.advanceScript.push('complete');
      vi.spyOn(LocalMessagingService, 'updateLinkSnapshot').mockRejectedValueOnce(new Error('disk full'));

      await expect(PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY)).resolves.toEqual({
        status: 'handshaking',
        role: 'initiator',
      });
      const unsaved = world.links.at(-1)!;
      expect(unsaved.closed).toBe(true);
      await expect(PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY)).resolves.not.toEqual({ status: 'ready' });
      await expect(sendChat('too early')).rejects.toThrow();
      expect(world.sentCounters).toEqual([]);
      await expect(LocalMessagingService.getLink(OWNER, COUNTERPARTY)).resolves.toMatchObject({
        status: 'handshaking',
      });

      advanceClock(MESSAGING_RETRY_POLICY.maxMs);
      world.advanceScript.push('complete');
      await expect(PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY)).resolves.toEqual({ status: 'ready' });
      expect(world.calls).toContain('restoreEncryptedLinkHandshake');
      await expect(LocalMessagingService.getLink(OWNER, COUNTERPARTY)).resolves.toMatchObject({
        status: 'established',
      });
    });

    it('registers an adopted inbound link only after its row is saved', async () => {
      world.inboundFrom.add(COUNTERPARTY);
      world.responderCompletes.add(COUNTERPARTY);
      vi.spyOn(LocalMessagingService, 'upsertLink').mockRejectedValueOnce(new Error('disk full'));

      await expect(PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY)).rejects.toThrow('disk full');
      const unsaved = world.links.at(-1)!;
      expect(unsaved.closed).toBe(true);

      world.inboundFrom.delete(COUNTERPARTY);
      world.responderCompletes.delete(COUNTERPARTY);
      await expect(PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY)).resolves.toEqual({
        status: 'handshaking',
        role: 'initiator',
      });
      expect(unsaved.sent).toEqual([]);
    });
  });

  describe('two tabs on one link', () => {
    const MARKER = { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) };
    const chat = (body: string) => ({ conversationId: CONVERSATION_ID, listingRef: LISTING_REF, body });
    const expectNoCounterReused = () => expect(new Set(world.sentCounters).size).toBe(world.sentCounters.length);
    const sends = () => world.calls.filter((call) => call === 'link.send').length;

    type Tab = {
      service: typeof PaykitMessagingService;
      application: typeof MessagingApplication;
      /** Sign-out as the app runs it: the tab's messaging session, then the database and keyring wipe. */
      signOut: () => Promise<void>;
      /** Drops the tab's cached wrapping key, as a reload does. */
      forgetKeys: () => void;
      /** How long this tab's sign-out waits for other tabs before it returns. */
      setTeardownWait: (ms: number) => void;
      close: () => Promise<void>;
    };
    const tabA = { service: PaykitMessagingService, application: MessagingApplication };
    let tabB: Tab | undefined;

    /**
     * A second tab: fresh copies of the messaging modules (their own session,
     * handles and queues) over the same IndexedDB, keyring and Web Locks.
     */
    const openTabB = async ({ enable = true } = {}): Promise<Tab> => {
      vi.resetModules();
      const service = await import('./paykit-messaging');
      const application = await import('@/application/messaging/messaging');
      const keyring = await import('@/libs/crypto/messaging-keyring');
      const { db } = await import('@/database/franky/franky');
      const helpers = await import('@/database/franky/franky.helpers');
      service.setPaykitWasmModuleForTests(wasm);
      world.nextApprovalPubky = OWNER;
      if (enable) await (await service.PaykitMessagingService.beginEnableFlow(OWNER)).awaitEnabled();
      return {
        service: service.PaykitMessagingService,
        application: application.MessagingApplication,
        signOut: async () => {
          application.MessagingApplication.clearMessagingSession();
          await helpers.clearDatabase();
        },
        forgetKeys: () => keyring.dropCachedWrappingKeyForTests(),
        setTeardownWait: (ms) => keyring.setTeardownLockWaitForTests(ms),
        close: async () => {
          application.MessagingApplication.clearMessagingSession();
          service.setPaykitWasmModuleForTests(null);
          await keyring.closeWrappingKeyStoreForTests();
          db.close();
        },
      };
    };

    beforeEach(async () => {
      MessagingApplication.clearMessagingSession();
      await CommerceMessagingOutboxModel.clear();
      world.markers.set(COUNTERPARTY, MARKER);
    });

    afterEach(async () => {
      await tabB?.close();
      tabB = undefined;
    });

    describe('once the link is established', () => {
      beforeEach(async () => {
        await enableMessaging(world);
        world.advanceScript.push('complete');
        await expect(tabA.service.ensureLink(OWNER, COUNTERPARTY)).resolves.toEqual({ status: 'ready' });
        tabB = await openTabB();
        await expect(tabB!.service.ensureLink(OWNER, COUNTERPARTY)).resolves.toEqual({ status: 'ready' });
      });

      it('never sends under a counter the other tab already used', async () => {
        await tabA.service.sendChatMessage(OWNER, COUNTERPARTY, chat('from tab A'));
        await tabB!.service.sendChatMessage(OWNER, COUNTERPARTY, chat('from tab B'));
        await tabA.service.sendDmMessage(OWNER, COUNTERPARTY, { body: 'tab A again' });
        await tabB!.service.sendDmMessage(OWNER, COUNTERPARTY, { body: 'tab B again' });

        expect(world.sentCounters).toEqual([0, 1, 2, 3]);
        expectNoCounterReused();
      });

      it('lets one tab send only after the other tab’s send and snapshot save are done', async () => {
        let release!: () => void;
        world.sendHold = new Promise<void>((resolve) => {
          release = resolve;
        });
        const first = tabA.service.sendChatMessage(OWNER, COUNTERPARTY, chat('from tab A'));
        await vi.waitFor(() => expect(sends()).toBe(1));
        const second = tabB!.service.sendChatMessage(OWNER, COUNTERPARTY, chat('from tab B'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(sends()).toBe(1);

        world.sendHold = null;
        release();
        await Promise.all([first, second]);

        expect(world.sentCounters).toEqual([0, 1]);
        expectNoCounterReused();
      });

      it('flushes queued messages in one tab without reusing a counter the other tab sent under', async () => {
        await LocalMessagingService.enqueueOutboxMessage({
          id: crypto.randomUUID(),
          owner_pubky: OWNER,
          counterparty_pubky: COUNTERPARTY,
          kind: 'chat',
          conversation_id: CONVERSATION_ID,
          listing_ref: LISTING_REF,
          body: 'queued in tab B',
          queued_at: Date.now(),
          attempts: 0,
          last_attempt_at: null,
          last_error: null,
        });
        await tabA.service.sendChatMessage(OWNER, COUNTERPARTY, chat('from tab A'));

        await expect(tabB!.application.flushOutbox(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY)).resolves.toEqual({
          delivered: 1,
          remaining: 0,
        });

        expect(world.sentCounters).toEqual([0, 1]);
      });

      it('never lets a receive in a stale tab save a snapshot behind the other tab’s send', async () => {
        const staleInB = world.links.at(-1)!;
        await tabA.service.sendChatMessage(OWNER, COUNTERPARTY, chat('from tab A'));
        staleInB.inboundQueue.push({
          version: 1,
          kind: 'marketplace.chat_message.v0',
          rawJson: JSON.stringify({
            version: 1,
            kind: 'marketplace.chat_message.v0',
            event_id: crypto.randomUUID(),
            conversation_id: CONVERSATION_ID,
            listing_ref: LISTING_REF,
            sent_at: '2026-08-21T10:00:00.000Z',
            body: 'reply',
          }),
        });

        await tabB!.service.receiveMessages(OWNER, COUNTERPARTY, ADMIT_ALL_GATE);
        expect(staleInB.closed).toBe(true);

        // A reload of either tab restores from the saved snapshot.
        MessagingApplication.clearMessagingSession();
        await enableMessaging(world);
        await tabA.service.sendChatMessage(OWNER, COUNTERPARTY, chat('after a reload'));

        expect(world.sentCounters).toEqual([0, 1]);
        expectNoCounterReused();
      });
    });

    it('never completes the same handshake in both tabs', async () => {
      await enableMessaging(world);
      await expect(tabA.service.ensureLink(OWNER, COUNTERPARTY)).resolves.toEqual({
        status: 'handshaking',
        role: 'initiator',
      });
      tabB = await openTabB();
      await expect(tabB!.service.ensureLink(OWNER, COUNTERPARTY)).resolves.toEqual({
        status: 'handshaking',
        role: 'initiator',
      });

      world.advanceScript.push('complete');
      await tabA.service.sendChatMessage(OWNER, COUNTERPARTY, chat('from tab A'));
      world.advanceScript.push('complete');
      await tabB!.service.sendChatMessage(OWNER, COUNTERPARTY, chat('from tab B'));

      expect(world.sentCounters).toEqual([0, 1]);
      expectNoCounterReused();
    });

    describe('provisioning one receiver', () => {
      const generated = () => world.calls.filter((call) => call === 'generateNoiseSecretKey').length;
      const enableIn = async (service: typeof PaykitMessagingService) => {
        world.nextApprovalPubky = OWNER;
        return await (await service.beginEnableFlow(OWNER)).awaitEnabled();
      };
      /** The device holds one receiver, and it is the key the marker advertises. */
      const expectOneAdvertisedKey = async () => {
        const stored = (await LocalMessagingService.getReceiver(OWNER))!;
        expect(stored.marker_published).toBe(true);
        expect(wasm.noisePublicKeyFromSecret(stored.noise_secret)).toBe(stored.noise_public_key);
        expect(world.lastPublishedMarker?.noisePublicKey).toBe(stored.noise_public_key);
        return stored.noise_public_key;
      };
      const receiverOf = (secret: number) => {
        const noiseSecret = new Uint8Array(32).fill(secret);
        return {
          id: OWNER,
          noise_secret: noiseSecret,
          noise_public_key: wasm.noisePublicKeyFromSecret(noiseSecret),
          receiver_path: 'marketplace/wallet',
          marker_published: false,
          created_at: 1,
          updated_at: 1,
        };
      };

      beforeEach(async () => {
        tabB = await openTabB({ enable: false });
      });

      it('two tabs enabling at once end with one key, the one the marker advertises', async () => {
        world.publishAcceptDelays = [40];

        const [inA, inB] = await Promise.all([enableIn(tabA.service), enableIn(tabB!.service)]);

        const key = await expectOneAdvertisedKey();
        expect([inA.noisePublicKey, inB.noisePublicKey]).toEqual([key, key]);
        expect(generated()).toBe(1);
      });

      it('two tabs resuming from the sign-in cookie at once end with one key, the one the marker advertises', async () => {
        world.cookieResume = 'success';
        world.publishAcceptDelays = [40];

        await expect(
          Promise.all([tabA.service.restorePersistedSession(OWNER), tabB!.service.restorePersistedSession(OWNER)]),
        ).resolves.toEqual([true, true]);

        await expectOneAdvertisedKey();
        expect(generated()).toBe(1);
      });

      it('two tabs replacing an unreadable receiver at once end with one key, the one the marker advertises', async () => {
        await CommerceMessagingReceiverModel.upsert({
          ...receiverOf(9),
          noise_secret: crypto.getRandomValues(new Uint8Array(60)),
          wrap_version: WRAP_VERSION_AES_GCM_256,
          marker_published: true,
        });
        vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        // Both tabs' first reads of the unreadable row meet, unless one tab
        // is kept out until the other is done.
        let waiting: (() => void) | null = null;
        let met = false;
        const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
        vi.spyOn(crypto.subtle, 'decrypt').mockImplementation(async (...args) => {
          if (!met) {
            if (waiting) {
              met = true;
              waiting();
            } else {
              await new Promise<void>((resolve) => {
                waiting = resolve;
                setTimeout(() => {
                  met = true;
                  resolve();
                }, 50);
              });
            }
          }
          return await decrypt(...args);
        });
        world.publishAcceptDelays = [30];

        const [inA, inB] = await Promise.all([enableIn(tabA.service), enableIn(tabB!.service)]);

        const key = await expectOneAdvertisedKey();
        expect([inA.noisePublicKey, inB.noisePublicKey]).toEqual([key, key]);
        expect(generated()).toBe(1);
      });

      it('a tab that last looked before the other tab set up adopts that key instead of making another', async () => {
        await expect(tabB!.service.isReceiverProvisioned(OWNER)).resolves.toBe(false);
        const inA = await enableIn(tabA.service);

        const inB = await enableIn(tabB!.service);

        expect(inB.noisePublicKey).toBe(inA.noisePublicKey);
        await expect(expectOneAdvertisedKey()).resolves.toBe(inA.noisePublicKey);
        expect(generated()).toBe(1);
      });

      it('adopts a receiver another writer stored while this tab was making its own', async () => {
        const other = receiverOf(42);
        const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
        vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
          await LocalMessagingService.upsertReceiver(other);
          return await encrypt(...args);
        });

        const enabled = await enableIn(tabA.service);

        expect(enabled.noisePublicKey).toBe(other.noise_public_key);
        await expect(expectOneAdvertisedKey()).resolves.toBe(other.noise_public_key);
      });

      it('never marks a receiver published when another key replaced it during the publish', async () => {
        let release!: () => void;
        world.publishHold = new Promise<void>((resolve) => {
          release = resolve;
        });
        const enabling = enableIn(tabA.service);
        await vi.waitFor(() => expect(world.calls).toContain('publishReceiverMarker'));
        const replacement = receiverOf(43);
        await LocalMessagingService.upsertReceiver(replacement);
        world.publishHold = null;
        release();

        await expect(enabling).rejects.toThrow(/changed while its marker was being published/);
        await expect(LocalMessagingService.getReceiver(OWNER)).resolves.toMatchObject({
          noise_public_key: replacement.noise_public_key,
          marker_published: false,
        });
      });

      it('never opens a link on a receiver whose marker is not published yet', async () => {
        world.cookieResume = 'success';
        world.publishMarkerFailures = 1;
        vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        await expect(tabA.service.restorePersistedSession(OWNER)).resolves.toBe(true);
        await expect(LocalMessagingService.getReceiver(OWNER)).resolves.toMatchObject({ marker_published: false });

        await expect(tabA.service.ensureLink(OWNER, COUNTERPARTY)).rejects.toThrow(/still being set up/);

        expect(world.calls).not.toContain('initiateEncryptedLink');
        expect(world.calls).not.toContain('acceptEncryptedLink');
      });

      it('sets up nothing without the Web Locks API', async () => {
        removeWebLocks();

        const outcome = await Promise.allSettled([enableIn(tabA.service)]);

        expect(generated()).toBe(0);
        expect(world.calls).not.toContain('publishReceiverMarker');
        await expect(CommerceMessagingReceiverModel.table.count()).resolves.toBe(0);
        expect(outcome[0].status).toBe('rejected');
        expect(String((outcome[0] as PromiseRejectedResult).reason)).toMatch(/Private messages are paused/);
      });
    });

    describe('a sign-out in another tab', () => {
      const payment = JSON.stringify({ version: 1, kind: 'paykit.private_payment_list.v0', endpoints: ['x'] });
      const hold = () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        return { held, release };
      };
      /**
       * After a reload (every cached wrapping key dropped), every wrapped row
       * in the database still opens under the persisted key.
       */
      const expectEveryWrappedRowOpens = async () => {
        dropCachedWrappingKeyForTests();
        for (const row of await CommerceMessagingLinkModel.table.toArray()) {
          await expect(LocalMessagingService.getLink(row.owner_id, row.counterparty_pubky)).resolves.not.toBeNull();
        }
        for (const row of await CommerceMessagingReceiverModel.table.toArray()) {
          await expect(LocalMessagingService.getReceiver(row.id)).resolves.not.toBeNull();
        }
        const unprocessed = await CommerceMessagingUnprocessedModel.table.toArray();
        for (const row of unprocessed) {
          const opened = await LocalMessagingService.getUnprocessed(row.owner_id, row.counterparty_pubky);
          expect(opened.map((event) => event.id)).toContain(row.id);
        }
      };
      /** What a tab that kept its session would do next: set up again, reopen the link, send. */
      const carryOnInTabA = async () => {
        await tabA.service.restorePersistedSession(OWNER).catch(() => undefined);
        await tabA.service.ensureLink(OWNER, COUNTERPARTY).catch(() => undefined);
        await tabA.service.sendChatMessage(OWNER, COUNTERPARTY, chat('after sign-out')).catch(() => undefined);
      };

      beforeEach(async () => {
        await enableMessaging(world);
        world.advanceScript.push('complete');
        await expect(tabA.service.ensureLink(OWNER, COUNTERPARTY)).resolves.toEqual({ status: 'ready' });
        tabB = await openTabB();
        vi.spyOn(Logger, 'warn').mockImplementation(() => {});
      });

      it('racing a send, leaves nothing wrapped under the deleted key and ends the other tab’s session', async () => {
        const send = hold();
        world.sendHold = send.held;
        const sending = tabA.service.sendChatMessage(OWNER, COUNTERPARTY, chat('in flight'));
        await vi.waitFor(() => expect(world.calls).toContain('link.send'));

        await tabB!.signOut();
        world.sendHold = null;
        send.release();
        await expect(sending).rejects.toThrow(/reset in another tab/);
        await carryOnInTabA();

        expect(tabA.service.hasActiveSession(OWNER)).toBe(false);
        await expect(CommerceMessagingLinkModel.table.count()).resolves.toBe(0);
        await expectEveryWrappedRowOpens();
      });

      it('racing a receive, stores nothing under the deleted key', async () => {
        const receive = hold();
        world.receiveHold = receive.held;
        world.links.at(-1)!.inboundQueue.push({ version: 1, kind: 'paykit.private_payment_list.v0', rawJson: payment });
        const receiving = tabA.service.receiveMessages(OWNER, COUNTERPARTY, ADMIT_ALL_GATE);
        await vi.waitFor(() => expect(world.calls).toContain('link.receive'));

        await tabB!.signOut();
        world.receiveHold = null;
        receive.release();
        await expect(receiving).rejects.toThrow(/reset in another tab/);
        await carryOnInTabA();

        await expect(CommerceMessagingUnprocessedModel.table.count()).resolves.toBe(0);
        await expectEveryWrappedRowOpens();
      });

      it('racing a setup, never stores or advertises a receiver under the deleted key', async () => {
        tabA.service.clearSession();
        await CommerceMessagingReceiverModel.clear();
        const publish = hold();
        world.publishHold = publish.held;
        world.nextApprovalPubky = OWNER;
        const enabling = (await tabA.service.beginEnableFlow(OWNER)).awaitEnabled();
        await vi.waitFor(() => expect(world.calls.filter((call) => call === 'publishReceiverMarker')).toHaveLength(3));

        await tabB!.signOut();
        world.publishHold = null;
        publish.release();
        await expect(enabling).rejects.toThrow(/reset in another tab/);

        // Setting up again works, under a key that survives a reload.
        const again = await (await tabA.service.beginEnableFlow(OWNER)).awaitEnabled();
        await expectEveryWrappedRowOpens();
        await expect(LocalMessagingService.getReceiver(OWNER)).resolves.toMatchObject({
          noise_public_key: again.noisePublicKey,
          marker_published: true,
        });
        expect(world.lastPublishedMarker?.noisePublicKey).toBe(again.noisePublicKey);
      });

      it('never replaces state it can no longer open because its own key is stale', async () => {
        await tabB!.signOut();
        world.nextApprovalPubky = OWNER;
        const replaced = await (await tabB!.service.beginEnableFlow(OWNER)).awaitEnabled();

        await carryOnInTabA();

        await expect(LocalMessagingService.getReceiver(OWNER)).resolves.toMatchObject({
          noise_public_key: replaced.noisePublicKey,
        });
        expect(world.lastPublishedMarker?.noisePublicKey).toBe(replaced.noisePublicKey);
        await expectEveryWrappedRowOpens();
      });

      it('waits for a write already under way before clearing anything', async () => {
        const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
        let signingOut: Promise<void> | null = null;
        vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
          signingOut = tabB!.signOut();
          await new Promise((resolve) => setTimeout(resolve, 30));
          return await encrypt(...args);
        });

        await tabA.service.sendChatMessage(OWNER, COUNTERPARTY, chat('saved before the wipe')).catch(() => undefined);
        await signingOut;

        await expect(CommerceMessagingLinkModel.table.count()).resolves.toBe(0);
        await expectEveryWrappedRowOpens();
      });

      it('treats a key another tab replaced after finding it unusable as stale, and sends nothing', async () => {
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open(`${DB_NAME}-messaging-keyring`);
          request.onsuccess = () => {
            const connection = request.result;
            const put = connection
              .transaction('wrapping-key', 'readwrite')
              .objectStore('wrapping-key')
              .put('not a key', 'wrapping-key');
            put.onsuccess = () => {
              connection.close();
              resolve();
            };
            put.onerror = () => reject(put.error);
          };
          request.onerror = () => reject(request.error);
        });
        tabB!.forgetKeys();
        await expect(tabB!.service.isReceiverProvisioned(OWNER)).resolves.toBe(false);
        const revisionBefore = await LocalMessagingService.getLinkRevision(OWNER, COUNTERPARTY);
        world.calls.length = 0;

        await expect(tabA.service.sendChatMessage(OWNER, COUNTERPARTY, chat('under the old key'))).rejects.toThrow(
          /reset in another tab/,
        );

        expect(world.sentCounters).toEqual([]);
        expect(world.calls).not.toContain('link.send');
        await expect(LocalMessagingService.getLinkRevision(OWNER, COUNTERPARTY)).resolves.toBe(revisionBefore);
        expect(tabA.service.hasActiveSession(OWNER)).toBe(false);
      });

      it('never clears while a writer that passed the check is suspended past sign-out’s wait', async () => {
        tabB!.setTeardownWait(20);
        let resume!: () => void;
        const suspended = new Promise<void>((resolve) => {
          resume = resolve;
        });
        let reached!: () => void;
        const atWrap = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
        vi.spyOn(crypto.subtle, 'encrypt').mockImplementationOnce(async (...args) => {
          reached();
          await suspended;
          return await encrypt(...args);
        });
        const sending = tabA.service.sendChatMessage(OWNER, COUNTERPARTY, chat('suspended mid-save'));
        await atWrap;

        await tabB!.signOut();
        await new Promise((resolve) => setTimeout(resolve, 50));
        // Sign-out returned, but nothing key-wrapped was cleared while the writer holds the fence.
        await expect(CommerceMessagingLinkModel.table.count()).resolves.toBe(1);
        expect(window.localStorage.getItem(TEARDOWN_PENDING)).not.toBeNull();

        resume();
        await sending.catch(() => undefined);
        await vi.waitFor(async () => {
          expect(window.localStorage.getItem(TEARDOWN_PENDING)).toBeNull();
        });
        await expect(CommerceMessagingLinkModel.table.count()).resolves.toBe(0);
        await expect(CommerceMessagingReceiverModel.table.count()).resolves.toBe(0);
        await expectEveryWrappedRowOpens();
      });

      it('finishes a sign-out a closed tab left pending, and reads and writes nothing until then', async () => {
        window.localStorage.setItem(TEARDOWN_PENDING, '1');
        world.calls.length = 0;

        await expect(tabA.service.sendChatMessage(OWNER, COUNTERPARTY, chat('before the cleanup'))).rejects.toThrow(
          /reset in another tab/,
        );
        expect(world.sentCounters).toEqual([]);
        expect(world.calls).not.toContain('link.send');
        await expect(CommerceMessagingLinkModel.table.count()).resolves.toBe(1);

        await resumePendingMessagingTeardown();

        expect(window.localStorage.getItem(TEARDOWN_PENDING)).toBeNull();
        await expect(CommerceMessagingLinkModel.table.count()).resolves.toBe(0);
        await expect(CommerceMessagingReceiverModel.table.count()).resolves.toBe(0);
      });

      it('treats a keyring an older build deleted as stale, and writes nothing under it', async () => {
        // An older build's sign-out: tables cleared and the keyring deleted,
        // without the key fence.
        await Promise.all([CommerceMessagingLinkModel.clear(), CommerceMessagingReceiverModel.clear()]);
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.deleteDatabase(`${DB_NAME}-messaging-keyring`);
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });

        await carryOnInTabA();

        await expectEveryWrappedRowOpens();
      });
    });

    describe('without a lock every tab shares', () => {
      beforeEach(async () => {
        await enableMessaging(world);
        world.advanceScript.push('complete');
        await tabA.service.ensureLink(OWNER, COUNTERPARTY);
        world.calls.length = 0;
      });

      it('refuses to send, receive or advance a link without the Web Locks API', async () => {
        const queuedId = crypto.randomUUID();
        await LocalMessagingService.enqueueOutboxMessage({
          id: queuedId,
          owner_pubky: OWNER,
          counterparty_pubky: COUNTERPARTY,
          kind: 'dm',
          conversation_id: null,
          listing_ref: null,
          body: 'queued',
          queued_at: Date.now(),
          attempts: 0,
          last_attempt_at: null,
          last_error: null,
        });
        removeWebLocks();
        const revisionBefore = await LocalMessagingService.getLinkRevision(OWNER, COUNTERPARTY);
        world.calls.length = 0;
        world.links.at(-1)!.inboundQueue.push({
          version: 1,
          kind: 'marketplace.chat_message.v0',
          rawJson: JSON.stringify({
            version: 1,
            kind: 'marketplace.chat_message.v0',
            event_id: crypto.randomUUID(),
            conversation_id: CONVERSATION_ID,
            listing_ref: LISTING_REF,
            sent_at: '2026-08-21T10:00:00.000Z',
            body: 'unread',
          }),
        });

        const outcomes = await Promise.allSettled([
          tabA.service.sendChatMessage(OWNER, COUNTERPARTY, chat('hello')),
          tabA.service.sendDmMessage(OWNER, COUNTERPARTY, { body: 'hello' }),
          tabA.service.receiveMessages(OWNER, COUNTERPARTY, ADMIT_ALL_GATE),
          tabA.service.ensureLink(OWNER, COUNTERPARTY),
          tabA.service.probeCounterparty(OWNER, COUNTERPARTY),
          // Queued bodies are encrypted at rest, so not even the flush reads them.
          MessagingApplication.flushOutbox(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY),
        ]);

        // Nothing ran: no ciphertext left, nothing was read, no link state moved.
        expect(world.sentCounters).toEqual([]);
        expect(world.calls.filter((call) => call.startsWith('link.') || call.startsWith('handshake.'))).toEqual([]);
        expect(world.calls).not.toContain('restoreEncryptedLink');
        expect(world.calls).not.toContain('initiateEncryptedLink');
        await expect(LocalMessagingService.getLinkRevision(OWNER, COUNTERPARTY)).resolves.toBe(revisionBefore);
        installWebLocks();
        await expect(LocalMessagingService.getMessages(OWNER, CONVERSATION_ID)).resolves.toEqual([]);
        const queued = await LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY);
        expect(queued.map((row) => row.id)).toEqual([queuedId]);
        // And each refusal says why.
        for (const outcome of outcomes) {
          expect(outcome.status).toBe('rejected');
          expect(String((outcome as PromiseRejectedResult).reason)).toMatch(/Private messages are paused/);
        }
      });

      it('refuses to send when the browser refuses the lock', async () => {
        // Only the pair lock is refused, so what the refusal alone stops is visible.
        installRefusingWebLocks(new DOMException('denied', 'SecurityError'), (name) =>
          name.startsWith('pubky-messaging-link|'),
        );
        vi.spyOn(Logger, 'warn').mockImplementation(() => {});

        await expect(tabA.service.sendChatMessage(OWNER, COUNTERPARTY, chat('hello'))).rejects.toThrow(
          /could not coordinate with your other tabs/,
        );

        expect(world.sentCounters).toEqual([]);
        expect(world.calls).not.toContain('link.send');
      });
    });
  });

  describe('inbound thread binding', () => {
    const ATTACKER = COUNTERPARTY;
    const VICTIM = 'y'.repeat(52);
    const VICTIM_LISTING_ID = '0033GVVN22HJ0FYQGZZS8R2VIC';

    function chatRaw(fields: { conversationId: string; listingRef: string; body: string; eventId?: string }) {
      return JSON.stringify({
        version: 1,
        kind: 'marketplace.chat_message.v0',
        event_id: fields.eventId ?? crypto.randomUUID(),
        conversation_id: fields.conversationId,
        listing_ref: fields.listingRef,
        sent_at: 1_787_306_400_000,
        body: fields.body,
      });
    }

    function pushInbound(rawJson: string) {
      world.links.at(-1)!.inboundQueue.push({ version: 1, kind: 'marketplace.chat_message.v0', rawJson });
    }

    async function seedThread(conversationId: string, listingRef: string, counterparty: string, body: string) {
      await LocalMessagingService.touchConversation({
        owner_id: OWNER,
        conversation_id: conversationId,
        kind: 'listing',
        listing_ref: listingRef,
        counterparty_pubky: counterparty,
        last_message_at: 1,
        updated_at: 1,
      });
      await LocalMessagingService.upsertMessage(crypto.randomUUID(), {
        owner_id: OWNER,
        conversation_id: conversationId,
        listing_ref: listingRef,
        counterparty_pubky: counterparty,
        direction: 'received',
        body,
        sent_at: 1,
        recorded_at: 1,
      });
    }

    beforeEach(async () => {
      await enableMessaging(world);
      world.markers.set(ATTACKER, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });
      world.advanceScript.push('complete');
      await PaykitMessagingService.ensureLink(OWNER, ATTACKER);
    });

    it.each([
      {
        case: 'OWNER is the seller: forged id names OWNER and another buyer',
        conversationId: buildMarketplaceConversationAggregateId(OWNER, VICTIM, VICTIM_LISTING_ID),
        listingRef: buildMarketplaceListingAggregateId(OWNER, VICTIM_LISTING_ID),
      },
      {
        case: 'OWNER is the buyer: forged id impersonates another seller',
        conversationId: buildMarketplaceConversationAggregateId(VICTIM, OWNER, VICTIM_LISTING_ID),
        listingRef: buildMarketplaceListingAggregateId(VICTIM, VICTIM_LISTING_ID),
      },
    ])('drops an attacker message planted in a thread with someone else ($case)', async (forged) => {
      await seedThread(forged.conversationId, forged.listingRef, VICTIM, 'the real thread');
      const eventId = crypto.randomUUID();
      pushInbound(chatRaw({ ...forged, eventId, body: 'pay the new address instead' }));

      const received = await PaykitMessagingService.receiveMessages(OWNER, ATTACKER, ADMIT_ALL_GATE);

      expect(received).toEqual([]);
      const thread = await LocalMessagingService.getMessages(OWNER, forged.conversationId);
      expect(thread.map((row) => row.body)).toEqual(['the real thread']);
      // Dropped, not quarantined: nothing from the attacker reached storage.
      await expect(CommerceMessagingMessageModel.findById(`${OWNER}:${eventId}`)).resolves.toBeNull();
      const conversations = await LocalMessagingService.getConversationsByOwner(OWNER);
      expect(conversations).toHaveLength(1);
      expect(conversations[0]).toMatchObject({ conversation_id: forged.conversationId, counterparty_pubky: VICTIM });
    });

    it('drops a forged id that opens a brand-new thread under someone else’s name', async () => {
      const conversationId = buildMarketplaceConversationAggregateId(OWNER, VICTIM, VICTIM_LISTING_ID);
      pushInbound(
        chatRaw({
          conversationId,
          listingRef: buildMarketplaceListingAggregateId(OWNER, VICTIM_LISTING_ID),
          body: 'hello from “VICTIM”',
        }),
      );

      await expect(PaykitMessagingService.receiveMessages(OWNER, ATTACKER, ADMIT_ALL_GATE)).resolves.toEqual([]);
      await expect(CommerceMessagingConversationModel.findByOwner(OWNER)).resolves.toEqual([]);
      await expect(CommerceMessagingMessageModel.table.count()).resolves.toBe(0);
    });

    it.each([
      {
        case: 'listing_ref names another seller’s listing',
        conversationId: buildMarketplaceConversationAggregateId(ATTACKER, OWNER, LISTING_ID),
        listingRef: buildMarketplaceListingAggregateId(VICTIM, LISTING_ID),
      },
      {
        case: 'listing_ref names a different listing of the same seller',
        conversationId: buildMarketplaceConversationAggregateId(ATTACKER, OWNER, LISTING_ID),
        listingRef: buildMarketplaceListingAggregateId(ATTACKER, VICTIM_LISTING_ID),
      },
      {
        case: 'seller and buyer are the same pubky',
        conversationId: buildMarketplaceConversationAggregateId(ATTACKER, ATTACKER, LISTING_ID),
        listingRef: buildMarketplaceListingAggregateId(ATTACKER, LISTING_ID),
      },
      {
        case: 'conversation id is not a listing conversation',
        conversationId: `dm:${OWNER}`,
        listingRef: buildMarketplaceListingAggregateId(ATTACKER, LISTING_ID),
      },
      {
        case: 'listing id is not a path-safe commerce id',
        conversationId: buildMarketplaceConversationAggregateId(ATTACKER, OWNER, '../x'),
        listingRef: buildMarketplaceListingAggregateId(ATTACKER, '../x'),
      },
    ])('drops a listing message whose envelope does not bind to the link ($case)', async (envelope) => {
      pushInbound(chatRaw({ ...envelope, body: 'not bound' }));
      await expect(PaykitMessagingService.receiveMessages(OWNER, ATTACKER, ADMIT_ALL_GATE)).resolves.toEqual([]);
      await expect(CommerceMessagingMessageModel.table.count()).resolves.toBe(0);
    });

    it.each([
      { case: 'the counterparty is the seller', seller: ATTACKER, buyer: OWNER },
      { case: 'OWNER is the seller', seller: OWNER, buyer: ATTACKER },
    ])('stores a bound listing message ($case)', async ({ seller, buyer }) => {
      const conversationId = buildMarketplaceConversationAggregateId(seller, buyer, LISTING_ID);
      const listingRef = buildMarketplaceListingAggregateId(seller, LISTING_ID);
      pushInbound(chatRaw({ conversationId, listingRef, body: 'a real question' }));

      const received = await PaykitMessagingService.receiveMessages(OWNER, ATTACKER, ADMIT_ALL_GATE);

      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({ conversation_id: conversationId, counterpartyPubky: ATTACKER });
      const thread = await LocalMessagingService.getMessages(OWNER, conversationId);
      expect(thread.map((row) => row.body)).toEqual(['a real question']);
    });

    it('keeps the bound messages of a drain that also carries a forged one, and still advances the link', async () => {
      const ownThread = buildMarketplaceConversationAggregateId(ATTACKER, OWNER, LISTING_ID);
      const victimThread = buildMarketplaceConversationAggregateId(OWNER, VICTIM, VICTIM_LISTING_ID);
      pushInbound(
        chatRaw({
          conversationId: victimThread,
          listingRef: buildMarketplaceListingAggregateId(OWNER, VICTIM_LISTING_ID),
          body: 'forged',
        }),
      );
      pushInbound(
        chatRaw({
          conversationId: ownThread,
          listingRef: buildMarketplaceListingAggregateId(ATTACKER, LISTING_ID),
          body: 'bound',
        }),
      );
      const snapshotSpy = vi.spyOn(LocalMessagingService, 'updateLinkSnapshot');

      const received = await PaykitMessagingService.receiveMessages(OWNER, ATTACKER, ADMIT_ALL_GATE);

      expect(received.map((row) => row.body)).toEqual(['bound']);
      await expect(LocalMessagingService.getMessages(OWNER, victimThread)).resolves.toEqual([]);
      expect(snapshotSpy).toHaveBeenCalledTimes(1);
    });

    it('never lets an inbound message overwrite a stored row that reuses its event id', async () => {
      const ownThread = buildMarketplaceConversationAggregateId(ATTACKER, OWNER, LISTING_ID);
      const listingRef = buildMarketplaceListingAggregateId(ATTACKER, LISTING_ID);
      const sent = await PaykitMessagingService.sendChatMessage(OWNER, ATTACKER, {
        conversationId: ownThread,
        listingRef,
        body: 'what I actually said',
      });
      pushInbound(chatRaw({ conversationId: ownThread, listingRef, eventId: sent.event_id, body: 'rewritten' }));

      await expect(PaykitMessagingService.receiveMessages(OWNER, ATTACKER, ADMIT_ALL_GATE)).resolves.toEqual([]);

      const thread = await LocalMessagingService.getMessages(OWNER, ownThread);
      expect(thread).toHaveLength(1);
      expect(thread[0]).toMatchObject({ direction: 'sent', body: 'what I actually said' });
    });

    it.each([
      {
        kind: 'listing message',
        conversationId: buildMarketplaceConversationAggregateId(ATTACKER, OWNER, LISTING_ID),
        envelope: (eventId: string, body: string, sentAt: number) =>
          chatRaw({
            conversationId: buildMarketplaceConversationAggregateId(ATTACKER, OWNER, LISTING_ID),
            listingRef: buildMarketplaceListingAggregateId(ATTACKER, LISTING_ID),
            eventId,
            body,
          }).replace('1787306400000', String(sentAt)),
      },
      {
        kind: 'direct message',
        conversationId: `dm:${ATTACKER}`,
        envelope: (eventId: string, body: string, sentAt: number) =>
          JSON.stringify({ version: 1, kind: 'pubky_app.dm.v0', event_id: eventId, sent_at: sentAt, body }),
      },
    ])('never lets the sender rewrite a received $kind by reusing its event id', async (fixture) => {
      const eventId = crypto.randomUUID();
      const link = world.links.at(-1)!;
      link.inboundQueue.push({
        version: 1,
        kind: 'x',
        rawJson: fixture.envelope(eventId, 'original', 1_787_306_400_000),
      });
      await expect(PaykitMessagingService.receiveMessages(OWNER, ATTACKER, ADMIT_ALL_GATE)).resolves.toHaveLength(1);
      const original = await CommerceMessagingMessageModel.table.get(`${OWNER}:${eventId}`);
      await LocalMessagingService.markConversationRead(OWNER, fixture.conversationId, original!.recorded_at + 1);
      vi.useFakeTimers({ toFake: ['Date'], now: original!.recorded_at + 60_000 });

      link.inboundQueue.push(
        { version: 1, kind: 'x', rawJson: fixture.envelope(eventId, 'edited later', 1_787_306_400_000) },
        { version: 1, kind: 'x', rawJson: fixture.envelope(eventId, 'original', 1_787_399_999_000) },
        { version: 1, kind: 'x', rawJson: fixture.envelope(eventId, 'original', 1_787_306_400_000) },
      );
      try {
        await expect(PaykitMessagingService.receiveMessages(OWNER, ATTACKER, ADMIT_ALL_GATE)).resolves.toEqual([]);
      } finally {
        vi.useRealTimers();
      }

      const thread = await LocalMessagingService.getMessages(OWNER, fixture.conversationId);
      expect(thread).toHaveLength(1);
      expect(thread[0]).toMatchObject({
        body: 'original',
        sent_at: 1_787_306_400_000,
        recorded_at: original!.recorded_at,
      });
      await expect(LocalMessagingService.countUnreadConversations(OWNER)).resolves.toBe(0);
      const conversation = await LocalMessagingService.getConversation(OWNER, fixture.conversationId);
      expect(conversation?.last_message_at).toBe(original!.recorded_at);
    });

    it('lets exactly one of two links claim an event id when their drains overlap', async () => {
      const SECOND = 'x'.repeat(52);
      world.markers.set(SECOND, { receiverPath: 'marketplace/wallet', noisePublicKey: 'q'.repeat(52) });
      world.advanceScript.push('complete');
      await PaykitMessagingService.ensureLink(OWNER, SECOND);
      const linkTo = (counterparty: string) => world.links.find((link) => link.counterparty === counterparty)!;
      const eventId = crypto.randomUUID();
      const threadWith = (counterparty: string) =>
        buildMarketplaceConversationAggregateId(counterparty, OWNER, LISTING_ID);
      for (const [counterparty, body] of [
        [ATTACKER, 'from the attacker'],
        [SECOND, 'from the second contact'],
      ]) {
        linkTo(counterparty).inboundQueue.push({
          version: 1,
          kind: 'marketplace.chat_message.v0',
          rawJson: chatRaw({
            conversationId: threadWith(counterparty),
            listingRef: buildMarketplaceListingAggregateId(counterparty, LISTING_ID),
            eventId,
            body,
          }),
        });
      }
      // Holds any per-id lookup until both drains have made one, so a
      // check-then-write collision guard sees an empty slot on both links.
      const parked: (() => void)[] = [];
      vi.spyOn(CommerceMessagingMessageModel, 'findById').mockImplementation(
        asOpaque(async (id: string) => {
          await new Promise<void>((resolve) => {
            parked.push(resolve);
            if (parked.length === 2) parked.forEach((release) => release());
            else setTimeout(resolve, 200);
          });
          return (await CommerceMessagingMessageModel.table.get(id)) ?? null;
        }),
      );

      const [fromAttacker, fromSecond] = await Promise.all([
        PaykitMessagingService.receiveMessages(OWNER, ATTACKER, ADMIT_ALL_GATE),
        PaykitMessagingService.receiveMessages(OWNER, SECOND, ADMIT_ALL_GATE),
      ]);

      expect(fromAttacker.length + fromSecond.length).toBe(1);
      const winner = fromAttacker.length === 1 ? ATTACKER : SECOND;
      const loser = winner === ATTACKER ? SECOND : ATTACKER;
      await expect(CommerceMessagingMessageModel.table.get(`${OWNER}:${eventId}`)).resolves.toMatchObject({
        counterparty_pubky: winner,
        conversation_id: threadWith(winner),
      });
      await expect(LocalMessagingService.getMessages(OWNER, threadWith(loser))).resolves.toEqual([]);
    });

    it('refuses to send into a thread that does not name the link counterparty', async () => {
      await expect(
        PaykitMessagingService.sendChatMessage(OWNER, ATTACKER, {
          conversationId: buildMarketplaceConversationAggregateId(OWNER, VICTIM, VICTIM_LISTING_ID),
          listingRef: buildMarketplaceListingAggregateId(OWNER, VICTIM_LISTING_ID),
          body: 'misaddressed',
        }),
      ).rejects.toThrow(/not between you and the person you are messaging/);
      expect(world.links.at(-1)!.sent).toHaveLength(0);
      await expect(CommerceMessagingMessageModel.table.count()).resolves.toBe(0);
    });
  });

  describe('session persistence across reloads', () => {
    const storedValue = () => window.localStorage.getItem('pubky.messaging.session.v1');

    // A reload keeps localStorage and the browser cookie jar but wipes all
    // in-memory wasm state. clearSession() deliberately wipes BOTH, so the
    // simulation re-seeds storage after dropping memory.
    const simulateReload = () => {
      const persisted = storedValue();
      PaykitMessagingService.clearSession();
      if (persisted !== null) window.localStorage.setItem('pubky.messaging.session.v1', persisted);
    };

    it('persists secret-free session metadata on enable', async () => {
      await enableMessaging(world);
      expect(JSON.parse(storedValue()!)).toEqual({ pubky: OWNER, exported: `exported-session:${OWNER}` });
    });

    it('restores the session silently after a reload, and link operations work without re-enable', async () => {
      await enableMessaging(world);
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });
      simulateReload();
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(false);

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(true);
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(true);
      expect(world.calls).toContain('restoreSession');
      // The restored session drives link operations directly.
      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
      expect(state).toEqual({ status: 'handshaking', role: 'initiator' });
    });

    it('link operations self-restore after a reload without an explicit restore call', async () => {
      await enableMessaging(world);
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });
      simulateReload();

      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
      expect(state).toEqual({ status: 'handshaking', role: 'initiator' });
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(true);
    });

    it('leaves another account\u2019s persisted blob in place without a restore attempt, then falls through to cookie resume', async () => {
      await enableMessaging(world);
      simulateReload();
      const foreign = JSON.stringify({ pubky: COUNTERPARTY, exported: `exported-session:${COUNTERPARTY}` });
      window.localStorage.setItem('pubky.messaging.session.v1', foreign);

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(false);
      expect(storedValue()).toBe(foreign);
      // The foreign blob is never sent to the homeserver; the only network
      // attempt is the cookie resume for the CURRENT account (unauthorized here).
      expect(world.calls).not.toContain('restoreSession');
      expect(world.calls).toContain('resumeSessionFromCookie');
    });

    it('drops a malformed persisted blob', async () => {
      window.localStorage.setItem('pubky.messaging.session.v1', 'not json');
      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(false);
      expect(storedValue()).toBeNull();
    });

    it('clears the blob and reports false when the homeserver rejects the restore (expired cookie)', async () => {
      await enableMessaging(world);
      simulateReload();
      world.restoreRejects = true;

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(false);
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(false);
      expect(storedValue()).toBeNull();
      // The surfaces now show the honest reconnect state.
      await expect(PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY)).rejects.toThrow(
        /No active messaging session/,
      );
    });

    it('a failed restore removes only the export it read, never a newer one another tab saved meanwhile', async () => {
      await enableMessaging(world);
      simulateReload();
      world.restoreRejects = true;
      const newer = JSON.stringify({ pubky: OWNER, exported: `exported-session:${OWNER}:newer` });
      world.duringRestore = () => window.localStorage.setItem('pubky.messaging.session.v1', newer);

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(false);
      expect(storedValue()).toBe(newer);
    });

    it('a restore that lands after another tab saved a newer export does not write the older one back', async () => {
      await enableMessaging(world);
      simulateReload();
      const newer = JSON.stringify({ pubky: OWNER, exported: `exported-session:${OWNER}:newer` });
      world.duringRestore = () => window.localStorage.setItem('pubky.messaging.session.v1', newer);

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(true);
      expect(storedValue()).toBe(newer);
    });

    it('rejects a restored session whose identity does not match the expected account', async () => {
      await enableMessaging(world);
      simulateReload();
      world.restoredPubkyOverride = COUNTERPARTY;

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(false);
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(false);
      expect(storedValue()).toBeNull();
    });

    it('sign-out clears BOTH the in-memory session and the persisted metadata', async () => {
      await enableMessaging(world);
      expect(storedValue()).not.toBeNull();
      PaykitMessagingService.clearSession();
      expect(storedValue()).toBeNull();
      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(false);
    });
  });

  describe('zero-approval cookie resume', () => {
    const storedValue = () => window.localStorage.getItem('pubky.messaging.session.v1');

    it('follows the resume order: an in-memory session short-circuits both restore paths', async () => {
      await enableMessaging(world);
      world.calls.length = 0;

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(true);

      expect(world.calls).not.toContain('restoreSession');
      expect(world.calls).not.toContain('resumeSessionFromCookie');
    });

    it('follows the resume order: a valid persisted restore wins and cookie resume is never attempted', async () => {
      await enableMessaging(world);
      const persisted = storedValue();
      PaykitMessagingService.clearSession();
      window.localStorage.setItem('pubky.messaging.session.v1', persisted!);
      world.cookieResume = 'success';
      world.calls.length = 0;

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(true);

      expect(world.calls).toContain('restoreSession');
      expect(world.calls).not.toContain('resumeSessionFromCookie');
    });

    it('resumes purely from the sign-in cookie with ZERO signer approvals and provisions the receiver', async () => {
      // Fresh account state: no enable flow ever ran, no persisted blob, no
      // receiver key — exactly a first visit after signing in with the
      // combined grant.
      world.cookieResume = 'success';

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(true);

      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(true);
      expect(world.calls).toContain('resumeSessionFromCookie');
      expect(world.calls).not.toContain('startAuthFlow');
      // Persisted like the approval path, so the next load takes the
      // restoreSession fast path.
      expect(JSON.parse(storedValue()!)).toEqual({ pubky: OWNER, exported: `exported-session:${OWNER}` });
      // Receiver key + marker provisioned automatically on first use.
      expect(world.calls).toContain('publishReceiverMarker');
      await expect(PaykitMessagingService.isReceiverProvisioned(OWNER)).resolves.toBe(true);
      const receiver = await LocalMessagingService.getReceiver(OWNER);
      expect(receiver?.noise_secret).toHaveLength(32);
    });

    it('after a cookie resume, the next load restores from the persisted metadata without re-running cookie resume', async () => {
      world.cookieResume = 'success';
      await PaykitMessagingService.restorePersistedSession(OWNER);
      const persisted = storedValue();
      PaykitMessagingService.clearSession();
      window.localStorage.setItem('pubky.messaging.session.v1', persisted!);
      world.calls.length = 0;

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(true);

      expect(world.calls).toContain('restoreSession');
      expect(world.calls).not.toContain('resumeSessionFromCookie');
    });

    it('falls through to cookie resume when the persisted restore is rejected (expired metadata, fresh sign-in cookie)', async () => {
      await enableMessaging(world);
      const persisted = storedValue();
      PaykitMessagingService.clearSession();
      window.localStorage.setItem('pubky.messaging.session.v1', persisted!);
      world.restoreRejects = true;
      world.cookieResume = 'success';
      world.calls.length = 0;

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(true);

      const restoreIndex = world.calls.indexOf('restoreSession');
      const cookieIndex = world.calls.indexOf('resumeSessionFromCookie');
      expect(restoreIndex).toBeGreaterThanOrEqual(0);
      expect(cookieIndex).toBeGreaterThan(restoreIndex);
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(true);
      expect(JSON.parse(storedValue()!)).toEqual({ pubky: OWNER, exported: `exported-session:${OWNER}` });
    });

    it('reports the honest enable state for a legacy session without the paykit scope (SessionResumeScopeMissing)', async () => {
      world.cookieResume = 'scope-missing';

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(false);

      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(false);
      expect(storedValue()).toBeNull();
      expect(world.calls).not.toContain('publishReceiverMarker');
      await expect(PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY)).rejects.toThrow(
        /No active messaging session/,
      );
    });

    it('after a pubky.app sign-in drops /pub/paykit from the cookie, the enable approval asks for both sites', async () => {
      world.cookieResume = 'scope-missing';
      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(false);

      const enabled = await enableMessaging(world);

      expect(world.calls).toContain(
        'startAuthFlow:/pub/pubky.app/:rw,/pub/paykit/:rw,/priv/pubky.app/:rw,/priv/social/:rw,/priv/app.locks/content/:r',
      );
      expect(enabled.pubky).toBe(OWNER);
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(true);
    });

    it('spaces failed silent resumes instead of retrying on every status poll, and sign-out resets them', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      world.cookieResume = 'unauthorized';

      for (let elapsed = 0; elapsed <= 60_000; elapsed += POLL_MS) {
        await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(false);
        advanceClock(POLL_MS);
      }
      // Attempts at 0, 4, 10, 20 and 40 s with the minimum jitter.
      expect(world.calls.filter((call) => call === 'resumeSessionFromCookie')).toHaveLength(5);

      PaykitMessagingService.clearSession();
      world.cookieResume = 'success';
      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(true);
    });

    it('reports no session when the homeserver holds nothing behind the cookies (SessionResumeUnauthorized)', async () => {
      world.cookieResume = 'unauthorized';

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(false);

      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(false);
      expect(world.calls).toContain('resumeSessionFromCookie');
    });

    it('rejects a cookie-resumed session whose identity does not match the expected account', async () => {
      world.cookieResume = 'success';
      world.cookieResumePubkyOverride = COUNTERPARTY;

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(false);

      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(false);
      expect(PaykitMessagingService.hasActiveSession(COUNTERPARTY)).toBe(false);
      expect(storedValue()).toBeNull();
    });

    it('link operations self-resume from the cookie alone (messages ready straight after sign-in)', async () => {
      world.cookieResume = 'success';
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });

      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'handshaking', role: 'initiator' });
      expect(world.calls).not.toContain('startAuthFlow');
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(true);
    });

    it('keeps the session when receiver provisioning fails transiently and retries on a spaced schedule', async () => {
      world.cookieResume = 'success';
      world.publishMarkerFailures = 1;

      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(true);
      expect(PaykitMessagingService.hasActiveSession(OWNER)).toBe(true);
      await expect(PaykitMessagingService.isReceiverProvisioned(OWNER)).resolves.toBe(false);

      // The next status poll is too soon: no second publish.
      advanceClock(POLL_MS / 2);
      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(true);
      expect(world.calls.filter((call) => call === 'publishReceiverMarker')).toHaveLength(1);

      // Once due (the scripted failure is consumed): provisioning heals
      // without any signer involvement, reusing the already-generated key.
      const before = await LocalMessagingService.getReceiver(OWNER);
      advanceClock(MESSAGING_RETRY_POLICY.baseMs);
      await expect(PaykitMessagingService.restorePersistedSession(OWNER)).resolves.toBe(true);
      await expect(PaykitMessagingService.isReceiverProvisioned(OWNER)).resolves.toBe(true);
      const after = await LocalMessagingService.getReceiver(OWNER);
      expect(after?.noise_secret).toEqual(before?.noise_secret);
    });
  });

  describe('at-rest wrapping of key material', () => {
    it('stores the receiver Noise secret WRAPPED — never plaintext — and unwraps it on read', async () => {
      const enabled = await enableMessaging(world);

      // The fake binding's first generated secret is deterministic (fill(1)).
      const raw = await CommerceMessagingReceiverModel.findById(OWNER);
      expect(raw?.wrap_version).toBe(WRAP_VERSION_AES_GCM_256);
      expect(raw?.noise_secret.byteLength).toBe(WRAP_IV_BYTES + 32 + 16);
      expect([...(raw?.noise_secret ?? [])]).not.toEqual([...new Uint8Array(32).fill(1)]);

      // The service read unwraps transparently.
      const receiver = await LocalMessagingService.getReceiver(OWNER);
      expect([...(receiver?.noise_secret ?? [])]).toEqual([...new Uint8Array(32).fill(1)]);
      expect(receiver?.noise_public_key).toBe(enabled.noisePublicKey);
    });

    it('stores link snapshots WRAPPED — never plaintext — and unwraps them on read', async () => {
      await enableMessaging(world);
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      // The fake handshake's initial snapshot is [72, 1, 0] followed by the key it is bound to.
      const initial = [72, 1, 0, ...new TextEncoder().encode('p'.repeat(52))];
      const raw = await CommerceMessagingLinkModel.findById(`${OWNER}:${COUNTERPARTY}`);
      expect(raw?.wrap_version).toBe(WRAP_VERSION_AES_GCM_256);
      expect([...(raw?.snapshot ?? [])]).not.toEqual(initial);

      const link = await LocalMessagingService.getLink(OWNER, COUNTERPARTY);
      expect([...(link?.snapshot ?? [])]).toEqual(initial);
    });

    it('treats the receiver as lost when the wrapping key is gone, and re-enable re-provisions it', async () => {
      await enableMessaging(world);
      await expect(LocalMessagingService.getReceiver(OWNER)).resolves.not.toBeNull();

      // The wrapping key is lost (profile wiped without the database): the
      // stored receiver ciphertext can never authenticate again.
      await resetMessagingKeyringForTests();
      await expect(LocalMessagingService.getReceiver(OWNER)).resolves.toBeNull();
      await expect(PaykitMessagingService.isReceiverProvisioned(OWNER)).resolves.toBe(false);

      // The existing re-enable affordance: provisioning generates a FRESH
      // receiver secret (the fake's second key, fill(2)), stored wrapped under
      // the newly generated wrapping key, and republishes the marker.
      PaykitMessagingService.clearSession();
      await enableMessaging(world);
      const receiver = await LocalMessagingService.getReceiver(OWNER);
      expect([...(receiver?.noise_secret ?? [])]).toEqual([...new Uint8Array(32).fill(2)]);
      expect(receiver?.marker_published).toBe(true);
      const raw = await CommerceMessagingReceiverModel.findById(OWNER);
      expect(raw?.wrap_version).toBe(WRAP_VERSION_AES_GCM_256);
      expect(raw?.noise_secret.byteLength).toBe(WRAP_IV_BYTES + 32 + 16);
    });

    it('treats a tampered link snapshot as lost and starts a fresh handshake instead of restoring', async () => {
      await enableMessaging(world);
      world.markers.set(COUNTERPARTY, { receiverPath: 'marketplace/wallet', noisePublicKey: 'p'.repeat(52) });
      world.advanceScript.push('complete');
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      // Tamper with the stored (wrapped) snapshot bytes directly at the model layer.
      const raw = await CommerceMessagingLinkModel.findById(`${OWNER}:${COUNTERPARTY}`);
      const tampered = new Uint8Array(raw!.snapshot);
      tampered[tampered.byteLength - 1] ^= 0xff;
      await CommerceMessagingLinkModel.upsert({ ...raw!, snapshot: tampered });

      // Reload: the link row reads as LOST, so discovery starts over instead
      // of feeding corrupt bytes to the binding.
      PaykitMessagingService.clearSession();
      await enableMessaging(world);
      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'handshaking', role: 'initiator' });
      expect(world.calls).toContain('initiateEncryptedLink');
      expect(world.calls).not.toContain('restoreEncryptedLink');
    });
  });

  describe('counterparty key pinning (trust on first use)', () => {
    const P_KEY = 'p'.repeat(52);
    const Q_KEY = 'q'.repeat(52);
    const R_KEY = 'r'.repeat(52);
    const markerFor = (noisePublicKey: string) => ({ receiverPath: 'marketplace/wallet', noisePublicKey });
    const inboundDm = (body: string) => {
      const rawJson = JSON.stringify({
        version: 1,
        kind: 'pubky_app.dm.v0',
        event_id: crypto.randomUUID(),
        sent_at: '2026-08-21T10:00:00.000Z',
        body,
      });
      return { version: 1, kind: 'pubky_app.dm.v0', rawJson };
    };

    /** An established link on P_KEY, then a reload: only the stored rows survive. */
    async function establishThenReload() {
      await enableMessaging(world);
      world.markers.set(COUNTERPARTY, markerFor(P_KEY));
      world.advanceScript.push('complete');
      await expect(PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY)).resolves.toEqual({ status: 'ready' });
      PaykitMessagingService.clearSession();
      await enableMessaging(world);
      world.calls = [];
    }

    beforeEach(() => MessagingApplication.clearMessagingSession());
    afterEach(() => MessagingApplication.clearMessagingSession());

    async function holdForQ() {
      await establishThenReload();
      world.markers.set(COUNTERPARTY, markerFor(Q_KEY));
      await expect(PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY)).resolves.toEqual({
        status: 'key-changed',
        pinnedKey: P_KEY,
        observedKey: Q_KEY,
      });
    }

    it('pins the key of the first link', async () => {
      await enableMessaging(world);
      world.markers.set(COUNTERPARTY, markerFor(P_KEY));
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      await expect(LocalMessagingService.getPeerKeyPin(OWNER, COUNTERPARTY)).resolves.toEqual({
        pinnedKey: P_KEY,
        observedKey: null,
        changedAt: null,
      });
    });

    it('holds an established link when the marker advertises another key: nothing is sent or started', async () => {
      await holdForQ();

      await expect(LocalMessagingService.getPeerKeyPin(OWNER, COUNTERPARTY)).resolves.toMatchObject({
        pinnedKey: P_KEY,
        observedKey: Q_KEY,
      });
      await expect(PaykitMessagingService.sendDmMessage(OWNER, COUNTERPARTY, { body: 'hi' })).rejects.toMatchObject({
        context: { linkStatus: 'key-changed' },
      });
      const queued = await MessagingApplication.sendOrQueueDmMessage(OWNER, COUNTERPARTY, 'later', ADMIT_ALL_POLICY);
      expect(queued.delivered).toBe(false);
      expect(world.sentCounters).toEqual([]);
      expect(world.calls).not.toContain('link.send');
      expect(world.calls).not.toContain('initiateEncryptedLink');
      expect(world.calls).not.toContain('acceptEncryptedLink');
      // The pin is unchanged: the link row still names the first key.
      await expect(LocalMessagingService.getLink(OWNER, COUNTERPARTY)).resolves.toMatchObject({
        remote_noise_public_key: P_KEY,
        status: 'established',
      });
    });

    it('keeps receiving on the pinned link while held, and flushes nothing', async () => {
      await holdForQ();
      await MessagingApplication.sendOrQueueDmMessage(OWNER, COUNTERPARTY, 'waiting', ADMIT_ALL_POLICY);
      world.links.at(-1)!.inboundQueue.push(inboundDm('sent before they changed devices'));

      advanceClock(MESSAGING_RETRY_POLICY.maxMs);
      const polled = await MessagingApplication.pollConversation(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY);

      expect(polled.state).toEqual({ status: 'key-changed', pinnedKey: P_KEY, observedKey: Q_KEY });
      expect(polled.received.map((message) => message.body)).toEqual(['sent before they changed devices']);
      expect(polled.flushed).toBe(0);
      expect(world.sentCounters).toEqual([]);
      await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toHaveLength(1);
    });

    it('inbox sync receives on a held pair without sending', async () => {
      await holdForQ();
      await MessagingApplication.sendOrQueueDmMessage(OWNER, COUNTERPARTY, 'waiting', ADMIT_ALL_POLICY);
      world.links.at(-1)!.inboundQueue.push(inboundDm('hello from the pinned key'));

      advanceClock(MESSAGING_RETRY_POLICY.maxMs);
      await MessagingApplication.syncCounterparties(OWNER, [], { policy: ADMIT_ALL_POLICY });

      const messages = await LocalMessagingService.getMessages(OWNER, `dm:${COUNTERPARTY}`);
      expect(messages.map((message) => message.body)).toEqual(['hello from the pinned key']);
      expect(world.sentCounters).toEqual([]);
    });

    it('a held pair still completes its pending handshake on the pinned key, and receives but sends nothing', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      await enableMessaging(world);
      world.markers.set(COUNTERPARTY, markerFor(P_KEY));
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
      PaykitMessagingService.clearSession();
      await enableMessaging(world);
      world.markers.set(COUNTERPARTY, markerFor(Q_KEY));
      await expect(PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY)).resolves.toMatchObject({
        status: 'key-changed',
      });
      await MessagingApplication.sendOrQueueDmMessage(OWNER, COUNTERPARTY, 'held back', ADMIT_ALL_POLICY);

      // The device holding the pinned key answers the handshake.
      world.calls = [];
      world.advanceScript.push('complete');
      advanceClock(MESSAGING_RETRY_POLICY.maxMs);
      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'key-changed', pinnedKey: P_KEY, observedKey: Q_KEY });
      await expect(LocalMessagingService.getLink(OWNER, COUNTERPARTY)).resolves.toMatchObject({
        status: 'established',
        remote_noise_public_key: P_KEY,
        observed_noise_public_key: Q_KEY,
      });
      const pinnedLink = world.links.at(-1)!;
      expect(pinnedLink.remoteNoisePublicKey()).toBe(P_KEY);
      pinnedLink.inboundQueue.push(inboundDm('answered from the pinned key'));
      await expect(PaykitMessagingService.receiveMessages(OWNER, COUNTERPARTY, ADMIT_ALL_GATE)).resolves.toMatchObject([
        { body: 'answered from the pinned key' },
      ]);
      await expect(MessagingApplication.flushOutbox(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY)).resolves.toEqual({
        delivered: 0,
        remaining: 1,
      });
      expect(world.sentCounters).toEqual([]);
      expect(world.calls).not.toContain('acceptEncryptedLink');
    });

    it('accepting the shown key moves the pair to it, re-pins, and sends what was queued once ready', async () => {
      await holdForQ();
      const oldLink = world.links.at(-1)!;
      await MessagingApplication.sendOrQueueDmMessage(OWNER, COUNTERPARTY, 'queued while held', ADMIT_ALL_POLICY);
      // A flush that failed while the pair was held leaves a retry waiting; accepting does not wait it out.
      await MessagingApplication.flushOutbox(OWNER, COUNTERPARTY, ADMIT_ALL_POLICY);
      // Their new device already initiated toward us with the new key.
      world.inboundFrom.add(COUNTERPARTY);
      world.responderCompletes.add(COUNTERPARTY);
      world.calls = [];

      const state = await MessagingApplication.acceptCounterpartyKey(OWNER, COUNTERPARTY, Q_KEY, ADMIT_ALL_POLICY);

      expect(state).toEqual({ status: 'ready' });
      expect(world.calls).toContain('acceptEncryptedLink');
      expect(oldLink.closed).toBe(true);
      const newLink = world.links.at(-1)!;
      expect(newLink).not.toBe(oldLink);
      expect(newLink.remoteNoisePublicKey()).toBe(Q_KEY);
      await expect(LocalMessagingService.getPeerKeyPin(OWNER, COUNTERPARTY)).resolves.toEqual({
        pinnedKey: Q_KEY,
        observedKey: null,
        changedAt: null,
      });
      expect(newLink.sent.map((raw) => JSON.parse(raw).body)).toEqual(['queued while held']);
      expect(oldLink.sent).toEqual([]);
      await expect(LocalMessagingService.getQueuedMessages(OWNER, COUNTERPARTY)).resolves.toEqual([]);
    });

    it('accepting initiates on the accepted key when nothing inbound waits', async () => {
      await holdForQ();
      world.calls = [];

      const state = await PaykitMessagingService.acceptCounterpartyKey(OWNER, COUNTERPARTY, Q_KEY);

      expect(state).toEqual({ status: 'handshaking', role: 'initiator' });
      expect(world.calls).toContain('initiateEncryptedLink');
      await expect(LocalMessagingService.getLink(OWNER, COUNTERPARTY)).resolves.toMatchObject({
        status: 'handshaking',
        role: 'initiator',
        remote_noise_public_key: Q_KEY,
      });
      await expect(LocalMessagingService.getPeerKeyPin(OWNER, COUNTERPARTY)).resolves.toMatchObject({
        observedKey: null,
      });
    });

    it('accepts nothing when the marker moved on to yet another key, and shows that key instead', async () => {
      await holdForQ();
      world.markers.set(COUNTERPARTY, markerFor(R_KEY));
      world.calls = [];

      const state = await PaykitMessagingService.acceptCounterpartyKey(OWNER, COUNTERPARTY, Q_KEY);

      expect(state).toEqual({ status: 'key-changed', pinnedKey: P_KEY, observedKey: R_KEY });
      expect(world.calls).not.toContain('initiateEncryptedLink');
      expect(world.calls).not.toContain('acceptEncryptedLink');
      await expect(LocalMessagingService.getLink(OWNER, COUNTERPARTY)).resolves.toMatchObject({
        remote_noise_public_key: P_KEY,
      });
    });

    it('never pins a key the user was not shown: Q shown, the marker moves to R, accepting R is refused and re-prompts', async () => {
      await holdForQ();
      world.markers.set(COUNTERPARTY, markerFor(R_KEY));
      world.calls = [];

      const refused = await PaykitMessagingService.acceptCounterpartyKey(OWNER, COUNTERPARTY, R_KEY);

      expect(refused).toEqual({ status: 'key-changed', pinnedKey: P_KEY, observedKey: R_KEY });
      expect(world.calls).not.toContain('initiateEncryptedLink');
      expect(world.calls).not.toContain('acceptEncryptedLink');
      await expect(LocalMessagingService.getPeerKeyPin(OWNER, COUNTERPARTY)).resolves.toMatchObject({
        pinnedKey: P_KEY,
        observedKey: R_KEY,
      });

      // R has now been shown, so accepting R is the user's decision.
      await expect(PaykitMessagingService.acceptCounterpartyKey(OWNER, COUNTERPARTY, R_KEY)).resolves.toEqual({
        status: 'handshaking',
        role: 'initiator',
      });
      await expect(LocalMessagingService.getPeerKeyPin(OWNER, COUNTERPARTY)).resolves.toMatchObject({
        pinnedKey: R_KEY,
        observedKey: null,
      });
    });

    it('refuses a key that was never shown or published, and changes nothing', async () => {
      await holdForQ();
      world.calls = [];

      const refused = await PaykitMessagingService.acceptCounterpartyKey(OWNER, COUNTERPARTY, 's'.repeat(52));

      expect(refused).toEqual({ status: 'key-changed', pinnedKey: P_KEY, observedKey: Q_KEY });
      expect(world.calls).not.toContain('initiateEncryptedLink');
      expect(world.calls).not.toContain('acceptEncryptedLink');
      await expect(LocalMessagingService.getLink(OWNER, COUNTERPARTY)).resolves.toMatchObject({
        remote_noise_public_key: P_KEY,
        status: 'established',
      });
    });

    it('accepts nothing while the marker cannot be read', async () => {
      await holdForQ();
      PaykitMessagingService.setMarkerReadSleepForTests(async () => undefined);
      world.markerReadFailures.set(COUNTERPARTY, { message: RAW_MARKER_TRANSPORT_ERROR, remaining: Infinity });
      world.calls = [];

      await expect(PaykitMessagingService.acceptCounterpartyKey(OWNER, COUNTERPARTY, Q_KEY)).rejects.toMatchObject({
        name: 'MarkerReadFailure',
      });
      expect(world.calls).not.toContain('initiateEncryptedLink');
      await expect(LocalMessagingService.getPeerKeyPin(OWNER, COUNTERPARTY)).resolves.toMatchObject({
        pinnedKey: P_KEY,
        observedKey: Q_KEY,
      });
      PaykitMessagingService.setMarkerReadSleepForTests(null);
    });

    it('clears the hold on its own once the marker advertises the pinned key again', async () => {
      await holdForQ();
      world.markers.set(COUNTERPARTY, markerFor(P_KEY));

      advanceClock(POLL_MS);
      await expect(PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY)).resolves.toMatchObject({
        status: 'key-changed',
      });
      advanceClock(MESSAGING_RETRY_POLICY.maxMs);
      await expect(PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY)).resolves.toEqual({ status: 'ready' });

      await expect(LocalMessagingService.getPeerKeyPin(OWNER, COUNTERPARTY)).resolves.toMatchObject({
        pinnedKey: P_KEY,
        observedKey: null,
      });
      await PaykitMessagingService.sendDmMessage(OWNER, COUNTERPARTY, { body: 'back on the pinned key' });
      expect(world.sentCounters).toHaveLength(1);
    });

    it('never starts a handshake on a new key for a pair whose snapshot no longer opens', async () => {
      await enableMessaging(world);
      world.markers.set(COUNTERPARTY, markerFor(P_KEY));
      world.advanceScript.push('complete');
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
      const raw = await CommerceMessagingLinkModel.findById(`${OWNER}:${COUNTERPARTY}`);
      const tampered = new Uint8Array(raw!.snapshot);
      tampered[tampered.byteLength - 1] ^= 0xff;
      await CommerceMessagingLinkModel.upsert({ ...raw!, snapshot: tampered });
      PaykitMessagingService.clearSession();
      await enableMessaging(world);
      world.markers.set(COUNTERPARTY, markerFor(Q_KEY));
      world.inboundFrom.add(COUNTERPARTY);
      world.calls = [];

      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'key-changed', pinnedKey: P_KEY, observedKey: Q_KEY });
      expect(world.calls).not.toContain('initiateEncryptedLink');
      expect(world.calls).not.toContain('acceptEncryptedLink');
    });

    it('refuses a completed handshake whose link reports another key than the one it started with', async () => {
      await enableMessaging(world);
      world.markers.set(COUNTERPARTY, markerFor(P_KEY));
      world.linkKeyOverride = Q_KEY;
      world.advanceScript.push('complete');

      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'recovery-needed', reason: 'link-key-mismatch' });
      expect(world.links.at(-1)!.closed).toBe(true);
      await expect(LocalMessagingService.getLink(OWNER, COUNTERPARTY)).resolves.toMatchObject({
        status: 'handshaking',
        remote_noise_public_key: P_KEY,
      });
      await expect(PaykitMessagingService.sendDmMessage(OWNER, COUNTERPARTY, { body: 'x' })).rejects.toThrow();
      expect(world.sentCounters).toEqual([]);
    });

    it('refuses an answered inbound link that reports another key than the one it was answered with', async () => {
      await enableMessaging(world);
      world.markers.set(COUNTERPARTY, markerFor(P_KEY));
      world.inboundFrom.add(COUNTERPARTY);
      world.responderCompletes.add(COUNTERPARTY);
      world.linkKeyOverride = Q_KEY;

      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'recovery-needed', reason: 'link-key-mismatch' });
      expect(world.links.at(-1)!.closed).toBe(true);
      await expect(LocalMessagingService.getLink(OWNER, COUNTERPARTY)).resolves.toBeNull();
    });

    it('refuses to restore an established link that reports another key than its pin', async () => {
      await establishThenReload();
      world.linkKeyOverride = Q_KEY;

      const state = await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(state).toEqual({ status: 'recovery-needed', reason: 'link-key-mismatch' });
      expect(world.links.at(-1)!.closed).toBe(true);
      await expect(PaykitMessagingService.sendDmMessage(OWNER, COUNTERPARTY, { body: 'x' })).rejects.toThrow();
      expect(world.sentCounters).toEqual([]);
    });

    it('a pending handshake on the pinned key does not answer a crossed handshake on a new key', async () => {
      // OWNER ('a…') sorts before COUNTERPARTY ('z…'), so it is the side that probes for a crossed handshake.
      await enableMessaging(world);
      world.markers.set(COUNTERPARTY, markerFor(P_KEY));
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);
      world.markers.set(COUNTERPARTY, markerFor(Q_KEY));
      world.inboundFrom.add(COUNTERPARTY);
      world.calls = [];

      advanceClock(MESSAGING_RETRY_POLICY.maxMs);
      await PaykitMessagingService.ensureLink(OWNER, COUNTERPARTY);

      expect(world.calls).not.toContain('acceptEncryptedLink');
    });

    it('reads the pinned and changed keys for the Verify step', async () => {
      await holdForQ();

      await expect(PaykitMessagingService.getMessagingKeys(OWNER, COUNTERPARTY)).resolves.toEqual({
        ownKey: (await LocalMessagingService.getReceiver(OWNER))!.noise_public_key,
        pinnedKey: P_KEY,
        observedKey: Q_KEY,
      });
    });
  });

  describe('own marker check', () => {
    const OTHER_KEY = 'x'.repeat(52);

    /** A receiver published by an earlier load, then a reload that resumes from the cookie. */
    async function publishedThenReload() {
      world.cookieResume = 'success';
      await PaykitMessagingService.restorePersistedSession(OWNER);
      PaykitMessagingService.clearSession();
      world.cookieResume = 'success';
      world.calls = [];
    }

    const ownKey = async () => (await LocalMessagingService.getReceiver(OWNER))!.noise_public_key;

    it('republishes this device key when the published marker advertises another one, and says so once', async () => {
      await publishedThenReload();
      world.markers.set(OWNER, { receiverPath: 'marketplace/wallet', noisePublicKey: OTHER_KEY });

      const status = await MessagingApplication.getStatus(OWNER);

      expect(status).toEqual({ sessionActive: true, receiverProvisioned: true, ownKeyRepublished: 'replaced' });
      expect(world.calls.filter((call) => call === 'publishReceiverMarker')).toHaveLength(1);
      expect(world.lastPublishedMarker?.noisePublicKey).toBe(await ownKey());
      expect(world.calls).not.toContain('generateNoiseSecretKey');
      // Told once; checked once per session.
      await expect(MessagingApplication.getStatus(OWNER)).resolves.toMatchObject({ ownKeyRepublished: null });
      expect(world.calls.filter((call) => call === 'publishReceiverMarker')).toHaveLength(1);
    });

    it('republishes it when no marker is published', async () => {
      await publishedThenReload();
      world.markers.delete(OWNER);

      await expect(MessagingApplication.getStatus(OWNER)).resolves.toMatchObject({ ownKeyRepublished: 'missing' });
      expect(world.markers.get(OWNER)?.noisePublicKey).toBe(await ownKey());
    });

    it('changes nothing when the published marker advertises this device key', async () => {
      await publishedThenReload();

      await expect(MessagingApplication.getStatus(OWNER)).resolves.toMatchObject({ ownKeyRepublished: null });
      expect(world.calls).toContain(`getReceiverMarker:${OWNER.slice(0, 4)}`);
      expect(world.calls).not.toContain('publishReceiverMarker');
    });

    it('publishes nothing on a failed read, and checks again on the spaced schedule', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      vi.spyOn(Logger, 'warn').mockImplementation(() => {});
      PaykitMessagingService.setMarkerReadSleepForTests(async () => undefined);
      await publishedThenReload();
      world.markers.set(OWNER, { receiverPath: 'marketplace/wallet', noisePublicKey: OTHER_KEY });
      world.markerReadFailures.set(OWNER, { message: RAW_MARKER_TRANSPORT_ERROR, remaining: Infinity });

      await expect(MessagingApplication.getStatus(OWNER)).resolves.toMatchObject({
        sessionActive: true,
        ownKeyRepublished: null,
      });
      expect(world.calls).not.toContain('publishReceiverMarker');

      world.markerReadFailures.delete(OWNER);
      await expect(MessagingApplication.getStatus(OWNER)).resolves.toMatchObject({ ownKeyRepublished: null });
      expect(world.calls).not.toContain('publishReceiverMarker');

      advanceClock(MESSAGING_RETRY_POLICY.maxMs);
      await expect(MessagingApplication.getStatus(OWNER)).resolves.toMatchObject({ ownKeyRepublished: 'replaced' });
      expect(world.lastPublishedMarker?.noisePublicKey).toBe(await ownKey());
      PaykitMessagingService.setMarkerReadSleepForTests(null);
    });

    it('status reads retried while the check is slow join it: one marker read, one receiver lock', async () => {
      await publishedThenReload();
      await PaykitMessagingService.restorePersistedSession(OWNER, { provision: false });
      world.calls = [];
      let release = () => {};
      world.markerReadHold = new Promise<void>((resolve) => (release = resolve));
      const lockRequests = vi.spyOn(navigator.locks, 'request');

      const reads = [
        MessagingApplication.getStatus(OWNER),
        MessagingApplication.getStatus(OWNER),
        MessagingApplication.getStatus(OWNER),
      ];
      await vi.waitFor(() => expect(world.calls).toContain(`getReceiverMarker:${OWNER.slice(0, 4)}`));
      const receiverLocks = () =>
        lockRequests.mock.calls.filter(([name]) => String(name).startsWith('pubky-messaging-receiver|')).length;
      expect(receiverLocks()).toBe(1);

      world.markerReadHold = null;
      release();
      await expect(Promise.all(reads)).resolves.toEqual([
        expect.objectContaining({ sessionActive: true, ownKeyRepublished: null }),
        expect.objectContaining({ sessionActive: true, ownKeyRepublished: null }),
        expect.objectContaining({ sessionActive: true, ownKeyRepublished: null }),
      ]);
      expect(world.calls.filter((call) => call.startsWith('getReceiverMarker'))).toHaveLength(1);
      expect(receiverLocks()).toBe(1);
    });

    it('a notice put back is told once by the next take, only while the session is live, never over a newer one', async () => {
      await publishedThenReload();
      await PaykitMessagingService.restorePersistedSession(OWNER, { provision: false });

      PaykitMessagingService.returnOwnMarkerRepublished(OWNER, 'replaced');
      PaykitMessagingService.returnOwnMarkerRepublished(OWNER, 'missing');
      expect(PaykitMessagingService.takeOwnMarkerRepublished(OWNER)).toBe('replaced');
      expect(PaykitMessagingService.takeOwnMarkerRepublished(OWNER)).toBeNull();

      PaykitMessagingService.clearSession();
      PaykitMessagingService.returnOwnMarkerRepublished(OWNER, 'missing');
      expect(PaykitMessagingService.takeOwnMarkerRepublished(OWNER)).toBeNull();
    });

    it('forgets an untold notice on sign-out', async () => {
      await publishedThenReload();
      world.markers.delete(OWNER);
      await PaykitMessagingService.restorePersistedSession(OWNER);

      PaykitMessagingService.clearSession();

      expect(PaykitMessagingService.takeOwnMarkerRepublished(OWNER)).toBeNull();
    });
  });

  describe('plaintext written by an older build still open in another tab', () => {
    const plaintextRow = (suffix: string) => ({
      id: `${OWNER}:old-build-${suffix}`,
      owner_id: OWNER,
      conversation_id: `dm:${COUNTERPARTY}`,
      listing_ref: null,
      counterparty_pubky: COUNTERPARTY,
      direction: 'sent' as const,
      body: `written by the old build ${suffix}`,
      sent_at: 1,
      recorded_at: 1,
    });

    beforeEach(() => MessagingApplication.clearMessagingSession());
    afterEach(() => MessagingApplication.clearMessagingSession());

    it('is sealed by the next status read, at most once per interval', async () => {
      await enableMessaging(world);
      await CommerceMessagingMessageModel.table.put(plaintextRow('a'));

      await MessagingApplication.getStatus(OWNER);
      await expect(CommerceMessagingMessageModel.table.get(`${OWNER}:old-build-a`)).resolves.toMatchObject({
        body: '',
        wrap_version: WRAP_VERSION_AES_GCM_256,
      });

      await CommerceMessagingMessageModel.table.put(plaintextRow('b'));
      await MessagingApplication.getStatus(OWNER);
      await expect(CommerceMessagingMessageModel.table.get(`${OWNER}:old-build-b`)).resolves.toMatchObject({
        body: 'written by the old build b',
      });

      advanceClock(MESSAGING_PLAINTEXT_SWEEP_INTERVAL_MS);
      await MessagingApplication.getStatus(OWNER);
      await expect(CommerceMessagingMessageModel.table.get(`${OWNER}:old-build-b`)).resolves.toMatchObject({
        body: '',
        wrap_version: WRAP_VERSION_AES_GCM_256,
      });
      const [opened] = await LocalMessagingService.getMessages(OWNER, `dm:${COUNTERPARTY}`).then((rows) =>
        rows.filter((row) => row.id === `${OWNER}:old-build-b`),
      );
      expect(opened.body).toBe('written by the old build b');
    });

    it('a sweep that does not settle holds the status read for the bounded wait only', async () => {
      await enableMessaging(world);
      let finish = () => {};
      const sweep = vi
        .spyOn(LocalMessagingService, 'sealPlaintextHistory')
        .mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
      const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
      const started = performance.now();

      await expect(MessagingApplication.getStatus(OWNER)).resolves.toMatchObject({ sessionActive: true });

      const waited = performance.now() - started;
      expect(waited).toBeGreaterThanOrEqual(MESSAGING_PLAINTEXT_SWEEP_WAIT_MS - 50);
      expect(waited).toBeLessThan(MESSAGING_PLAINTEXT_SWEEP_WAIT_MS + 1_000);
      expect(warn).toHaveBeenCalledWith(expect.any(String), { reason: 'plaintext_sweep_slow' });
      // The next status read does not start a second sweep while this one runs.
      await MessagingApplication.getStatus(OWNER);
      expect(sweep).toHaveBeenCalledTimes(1);
      finish();
    });

    it('never fails the status read when sealing fails', async () => {
      await enableMessaging(world);
      vi.spyOn(LocalMessagingService, 'sealPlaintextHistory').mockRejectedValue(new Error('encrypt unavailable'));
      vi.spyOn(Logger, 'warn').mockImplementation(() => {});

      await expect(MessagingApplication.getStatus(OWNER)).resolves.toMatchObject({ sessionActive: true });
    });
  });
});
