'use client';

import { useEffect, useRef, useState } from 'react';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  classifyDigitalDeliverRefusal,
  DIGITAL_DELIVER_REFUSAL_COPY,
  DIGITAL_READ_REFUSAL_COPY,
  DIGITAL_SELLER_COPY,
  digitalEvidenceLines,
  digitalOrderManualChannels,
  isDigitalOrderEnded,
  type MarketplaceDigitalDeliveryChannel,
  type MarketplaceOrderDeliveryEmail,
  sellerDeliveryEmailReadCopy,
} from '@/libs/commerce/digital';
import { AppError } from '@/libs/error/error';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';

export type SellerDeliveryEmailState =
  | { status: 'hidden' }
  | { status: 'loading' }
  | { status: 'shown'; email: MarketplaceOrderDeliveryEmail }
  | { status: 'refused'; message: string };

export type SellerDeliveryEvidenceState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; lines: string[] }
  | { status: 'failed' };

const HIDDEN: SellerDeliveryEmailState = { status: 'hidden' };

/** The service releases the buyer's email only on a paid digital order that has not ended (§6 F7, F8). */
function emailEntitled(order: MarketplaceOrder): boolean {
  return order.fulfillment === 'digital' && order.receiptId !== null && !isDigitalOrderEnded(order.state);
}

/**
 * The seller's delivery actions on a digital order (digital delivery design
 * §3 "Seller's orders", §4.3, §6 F6–F8, F13–F15): Show email reads the
 * buyer's address on request and holds it in memory until hidden, marked, or
 * the order stops entitling the read; Mark emailed and Mark delivered send
 * `fulfillment.deliver_digital` with the order revision, so a racing buyer
 * cancel request has one winner. Both reads are accepted only for this order.
 */
export function useSellerDigitalDelivery(order: MarketplaceOrder, onChanged?: () => Promise<void> | void) {
  const [storedEmail, setEmail] = useState<SellerDeliveryEmailState>(HIDDEN);
  const [acting, setActing] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<SellerDeliveryEvidenceState>({ status: 'idle' });
  const [evidenceAttempt, setEvidenceAttempt] = useState(0);
  const paid = order.fulfillment === 'digital' && order.receiptId !== null;
  const entitled = emailEntitled(order);
  const latest = useRef({ id: order.id, entitled });

  useEffect(() => {
    latest.current = { id: order.id, entitled };
    if (!entitled) setEmail(HIDDEN);
  }, [order.id, entitled]);

  // The delivery evidence (§3 "Seller's orders"): timestamps and an open
  // count only, read on view once the order is paid and after each mark.
  useEffect(() => {
    if (!paid) {
      setEvidence({ status: 'idle' });
      return;
    }
    let current = true;
    setEvidence({ status: 'loading' });
    CommerceController.fetchOrderDigitalEvidence(order.id)
      .then((read) => {
        if (!current) return;
        setEvidence(
          read.orderId === order.id
            ? { status: 'ready', lines: digitalEvidenceLines(read, order.lines) }
            : { status: 'failed' },
        );
      })
      .catch(() => {
        if (current) setEvidence({ status: 'failed' });
      });
    return () => {
      current = false;
    };
    // The evidence follows the order's identity and revision, not each new object of the same order.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- order identity is id+revision
  }, [paid, order.id, order.revision, evidenceAttempt]);

  const showEmail = async () => {
    const orderId = order.id;
    const stillEntitled = () => latest.current.id === orderId && latest.current.entitled;
    setEmail({ status: 'loading' });
    try {
      const read = await CommerceController.fetchOrderDeliveryEmail(orderId);
      if (!stillEntitled()) {
        setEmail(HIDDEN);
        return;
      }
      setEmail(
        read.orderId === orderId
          ? { status: 'shown', email: read }
          : { status: 'refused', message: DIGITAL_READ_REFUSAL_COPY.failed },
      );
    } catch (error) {
      if (!stillEntitled()) {
        setEmail(HIDDEN);
        return;
      }
      const refusal = error instanceof AppError ? error.context?.refusal : undefined;
      setEmail({
        status: 'refused',
        message: sellerDeliveryEmailReadCopy(typeof refusal === 'string' ? refusal : null),
      });
    }
  };

  const mark = async (channel: MarketplaceDigitalDeliveryChannel): Promise<boolean> => {
    setActing(true);
    setMessage(null);
    try {
      const response = await CommerceController.commitDeliverDigital(order.id, order.revision, channel);
      if (!response.ok) {
        const refusal = classifyDigitalDeliverRefusal(response.error, { orderState: order.state, channel });
        setMessage(refusal ? DIGITAL_DELIVER_REFUSAL_COPY[refusal] : DIGITAL_SELLER_COPY.deliverFailed);
        if (refusal === 'changed' || refusal === 'already_marked') await onChanged?.();
        return false;
      }
      setMessage(channel === 'email' ? DIGITAL_SELLER_COPY.markedEmailed : DIGITAL_SELLER_COPY.markedDelivered);
      setEmail(HIDDEN);
      setEvidenceAttempt((value) => value + 1);
      await onChanged?.();
      return true;
    } catch {
      setMessage(DIGITAL_SELLER_COPY.deliverFailed);
      return false;
    } finally {
      setActing(false);
    }
  };

  return {
    channels: digitalOrderManualChannels(order.lines),
    // Hidden in the same render the order stops entitling the read, before the effect clears it.
    email: entitled ? storedEmail : HIDDEN,
    showEmail,
    hideEmail: () => setEmail(HIDDEN),
    mark,
    acting,
    message,
    /** Idle before payment; ready only on a successful read for this order. */
    evidence,
    retryEvidence: () => setEvidenceAttempt((value) => value + 1),
  };
}
