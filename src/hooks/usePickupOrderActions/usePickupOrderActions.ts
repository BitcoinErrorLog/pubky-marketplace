'use client';

import { useState } from 'react';
import { CommerceController } from '@/controllers/commerce/commerce';
import { MARKETPLACE_FAILURE_MESSAGES } from '@/libs/commerce/failure-messages';
import { classifyMarketplacePickupRefusal, pickupRefusalToastDescription } from '@/libs/commerce/pickup';
import { buildMarketplaceOrderAggregateId, isMarketplaceRevisionConflict } from '@/libs/commerce/transaction-commands';
import { isMarketplaceSessionRequiredError } from '@/libs/error/error.utils';
import { toast } from '@/molecules/Toaster/use-toast';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';

export type PickupHandoverOutcome = 'confirmed' | 'terms_blocked' | false;
export type PickupCancelOutcome = 'cancelled' | 'cancel_requested' | false;

export interface UsePickupOrderActionsResult {
  isActing: boolean;
  /** Seller: `fulfillment.mark_ready` from `paid` (§A6). */
  markReady: () => Promise<boolean>;
  /**
   * Either party: `fulfillment.confirm_pickup` from `paid` |
   * `ready_for_pickup` (§A6). Returns `'terms_blocked'` when the service
   * refuses a SELLER-actor confirm because a post-payment terms change is
   * unresolved — the caller renders the explanation instead of an error.
   */
  confirmHandover: () => Promise<PickupHandoverOutcome>;
  /**
   * Buyer: `order.cancel_request`. The service answers either the unilateral
   * exit (`cancelled` — terms-change or bounded withdrawal, §A3) or, when
   * the request raced `fulfillment.mark_ready` before the first reveal, the
   * ordinary `cancel_requested` — the caller renders that degraded outcome
   * honestly (§7.2), never the unilateral-exit copy.
   */
  cancelOrder: (reason: string) => Promise<PickupCancelOutcome>;
}

/**
 * Pickup-path order commands (local pickup design PART A, §A6/§A7). All
 * read `expected_revision` from the freshly loaded order; a
 * `REVISION_CONFLICT` refetches through `onChanged` and asks for a retry —
 * the same discipline as `useMarketplaceOrders.actOnOrder`.
 */
export function usePickupOrderActions(
  order: MarketplaceOrder,
  onChanged: () => Promise<void> | void,
): UsePickupOrderActionsResult {
  const [isActing, setIsActing] = useState(false);

  const run = async <T>(action: () => Promise<T>): Promise<T | false> => {
    setIsActing(true);
    try {
      return await action();
    } catch (actionError) {
      if (isMarketplaceSessionRequiredError(actionError)) {
        toast({ variant: 'error', description: actionError.message });
      } else {
        toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.order });
      }
      return false;
    } finally {
      setIsActing(false);
    }
  };

  const markReady = (): Promise<boolean> =>
    run(async () => {
      const response = await CommerceController.commitMarkReady(order.id, order.revision);
      if (!response.ok) {
        if (isMarketplaceRevisionConflict(response)) {
          await onChanged();
          toast({
            variant: 'error',
            description: 'This order changed since you loaded it. The latest state was reloaded — retry from there.',
          });
          return false;
        }
        toast({ variant: 'error', description: pickupRefusalToastDescription(response.error.message) });
        return false;
      }
      toast({ title: 'Ready for pickup', description: 'The buyer was notified that the order is ready to collect.' });
      await onChanged();
      return true;
    });

  const confirmHandover = (): Promise<PickupHandoverOutcome> =>
    run<PickupHandoverOutcome>(async () => {
      const response = await CommerceController.commitConfirmPickup(order.id, order.revision);
      if (!response.ok) {
        if (isMarketplaceRevisionConflict(response)) {
          await onChanged();
          toast({
            variant: 'error',
            description: 'This order changed since you loaded it. The latest state was reloaded — retry from there.',
          });
          return false;
        }
        // The seller-actor refusal during an unresolved terms change (§A6) is
        // an expected outcome with its own explanation, not an error.
        if (classifyMarketplacePickupRefusal(response.error.message) === 'terms_change_unresolved') {
          return 'terms_blocked';
        }
        toast({ variant: 'error', description: pickupRefusalToastDescription(response.error.message) });
        return false;
      }
      toast({ title: 'Handover confirmed', description: 'The pickup is complete — the order is delivered.' });
      await onChanged();
      return 'confirmed';
    }).then((outcome) => outcome ?? false);

  const cancelOrder = (reason: string): Promise<PickupCancelOutcome> =>
    run<PickupCancelOutcome>(async () => {
      const response = await CommerceController.executeMarketplaceCommand({
        version: 1,
        commandId: crypto.randomUUID(),
        aggregateId: buildMarketplaceOrderAggregateId(order.id),
        expectedRevision: order.revision,
        issuedAt: new Date().toISOString(),
        kind: 'order.cancel_request',
        payload: { orderId: order.id, reason },
      });
      if (!response.ok) {
        if (isMarketplaceRevisionConflict(response)) {
          await onChanged();
          toast({
            variant: 'error',
            description: 'This order changed since you loaded it. The latest state was reloaded — retry from there.',
          });
          return false;
        }
        toast({ variant: 'error', description: pickupRefusalToastDescription(response.error.message) });
        return false;
      }
      await onChanged();
      const result = response.result as { kind?: string; order?: { state?: string } };
      return result.kind === 'order' && result.order?.state === 'cancelled' ? 'cancelled' : 'cancel_requested';
    }).then((outcome) => outcome ?? false);

  return { isActing, markReady, confirmHandover, cancelOrder };
}
