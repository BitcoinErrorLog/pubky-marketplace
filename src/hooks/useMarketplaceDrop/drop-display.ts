import { type CommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import type { MarketplaceDropReadyCheck, MarketplacePublicDrop } from '@/services/marketplace/marketplace';

/**
 * The ONE place drop card and page states derive from (drops design, "state
 * machines in the UI"), so shelf and page can never disagree. The five
 * service states render verbatim from the projection; everything else is an
 * honest absence state:
 *
 * - `unavailable`: no durable transaction service in this deployment — drops
 *   are durable-mode only (ADR 0026: server time is the feature).
 * - `unregistered`: the seller-signed record exists but the service has no
 *   drop aggregate (yet). The clock may show the seller's INTENT as an
 *   estimate; it must never claim `live`.
 *
 * The device clock NEVER appears here: a projection that still says
 * `announced` after `startsAt` renders as announced. The clock only
 * schedules polls and countdown text.
 */
export type MarketplaceDropDisplayState =
  | 'unavailable'
  | 'unregistered'
  | 'announced'
  | 'live'
  | 'ended_sold_out'
  | 'ended_closed'
  | 'ended_cancelled';

export function deriveDropDisplayState({
  adapterMode,
  projection,
}: {
  adapterMode: CommerceAdapterMode;
  projection: MarketplacePublicDrop | null;
}): MarketplaceDropDisplayState {
  if (!isDurableCommerceMode(adapterMode)) return 'unavailable';
  if (projection === null) return 'unregistered';
  return projection.state;
}

/**
 * Truthful stock display (ADR 0026, "Stock-display honesty"): the service
 * applies the seller's `stockDisplay` policy server-side, so the client only
 * renders what actually arrived — an exact number, a band label, or nothing.
 * A projection whose policy says `exact` but carries no number renders
 * nothing rather than an invented value.
 */
export type MarketplaceDropStockDisplay =
  | { kind: 'exact'; remaining: number }
  | { kind: 'band'; band: 'plenty' | 'low' | 'last_few' }
  | { kind: 'hidden' };

export function deriveDropStockDisplay(projection: MarketplacePublicDrop): MarketplaceDropStockDisplay {
  if (typeof projection.remaining === 'number') return { kind: 'exact', remaining: projection.remaining };
  if (projection.remainingBand != null) return { kind: 'band', band: projection.remainingBand };
  return { kind: 'hidden' };
}

export const DROP_STOCK_BAND_LABELS: Record<'plenty' | 'low' | 'last_few', string> = {
  plenty: 'Plenty left',
  low: 'Running low',
  last_few: 'Last few',
};

export interface MarketplaceDropReadyCheckItem {
  id: 'session' | 'address' | 'allowance';
  label: string;
  ready: boolean;
  detail: string;
}

export interface MarketplaceDropReadyCheckView {
  items: MarketplaceDropReadyCheckItem[];
  allReady: boolean;
}

/**
 * The pre-drop ready check (drops design, "Ready check"): three real,
 * device-verifiable facts — nothing is reserved early. The allowance item
 * only claims what the service's per-buyer read actually said; while that
 * read is unavailable (no session, not loaded) it is honestly not-ready
 * with the reason.
 */
export function deriveDropReadyCheck({
  hasSession,
  hasAddress,
  readyCheck,
}: {
  hasSession: boolean;
  hasAddress: boolean;
  readyCheck: MarketplaceDropReadyCheck | null;
}): MarketplaceDropReadyCheckView {
  const allowance = readyCheck?.remainingAllowance ?? null;
  const items: MarketplaceDropReadyCheckItem[] = [
    {
      id: 'session',
      label: 'Purchases approved in Pubky Ring',
      ready: hasSession,
      detail: hasSession
        ? 'Your approval is ready; claiming will not need a Ring detour.'
        : 'Approve purchases in Pubky Ring now so the claim needs no approval detour at T-0.',
    },
    {
      id: 'address',
      label: 'Delivery address chosen',
      ready: hasAddress,
      detail: hasAddress
        ? 'Your saved address is applied to the claim automatically.'
        : 'Save a delivery address so the claim can be a single tap.',
    },
    {
      id: 'allowance',
      label: 'Per-buyer allowance',
      ready: allowance !== null && allowance > 0,
      detail:
        allowance === null
          ? hasSession
            ? 'Your allowance loads from the transaction service once the drop is registered.'
            : 'Connect the session to read your allowance for this drop.'
          : allowance > 0
            ? `You can buy ${allowance} in this drop.`
            : "You have reached this drop's per-buyer limit.",
    },
  ];
  return { items, allReady: items.every((item) => item.ready) };
}

/** Parses `drop:{sellerPubky}_{dropId}` (see `buildMarketplaceDropAggregateId`). */
export function parseDropAggregateId(aggregateId: string): { sellerPubky: string; dropId: string } | null {
  if (!aggregateId.startsWith('drop:')) return null;
  const rest = aggregateId.slice('drop:'.length);
  if (rest.length < 54 || rest[52] !== '_') return null;
  return { sellerPubky: rest.slice(0, 52), dropId: rest.slice(53) };
}

/**
 * The one-sentence no-fake promise printed on the drop page footer (drops
 * design, "At T-0 — the moment, without lies").
 */
export const DROP_NO_FAKE_PROMISE =
  'This page never shows fake queues, fake stock, or fake demand — every state comes from the transaction service or is labeled an estimate.';

/** Final-state labels for the archive view — honest copy, no euphemisms. */
export const DROP_ENDED_LABELS: Record<'ended_sold_out' | 'ended_closed' | 'ended_cancelled', string> = {
  ended_sold_out: 'Sold out',
  ended_closed: 'Ended',
  ended_cancelled: 'Cancelled by seller',
};

export const DROP_ENDED_DESCRIPTIONS: Record<'ended_sold_out' | 'ended_closed' | 'ended_cancelled', string> = {
  ended_sold_out: 'Every unit was claimed and paid. The archive below is the final state.',
  ended_closed: 'The window closed on server time before the quantity sold out.',
  ended_cancelled:
    'The seller cancelled this drop. New checkouts are refused; any already-paid orders follow the normal cancellation and refund process.',
};
