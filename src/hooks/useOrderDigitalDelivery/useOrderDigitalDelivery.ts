'use client';

import { useState } from 'react';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  bindOrderDigitalLine,
  classifyDigitalReadRefusal,
  DIGITAL_FILE_OPEN_FAILURE_COPY,
  DIGITAL_ORDER_LINE_MISMATCH_COPY,
  DIGITAL_READ_REFUSAL_COPY,
  type MarketplaceDigitalDeliveryKind,
} from '@/libs/commerce/digital';
import { MARKETPLACE_FAILURE_MESSAGES } from '@/libs/commerce/failure-messages';
import { AppError } from '@/libs/error/error';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { isMarketplaceSessionRequiredError } from '@/libs/error/error.utils';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';

/** How long a saved file's object URL outlives the click that starts the download. */
const OBJECT_URL_LIFETIME_MS = 1_000;

export type OrderDigitalLine = {
  lineIndex: number;
  title: string;
  kind: MarketplaceDigitalDeliveryKind;
};

export type OrderDigitalLineState = { status: 'idle' | 'opening' | 'failed'; message: string | null };

/** A revealed link or text, held in component memory only. */
export type OrderDigitalReveal = { kind: 'link'; url: string } | { kind: 'text'; text: string };

/** The digital lines of an order, with the kind each was bought as. */
export function orderDigitalLines(order: MarketplaceOrder): OrderDigitalLine[] {
  if (order.fulfillment !== 'digital') return [];
  return order.lines.flatMap((line, lineIndex) =>
    line.digitalKind ? [{ lineIndex, title: line.title, kind: line.digitalKind }] : [],
  );
}

/** Plain copy for a failed read: the refusal's own copy, never the service message. */
export function orderDigitalReadFailureMessage(error: unknown): string {
  if (isMarketplaceSessionRequiredError(error)) return MARKETPLACE_FAILURE_MESSAGES.session;
  if (error instanceof AppError) {
    const refusal = classifyDigitalReadRefusal(error.context?.refusal);
    if (refusal) return DIGITAL_READ_REFUSAL_COPY[refusal];
    if (error.code === ClientErrorCode.NOT_FOUND) return DIGITAL_READ_REFUSAL_COPY.not_found;
  }
  return DIGITAL_READ_REFUSAL_COPY.failed;
}

/** Hands decrypted bytes to the browser as a download, then drops the object URL. */
export function saveDigitalFile(bytes: Uint8Array, fileName: string, contentType: string): void {
  const blob = new Blob([new Uint8Array(bytes)], { type: contentType });
  bytes.fill(0);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_LIFETIME_MS);
}

/**
 * The buyer's purchase on a digital order (digital delivery design §3 "After
 * payment", §3.4). Every action reads the pinned payload of that one line
 * fresh; the service logs each read as an access to that line, so nothing is
 * read until the buyer asks, and opening one line never releases another. A
 * file is fetched from the seller's homeserver, verified, decrypted and
 * saved; a link or text is shown until hidden. No key, link, text or file is
 * persisted.
 */
export function useOrderDigitalDelivery(order: MarketplaceOrder) {
  const [states, setStates] = useState<Record<number, OrderDigitalLineState>>({});
  const [reveals, setReveals] = useState<Record<number, OrderDigitalReveal>>({});

  const setLine = (lineIndex: number, next: OrderDigitalLineState) =>
    setStates((current) => ({ ...current, [lineIndex]: next }));

  const readLine = async (lineIndex: number) =>
    bindOrderDigitalLine(order, lineIndex, await CommerceController.fetchOrderDigitalDelivery(order.id, lineIndex));

  const open = async (lineIndex: number) => {
    setLine(lineIndex, { status: 'opening', message: null });
    try {
      const line = await readLine(lineIndex);
      if (!line) {
        setLine(lineIndex, { status: 'failed', message: DIGITAL_ORDER_LINE_MISMATCH_COPY });
        return;
      }
      if (line.kind === 'file') {
        const opened = await CommerceController.openOrderDigitalFile(line);
        if (!opened.ok) {
          setLine(lineIndex, { status: 'failed', message: DIGITAL_FILE_OPEN_FAILURE_COPY[opened.reason] });
          return;
        }
        saveDigitalFile(opened.bytes, opened.fileName, opened.contentType);
      } else {
        setReveals((current) => ({
          ...current,
          [lineIndex]: line.kind === 'link' ? { kind: 'link', url: line.url } : { kind: 'text', text: line.text },
        }));
      }
      setLine(lineIndex, { status: 'idle', message: null });
    } catch (error) {
      setLine(lineIndex, { status: 'failed', message: orderDigitalReadFailureMessage(error) });
    }
  };

  const hide = (lineIndex: number) =>
    setReveals((current) => {
      const next = { ...current };
      delete next[lineIndex];
      return next;
    });

  return {
    lines: orderDigitalLines(order),
    stateFor: (lineIndex: number): OrderDigitalLineState => states[lineIndex] ?? { status: 'idle', message: null },
    revealFor: (lineIndex: number): OrderDigitalReveal | null => reveals[lineIndex] ?? null,
    /** Download a file, or show a link or text. */
    open,
    hide,
  };
}
