// LIVE proof on the STAGING network (homeserver, pkarr relays and Nexus) that
// a buyer's first message reaches a seller whose follower list is longer than
// one Nexus page, with neither side keeping a conversation open:
//
// 1. The buyer, a follower outside the seller's first Nexus followers page,
//    publishes the conversation request and sends; the message queues behind
//    the handshake. The buyer then leaves (the live session is dropped).
// 2. The seller, in a browser with no messaging history, runs inbox sync
//    passes only. It must find the buyer and answer the handshake.
// 3. The buyer comes back and runs sync passes only: the handshake finishes
//    and the queued message is sent.
// 4. The seller's next passes receive it.
//
// Everything below the app is real: vendored WASM crypto, the staging
// homeserver, public pkarr relays, the staging Nexus follower index and
// IndexedDB. Each "browser" is the same origin with one account signed in at
// a time, so local state per account is what that account's browser holds.
//
// Seats are throwaway staging identities created from single-use signup
// tokens (`FC64_SIGNUP_TOKENS`) or signed back in from a saved key file
// (`FC64_SEAT_KEYS`). Their keys are written to `.first-contact-out/`, never
// printed. With `FC64_FINAL_CLEANUP=1` every file the seats wrote is deleted
// before they sign out. See vitest.first-contact.staging.config.ts.

import { describe, expect, it } from 'vitest';
import { commands } from 'vitest/browser';
import { FirstContactApplication } from '@/application/messaging/first-contact';
import { MessagingController } from '@/controllers/messaging/messaging';
import {
  buildMarketplaceConversationAggregateId,
  buildMarketplaceListingAggregateId,
} from '@/libs/commerce/transaction-commands';
import { buildConversationRequest, conversationRequestUrl } from '@/libs/messaging/first-contact';
import type { Pubky } from '@/models/models.types';
import { FollowNormalizer } from '@/pipes/follow/follow.normalizer';
import { UserNormalizer } from '@/pipes/user/user.normalizer';
import { HomeserverService } from '@/services/homeserver/homeserver';
import { LocalMessagingService } from '@/services/local/messaging/messaging';
import { PaykitMessagingService, setPaykitWasmModuleForTests } from '@/services/paykit/paykit-messaging';
import { useAuthStore } from '@/stores/auth/auth.store';

declare const __SIGNUP_TOKENS__: string[];
declare const __SEAT_KEYS__: { label: string; secretHex: string }[];
declare const __FINAL_CLEANUP__: boolean;

type PaykitWasmModule = typeof import('paykit-wasm');
type SessionHandle = import('paykit-wasm').SessionHandle;

const STAGING_HOMESERVER_PUBKY = 'ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy';
const STAGING_NEXUS = 'https://nexus.staging.pubky.app';
const NEXUS_PAGE = 20;
const FOLLOWERS = 23;
const LISTING_ID = '0033GVVN22HJ0FYQGZZS8R2BFC';
const PASS_GAP_MS = 2_000;
const SELLER_PASSES = 15;
const OUT = '.first-contact-out';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const log = (tag: string, data: unknown) => console.info(`[first-contact] ${tag} ${JSON.stringify(data)}`);
const short = (pubky: string) => pubky.slice(0, 8);

let wasm: PaykitWasmModule;

type Seat = { label: string; pubky: string; secret: Uint8Array; session: SessionHandle };

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fromHex(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index++) bytes[index] = parseInt(value.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

async function openSeats(labels: string[]): Promise<Seat[]> {
  const saved = new Map(__SEAT_KEYS__.map((key) => [key.label, key.secretHex]));
  const tokens = [...__SIGNUP_TOKENS__];
  const seats: Seat[] = [];
  for (const label of labels) {
    const client = new wasm.PubkyClient();
    const savedHex = saved.get(label);
    let secret: Uint8Array;
    let session: SessionHandle;
    if (savedHex) {
      secret = fromHex(savedHex);
      session = (await client.signinWithSecret(secret)) as SessionHandle;
    } else {
      const token = tokens.shift();
      if (!token) throw new Error(`No signup token left for seat ${label}`);
      secret = new Uint8Array(32);
      crypto.getRandomValues(secret);
      session = (await client.signupWithSecret(secret, STAGING_HOMESERVER_PUBKY, token)) as SessionHandle;
    }
    seats.push({ label, pubky: session.pubky(), secret, session });
    await commands.writeFile(
      `${OUT}/seat-keys.json`,
      JSON.stringify(
        seats.map((seat) => ({ label: seat.label, pubky: seat.pubky, secretHex: hex(seat.secret) })),
        null,
        2,
      ),
    );
  }
  return seats;
}

async function putJson(session: SessionHandle, url: string, value: unknown): Promise<void> {
  const path = url.replace(/^pubky:\/\/[a-z0-9]{52}/, '');
  await session.putPublic(path, new TextEncoder().encode(JSON.stringify(value)));
}

async function nexusFollowers(seller: string): Promise<string[]> {
  const ids: string[] = [];
  for (let skip = 0; ; skip += NEXUS_PAGE) {
    const response = await fetch(
      `${STAGING_NEXUS}/v0/stream/users/ids?source=followers&user_id=${seller}&skip=${skip}&limit=${NEXUS_PAGE}`,
    );
    if (response.status === 404) return ids;
    if (!response.ok) throw new Error(`Nexus followers read failed: ${response.status}`);
    const page = (await response.json()) as string[];
    ids.push(...page);
    if (page.length < NEXUS_PAGE) return ids;
  }
}

/** One account's browser opening the Shop: a fresh session handle for that account, provisioned like a resume. */
async function openBrowser(seat: Seat): Promise<void> {
  PaykitMessagingService.clearSession();
  useAuthStore.setState({ currentUserPubky: seat.pubky as Pubky });
  const session = (await new wasm.PubkyClient().signinWithSecret(seat.secret)) as SessionHandle;
  await PaykitMessagingService.enableWithSessionForTests(session);
}

/** The account closes every Shop tab: nothing of it runs until it opens a browser again. */
function closeBrowser(): void {
  PaykitMessagingService.clearSession();
  FirstContactApplication.clear();
  useAuthStore.setState({ currentUserPubky: null });
}

async function syncUntil(label: string, passes: number, done: () => Promise<boolean>) {
  for (let pass = 1; pass <= passes; pass++) {
    const started = performance.now();
    let error: string | null = null;
    try {
      await MessagingController.syncInbox();
    } catch (caught) {
      error = String(caught).slice(0, 200);
    }
    const reached = await done();
    log(`${label}-pass`, { pass, ms: Math.round(performance.now() - started), reached, error });
    if (reached) return pass;
    await sleep(PASS_GAP_MS);
  }
  return null;
}

async function deleteEverything(seat: Seat): Promise<number> {
  const files = await HomeserverService.list({ baseDirectory: `pubky://${seat.pubky}/pub/`, limit: 1000 });
  for (const url of files) {
    await seat.session.deletePublic(url.replace(/^pubky:\/\/[a-z0-9]{52}/, ''));
  }
  return files.length;
}

describe('first contact from a follower outside the first Nexus page (staging)', () => {
  it('delivers the queued first message with only sync passes on both sides', async () => {
    wasm = await import('paykit-wasm');
    await wasm.default();
    setPaykitWasmModuleForTests(wasm);

    const labels = ['SELLER', ...Array.from({ length: FOLLOWERS }, (_, index) => `F${String(index).padStart(2, '0')}`)];
    const seats = await openSeats(labels);
    const results: Record<string, unknown> = { seats: seats.map((seat) => `${seat.label} ${seat.pubky}`) };
    try {
      const [seller, ...followers] = seats;
      for (const seat of seats) {
        const profile = UserNormalizer.to(
          {
            name: `fc64 ${seat.label.toLowerCase()}`,
            bio: 'Throwaway staging test seat',
            image: null,
            links: [],
            status: null,
          },
          seat.pubky as Pubky,
        );
        await putJson(seat.session, profile.meta.url, profile.user.toJson());
      }
      for (const seat of followers) {
        const follow = FollowNormalizer.to({ follower: seat.pubky as Pubky, followee: seller.pubky as Pubky });
        await putJson(seat.session, follow.meta.url, follow.follow.toJson());
      }

      // The staging Nexus indexes the follows; the Shop names followers from it.
      let order: string[] = [];
      const indexDeadline = Date.now() + 300_000;
      while (Date.now() < indexDeadline) {
        order = await nexusFollowers(seller.pubky);
        if (followers.every((seat) => order.includes(seat.pubky))) break;
        await sleep(5_000);
      }
      expect(followers.every((seat) => order.includes(seat.pubky))).toBe(true);
      const firstPage = order.slice(0, NEXUS_PAGE);
      const buyer = followers.find((seat) => order.indexOf(seat.pubky) >= NEXUS_PAGE);
      if (!buyer) throw new Error('No follower outside the first Nexus page');
      results.followerOrder = order.map(short);
      results.buyer = { label: buyer.label, pubky: buyer.pubky, followerPosition: order.indexOf(buyer.pubky) };
      log('setup', {
        buyer: results.buyer,
        followers: order.length,
        firstPageHasBuyer: firstPage.includes(buyer.pubky),
      });

      const conversationId = buildMarketplaceConversationAggregateId(seller.pubky, buyer.pubky, LISTING_ID);
      const body = `first contact ${crypto.randomUUID()}`;

      // The seller has messaging on (its marker is published) from an earlier visit.
      await openBrowser(seller);
      closeBrowser();

      // 1. The buyer writes the request (what the Shop's first message writes) and sends.
      await openBrowser(buyer);
      await putJson(
        buyer.session,
        conversationRequestUrl(buyer.pubky, seller.pubky, LISTING_ID),
        buildConversationRequest({
          sellerPubky: seller.pubky,
          buyerPubky: buyer.pubky,
          listingId: LISTING_ID,
          createdAt: Date.now(),
        }),
      );
      const sent = await MessagingController.sendOrQueueMessage(seller.pubky, buyer.pubky, LISTING_ID, body);
      expect(sent.delivered).toBe(false);
      expect((await LocalMessagingService.getLink(buyer.pubky, seller.pubky))?.status).toBe('handshaking');
      closeBrowser();

      // 2. The seller opens the Shop later in a browser with no messaging history.
      await openBrowser(seller);
      const sellerAnswered = await syncUntil('seller', SELLER_PASSES, async () => {
        const link = await LocalMessagingService.getLink(seller.pubky, buyer.pubky);
        return link !== null && link !== undefined;
      });
      results.sellerAnsweredAtPass = sellerAnswered;
      expect(sellerAnswered).not.toBeNull();
      const thread = await LocalMessagingService.getConversation(seller.pubky, conversationId);
      results.sellerThread = thread ? { origin: thread.origin, listingRef: thread.listing_ref } : null;
      expect(thread?.listing_ref).toBe(buildMarketplaceListingAggregateId(seller.pubky, LISTING_ID));
      closeBrowser();

      // 3. The buyer comes back to the Shop: sync passes finish the handshake and send.
      await openBrowser(buyer);
      const buyerSent = await syncUntil('buyer', 10, async () => {
        const queued = await LocalMessagingService.getQueuedMessages(buyer.pubky, seller.pubky);
        return queued.length === 0;
      });
      results.buyerSentAtPass = buyerSent;
      expect(buyerSent).not.toBeNull();
      closeBrowser();

      // 4. The seller's next visit receives it.
      await openBrowser(seller);
      const sellerReceived = await syncUntil('seller-receive', 10, async () => {
        const messages = await LocalMessagingService.getMessages(seller.pubky, conversationId);
        return messages.some((message) => message.body === body && message.direction === 'received');
      });
      results.sellerReceivedAtPass = sellerReceived;
      expect(sellerReceived).not.toBeNull();
    } finally {
      closeBrowser();
      if (__FINAL_CLEANUP__) {
        const deleted: Record<string, number | string> = {};
        for (const seat of seats) {
          try {
            deleted[seat.label] = await deleteEverything(seat);
          } catch (error) {
            deleted[seat.label] = `failed: ${String(error).slice(0, 120)}`;
          }
        }
        results.deletedFiles = deleted;
      }
      const signedOut: Record<string, string> = {};
      for (const seat of seats) {
        try {
          await wasm.signOutSession(seat.session);
          signedOut[seat.label] = 'signed-out';
        } catch (error) {
          signedOut[seat.label] = `failed: ${String(error).slice(0, 120)}`;
        }
      }
      results.signedOut = signedOut;
      log('RESULT', results);
      await commands.writeFile(`${OUT}/result-${Date.now()}.json`, JSON.stringify(results, null, 2));
    }
  }, 1_500_000);
});
