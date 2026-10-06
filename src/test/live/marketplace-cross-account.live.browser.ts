// LIVE cross-account marketplace proof against the REAL staging homeserver:
// identity A (the seller) publishes a listing and a shop record through the
// app's real create path; identity B (a fresh stranger account with an EMPTY
// local cache) loads that listing through the app's real read path
// (`getOrFetchListing` → homeserver fetch → normalizer) and A's shop page
// data. Nothing is mocked: real `@synonymdev/pubky` WASM client, real public
// pkarr relays, real staging-homeserver reads/writes, real IndexedDB cache.
//
// Why the stranger perspective is the whole point: the serialized-nulls bug
// (commits 29edb411 / 60d64831) made every published listing unloadable by
// ANYONE except its cached seller — and it shipped because every test either
// read its own writes back from the local cache or used already-normalized
// fixtures. This journey publishes a record carrying the exact nulls shipped
// studios serialize (`region: null`, `sku: null`, `priceOverride: null`),
// proves those nulls are really on the wire, and then proves a second account
// can load and render it.
//
// The staging homeserver requires SINGLE-USE signup tokens; see
// vitest.cross-account.staging.config.ts for how to pass them and how to
// re-run with saved identity secrets if tokens were already consumed.

import { blake3 } from '@noble/hashes/blake3.js';
import { Keypair } from '@synonymdev/pubky';
import { beforeAll, describe, expect, it } from 'vitest';
import { CommerceApplication } from '@/application/commerce/commerce';
import { COMMERCE_CONTRACT_VERSION, COMMERCE_TAXONOMY_VERSION } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { db } from '@/database/franky/franky';
import { formatCommerceCondition, formatCommerceMoney } from '@/libs/commerce/format';
import {
  type CommerceListingRecord,
  commerceListingRecordSchema,
  type CommerceShopRecord,
} from '@/libs/commerce/marketplace-records';
import { resolveMarketplaceMediaUrl } from '@/libs/commerce/media-url';
import { CommerceRecordNormalizer } from '@/pipes/commerce/commerce.normalizer';
import { CommerceHomeserverService } from '@/services/homeserver/commerce/commerce';
import { HomeserverService } from '@/services/homeserver/homeserver';
import { LocalCommerceService } from '@/services/local/commerce/commerce';
import { useAuthStore } from '@/stores/auth/auth.store';

// Injected by vitest.cross-account.staging.config.ts `define` at build time.
declare const __STAGING_SIGNUP_TOKEN_A__: string;
declare const __STAGING_SIGNUP_TOKEN_B__: string;
declare const __STAGING_SECRET_A__: string;
declare const __STAGING_SECRET_B__: string;

const STAGING_HOMESERVER_PUBKY = 'ufibwbmed6jeq9k4p583go95wofakh9fwpp4k734trq79pd9u1uy';
const PUBLIC_PKARR_RELAY = 'https://pkarr.pubky.app';
/** Bounded patience for cross-account reads: a freshly signed-up seller's
 *  pkarr record can take a moment to be servable through the public relays. */
const CROSS_READ_DEADLINE_MS = 90_000;
const CROSS_READ_RETRY_DELAY_MS = 3_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

interface StagingIdentity {
  pubky: string;
  secret: Uint8Array;
}

/**
 * Signs up with a single-use staging token via the app's own signup path
 * (`HomeserverService.signUp`), or — when a saved identity secret is provided
 * (re-run after tokens were consumed) — signs back in instead. Always logs the
 * secret so a failed partial run stays recoverable; these are throwaway
 * staging test identities, not real users. The resulting session is installed
 * into the app's auth store, exactly where the real app keeps it, so every
 * subsequent write resolves the owned session the way production code does.
 */
async function signInAs(label: string, savedSecretHex: string, signupToken: string): Promise<StagingIdentity> {
  const secret = savedSecretHex ? hexToBytes(savedSecretHex) : randomIdentitySecret();
  const keypair = Keypair.fromSecret(secret);
  const pubky = keypair.publicKey.z32();

  if (savedSecretHex) {
    const result = await HomeserverService.signIn({ keypair });
    if (!result) throw new Error(`Sign-in for ${label} requested a retry after republish; re-run the suite.`);
    useAuthStore.getState().setCurrentUserPubky(pubky);
    useAuthStore.getState().setSession(result.session);
    console.info(`[cross-account-live] ${label}: signed back in as ${pubky}`);
    return { pubky, secret };
  }

  if (!signupToken) {
    throw new Error(
      `Missing credentials for ${label}: pass MARKETPLACE_STAGING_SIGNUP_TOKEN_${label} (single-use signup token) ` +
        `or MARKETPLACE_STAGING_SECRET_${label} (identity secret hex from a previous run).`,
    );
  }

  console.info(`[cross-account-live] ${label}: identity secret (save for re-runs): ${bytesToHex(secret)}`);
  const { session } = await HomeserverService.signUp({ keypair, signupToken });
  useAuthStore.getState().setCurrentUserPubky(pubky);
  useAuthStore.getState().setSession(session);
  console.info(`[cross-account-live] ${label}: signed up as ${pubky}`);
  return { pubky, secret };
}

/** Renders a real PNG in the page and returns its raw bytes — genuine media
 *  content for the listing's homeserver upload, not a placeholder. */
async function renderListingPhotoBytes(): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable in the test browser.');
  context.fillStyle = '#5b21b6';
  context.fillRect(0, 0, 64, 64);
  context.fillStyle = '#f59e0b';
  context.fillRect(12, 12, 40, 40);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error('canvas.toBlob produced no PNG'))),
      'image/png',
    );
  });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height };
}

/**
 * Keeps retrying a cross-account homeserver read until the deadline. A fresh
 * seller's pkarr record propagates through the public relays asynchronously;
 * failing instantly would test relay latency, not the read path. Errors other
 * than the final one are logged, never swallowed silently.
 */
async function withPkarrPatience<T>(label: string, read: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    try {
      return await read();
    } catch (error) {
      if (Date.now() - startedAt >= CROSS_READ_DEADLINE_MS) throw error;
      console.info(`[cross-account-live] ${label}: not readable yet, retrying`, error);
      await sleep(CROSS_READ_RETRY_DELAY_MS);
    }
  }
}

describe('marketplace cross-account journey — live proof on STAGING (public network)', () => {
  beforeAll(async () => {
    // Reachability of the public relay, via a real pkarr read of the staging
    // homeserver's record — the same resolution the SDK performs.
    const response = await fetch(`${PUBLIC_PKARR_RELAY}/${STAGING_HOMESERVER_PUBKY}`);
    if (!response.ok) {
      throw new Error(
        `The public pkarr relay ${PUBLIC_PKARR_RELAY} did not serve the staging homeserver record ` +
          `(status ${response.status}). This live proof needs the public staging network to be reachable.`,
      );
    }
  });

  it('lets a stranger load a seller-published listing (with studio-serialized nulls) and the shop page', async () => {
    // ── Identity A: the seller ─────────────────────────────────────────────
    const sellerIdentity = await signInAs('A', __STAGING_SECRET_A__, __STAGING_SIGNUP_TOKEN_A__);
    const seller = sellerIdentity.pubky;

    // Real media through the real upload path (the studio's resolveForPublish
    // does exactly this: bytes → CommerceController.commitCreateMedia → URL).
    const photo = await renderListingPhotoBytes();
    const mediaId = crypto.randomUUID().replaceAll('-', '');
    const mediaUrl = await CommerceController.commitCreateMedia(mediaId, photo.bytes);

    // The record, shaped exactly like the sell studio's builder shapes it.
    const listingId = crypto.randomUUID().replaceAll('-', '');
    const now = new Date().toISOString();
    const parsedListing = commerceListingRecordSchema.parse({
      schemaVersion: COMMERCE_CONTRACT_VERSION,
      recordType: 'listing',
      ownerPubky: seller,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      listingId,
      state: 'active',
      title: 'Cross-account live proof boots',
      description: 'Published by identity A so identity B can load it as a stranger.',
      taxonomyVersion: COMMERCE_TAXONOMY_VERSION,
      categoryId: 'fashion-shoes-boots',
      condition: 'good',
      tags: ['cross', 'account', 'live', 'proof'],
      location: { countryCode: 'US' },
      media: [
        {
          id: mediaId,
          type: 'image',
          url: mediaUrl,
          contentHash: bytesToHex(blake3(photo.bytes)),
          mimeType: 'image/png',
          byteSize: photo.bytes.byteLength,
          width: photo.width,
          height: photo.height,
          altText: 'Purple square with an amber inset, the live-proof listing photo',
        },
      ],
      variants: [
        {
          id: 'variant_1',
          options: { size: '42' },
          quantity: 1,
          mediaIds: [mediaId],
          enabled: true,
        },
      ],
      sale: {
        format: 'fixed_price',
        unitPrice: { amountMinor: 12_500, currency: 'USD', exponent: 2 },
        acceptsOffers: true,
      },
      fulfillmentMethods: ['physical'],
      package: { weightGrams: 1_200, lengthMillimeters: 350, widthMillimeters: 250, heightMillimeters: 150 },
      shippingOptions: [
        {
          id: 'seller_flat_rate',
          pricing: 'flat',
          label: 'Ground shipping',
          price: { amountMinor: 1_200, currency: 'USD', exponent: 2 },
          estimatedMinDays: 3,
          estimatedMaxDays: 7,
        },
      ],
      returnPolicy: { acceptsReturns: true, returnWindowDays: 30, buyerPaysReturnShipping: true },
      adultOnly: false,
    });

    // The wire shape shipped studios actually published: unset optional form
    // fields serialized as EXPLICIT nulls (see the regression fixed in
    // 29edb411/60d64831 — `region: null`, `sku: null`, `priceOverride: null`
    // live on real homeserver records forever). The current controller strips
    // nulls on normalization, so the null-carrying corpus is reproduced at the
    // application layer — the same layer the controller delegates to, running
    // the full real publish (staged sync job, homeserver PUT, cache upsert).
    const wireListing = {
      ...parsedListing,
      location: { ...parsedListing.location, region: null },
      variants: parsedListing.variants.map((variant) => ({ ...variant, sku: null, priceOverride: null })),
    } as unknown as CommerceListingRecord;
    await CommerceApplication.commitUpsertListing(wireListing);

    // Prove the nulls are REALLY on the wire — read A's own record back as raw
    // JSON (no normalizer) straight from the homeserver.
    const listingUri = CommerceRecordNormalizer.listingUri(seller, listingId);
    const rawListing = (await CommerceHomeserverService.fetchJson(listingUri)) as {
      location: { region: unknown };
      variants: Array<{ sku: unknown; priceOverride: unknown }>;
    };
    expect(rawListing.location.region).toBeNull();
    expect(rawListing.variants[0].sku).toBeNull();
    expect(rawListing.variants[0].priceOverride).toBeNull();
    console.info(`[cross-account-live] A: published listing ${seller}:${listingId} with wire nulls verified`);

    // A's shop record, through the real controller path the shop studio uses.
    await CommerceController.commitUpsertShop({
      schemaVersion: COMMERCE_CONTRACT_VERSION,
      recordType: 'shop',
      ownerPubky: seller,
      revision: 1,
      createdAt: now,
      updatedAt: now,
      name: 'Cross-Account Proof Shop',
      bio: 'Shop record published by identity A for the live stranger-read proof.',
      location: { countryCode: 'US' },
      shippingPolicy: 'Ships in 3-7 days, flat rate.',
      returnPolicy: '30-day returns, buyer pays return shipping.',
      vacationMode: false,
    });
    console.info(`[cross-account-live] A: published shop record for ${seller}`);

    // ── Identity B: the stranger ───────────────────────────────────────────
    // A fresh account AND a genuinely empty local cache: the commerce cache is
    // one shared IndexedDB, so destroy and recreate it — otherwise B would
    // read A's local copy and the cross-account read would be a lie (which is
    // exactly how the original bug escaped).
    await db.delete();
    await db.open();
    useAuthStore.getState().setSession(null);
    useAuthStore.getState().setCurrentUserPubky(null);

    const strangerIdentity = await signInAs('B', __STAGING_SECRET_B__, __STAGING_SIGNUP_TOKEN_B__);
    expect(strangerIdentity.pubky).not.toBe(seller);

    const compositeListingId = `${seller}:${listingId}`;
    const cachedBeforeFetch = await LocalCommerceService.getListing(compositeListingId);
    expect(cachedBeforeFetch).toBeFalsy();

    // THE read under test: the exact production path a stranger's listing page
    // runs — CommerceController.getOrFetchListing → homeserver fetch →
    // normalizer. The pre-fix schema rejected the nulls right here.
    const loaded = await withPkarrPatience('B: getOrFetchListing', () =>
      CommerceController.getOrFetchListing(seller, listingId),
    );

    // Normalized, renders-ready record: the nulls became honest absences...
    expect(loaded.location.region).toBeUndefined();
    expect(loaded.variants[0].sku).toBeUndefined();
    expect(loaded.variants[0].priceOverride).toBeUndefined();
    // ...and everything the listing page paints resolves from the record.
    expect(loaded.title).toBe('Cross-account live proof boots');
    expect(loaded.state).toBe('active');
    expect(loaded.sale.format).toBe('fixed_price');
    if (loaded.sale.format !== 'fixed_price') throw new Error('unreachable');
    expect(formatCommerceMoney(loaded.sale.unitPrice)).toBe('$125.00');
    expect(formatCommerceCondition(loaded.condition)).toBe('Good');
    const strangerVisibleMediaUrl = resolveMarketplaceMediaUrl(loaded.media[0].url);
    expect(strangerVisibleMediaUrl).toMatch(/^https:\/\//);
    expect(loaded.media[0].contentHash).toBe(bytesToHex(blake3(photo.bytes)));
    console.info(`[cross-account-live] B: loaded ${compositeListingId} through the real read path`);

    // The read is local-first: the fetch must have populated B's cache.
    const cachedAfterFetch = await LocalCommerceService.getListing(compositeListingId);
    expect(cachedAfterFetch?.record.title).toBe('Cross-account live proof boots');

    // ── A's shop page, as B sees it ────────────────────────────────────────
    // Mirrors MarketplaceShop.tsx: the canonical shop record from the
    // homeserver, the Nexus seller-catalog refresh (tolerated failure — the
    // staging Nexus does not serve marketplace endpoints yet, exactly like the
    // real page tolerates it), and the local-first seller listings.
    const shop: CommerceShopRecord = await withPkarrPatience('B: getOrFetchShop', () =>
      CommerceController.getOrFetchShop(seller),
    );
    expect(shop.name).toBe('Cross-Account Proof Shop');
    expect(shop.bio).toContain('stranger-read proof');
    expect(shop.vacationMode).toBe(false);

    await CommerceApplication.fetchSellerCatalogListings(seller).catch((error) => {
      console.info('[cross-account-live] B: Nexus seller-catalog refresh unavailable (expected on staging)', error);
    });

    const sellerListings = await CommerceController.getListingsBySeller(seller);
    expect(sellerListings.map(({ record }) => record.listingId)).toContain(listingId);
    console.info(`[cross-account-live] B: loaded ${seller}'s shop page data`);
  });
});
