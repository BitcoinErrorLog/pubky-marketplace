'use client';

import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { extractCheckoutOrderIds } from '@/libs/commerce/checkout-phase';
import { MARKETPLACE_FAILURE_MESSAGES, marketplaceDropRefusalMessage } from '@/libs/commerce/failure-messages';
import {
  buildMarketplaceCheckoutAggregateId,
  buildMarketplaceListingAggregateId,
  isListingDeletedResponse,
  isMarketplaceRevisionConflict,
} from '@/libs/commerce/transaction-commands';
import { isMarketplaceSessionRequiredError } from '@/libs/error/error.utils';
import type { CommerceDeliveryAddressModelSchema } from '@/models/commerce/commerce.schema';
import { toast } from '@/molecules/Toaster/use-toast';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';

export interface UseMarketplaceDropClaimResult {
  /** Saved addresses in picker order (default first); the claim uses the first. */
  addresses: CommerceDeliveryAddressModelSchema[];
  claimAddress: CommerceDeliveryAddressModelSchema | null;
  /** The listing currently submitting; claims are serialized, never parallel. */
  submittingListingId: string | null;
  /** Listings this session claimed successfully (composite `seller:listingId`). */
  claimedListingIds: ReadonlySet<string>;
  /** Payment deadlines keyed by the claimed seller/listing composite id. */
  claimDeadlines?: ReadonlyMap<string, string>;
  /** Checkout row ids keyed by the claimed seller/listing composite id. */
  claimedOrderIds?: ReadonlyMap<string, string>;
  /**
   * The last claim refusal, mapped to client-owned static copy.
   */
  failure: string | null;
  needsSession: boolean;
  sessionError: string | null;
  claim: (listingOwnerPubky: string, listingId: string, remainingAllowance: number | null) => Promise<boolean>;
}

/**
 * The FCFS claim (drops design, "At T-0"): one unit of one listing per
 * checkout (the v1 rule), through the EXACT existing checkout path —
 * projection read (with the one-sync listing heal), `checkout.create` with
 * quantity 1, the buyer's saved delivery address, optimistic `submitting`
 * state, then the authoritative result. No queue UI of any kind exists:
 * the service answers reserved or refused, and a refusal renders static
 * client-owned copy.
 */
export function useMarketplaceDropClaim(onClaimed?: () => void | Promise<void>): UseMarketplaceDropClaimResult {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  // Connecting a session replaces this store object; the session-required
  // affordance clears without a failed claim attempt.
  const marketplaceSession = useCommerceStore((state) => state.marketplaceSession);
  const [submittingListingId, setSubmittingListingId] = useState<string | null>(null);
  const [claimedListingIds, setClaimedListingIds] = useState<ReadonlySet<string>>(new Set());
  const [claimDeadlines, setClaimDeadlines] = useState<ReadonlyMap<string, string>>(new Map());
  const [claimedOrderIds, setClaimedOrderIds] = useState<ReadonlyMap<string, string>>(new Map());
  const [failure, setFailure] = useState<string | null>(null);
  const [needsSession, setNeedsSession] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);

  const addresses = useLiveQuery(
    async () => {
      if (!currentUserPubky) return [];
      return await CommerceController.getDeliveryAddresses();
    },
    [currentUserPubky],
    [] as CommerceDeliveryAddressModelSchema[],
  );
  const claimAddress = addresses[0] ?? null;

  useEffect(() => {
    if (!marketplaceSession) return;
    setNeedsSession(false);
    setSessionError(null);
  }, [marketplaceSession]);

  const claim = async (
    listingOwnerPubky: string,
    listingId: string,
    remainingAllowance: number | null,
  ): Promise<boolean> => {
    if (submittingListingId !== null) return false;
    if (currentUserPubky === listingOwnerPubky) {
      setFailure('You cannot claim from your own drop');
      return false;
    }
    if (remainingAllowance === 0) {
      setFailure(MARKETPLACE_FAILURE_MESSAGES.claimRefusal);
      return false;
    }
    if (!claimAddress) {
      setFailure(MARKETPLACE_FAILURE_MESSAGES.claimAddress);
      return false;
    }
    const compositeId = `${listingOwnerPubky}:${listingId}`;
    setSubmittingListingId(compositeId);
    setFailure(null);
    try {
      let projection = await CommerceController.getMarketplaceListingProjection(listingOwnerPubky, listingId);
      let removed = false;
      if (!projection && isDurableCommerceMode(getCommerceAdapterMode())) {
        ({ projection, removed } = await syncThenReread(listingOwnerPubky, listingId));
      }
      if (!projection) {
        setFailure(
          removed ? MARKETPLACE_FAILURE_MESSAGES.listingRemoved : MARKETPLACE_FAILURE_MESSAGES.claimListingUnavailable,
        );
        return false;
      }
      const commandId = crypto.randomUUID();
      const response = await CommerceController.executeMarketplaceCommand({
        version: 1,
        commandId,
        aggregateId: buildMarketplaceCheckoutAggregateId(commandId),
        expectedRevision: 0,
        issuedAt: new Date().toISOString(),
        kind: 'checkout.create',
        payload: {
          lines: [
            {
              listingAggregateId: projection.aggregateId,
              expectedRevision: projection.serverRevision,
              quantity: 1,
            },
          ],
          deliveryAddress: {
            name: claimAddress.name,
            line1: claimAddress.line1,
            line2: claimAddress.line2,
            city: claimAddress.city,
            region: claimAddress.region,
            postalCode: claimAddress.postal_code,
            countryCode: claimAddress.country_code.toUpperCase(),
          },
          guaranteePolicyVersion: 1,
        },
      });
      if (!response.ok) {
        await Promise.resolve(onClaimed?.()).catch(() => {});
        // The service's refusal is classified by stable code and message;
        // arbitrary wire text never reaches rendered state.
        setFailure(
          isMarketplaceRevisionConflict(response)
            ? 'The listing changed while you were claiming. Refresh and try again.'
            : (marketplaceDropRefusalMessage(response.error.code, response.error.message) ??
                MARKETPLACE_FAILURE_MESSAGES.claimRefusal),
        );
        return false;
      }
      setClaimedListingIds((current) => new Set(current).add(compositeId));
      const createdIds = extractCheckoutOrderIds(response.result);
      if (createdIds[0]) {
        setClaimedOrderIds((current) => new Map(current).set(compositeId, createdIds[0]));
      }
      const responseDeadline = readHoldExpiresAt(response.result);
      const projectionDeadline =
        responseDeadline ?? (await readClaimedOrderDeadline(projection.aggregateId)).holdExpiresAt;
      if (projectionDeadline) {
        setClaimDeadlines((current) => new Map(current).set(compositeId, projectionDeadline));
      }
      toast({
        title: 'Claimed',
        description: responseDeadline
          ? `Reserved while you pay. Continue checkout by ${formatDeadline(responseDeadline)}.`
          : 'Reserved. Continue checkout to pay.',
      });
      await Promise.resolve(onClaimed?.()).catch(() => {});
      return true;
    } catch (claimError) {
      await Promise.resolve(onClaimed?.()).catch(() => {});
      if (isMarketplaceSessionRequiredError(claimError)) {
        setNeedsSession(true);
        setSessionError(MARKETPLACE_FAILURE_MESSAGES.session);
        return false;
      }
      setFailure(MARKETPLACE_FAILURE_MESSAGES.claim);
      return false;
    } finally {
      setSubmittingListingId(null);
    }
  };

  return {
    addresses,
    claimAddress,
    submittingListingId,
    claimedListingIds,
    claimDeadlines,
    claimedOrderIds,
    failure,
    needsSession,
    sessionError,
    claim,
  };
}

function readHoldExpiresAt(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as Record<string, unknown>;
  for (const key of ['hold_expires_at', 'holdExpiresAt']) {
    if (typeof record[key] === 'string') return record[key];
  }
  for (const value of Object.values(record)) {
    const nested = readHoldExpiresAt(value);
    if (nested) return nested;
  }
  return null;
}

async function readClaimedOrderDeadline(listingAggregateId: string): Promise<{ holdExpiresAt: string | null }> {
  const getOrders = CommerceController.getMarketplaceOrders;
  if (typeof getOrders !== 'function') return { holdExpiresAt: null };
  try {
    const orders = await getOrders();
    const order = orders.find(
      (candidate) =>
        candidate.state === 'pending_payment' &&
        candidate.lines.some((line) => line.listingAggregateId === listingAggregateId),
    );
    return { holdExpiresAt: order?.holdExpiresAt ?? null };
  } catch {
    return { holdExpiresAt: null };
  }
}

function formatDeadline(deadline: string): string {
  return new Date(deadline).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * One `listing.sync` attempt followed by one projection re-read — the same
 * buyer-side heal the cart checkout uses for a listing published before
 * durable-mode registration existed. A sync that reports the seller deleted
 * the listing sets `removed` so the caller can say so.
 */
async function syncThenReread(sellerPubky: string, listingId: string) {
  try {
    const response = await CommerceController.syncListingRegistration(sellerPubky, listingId);
    if (!response.ok) return { projection: null, removed: false };
    if (isListingDeletedResponse(response, buildMarketplaceListingAggregateId(sellerPubky, listingId))) {
      return { projection: null, removed: true };
    }
    return {
      projection: await CommerceController.getMarketplaceListingProjection(sellerPubky, listingId),
      removed: false,
    };
  } catch {
    return { projection: null, removed: false };
  }
}
