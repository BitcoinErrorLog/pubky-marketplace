import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { z } from 'zod';
import { getCommerceAdapterMode, getMarketplaceUrl, isDurableCommerceMode } from '@/config/commerce';
import type {
  MarketplaceDigitalDeliveryCapability,
  MarketplaceOrderDeliveryEmail,
  MarketplaceOrderDigitalDelivery,
  MarketplaceOrderDigitalEvidence,
  MarketplaceSellerDigitalDelivery,
} from '@/libs/commerce/digital';
import type {
  PaymentMethodKind,
  SellerPaymentConfig,
  SellerPaymentConfigOwnView,
} from '@/libs/commerce/payment-methods';
import type { MarketplacePickupReveal, MarketplaceSellerPickupDetails } from '@/libs/commerce/pickup';
import type { MarketplacePrivKeysResult } from '@/libs/commerce/priv-keys';
import type {
  SellerShippingConfig,
  ShipFromAddress,
  ShippingLabel,
  ShippingParcel,
  ShippoRate,
} from '@/libs/commerce/shipping';
import {
  type MarketplaceCommand,
  type MarketplaceCommandResponse,
  marketplaceCommandResponseSchema,
} from '@/libs/commerce/transaction-commands';
import { commercePubkySchema } from '@/libs/commerce/transaction-contracts';
import { AuthErrorCode, ClientErrorCode, ServerErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { safeFetch } from '@/libs/error/error.http';
import { ErrorService } from '@/libs/error/error.types';
import { PARSE_JSON_WITH_BODY_EXCERPT, parseResponseOrThrow } from '@/libs/http/response.utils';
import { reportMarketplaceNotificationInvalidTypes } from './marketplace-notification-diagnostics';
import {
  type MarketplaceBidHistory,
  type MarketplaceListingProjection,
  marketplaceListingProjectionSchema,
  type MarketplaceNotificationEntry,
  type MarketplaceOffer,
  marketplaceOfferSchema,
  type MarketplaceOrder,
  type MarketplaceParticipantOrder,
  marketplaceParticipantOrderSchema,
  type MarketplacePayment,
  marketplacePaymentSchema,
  type MarketplaceReceipt,
  marketplaceReceiptSchema,
  type MarketplaceSellerListingProjection,
  parseMarketplaceNotificationEntries,
} from './marketplace-projections';
import { MarketplaceTransactionService } from './marketplace-transaction';

const conversationSchema = z
  .object({
    id: z.string(),
    listingAggregateId: z.string(),
    sellerPubky: commercePubkySchema,
    buyerPubky: commercePubkySchema,
    revision: z.number().int().positive(),
    lastMessageAt: z.string(),
    messages: z.array(
      z.object({
        id: z.uuid(),
        senderPubky: commercePubkySchema,
        recipientPubky: commercePubkySchema,
        text: z.string(),
        attachments: z.array(
          z.object({
            id: z.uuid(),
            senderPubky: commercePubkySchema,
            recipientPubky: commercePubkySchema,
            mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
            byteSize: z.number().int().positive(),
            contentHash: z.string().regex(/^[a-f0-9]{64}$/),
            createdAt: z.string(),
          }),
        ),
        createdAt: z.string(),
      }),
    ),
  })
  .passthrough();

const attachmentMetadataSchema = z.object({
  id: z.uuid(),
  senderPubky: commercePubkySchema,
  recipientPubky: commercePubkySchema,
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  byteSize: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string(),
});

const notificationPreferencesSchema = z.object({
  ownerPubky: commercePubkySchema,
  revision: z.number().int().nonnegative(),
  messages: z.boolean(),
  offers: z.boolean(),
  bids: z.boolean(),
  auctions: z.boolean(),
  updatedAt: z.string(),
});

export type MarketplaceConversation = z.infer<typeof conversationSchema>;
export type MarketplaceNotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
export type MarketplaceAttachmentMetadata = z.infer<typeof attachmentMetadataSchema>;
export type {
  MarketplaceBidHistory,
  MarketplaceDropReadyCheck,
  MarketplaceListingProjection,
  MarketplaceNotification,
  MarketplaceNotificationEntry,
  MarketplaceOffer,
  MarketplaceOfferAward,
  MarketplaceOrder,
  MarketplacePayment,
  MarketplacePublicDrop,
  MarketplaceReceipt,
  MarketplaceSellerDrop,
  MarketplaceSellerListingProjection,
  MarketplaceUnrecognizedNotification,
} from './marketplace-projections';

/**
 * Facade over the two marketplace transports, selected by `commerceAdapterMode`:
 *
 * - `sandbox`: the in-memory prototype service. Trust-me `x-pubky-actor`
 *   header, camelCase wire, full query surface. Simulated outcomes.
 * - `transaction-service`: the durable Rust service (see
 *   `MarketplaceTransactionService`). Bearer sessions from Pubky AuthTokens,
 *   snake_case wire, the ported command set plus role-scoped projection
 *   reads (listings, offers, orders, payments, receipts, notifications,
 *   reports). Authoritative outcomes.
 * - anything else fails closed before any bytes leave the client.
 *
 * Sandbox-only surfaces with NO durable counterpart keep their explicit
 * sandbox assertion in every other mode: conversations/messages and
 * attachments (no durable tables; `message.*` commands unported) and
 * notification preferences (`notification.*` commands unported).
 *
 */
export class MarketplaceGatewayService {
  private constructor() {}

  static async execute(
    actor: string,
    command: MarketplaceCommand,
    options: { signal?: AbortSignal } = {},
  ): Promise<MarketplaceCommandResponse> {
    if (isDurableCommerceMode(getCommerceAdapterMode())) {
      return await MarketplaceTransactionService.execute(actor, command, options);
    }
    this.assertSandbox();
    const url = `${getMarketplaceUrl()}/v1/commands`;
    const response = await safeFetch(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-pubky-actor': actor,
        },
        body: JSON.stringify(command),
      },
      ErrorService.Marketplace,
      'execute',
    );
    const raw = await parseResponseOrThrow<unknown>(response, ErrorService.Marketplace, 'execute', url);
    const parsed = marketplaceCommandResponseSchema.safeParse(raw);
    if (!parsed.success) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'Marketplace returned an invalid command response.', {
        service: ErrorService.Marketplace,
        operation: 'execute',
        context: { statusCode: response.status },
      });
    }
    return parsed.data;
  }

  /**
   * Listing/inventory projection. The durable service serves it to any
   * authenticated user (public catalog data behind the bearer session), so
   * that mode needs the signed-in actor to bind the session; the sandbox
   * endpoint is unauthenticated and ignores the actor.
   */
  static async getListingBids(actor: string | null, aggregateId: string): Promise<MarketplaceBidHistory | null> {
    this.assertDurableServiceOnly('getListingBids');
    return await MarketplaceTransactionService.getListingBids(this.requireActor('getListingBids', actor), aggregateId);
  }

  static async getListing(
    actor: string | null,
    aggregateId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<MarketplaceListingProjection | null> {
    if (isDurableCommerceMode(getCommerceAdapterMode())) {
      return await MarketplaceTransactionService.getListing(
        this.requireActor('getListing', actor),
        aggregateId,
        options,
      );
    }
    this.assertSandbox();
    const url = `${getMarketplaceUrl()}/v1/listings?aggregateId=${encodeURIComponent(aggregateId)}`;
    const response = await safeFetch(url, { method: 'GET' }, ErrorService.Marketplace, 'getListing');
    if (response.status === 404) return null;
    const raw = await parseResponseOrThrow<unknown>(
      response,
      ErrorService.Marketplace,
      'getListing',
      url,
      PARSE_JSON_WITH_BODY_EXCERPT,
    );
    const parsed = marketplaceListingProjectionSchema.safeParse(raw);
    if (!parsed.success) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'Marketplace returned an invalid listing projection.', {
        service: ErrorService.Marketplace,
        operation: 'getListing',
        context: { statusCode: response.status },
      });
    }
    return parsed.data;
  }

  static async getSellerListing(
    actor: string,
    aggregateId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<MarketplaceSellerListingProjection | null> {
    this.assertDurableServiceOnly('getSellerListing');
    return await MarketplaceTransactionService.getSellerListing(actor, aggregateId, options);
  }

  /**
   * The seller's standing amount-band consent (ratified D2). Only the
   * durable transaction service has attestations at all, so the sandbox
   * answer is `null` — "the feature does not exist here", which callers must
   * render as absence, never as a fake false-with-a-checkbox.
   */
  static async getBandConsent(actor: string, sellerPubky: string): Promise<boolean | null> {
    if (isDurableCommerceMode(getCommerceAdapterMode())) {
      return await MarketplaceTransactionService.getBandConsent(actor, sellerPubky);
    }
    return null;
  }

  /**
   * The durable service's deterministic receipt attestation for the
   * portable order-receipt document. Null in sandbox mode — the sandbox has
   * no attestor and no receipts worth exporting.
   */
  /** The owner's `/priv` data keys; none outside the durable service. */
  static async getPrivKeys(actor: string): Promise<MarketplacePrivKeysResult> {
    if (isDurableCommerceMode(getCommerceAdapterMode())) {
      return await MarketplaceTransactionService.getPrivKeys(actor);
    }
    return { kind: 'unavailable' };
  }

  static async getReceiptAttestation(actor: string, receiptId: string) {
    if (isDurableCommerceMode(getCommerceAdapterMode())) {
      return await MarketplaceTransactionService.getReceiptAttestation(actor, receiptId);
    }
    return null;
  }

  /**
   * Drops exist only against the durable service (ADR 0026: server time is
   * the feature). Every read returns null in sandbox mode, and callers
   * render honest absence.
   */
  static async getPublicDrop(sellerPubky: string, dropId: string) {
    if (isDurableCommerceMode(getCommerceAdapterMode())) {
      return await MarketplaceTransactionService.getPublicDrop(sellerPubky, dropId);
    }
    return null;
  }

  static async getDrop(actor: string, aggregateId: string) {
    if (isDurableCommerceMode(getCommerceAdapterMode())) {
      return await MarketplaceTransactionService.getDrop(actor, aggregateId);
    }
    return null;
  }

  static async getDropReadyCheck(actor: string, aggregateId: string) {
    if (isDurableCommerceMode(getCommerceAdapterMode())) {
      return await MarketplaceTransactionService.getDropReadyCheck(actor, aggregateId);
    }
    return null;
  }

  static async getEditionAttestation(actor: string, receiptId: string) {
    if (isDurableCommerceMode(getCommerceAdapterMode())) {
      return await MarketplaceTransactionService.getEditionAttestation(actor, receiptId);
    }
    return null;
  }

  static async getConversations(actor: string): Promise<MarketplaceConversation[]> {
    this.assertSandbox();
    const url = `${getMarketplaceUrl()}/v1/conversations`;
    const response = await safeFetch(
      url,
      { method: 'GET', headers: { 'x-pubky-actor': actor } },
      ErrorService.Marketplace,
      'getConversations',
    );
    const raw = await parseResponseOrThrow<unknown>(response, ErrorService.Marketplace, 'getConversations', url);
    const parsed = z.object({ conversations: z.array(conversationSchema) }).safeParse(raw);
    if (!parsed.success) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'Marketplace returned invalid conversations.', {
        service: ErrorService.Marketplace,
        operation: 'getConversations',
        context: { statusCode: response.status },
      });
    }
    return parsed.data.conversations;
  }

  static async getOffers(actor: string): Promise<MarketplaceOffer[]> {
    if (isDurableCommerceMode(getCommerceAdapterMode())) {
      return await MarketplaceTransactionService.getOffers(actor);
    }
    this.assertSandbox();
    const url = `${getMarketplaceUrl()}/v1/offers`;
    const response = await safeFetch(
      url,
      { method: 'GET', headers: { 'x-pubky-actor': actor } },
      ErrorService.Marketplace,
      'getOffers',
    );
    const raw = await parseResponseOrThrow<unknown>(response, ErrorService.Marketplace, 'getOffers', url);
    const parsed = z.object({ offers: z.array(marketplaceOfferSchema) }).safeParse(raw);
    if (!parsed.success) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'Marketplace returned invalid offers.', {
        service: ErrorService.Marketplace,
        operation: 'getOffers',
        context: { statusCode: response.status },
      });
    }
    return parsed.data.offers;
  }

  static async getNotifications(actor: string): Promise<MarketplaceNotificationEntry[]> {
    if (isDurableCommerceMode(getCommerceAdapterMode())) {
      return await MarketplaceTransactionService.getNotifications(actor);
    }
    this.assertSandbox();
    const url = `${getMarketplaceUrl()}/v1/notifications`;
    const response = await safeFetch(
      url,
      { method: 'GET', headers: { 'x-pubky-actor': actor } },
      ErrorService.Marketplace,
      'getNotifications',
    );
    const raw = await parseResponseOrThrow<unknown>(response, ErrorService.Marketplace, 'getNotifications', url);
    return parseMarketplaceNotificationEntries(raw, reportMarketplaceNotificationInvalidTypes);
  }

  static async getNotificationPreferences(actor: string): Promise<MarketplaceNotificationPreferences> {
    this.assertSandbox();
    const url = `${getMarketplaceUrl()}/v1/notification-preferences`;
    const response = await safeFetch(
      url,
      { method: 'GET', headers: { 'x-pubky-actor': actor } },
      ErrorService.Marketplace,
      'getNotificationPreferences',
    );
    const raw = await parseResponseOrThrow<unknown>(
      response,
      ErrorService.Marketplace,
      'getNotificationPreferences',
      url,
    );
    const parsed = notificationPreferencesSchema.safeParse(raw);
    if (!parsed.success) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'Marketplace returned invalid notification preferences.', {
        service: ErrorService.Marketplace,
        operation: 'getNotificationPreferences',
        context: { statusCode: response.status },
      });
    }
    return parsed.data;
  }

  static async getOrders(actor: string): Promise<MarketplaceParticipantOrder[]> {
    if (isDurableCommerceMode(getCommerceAdapterMode())) {
      return await MarketplaceTransactionService.getOrders(actor);
    }
    this.assertSandbox();
    const url = `${getMarketplaceUrl()}/v1/orders`;
    const response = await safeFetch(
      url,
      { method: 'GET', headers: { 'x-pubky-actor': actor } },
      ErrorService.Marketplace,
      'getOrders',
    );
    const raw = await parseResponseOrThrow<unknown>(response, ErrorService.Marketplace, 'getOrders', url);
    const parsed = z.object({ orders: z.array(marketplaceParticipantOrderSchema) }).safeParse(raw);
    if (!parsed.success) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'Marketplace returned invalid orders.', {
        service: ErrorService.Marketplace,
        operation: 'getOrders',
        context: { statusCode: response.status },
      });
    }
    return parsed.data.orders;
  }

  static async getPayment(actor: string, paymentId: string): Promise<MarketplacePayment | null> {
    if (isDurableCommerceMode(getCommerceAdapterMode())) {
      return await MarketplaceTransactionService.getPayment(actor, paymentId);
    }
    this.assertSandbox();
    const url = `${getMarketplaceUrl()}/v1/payments/${encodeURIComponent(paymentId)}`;
    const response = await safeFetch(
      url,
      { method: 'GET', headers: { 'x-pubky-actor': actor } },
      ErrorService.Marketplace,
      'getPayment',
    );
    if (response.status === 404) return null;
    const raw = await parseResponseOrThrow<unknown>(response, ErrorService.Marketplace, 'getPayment', url);
    const parsed = marketplacePaymentSchema.safeParse(raw);
    if (!parsed.success) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'Marketplace returned an invalid payment.', {
        service: ErrorService.Marketplace,
        operation: 'getPayment',
        context: { statusCode: response.status },
      });
    }
    return parsed.data;
  }

  static async getReceipt(actor: string, receiptId: string): Promise<MarketplaceReceipt | null> {
    if (isDurableCommerceMode(getCommerceAdapterMode())) {
      return await MarketplaceTransactionService.getReceipt(actor, receiptId);
    }
    this.assertSandbox();
    const url = `${getMarketplaceUrl()}/v1/receipts/${encodeURIComponent(receiptId)}`;
    const response = await safeFetch(
      url,
      { method: 'GET', headers: { 'x-pubky-actor': actor } },
      ErrorService.Marketplace,
      'getReceipt',
    );
    if (response.status === 404) return null;
    const raw = await parseResponseOrThrow<unknown>(response, ErrorService.Marketplace, 'getReceipt', url);
    const parsed = marketplaceReceiptSchema.safeParse(raw);
    if (!parsed.success) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'Marketplace returned an invalid receipt.', {
        service: ErrorService.Marketplace,
        operation: 'getReceipt',
        context: { statusCode: response.status },
      });
    }
    return parsed.data;
  }

  /** One order projection by id — durable service only (used to source a fresh `expected_revision`). */
  static async getOrder(actor: string, orderId: string): Promise<MarketplaceOrder | null> {
    this.assertDurableServiceOnly('getOrder');
    return await MarketplaceTransactionService.getOrder(actor, orderId);
  }

  /**
   * The paying buyer's per-line pickup-details reveal (local pickup §A3) —
   * durable service only: the sandbox deployment refuses pickup outright
   * (§A8), so no sandbox counterpart exists. The revealed details are held
   * in memory only and are never persisted to Dexie or any store.
   */
  static async getOrderPickupDetails(actor: string, orderId: string): Promise<MarketplacePickupReveal> {
    this.assertDurableServiceOnly('getOrderPickupDetails');
    return await MarketplaceTransactionService.getOrderPickupDetails(actor, orderId);
  }

  /**
   * The seller's owner read of their own pickup details plus the surviving
   * version counter (§A4) — durable service only, same boundary as the
   * buyer reveal.
   */
  /**
   * The seller's owner read of their listing's digital delivery (digital
   * delivery design §6 C5) — durable service only: the sandbox seals and
   * releases nothing.
   */
  static async getListingDigitalDelivery(
    actor: string,
    aggregateId: string,
  ): Promise<MarketplaceSellerDigitalDelivery> {
    this.assertDurableServiceOnly('getListingDigitalDelivery');
    return await MarketplaceTransactionService.getListingDigitalDelivery(actor, aggregateId);
  }

  /** The buyer's pinned digital payload for one order line (§4.2) — durable service only. */
  static async getOrderDigitalDelivery(
    actor: string,
    orderId: string,
    lineIndex: number,
  ): Promise<MarketplaceOrderDigitalDelivery> {
    this.assertDurableServiceOnly('getOrderDigitalDelivery');
    return await MarketplaceTransactionService.getOrderDigitalDelivery(actor, orderId, lineIndex);
  }

  /** The seller's delivery evidence on a digital order (§3) — durable service only. */
  static async getOrderDigitalEvidence(actor: string, orderId: string): Promise<MarketplaceOrderDigitalEvidence> {
    this.assertDurableServiceOnly('getOrderDigitalEvidence');
    return await MarketplaceTransactionService.getOrderDigitalEvidence(actor, orderId);
  }

  /** An email-kind order's delivery email and emailed time (§4.3) — durable service only. */
  static async getOrderDeliveryEmail(actor: string, orderId: string): Promise<MarketplaceOrderDeliveryEmail> {
    this.assertDurableServiceOnly('getOrderDeliveryEmail');
    return await MarketplaceTransactionService.getOrderDeliveryEmail(actor, orderId);
  }

  static async getListingPickupDetails(actor: string, aggregateId: string): Promise<MarketplaceSellerPickupDetails> {
    this.assertDurableServiceOnly('getListingPickupDetails');
    return await MarketplaceTransactionService.getListingPickupDetails(actor, aggregateId);
  }

  /**
   * The deployment's `pickup_available` capability (§A7): true iff the
   * durable service reports the pickup sealing key configured AND sandbox
   * payments disabled. False in every non-durable mode — the sandbox
   * deployment stores and reveals no pickup details — so UI gates the
   * pickup option off everywhere else.
   */
  static async getPickupAvailability(): Promise<boolean> {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) return false;
    const health = await MarketplaceTransactionService.getHealth();
    return health.pickupAvailable;
  }

  /**
   * The deployment's digital delivery capability (digital delivery design
   * §6 B5): available iff the durable service reports its digital sealing
   * key configured, with the file cap it enforces. Off in every non-durable
   * mode — the sandbox seals and releases nothing — so UI gates the Digital
   * delivery option off everywhere else.
   */
  static async getDigitalDeliveryCapability(): Promise<MarketplaceDigitalDeliveryCapability> {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) return { available: false, maxBytes: null };
    const health = await MarketplaceTransactionService.getHealth();
    return {
      available: health.digitalDeliveryAvailable,
      maxBytes: health.digitalDeliveryMaxBytes ?? null,
    };
  }

  /**
   * Whether the durable service reports USDT payments on (`/health`
   * `usdt_payments.available`, present only when its USDT flag is on). Off in
   * every non-durable mode: the sandbox has no payment rails.
   */
  static async getUsdtPaymentsCapability(): Promise<boolean> {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) return false;
    const health = await MarketplaceTransactionService.getHealth();
    return health.usdtPayments?.available === true;
  }

  /**
   * Seller-configurable payment methods — durable service only (the sandbox
   * has no payment rails). See `MarketplaceTransactionService` for the
   * endpoint semantics.
   */
  static async getSellerPaymentConfig(sellerPubky: string): Promise<SellerPaymentConfig> {
    this.assertDurableServiceOnly('getSellerPaymentConfig');
    return await MarketplaceTransactionService.getSellerPaymentConfig(sellerPubky);
  }

  static async getMyPaymentConfig(actor: string): Promise<SellerPaymentConfigOwnView | null> {
    this.assertDurableServiceOnly('getMyPaymentConfig');
    return await MarketplaceTransactionService.getMyPaymentConfig(actor);
  }

  static async putMyPaymentConfig(
    actor: string,
    input: {
      bitcoinEnabled: boolean;
      stripePaymentLink: string | null;
      stripeRestrictedKey?: string;
      paypalMerchantEmail: string | null;
      usdtEnabled?: boolean;
    },
  ): Promise<SellerPaymentConfigOwnView> {
    this.assertDurableServiceOnly('putMyPaymentConfig');
    return await MarketplaceTransactionService.putMyPaymentConfig(actor, input);
  }

  static async bindPaymentMethod(actor: string, orderId: string, method: PaymentMethodKind): Promise<MarketplaceOrder> {
    this.assertDurableServiceOnly('bindPaymentMethod');
    return await MarketplaceTransactionService.bindPaymentMethod(actor, orderId, method);
  }

  static async verifyStripePayment(
    actor: string,
    orderId: string,
  ): Promise<{ verified: boolean; order: MarketplaceOrder | null }> {
    this.assertDurableServiceOnly('verifyStripePayment');
    return await MarketplaceTransactionService.verifyStripePayment(actor, orderId);
  }

  static async markFiatPaid(actor: string, orderId: string, transactionRef?: string): Promise<MarketplaceOrder> {
    this.assertDurableServiceOnly('markFiatPaid');
    return await MarketplaceTransactionService.markFiatPaid(actor, orderId, transactionRef);
  }

  static async confirmFiatReceived(actor: string, orderId: string): Promise<MarketplaceOrder> {
    this.assertDurableServiceOnly('confirmFiatReceived');
    return await MarketplaceTransactionService.confirmFiatReceived(actor, orderId);
  }

  static async confirmBitcoinPayment(actor: string, orderId: string, reason?: string) {
    this.assertDurableServiceOnly('confirmBitcoinPayment');
    return await MarketplaceTransactionService.confirmBitcoinPayment(actor, orderId, reason);
  }

  static async resolveBitcoinPayment(
    actor: string,
    orderId: string,
    input: {
      outcome: 'paid' | 'refunded' | 'abandoned';
      reason?: string;
      externalRefundReference?: string;
    },
    idempotencyKey: string,
  ) {
    this.assertDurableServiceOnly('resolveBitcoinPayment');
    return await MarketplaceTransactionService.resolveBitcoinPayment(actor, orderId, input, idempotencyKey);
  }

  static async getMyShippingConfig(actor: string): Promise<SellerShippingConfig | null> {
    this.assertDurableServiceOnly('getMyShippingConfig');
    return await MarketplaceTransactionService.getMyShippingConfig(actor);
  }

  static async putMyShippingConfig(
    actor: string,
    input: { shippoApiKey?: string; shipFrom: ShipFromAddress | null },
  ): Promise<SellerShippingConfig> {
    this.assertDurableServiceOnly('putMyShippingConfig');
    return await MarketplaceTransactionService.putMyShippingConfig(actor, input);
  }

  static async quoteShippingRates(actor: string, orderId: string, parcel: ShippingParcel): Promise<ShippoRate[]> {
    this.assertDurableServiceOnly('quoteShippingRates');
    return await MarketplaceTransactionService.quoteShippingRates(actor, orderId, parcel);
  }

  static async purchaseShippingLabel(actor: string, orderId: string, rateId: string): Promise<ShippingLabel> {
    this.assertDurableServiceOnly('purchaseShippingLabel');
    return await MarketplaceTransactionService.purchaseShippingLabel(actor, orderId, rateId);
  }

  static async getShippingLabel(actor: string, orderId: string): Promise<ShippingLabel | null> {
    this.assertDurableServiceOnly('getShippingLabel');
    return await MarketplaceTransactionService.getShippingLabel(actor, orderId);
  }

  static async uploadAttachment(actor: string, recipient: string, file: File): Promise<MarketplaceAttachmentMetadata> {
    this.assertSandbox();
    const url = `${getMarketplaceUrl()}/v1/attachments`;
    const response = await safeFetch(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': file.type,
          'x-pubky-actor': actor,
          'x-recipient-pubky': recipient,
        },
        body: file,
      },
      ErrorService.Marketplace,
      'uploadAttachment',
    );
    const raw = await parseResponseOrThrow<unknown>(response, ErrorService.Marketplace, 'uploadAttachment', url);
    const parsed = attachmentMetadataSchema.safeParse(raw);
    if (!parsed.success) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'Marketplace returned invalid attachment metadata.', {
        service: ErrorService.Marketplace,
        operation: 'uploadAttachment',
        context: { statusCode: response.status },
      });
    }
    return parsed.data;
  }

  static async fetchAttachment(actor: string, attachmentId: string): Promise<Blob> {
    this.assertSandbox();
    const url = `${getMarketplaceUrl()}/v1/attachments/${encodeURIComponent(attachmentId)}`;
    const response = await safeFetch(
      url,
      { method: 'GET', headers: { 'x-pubky-actor': actor } },
      ErrorService.Marketplace,
      'fetchAttachment',
    );
    const bytes = new Uint8Array(await response.arrayBuffer());
    const expectedHash = response.headers.get('x-content-hash');
    if (!expectedHash || bytesToHex(blake3(bytes)) !== expectedHash) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'Marketplace attachment integrity check failed.', {
        service: ErrorService.Marketplace,
        operation: 'fetchAttachment',
        context: { statusCode: response.status },
      });
    }
    return new Blob([bytes], { type: response.headers.get('content-type') ?? 'application/octet-stream' });
  }

  /**
   * The durable service authenticates every projection read, so a read
   * without a signed-in pubky can never be satisfied — fail with the same
   * session guidance the transport gives, before any bytes leave the client.
   */
  private static requireActor(operation: string, actor: string | null): string {
    if (actor) return actor;
    throw Err.auth(
      AuthErrorCode.SESSION_EXPIRED,
      'A marketplace session is required. Sign in and approve the marketplace connection on your signer.',
      { service: ErrorService.Marketplace, operation },
    );
  }

  private static assertDurableServiceOnly(operation: string): void {
    if (!isDurableCommerceMode(getCommerceAdapterMode())) {
      throw Err.client(
        ClientErrorCode.BAD_REQUEST,
        'This marketplace read exists only on the durable transaction service.',
        {
          service: ErrorService.Marketplace,
          operation,
        },
      );
    }
  }

  private static assertSandbox(): void {
    if (getCommerceAdapterMode() !== 'sandbox') {
      throw Err.client(ClientErrorCode.BAD_REQUEST, 'Sandbox marketplace commands are disabled.', {
        service: ErrorService.Marketplace,
        operation: 'assertSandbox',
      });
    }
  }
}
