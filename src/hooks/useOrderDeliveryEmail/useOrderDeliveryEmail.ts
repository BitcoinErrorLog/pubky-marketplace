'use client';

import { useEffect, useState } from 'react';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  classifyDeliveryEmailChangeRefusal,
  DELIVERY_EMAIL_CHANGE_COPY,
  DIGITAL_CHECKOUT_REFUSAL_COPY,
  isWellFormedDeliveryEmail,
  type MarketplaceOrderDeliveryEmail,
} from '@/libs/commerce/digital';
import { AppError } from '@/libs/error/error';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';
import { orderDigitalReadFailureMessage } from '../useOrderDigitalDelivery/useOrderDigitalDelivery';

export type OrderDeliveryEmailState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; email: MarketplaceOrderDeliveryEmail }
  /** No address on file (purged, or never stored): the buyer can enter one (§6 F9). */
  | { status: 'missing' }
  | { status: 'failed'; message: string };

/** True when the order has a line the seller emails. */
export function orderHasEmailLine(order: MarketplaceOrder): boolean {
  return order.fulfillment === 'digital' && order.lines.some((line) => line.digitalKind === 'email');
}

/**
 * The delivery email on the buyer's email-kind order (digital delivery design
 * §4.3, §6 F5, F9, F11, F12): read on view (never stored), and changeable
 * until the seller marks it emailed.
 */
export function useOrderDeliveryEmail(
  order: MarketplaceOrder,
  { enabled, onChanged }: { enabled: boolean; onChanged?: () => Promise<void> | void },
) {
  const [state, setState] = useState<OrderDeliveryEmailState>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [changeMessage, setChangeMessage] = useState<string | null>(null);
  const active = enabled && orderHasEmailLine(order);

  useEffect(() => {
    if (!active) return;
    let current = true;
    setState({ status: 'loading' });
    CommerceController.fetchOrderDeliveryEmail(order.id)
      .then((email) => {
        if (current) setState({ status: 'ready', email });
      })
      .catch((error: unknown) => {
        if (!current) return;
        if (error instanceof AppError && error.context?.refusal === 'email_missing') {
          setState({ status: 'missing' });
          return;
        }
        setState({ status: 'failed', message: orderDigitalReadFailureMessage(error) });
      });
    return () => {
      current = false;
    };
  }, [active, order.id, attempt]);

  /** Saves a new address; true when the service took it. */
  const change = async (deliveryEmail: string): Promise<boolean> => {
    const trimmed = deliveryEmail.trim();
    if (!isWellFormedDeliveryEmail(trimmed)) {
      setChangeMessage(
        trimmed ? DIGITAL_CHECKOUT_REFUSAL_COPY.invalid_email : DIGITAL_CHECKOUT_REFUSAL_COPY.email_required,
      );
      return false;
    }
    setSaving(true);
    setChangeMessage(null);
    try {
      const response = await CommerceController.commitSetDeliveryEmail(order.id, order.revision, trimmed);
      if (!response.ok) {
        const refusal = classifyDeliveryEmailChangeRefusal(response.error);
        setChangeMessage(DELIVERY_EMAIL_CHANGE_COPY[refusal ?? 'failed']);
        if (refusal === 'already_emailed' || refusal === 'changed') {
          setAttempt((value) => value + 1);
          await onChanged?.();
        }
        return false;
      }
      setChangeMessage(DELIVERY_EMAIL_CHANGE_COPY.saved);
      setAttempt((value) => value + 1);
      await onChanged?.();
      return true;
    } catch {
      setChangeMessage(DELIVERY_EMAIL_CHANGE_COPY.failed);
      return false;
    } finally {
      setSaving(false);
    }
  };

  return {
    state,
    saving,
    changeMessage,
    change,
    retry: () => setAttempt((value) => value + 1),
  };
}
