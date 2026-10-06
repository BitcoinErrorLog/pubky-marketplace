// The background sync pass against the real messaging stack: controller,
// policy, application, PaykitMessagingService, Dexie and the keyring, over
// the two-party Paykit fake and an in-memory homeserver. The fake's cookie
// resume succeeds for any account, as a fresh sign-in cookie does, so any
// path that resumes and provisions the wrong account would mint and publish
// here. Account switches happen between the pass's own steps.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommercePrivKeyringApplication } from '@/application/commerce/priv-keyring';
import { FirstContactApplication } from '@/application/messaging/first-contact';
import { MessagingApplication } from '@/application/messaging/messaging';
import { UserStreamApplication } from '@/application/stream/users/users';
import { buildMarketplaceConversationAggregateId } from '@/libs/commerce/transaction-commands';
import { Logger } from '@/libs/logger/logger';
import { CONVERSATION_REQUEST_KIND, conversationRequestUrl } from '@/libs/messaging/first-contact';
import { MESSAGING_SYNC_RESUME_TIMEOUT_MS } from '@/libs/messaging/pass-deadline';
import {
  CommerceMessagingConversationModel,
  CommerceMessagingLinkModel,
  CommerceMessagingMessageModel,
  CommerceMessagingOutboxModel,
  CommerceMessagingReceiverModel,
  CommerceMessagingUnprocessedModel,
} from '@/models/messaging/messaging.models';
import type { Pubky } from '@/models/models.types';
import { LocalMessagingService } from '@/services/local/messaging/messaging';
import { PaykitMessagingService, setPaykitWasmModuleForTests } from '@/services/paykit/paykit-messaging';
import { useAuthStore } from '@/stores/auth/auth.store';
import { type FakeHomeserver, installFakeHomeserver } from '@/test-utils/fake-homeserver';
import { createFakePaykitPair } from '@/test-utils/fake-paykit-pair';
import { establishMarketplaceSession } from '@/test-utils/priv-session-replacement';
import { installWebLocks, removeWebLocks } from '@/test-utils/web-locks';
import { MessagingController } from './messaging';

vi.mock('@/libs/runtime-config/runtime-config', async () => {
  const actual = await vi.importActual<typeof import('@/libs/runtime-config/runtime-config')>(
    '@/libs/runtime-config/runtime-config',
  );
  return { ...actual, getTestnet: () => true, getCommerceAdapterMode: () => 'unavailable' };
});

// A short resume bound, so a hung resume ends within the test on real timers.
vi.mock('@/libs/messaging/pass-deadline', async () => ({
  ...(await vi.importActual<typeof import('@/libs/messaging/pass-deadline')>('@/libs/messaging/pass-deadline')),
  MESSAGING_SYNC_RESUME_TIMEOUT_MS: 50,
}));

const SELLER = 'i9cewoshwtswuzh6h7hzrjkqbkmf9d7o7kqqx7qnfp76mi3tbwiy';
const OTHER = 'ep4ej6h5xyb4ouzob63w1kwg4uuxncyj7cphd1tobcik8fg9guno';
const BUYER = 'rpkwgwckimtzc4wpz35pzbd7gyr9i8ek5toetzccby8owufhguoy';
const LISTING = '0033GVVN22HJ0FYQGZZS8R2BFC';

let homeserver: FakeHomeserver;
let pair: ReturnType<typeof createFakePaykitPair>;
let actor: string | null;

/** The account signed in on this device; `null` after a sign-out. */
function signInAs(pubky: string | null) {
  actor = pubky;
  if (pubky) establishMarketplaceSession(pubky);
}

/** `pubky` sets messaging up on this device the way an open Messages page does. */
async function setUpMessagingHere(pubky: string) {
  signInAs(pubky);
  await expect(MessagingController.getMessagingStatus()).resolves.toMatchObject({ sessionActive: true });
}

/** A browser reload: nothing in memory survives, the device's IndexedDB does. */
function reload() {
  MessagingApplication.clearMessagingSession();
  FirstContactApplication.clear();
  CommercePrivKeyringApplication.clear();
}

/** Runs `effect` right after the real `publishedReceiverKey` read number `call` of the pass. */
function afterReceiverRead(call: number, effect: () => Promise<void> | void) {
  const real = PaykitMessagingService.publishedReceiverKey.bind(PaykitMessagingService);
  let calls = 0;
  vi.spyOn(PaykitMessagingService, 'publishedReceiverKey').mockImplementation(async (pubky: string) => {
    const key = await real(pubky);
    calls += 1;
    if (calls === call) await effect();
    return key;
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(1_790_000_000_000);
  homeserver = installFakeHomeserver();
  pair = createFakePaykitPair();
  setPaykitWasmModuleForTests(pair.module);
  installWebLocks();
  actor = null;
  vi.spyOn(useAuthStore, 'getState').mockImplementation(() => ({
    ...useAuthStore.getInitialState(),
    currentUserPubky: actor as Pubky | null,
    selectCurrentUserPubky: () => {
      if (!actor) throw new Error('signed out');
      return actor as Pubky;
    },
  }));
  vi.spyOn(UserStreamApplication, 'fetchStreamIds').mockResolvedValue([]);
  await Promise.all([
    CommerceMessagingReceiverModel.clear(),
    CommerceMessagingLinkModel.clear(),
    CommerceMessagingConversationModel.clear(),
    CommerceMessagingMessageModel.clear(),
    CommerceMessagingOutboxModel.clear(),
    CommerceMessagingUnprocessedModel.clear(),
  ]);
});

afterEach(() => {
  reload();
  setPaykitWasmModuleForTests(null);
  removeWebLocks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('background sync: never mints or publishes a messaging key', () => {
  it('a status read for an account with no key here does mint and publish one (the fake can see it)', async () => {
    await setUpMessagingHere(OTHER);
    expect(await LocalMessagingService.getReceiver(OTHER)).not.toBeNull();
    expect(pair.marker(OTHER)).toBeDefined();
  });

  it('mints nothing for the account that signs in between its key check and its session resume', async () => {
    await setUpMessagingHere(SELLER);
    reload();
    afterReceiverRead(1, () => signInAs(OTHER));

    const outcome = await MessagingController.syncInboxInBackground(SELLER, () => true);

    expect(outcome).toBe('skipped');
    expect(await LocalMessagingService.getReceiver(OTHER)).toBeNull();
    expect(pair.marker(OTHER)).toBeUndefined();
    expect(PaykitMessagingService.hasActiveSession(OTHER)).toBe(false);
  });

  it('mints nothing for the account that signs in during the session resume', async () => {
    await setUpMessagingHere(SELLER);
    reload();
    const resume = MessagingApplication.resumeSession.bind(MessagingApplication);
    vi.spyOn(MessagingApplication, 'resumeSession').mockImplementation(async (pubky: string) => {
      const resumed = await resume(pubky);
      signInAs(OTHER);
      return resumed;
    });

    await expect(MessagingController.syncInboxInBackground(SELLER, () => true)).resolves.toBe('skipped');
    expect(await LocalMessagingService.getReceiver(OTHER)).toBeNull();
    expect(pair.marker(OTHER)).toBeUndefined();
  });

  it('does not replace a key another tab removed after its check, and stops', async () => {
    await setUpMessagingHere(SELLER);
    const publishedKey = pair.marker(SELLER)?.noisePublicKey;
    reload();
    afterReceiverRead(1, async () => {
      await CommerceMessagingReceiverModel.clear();
    });

    await expect(MessagingController.syncInboxInBackground(SELLER, () => true)).resolves.toBe('skipped');
    expect(await LocalMessagingService.getReceiver(SELLER)).toBeNull();
    expect(pair.marker(SELLER)?.noisePublicKey).toBe(publishedKey);
  });

  it('stops when another tab replaced the key between its check and the sync', async () => {
    await setUpMessagingHere(SELLER);
    reload();
    const syncSpy = vi.spyOn(MessagingController, 'syncInbox');
    afterReceiverRead(1, async () => {
      const receiver = await LocalMessagingService.getReceiver(SELLER);
      await LocalMessagingService.upsertReceiver({ ...receiver!, noise_public_key: `${'r'.repeat(50)}99` });
    });

    await expect(MessagingController.syncInboxInBackground(SELLER, () => true)).resolves.toBe('skipped');
    expect(syncSpy).not.toHaveBeenCalled();
  });

  it('does nothing where this device holds no key for the account', async () => {
    signInAs(OTHER);

    await expect(MessagingController.syncInboxInBackground(OTHER, () => true)).resolves.toBe('skipped');
    expect(await LocalMessagingService.getReceiver(OTHER)).toBeNull();
    expect(pair.marker(OTHER)).toBeUndefined();
  });

  it('syncs for the account that holds its key here', async () => {
    await setUpMessagingHere(SELLER);
    reload();
    const syncSpy = vi.spyOn(MessagingController, 'syncInbox');

    await expect(MessagingController.syncInboxInBackground(SELLER, () => true)).resolves.toBe('synced');
    expect(syncSpy).toHaveBeenCalledWith(expect.objectContaining({ ownerPubky: SELLER }));
  });
});

describe('a sync pass of an account that left', () => {
  /** BUYER follows SELLER and asked about LISTING: a pass reaching discovery adds the thread. */
  function plantRequest() {
    homeserver.files.set(`pubky://${BUYER}/pub/pubky.app/follows/${SELLER}`, { uri: `pubky://${SELLER}` });
    homeserver.files.set(conversationRequestUrl(BUYER, SELLER, LISTING), {
      version: 1,
      kind: CONVERSATION_REQUEST_KIND,
      seller_pubky: SELLER,
      buyer_pubky: BUYER,
      listing_id: LISTING,
      created_at: Date.now(),
    });
  }

  it('discovers the request while the account is still signed in', async () => {
    await setUpMessagingHere(SELLER);
    plantRequest();
    vi.mocked(UserStreamApplication.fetchStreamIds).mockImplementation(async ({ streamId }) =>
      String(streamId).endsWith(':followers') ? [BUYER as Pubky] : [],
    );

    await MessagingController.syncInbox();

    expect(
      await LocalMessagingService.getConversation(
        SELLER,
        buildMarketplaceConversationAggregateId(SELLER, BUYER, LISTING),
      ),
    ).toBeDefined();
  });

  it('writes no thread, link or contact for it after a sign-out during its follow-graph read', async () => {
    await setUpMessagingHere(SELLER);
    plantRequest();
    vi.mocked(UserStreamApplication.fetchStreamIds).mockImplementation(async ({ streamId }) => {
      if (String(streamId).endsWith(':following')) return [OTHER as Pubky];
      MessagingApplication.clearMessagingSession();
      FirstContactApplication.clear();
      signInAs(null);
      return [BUYER as Pubky];
    });
    const knownSpy = vi.spyOn(FirstContactApplication, 'setKnownContacts');
    const pagerSpy = vi.spyOn(FirstContactApplication, 'followGraphPager');

    await MessagingController.syncInbox({ ownerPubky: SELLER });

    expect(knownSpy).not.toHaveBeenCalled();
    const pagersBeforeSignOut = pagerSpy.mock.calls.length;
    expect(pagersBeforeSignOut).toBe(2);
    expect(await CommerceMessagingConversationModel.findByOwner(SELLER)).toEqual([]);
    expect(await CommerceMessagingLinkModel.findByOwner(SELLER)).toEqual([]);
  });

  it('starts no pair step for it after another account signs in mid-pass', async () => {
    await setUpMessagingHere(SELLER);
    vi.mocked(UserStreamApplication.fetchStreamIds).mockImplementation(async ({ streamId }) => {
      if (String(streamId).endsWith(':followers')) signInAs(OTHER);
      return String(streamId).endsWith(':followers') ? [BUYER as Pubky] : [];
    });
    const probeSpy = vi.spyOn(PaykitMessagingService, 'probeCounterparty');

    await MessagingController.syncInbox({ ownerPubky: SELLER });

    expect(probeSpy).not.toHaveBeenCalled();
  });
});

describe('account switch without a sign-out', () => {
  it('forgets the account that left: its known contacts and seen requests', async () => {
    await setUpMessagingHere(SELLER);
    vi.mocked(UserStreamApplication.fetchStreamIds).mockImplementation(async ({ streamId }) =>
      String(streamId).endsWith(':following') ? [BUYER as Pubky] : [],
    );
    await MessagingController.syncInbox();
    await expect(FirstContactApplication.originFor(SELLER, BUYER)).resolves.toBe('known');

    FirstContactApplication.clearOtherAccounts(OTHER);

    await expect(FirstContactApplication.originFor(SELLER, BUYER)).resolves.toBe('request');
  });

  it('keeps the account that stays', async () => {
    await setUpMessagingHere(SELLER);
    vi.mocked(UserStreamApplication.fetchStreamIds).mockImplementation(async ({ streamId }) =>
      String(streamId).endsWith(':following') ? [BUYER as Pubky] : [],
    );
    await MessagingController.syncInbox();

    FirstContactApplication.clearOtherAccounts(SELLER);

    await expect(FirstContactApplication.originFor(SELLER, BUYER)).resolves.toBe('known');
  });
});

describe('the provisioning hold of a background pass', () => {
  const HELD_LOG = 'Skipped receiver provisioning while background sync holds it';

  it('says when a resume inside the hold skips provisioning', async () => {
    await setUpMessagingHere(SELLER);
    reload();
    await CommerceMessagingReceiverModel.clear();
    const info = vi.spyOn(Logger, 'info');

    await MessagingApplication.withoutReceiverProvisioning(SELLER, () => MessagingController.getMessagingStatus());

    expect(info).toHaveBeenCalledWith(HELD_LOG, { reason: 'receiver_provisioning_held' });
    expect(await LocalMessagingService.getReceiver(SELLER)).toBeNull();
  });

  it('ends when the session resume hangs, and the resume that settles later touches no key', async () => {
    await setUpMessagingHere(SELLER);
    const publishedKey = pair.marker(SELLER)?.noisePublicKey;
    reload();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const resume = MessagingApplication.resumeSession.bind(MessagingApplication);
    let lateResume: Promise<boolean> | null = null;
    vi.spyOn(MessagingApplication, 'resumeSession').mockImplementation((pubky: string) => {
      lateResume = gate.then(() => resume(pubky));
      return lateResume;
    });
    vi.spyOn(Logger, 'warn').mockImplementation(() => {});
    const syncSpy = vi.spyOn(MessagingController, 'syncInbox');

    await expect(MessagingController.syncInboxInBackground(SELLER, () => true)).rejects.toMatchObject({
      context: { timeoutMs: MESSAGING_SYNC_RESUME_TIMEOUT_MS },
    });
    expect(syncSpy).not.toHaveBeenCalled();

    // The resume settles after the pass gave up: it resumes the session, and
    // even with the key gone it creates and publishes nothing.
    await CommerceMessagingReceiverModel.clear();
    release();
    await expect(lateResume).resolves.toBe(true);
    expect(await LocalMessagingService.getReceiver(SELLER)).toBeNull();
    expect(pair.marker(SELLER)?.noisePublicKey).toBe(publishedKey);

    // The hold is gone: the foreground provisions again.
    const info = vi.spyOn(Logger, 'info');
    await expect(MessagingController.getMessagingStatus()).resolves.toMatchObject({ sessionActive: true });
    expect(info).not.toHaveBeenCalledWith(HELD_LOG, expect.anything());
    expect(await LocalMessagingService.getReceiver(SELLER)).not.toBeNull();
  });
});

describe('a foreground inbox sync during a background pass', () => {
  /** Holds the first pass's two follow-graph reads (follows and followers) until `release`; later reads answer at once. */
  function holdFirstFollowRead() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    vi.mocked(UserStreamApplication.fetchStreamIds).mockImplementation(async () => {
      calls += 1;
      if (calls <= 2) await gate;
      return [];
    });
    return { release, calls: () => calls };
  }

  it('starts its own pass instead of inheriting the background stop and deadline', async () => {
    await setUpMessagingHere(SELLER);
    const reads = holdFirstFollowRead();
    let backgroundContinues = true;
    const background = MessagingController.syncInbox({
      ownerPubky: SELLER,
      shouldContinue: () => backgroundContinues,
    });
    await vi.waitFor(() => expect(reads.calls()).toBe(2));
    backgroundContinues = false;

    await expect(MessagingController.syncInbox()).resolves.toMatchObject({ rateLimited: 0 });
    expect(reads.calls()).toBe(4);

    reads.release();
    await background;
  });

  it('a background pass joins a foreground pass already running', async () => {
    await setUpMessagingHere(SELLER);
    const reads = holdFirstFollowRead();
    const foreground = MessagingController.syncInbox();
    await vi.waitFor(() => expect(reads.calls()).toBe(2));

    const joined = MessagingController.syncInbox({ ownerPubky: SELLER, shouldContinue: () => true });
    reads.release();

    const [first, second] = await Promise.all([foreground, joined]);
    expect(second).toBe(first);
    expect(reads.calls()).toBe(2);
  });
});
