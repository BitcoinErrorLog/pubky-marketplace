'use client';

import { useEffect, useState } from 'react';
import { MessagingController } from '@/controllers/messaging/messaging';
import { Logger } from '@/libs/logger/logger';

export type MessagingKeysState = Awaited<ReturnType<typeof MessagingController.getMessagingKeys>>;

/**
 * This device's messaging key and the one pinned for `counterpartyPubky`,
 * read from local storage while `enabled`. Nothing is fetched otherwise.
 */
export function useMessagingKeys(
  counterpartyPubky: string,
  enabled: boolean,
): { keys: MessagingKeysState | null; status: 'idle' | 'loading' | 'ready' | 'error' } {
  const [keys, setKeys] = useState<MessagingKeysState | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setStatus('loading');
    MessagingController.getMessagingKeys(counterpartyPubky)
      .then((next) => {
        if (cancelled) return;
        setKeys(next);
        setStatus('ready');
      })
      .catch((error: unknown) => {
        Logger.warn('Could not read the messaging keys for this conversation', { error });
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [counterpartyPubky, enabled]);

  return { keys, status };
}
