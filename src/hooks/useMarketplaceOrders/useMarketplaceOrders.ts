'use client';

import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import { getCommerceAdapterMode, getCommercePollIntervalMs, isTransactionalCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  MARKETPLACE_FAILURE_MESSAGES,
  marketplaceErrorCode,
  marketplaceFailureMessage,
} from '@/libs/commerce/failure-messages';
import { orderShowsCommandResult } from '@/libs/commerce/order-command-result';
import { plainRefundRefusal } from '@/libs/commerce/partial-refund';
import { pickupRefusalFailureMessage } from '@/libs/commerce/pickup';
import { orderChangedMessage } from '@/libs/commerce/refund-copy';
import {
  buildMarketplaceOrderAggregateId,
  buildMarketplacePaymentAggregateId,
  classifyMarketplacePickupCommandRefusal,
  isMarketplaceRevisionConflict,
} from '@/libs/commerce/transaction-commands';
import { isMarketplaceSessionRequiredError } from '@/libs/error/error.utils';
import { toast } from '@/molecules/Toaster/use-toast';
import type { MarketplaceOrder, MarketplacePayment, MarketplaceReceipt } from '@/services/marketplace/marketplace';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';

export interface MarketplaceOrderView {
  order: MarketplaceOrder;
  payment: MarketplacePayment | null;
  receipt: MarketplaceReceipt | null;
}

/**
 * Order timelines against whichever transactional backend the mode selects:
 * the in-memory sandbox or the durable transaction service. Post-purchase
 * commands source `expected_revision` from the freshly-loaded order. A
 * `REVISION_CONFLICT` re-reads the order: when that read already shows the
 * command's result, the action succeeded; otherwise the buyer is asked to
 * retry from the reloaded order.
 *
 * `payment.sandbox_advance` remains SANDBOX-ONLY: the durable service still
 * models payments with its sandbox adapter (no funds move anywhere), and this
 * client refuses to simulate payment progress against the authority — so in
 * `transaction-service` mode a payment can only advance if some other actor
 * (e.g. a test harness) drives it.
 */
export function useMarketplaceOrders() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  // Refetch trigger: connecting a session replaces this store object, so the
  // effect below re-runs immediately instead of waiting for the next poll.
  const marketplaceSession = useCommerceStore((state) => state.marketplaceSession);
  const adapterMode = getCommerceAdapterMode();
  const isTransactional = isTransactionalCommerceMode(adapterMode);
  const [orders, setOrders] = useState<MarketplaceOrderView[]>([]);
  const [isLoading, setIsLoading] = useState(isTransactional && Boolean(currentUserPubky));
  const [error, setError] = useState<string | null>(null);
  const [needsSession, setNeedsSession] = useState(false);

  const readOrders = () => loadOrders(currentUserPubky, setOrders, setIsLoading, setError, setNeedsSession);
  const refresh = async () => {
    await readOrders();
  };

  useEffect(() => {
    if (!currentUserPubky || !isTransactional) {
      setIsLoading(false);
      return;
    }
    let active = true;
    void loadOrders(currentUserPubky, setOrders, setIsLoading, setError, setNeedsSession);
    const timer = window.setInterval(() => {
      if (active) void loadOrders(currentUserPubky, setOrders, setIsLoading, setError, setNeedsSession);
    }, getCommercePollIntervalMs());
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [currentUserPubky, isTransactional, marketplaceSession]);

  const advancePayment = async (
    payment: MarketplacePayment,
    target: 'detected' | 'confirmed' | 'expired' | 'manual_review',
    confirmations: number,
  ) => {
    // Re-checked at call time: the render-time flag can go stale if the mode changes.
    if (getCommerceAdapterMode() !== 'sandbox') {
      toast({ variant: 'error', description: 'Simulated payments only exist on the sandbox service.' });
      return false;
    }
    try {
      const response = await CommerceController.executeMarketplaceCommand({
        version: 1,
        commandId: crypto.randomUUID(),
        aggregateId: buildMarketplacePaymentAggregateId(payment.id),
        expectedRevision: payment.revision,
        issuedAt: new Date().toISOString(),
        kind: 'payment.sandbox_advance',
        payload: { paymentId: payment.id, target, confirmations },
      });
      if (!response.ok) {
        if (isMarketplaceRevisionConflict(response)) {
          await refresh();
          toast({
            variant: 'error',
            description: MARKETPLACE_FAILURE_MESSAGES.paymentChanged,
          });
          return false;
        }
        toast({
          variant: 'error',
          description: marketplaceFailureMessage(response.error.code, MARKETPLACE_FAILURE_MESSAGES.sandboxPayment),
        });
        return false;
      }
      await refresh();
      return true;
    } catch (actionError) {
      if (isMarketplaceSessionRequiredError(actionError)) {
        // Expiry mid-action must surface the reconnect affordance, not a
        // generic failure: the surface swaps to the session-required card.
        setNeedsSession(true);
        setError(MARKETPLACE_FAILURE_MESSAGES.session);
        toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.session });
        return false;
      }
      toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.sandboxPayment });
      return false;
    }
  };

  const actOnOrder = async (order: MarketplaceOrder, kind: string, payload: Record<string, unknown>) => {
    try {
      const response = await CommerceController.executeMarketplaceCommand({
        version: 1,
        commandId: crypto.randomUUID(),
        aggregateId: buildMarketplaceOrderAggregateId(order.id),
        expectedRevision: order.revision,
        issuedAt: new Date().toISOString(),
        kind,
        payload: { orderId: order.id, ...payload },
      });
      if (!response.ok) {
        if (isMarketplaceRevisionConflict(response)) {
          const fresh = await readOrders();
          const current = fresh?.find((view) => view.order.id === order.id)?.order;
          if (current && orderShowsCommandResult(current, kind, payload)) {
            return true;
          }
          toast({
            variant: 'error',
            description: orderChangedMessage(order, current),
          });
          return false;
        }
        const pickupRefusal = classifyMarketplacePickupCommandRefusal(response);
        const isPickupCommand =
          kind === 'fulfillment.mark_ready' ||
          kind === 'fulfillment.confirm_pickup' ||
          kind === 'pickup_details.set' ||
          kind === 'pickup_details.clear' ||
          (kind === 'order.cancel_request' && order.fulfillment === 'pickup');
        const refundRefusal = kind === 'refund.record_external' ? plainRefundRefusal(response.error.message) : null;
        toast({
          variant: 'error',
          description:
            pickupRefusal || isPickupCommand
              ? pickupRefusalFailureMessage(pickupRefusal)
              : (refundRefusal ?? marketplaceFailureMessage(response.error.code, MARKETPLACE_FAILURE_MESSAGES.order)),
        });
        return false;
      }
      if (kind === 'review.create' || kind === 'review.update') {
        await publishReviewRecord(order, response.result);
      }
      await refresh();
      return true;
    } catch (actionError) {
      if (isMarketplaceSessionRequiredError(actionError)) {
        setNeedsSession(true);
        setError(MARKETPLACE_FAILURE_MESSAGES.session);
        toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.session });
        return false;
      }
      toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.order });
      return false;
    }
  };

  return { orders, isLoading, error, needsSession, refresh, advancePayment, actOnOrder, adapterMode };
}

/**
 * Publishes the reviewer-owned public review record (with the embedded
 * purchase attestation) after the service accepted the review. The review
 * itself already succeeded; a publication failure is reported honestly and
 * the staged record retries when the orders surface next loads.
 */
async function publishReviewRecord(order: MarketplaceOrder, result: unknown): Promise<void> {
  try {
    const published = await CommerceController.publishOwnMarketplaceReview(
      order,
      (result ?? {}) as Record<string, unknown>,
    );
    if (published === null) return; // No attestation issued: review stays service-only.
    toast({ description: 'Review published to your homeserver with its purchase attestation.' });
  } catch {
    toast({
      variant: 'error',
      description:
        'Your review was saved, but publishing the public record to your homeserver failed. It will retry when your orders next load.',
    });
  }
}

async function loadOrders(
  currentUserPubky: string | null,
  setOrders: Dispatch<SetStateAction<MarketplaceOrderView[]>>,
  setIsLoading: Dispatch<SetStateAction<boolean>>,
  setError: Dispatch<SetStateAction<string | null>>,
  setNeedsSession: Dispatch<SetStateAction<boolean>>,
): Promise<MarketplaceOrderView[] | null> {
  if (!currentUserPubky || !isTransactionalCommerceMode(getCommerceAdapterMode())) return null;
  // Retryable outbox for own-review records: any publication that failed
  // mid-flight is retried whenever this surface loads. Best-effort — a
  // failure keeps the row pending and is logged inside the application.
  void CommerceController.resumeOwnReviewPublications().catch(() => undefined);
  void CommerceController.sweepOwnAuctionReserves().catch(() => undefined);
  // Same outbox semantics for own review-RESPONSE records (subject-only
  // responses published to the responder's homeserver).
  void CommerceController.resumeOwnReviewResponsePublications().catch(() => undefined);
  try {
    const orders = await CommerceController.getMarketplaceOrders();
    const views = await Promise.all(
      orders.map(async (order) => {
        // The durable service embeds the payment projection in the order
        // read; the sandbox serves it from its own endpoint.
        const payment = order.payment ?? (await CommerceController.getMarketplacePayment(order.paymentId));
        const receipt = order.receiptId ? await CommerceController.getMarketplaceReceipt(order.receiptId) : null;
        return { order, payment, receipt };
      }),
    );
    setOrders(views);
    setError(null);
    setNeedsSession(false);
    // Portable order receipts (credible exit): best-effort publication of
    // any missing signed receipt document to the user's own homeserver.
    // Failures are logged in the application layer and retry on next load.
    void CommerceController.publishOrderReceipts(orders).catch(() => undefined);
    return views;
  } catch (loadError) {
    // A missing/expired marketplace session is not a dead end: flag it so the
    // surface renders the session-connect affordance with static guidance.
    setNeedsSession(isMarketplaceSessionRequiredError(loadError));
    setError(
      marketplaceFailureMessage(
        marketplaceErrorCode(loadError),
        MARKETPLACE_FAILURE_MESSAGES.ordersUnavailable,
        loadError,
      ),
    );
    return null;
  } finally {
    setIsLoading(false);
  }
}
