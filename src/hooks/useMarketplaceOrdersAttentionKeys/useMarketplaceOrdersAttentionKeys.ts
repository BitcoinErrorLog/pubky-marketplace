'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { getCommerceAdapterMode, isTransactionalCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  MARKETPLACE_ORDERS_SEEN_EVENT,
  ordersNeedingAttentionKeys,
  readOrdersSeenAt,
} from '@/libs/commerce/marketplace-attention';
import { Logger } from '@/libs/logger/logger';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';

/**
 * Orders whose next move is the signed-in identity, newer than the last time
 * this account opened the Orders tab. The durable service has no read state
 * for orders; the checkpoint is the account's private homeserver document,
 * mirrored in local storage (see `CommerceAttentionSeenApplication`). A
 * failed fetch contributes nothing.
 *
 * The keys and the checkpoint are tagged with the pubky they were read for.
 * An identity change clears both before paint, and a result whose pubky is
 * no longer signed in is dropped.
 */
type TaggedKeys = { pubky: string; keys: readonly string[] };
type TaggedSeen = { pubky: string; seenAt: number };

const NO_KEYS: readonly string[] = [];

export function useMarketplaceOrdersAttentionKeys(): readonly string[] {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const marketplaceSession = useCommerceStore((state) => state.marketplaceSession);
  const adapterMode = getCommerceAdapterMode();
  const [trackedPubky, setTrackedPubky] = useState(currentUserPubky);
  const [seen, setSeen] = useState<TaggedSeen | null>(null);
  const [taggedKeys, setTaggedKeys] = useState<TaggedKeys | null>(null);
  const pubkyRef = useRef(currentUserPubky);
  useLayoutEffect(() => {
    pubkyRef.current = currentUserPubky;
  }, [currentUserPubky]);

  if (trackedPubky !== currentUserPubky) {
    setTrackedPubky(currentUserPubky);
    setSeen(null);
    setTaggedKeys(null);
  }

  const seenAt = seen?.pubky === currentUserPubky ? seen.seenAt : undefined;
  const keys = taggedKeys?.pubky === currentUserPubky ? taggedKeys.keys : NO_KEYS;

  useEffect(() => {
    if (!currentUserPubky) {
      setSeen(null);
      return;
    }
    const pubky = currentUserPubky;
    const read = () => {
      if (pubkyRef.current !== pubky) return;
      setSeen({ pubky, seenAt: readOrdersSeenAt(pubky, window.localStorage) });
    };
    read();
    window.addEventListener(MARKETPLACE_ORDERS_SEEN_EVENT, read);
    window.addEventListener('storage', read);
    // Raises the local copy (and fires the event above) when another browser
    // already cleared Orders for this account.
    Promise.resolve()
      .then(() => CommerceController.syncAttentionSeen())
      .catch((error) => {
        Logger.warn('Failed to load the marketplace badge checkpoint', { error });
      });
    return () => {
      window.removeEventListener(MARKETPLACE_ORDERS_SEEN_EVENT, read);
      window.removeEventListener('storage', read);
    };
  }, [currentUserPubky]);

  useEffect(() => {
    if (!currentUserPubky || !isTransactionalCommerceMode(adapterMode)) {
      setTaggedKeys(currentUserPubky ? { pubky: currentUserPubky, keys: NO_KEYS } : null);
      return;
    }
    if (seenAt === undefined) return;
    const fetchedFor = currentUserPubky;
    const fetchedSeenAt = seenAt;
    let active = true;
    // A stubbed controller (tests) throws before a promise exists. That is a
    // failed load: the badge stays at zero.
    Promise.resolve()
      .then(() => CommerceController.getMarketplaceOrders())
      .then((orders) => {
        if (!active || pubkyRef.current !== fetchedFor) return;
        setTaggedKeys({
          pubky: fetchedFor,
          keys: ordersNeedingAttentionKeys(orders, fetchedFor, fetchedSeenAt),
        });
      })
      .catch((error) => {
        if (!active || pubkyRef.current !== fetchedFor) return;
        setTaggedKeys({ pubky: fetchedFor, keys: NO_KEYS });
        Logger.warn('Failed to load the marketplace orders badge count', { error });
      });
    return () => {
      active = false;
    };
  }, [currentUserPubky, adapterMode, marketplaceSession, seenAt]);

  return keys;
}
