'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getCommerceAdapterMode, getCommercePollIntervalMs, isLocksPaykitCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { MARKETPLACE_FAILURE_MESSAGES, marketplaceFailureMessage } from '@/libs/commerce/failure-messages';
import type { CommerceDigitalLock } from '@/libs/commerce/marketplace-records';
import { isMarketplaceRevisionConflict } from '@/libs/commerce/transaction-commands';
import type { CommerceLocksCorrelationModelSchema } from '@/models/commerce/commerce.schema';
import { toast } from '@/molecules/Toaster/use-toast';
import type { MarketplaceOrder, MarketplacePayment } from '@/services/marketplace/marketplace';

/**
 * Fallback polling bound when the registration's marketplace payment window
 * is unknown (e.g. resumed before registration succeeded). Polling never runs
 * unbounded: it stops here at the latest and the user resumes it explicitly.
 */
const LOCKS_POLL_FALLBACK_BOUND_MS = 15 * 60 * 1_000;

export interface MarketplaceLocksDelivery {
  objectUrl: string;
  fileName: string;
  byteSize: number;
}

/**
 * The buyer's side of a real Locks/Paykit payment for one order
 * (`locks-paykit` mode).
 *
 * - `start` submits the proof bundle to the Lock Server (which requests the
 *   real Paykit invoice and privately delivers the Payment Request to the
 *   buyer's wallet) and registers the correlation with the transaction
 *   service via `payment.register_locks`, sourcing `expected_revision` from a
 *   freshly-read payment projection. A revision conflict refetches and asks
 *   the user to retry — never a blind resubmit.
 * - Status polling reads the order projection back from the transaction
 *   service. THE CLIENT NEVER ADVANCES THE PAYMENT: the service's worker
 *   independently verifies the Locks lifecycle and confirms exactly once.
 *   Polling is abortable (unmount), bounded (the registration's payment
 *   window, or a fallback bound), and resumable — the correlation is
 *   persisted, so a reload re-reads the durable state and picks up where the
 *   buyer left off.
 * - `unlock` redeems a confirmed payment for the guarded digital content and
 *   verifies its BLAKE3 hash before offering it to the buyer.
 */
export function useMarketplaceLocksPayment({
  order,
  payment,
  digitalLock,
  isBuyer,
  onPaymentChanged,
}: {
  order: MarketplaceOrder;
  payment: MarketplacePayment | null;
  digitalLock: CommerceDigitalLock | null;
  isBuyer: boolean;
  onPaymentChanged: () => void | Promise<void>;
}) {
  const adapterMode = getCommerceAdapterMode();
  const enabled = isLocksPaykitCommerceMode(adapterMode) && isBuyer && Boolean(digitalLock) && payment !== null;

  const [correlation, setCorrelation] = useState<CommerceLocksCorrelationModelSchema | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const [delivery, setDelivery] = useState<MarketplaceLocksDelivery | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by resumePolling to restart a bounded poll that reached its limit.
  const [pollEpoch, setPollEpoch] = useState(0);
  const [pollExhausted, setPollExhausted] = useState(false);
  const deliveryRef = useRef<MarketplaceLocksDelivery | null>(null);

  const loadCorrelation = useCallback(async () => {
    if (!enabled || !payment) {
      setCorrelation(null);
      return;
    }
    try {
      setCorrelation((await CommerceController.getMarketplaceLocksCorrelation(payment.id)) ?? null);
    } catch {
      setCorrelation(null);
    }
  }, [enabled, payment?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void loadCorrelation();
  }, [loadCorrelation]);

  // Bounded, abortable status polling while the payment can still move.
  // The projection read is the ONLY source of payment progress.
  useEffect(() => {
    if (!enabled || !payment || !correlation) return;
    if (payment.state !== 'awaiting_entitlement' && payment.state !== 'detected') return;
    const boundAt = correlation.window_expires_at
      ? Date.parse(correlation.window_expires_at) + 60_000
      : Date.now() + LOCKS_POLL_FALLBACK_BOUND_MS;
    let active = true;
    setPollExhausted(false);
    const timer = window.setInterval(() => {
      if (!active) return;
      if (Date.now() > boundAt) {
        window.clearInterval(timer);
        setPollExhausted(true);
        return;
      }
      void Promise.resolve(onPaymentChanged()).catch(() => undefined);
    }, getCommercePollIntervalMs());
    return () => {
      active = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, payment?.id, payment?.state, correlation?.id, correlation?.window_expires_at, pollEpoch]);

  useEffect(() => {
    deliveryRef.current = delivery;
  }, [delivery]);

  useEffect(
    () => () => {
      if (deliveryRef.current) URL.revokeObjectURL(deliveryRef.current.objectUrl);
    },
    [],
  );

  const start = async (): Promise<boolean> => {
    if (!enabled || !payment || !digitalLock) return false;
    setIsStarting(true);
    setError(null);
    try {
      // Fresh read so expected_revision reflects the current aggregate, not a
      // possibly stale list render.
      const freshOrder = await CommerceController.getMarketplaceOrder(order.id);
      const freshPayment = freshOrder?.payment ?? payment;
      const response = await CommerceController.beginMarketplaceLocksPayment({
        order: freshOrder ?? order,
        payment: freshPayment,
        digitalLock,
      });
      await loadCorrelation();
      if (!response.ok) {
        if (isMarketplaceRevisionConflict(response)) {
          await onPaymentChanged();
          toast({
            variant: 'error',
            description: 'This payment changed since you loaded it. The latest state was reloaded — retry from there.',
          });
          return false;
        }
        setError(marketplaceFailureMessage(response.error.code, MARKETPLACE_FAILURE_MESSAGES.locksPayment));
        return false;
      }
      await onPaymentChanged();
      return true;
    } catch {
      setError('The payment request could not be created. Nothing was charged; you can retry.');
      return false;
    } finally {
      setIsStarting(false);
    }
  };

  const unlock = async (): Promise<boolean> => {
    if (!enabled || !payment) return false;
    setIsUnlocking(true);
    setError(null);
    try {
      const { bytes, contentPath } = await CommerceController.unlockMarketplaceLocksContent(payment.id);
      const objectUrl = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer]));
      if (deliveryRef.current) URL.revokeObjectURL(deliveryRef.current.objectUrl);
      setDelivery({
        objectUrl,
        fileName: contentPath.split('/').filter(Boolean).at(-1) ?? contentPath,
        byteSize: bytes.byteLength,
      });
      return true;
    } catch {
      setError('The content could not be unlocked or failed its integrity check.');
      return false;
    } finally {
      setIsUnlocking(false);
    }
  };

  const resumePolling = () => {
    setPollExhausted(false);
    setPollEpoch((epoch) => epoch + 1);
  };

  return {
    enabled,
    correlation,
    isStarting,
    isUnlocking,
    delivery,
    error,
    pollExhausted,
    start,
    unlock,
    resumePolling,
  };
}
