'use client';

import { CheckCircle2, ExternalLink, RefreshCw } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Switch } from '@/atoms/Switch/Switch';
import { Typography } from '@/atoms/Typography/Typography';
import { USDT_NEEDS_BITKIT_COPY, type UsdtSellerReadiness } from '@/libs/commerce/usdt-seller-setup';

type MarketplaceUsdtSellerSetupProps = {
  readiness: UsdtSellerReadiness;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onSetup: () => void;
  onReconnect: () => void;
  onRetry: () => void;
  isRetrying: boolean;
  /** Bitkit setup needs the signed-in seller; without one the buttons stay disabled. */
  canOpenBitkit: boolean;
};

/**
 * The seller's "Accept USDT" control and its readiness (docs/ecommerce/usdt-payments.md).
 * Readiness comes only from the service's signed Paykit lookup, never from how
 * the seller signed in. The USDT address itself is never shown: it lives in
 * Bitkit and paykit-server.
 */
export function MarketplaceUsdtSellerSetup({
  readiness,
  enabled,
  onEnabledChange,
  onSetup,
  onReconnect,
  onRetry,
  isRetrying,
  canOpenBitkit,
}: MarketplaceUsdtSellerSetupProps) {
  return (
    <div className="grid gap-6" data-testid="usdt-seller-setup">
      <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div>
          <Typography as="label" htmlFor="get-paid-usdt" className="block text-sm font-semibold">
            Accept USDT
          </Typography>
          <Typography as="p" className="text-sm text-muted-foreground">
            Offer USDT (USDT0 on Arbitrum One) at checkout.
          </Typography>
        </div>
        <Switch
          id="get-paid-usdt"
          checked={enabled}
          onCheckedChange={onEnabledChange}
          disabled={!enabled && readiness !== 'ready'}
          aria-label="Accept USDT"
        />
      </div>

      {readiness === 'ready' ? (
        <Typography as="p" className="flex items-center gap-2 text-sm text-brand" data-testid="usdt-readiness-ready">
          <CheckCircle2 className="size-4" />
          USDT ready
        </Typography>
      ) : (
        <div className="grid justify-items-start gap-3" data-testid={`usdt-readiness-${readiness}`}>
          <Typography as="p" className="text-sm text-muted-foreground">
            {USDT_NEEDS_BITKIT_COPY}
          </Typography>
          {readiness === 'setup' && (
            <>
              <Typography as="p" className="text-sm text-muted-foreground">
                Set up Bitkit payments to receive Bitcoin and add a USDT address in one step.
              </Typography>
              <Button variant="secondary" className="w-fit" disabled={!canOpenBitkit} onClick={onSetup}>
                Set up Bitkit payments
                <ExternalLink className="size-4" />
              </Button>
            </>
          )}
          {readiness === 'reconnect' && (
            <>
              <Typography as="p" className="text-sm text-muted-foreground">
                Your Bitkit account stays the same. Reconnect to share a USDT address.
              </Typography>
              <Button variant="secondary" className="w-fit" disabled={!canOpenBitkit} onClick={onReconnect}>
                Add USDT in Bitkit
                <ExternalLink className="size-4" />
              </Button>
            </>
          )}
          {readiness === 'unavailable' && (
            <>
              <Typography as="p" role="status" className="text-sm text-amber-300">
                USDT can&apos;t be checked right now. Try again later.
              </Typography>
              <Button variant="secondary" className="w-fit" disabled={isRetrying} onClick={onRetry}>
                <RefreshCw className="size-4" />
                Check again
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
