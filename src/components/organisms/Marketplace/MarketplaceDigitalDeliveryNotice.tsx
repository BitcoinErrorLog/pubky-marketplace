'use client';

import { KeyRound } from 'lucide-react';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Typography } from '@/atoms/Typography/Typography';
import { type CommerceAdapterMode, isLocksPaykitCommerceMode } from '@/config/commerce';

/**
 * Pre-purchase notice on a Locks-guarded digital listing. Purely
 * informational: the payment itself happens after checkout, from the order
 * (see `MarketplacePaymentStatusCard`), where the transaction service
 * independently verifies the Locks entitlement before the order advances.
 */
export function MarketplaceDigitalDeliveryNotice({ adapterMode }: { adapterMode: CommerceAdapterMode }) {
  return (
    <Card className="gap-4 border border-brand/30 py-5">
      <CardContent className="flex items-start gap-3 px-5">
        <div className="rounded-full bg-brand/15 p-2 text-brand">
          <KeyRound className="size-5" />
        </div>
        <div>
          <Typography as="h2" className="font-semibold">
            Locks-protected digital delivery
          </Typography>
          <Typography as="p" className="text-sm text-muted-foreground">
            {isLocksPaykitCommerceMode(adapterMode)
              ? 'After checkout, approve the Bitcoin payment in your wallet. Your content unlocks once payment is confirmed. Your wallet keys stay private.'
              : 'Purchases of this digital item are unavailable here.'}
          </Typography>
        </div>
      </CardContent>
    </Card>
  );
}
