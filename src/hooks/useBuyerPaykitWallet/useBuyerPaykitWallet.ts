'use client';

import { useEffect, useState } from 'react';
import { CommerceController } from '@/controllers/commerce/commerce';
import { Logger } from '@/libs/logger/logger';

/**
 * Whether the buyer can receive a Bitcoin payment request:
 * - `idle`: not checked (no buyer, or Bitcoin is not in play);
 * - `checking`: the public Paykit read is in flight;
 * - `payable`: the buyer publishes a Paykit receiver that takes payment
 *   requests (a Paykit wallet such as Bitkit);
 * - `not_payable`: they publish none, so a Bitcoin Pay cannot succeed;
 * - `unknown`: the read failed; Pay is not blocked and the service answers.
 */
export type BuyerPaykitWalletState = 'idle' | 'checking' | 'payable' | 'not_payable' | 'unknown';

export function useBuyerPaykitWallet(buyerPubky: string | null, enabled: boolean) {
  const [result, setResult] = useState<{ key: string; state: BuyerPaykitWalletState } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = enabled && buyerPubky ? `${buyerPubky}:${attempt}` : null;

  useEffect(() => {
    if (!key || !buyerPubky) return;
    let active = true;
    void (async () => {
      try {
        const payable = await CommerceController.hasBuyerPaykitWallet(buyerPubky);
        if (active) setResult({ key, state: payable ? 'payable' : 'not_payable' });
      } catch (error) {
        Logger.warn('Could not read the buyer Paykit wallet; Pay stays available', { error });
        if (active) setResult({ key, state: 'unknown' });
      }
    })();
    return () => {
      active = false;
    };
  }, [key, buyerPubky]);

  const state: BuyerPaykitWalletState = !key ? 'idle' : result?.key === key ? result.state : 'checking';
  return { state, recheck: () => setAttempt((current) => current + 1) };
}
