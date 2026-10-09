'use client';

import { KeyRound } from 'lucide-react';
import { Heading } from '@/atoms/Heading/Heading';
import { Typography } from '@/atoms/Typography/Typography';
import { MarketplaceSessionConnectDialog } from './MarketplaceSessionConnectDialog';

/**
 * Shows static approval copy on durable marketplace surfaces when the durable
 * transport reports `isMarketplaceSessionRequiredError`, naming the signer that
 * approves the grant link (`useMarketplaceApprovalSigner`). Sandbox surfaces
 * never see this card because they do not use the durable transport.
 */
/**
 * Orders and the seller dashboard read through the marketplace session.
 * That session is the approval labeled for purchases. The service will not
 * list sales without it.
 */
export const SALES_LIST_SESSION_NOTE =
  'Your sales use this same approval, because the marketplace lists them only for a session it can tie to you.';

export function MarketplaceSessionRequiredCard({
  onConnected,
  note,
  intent = 'buy',
}: {
  onConnected?: () => void | Promise<void>;
  note?: string;
  intent?: 'buy' | 'sell';
}) {
  return (
    <div
      role="alert"
      className="flex min-h-56 flex-col items-center justify-center gap-4 rounded-md border border-dashed px-6 py-8 text-center"
    >
      <KeyRound className="size-10 text-muted-foreground" />
      <div>
        <Heading level={2} size="md">
          {intent === 'sell' ? 'Enable selling' : 'Enable purchases'}
        </Heading>
        <Typography as="p" className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
          {intent === 'sell'
            ? 'Manage your listings, orders, and offers with one approval.'
            : 'Buy, bid, and make offers with one approval.'}
        </Typography>
        {note ? (
          <Typography as="p" className="mx-auto max-w-lg text-sm text-muted-foreground">
            {note}
          </Typography>
        ) : null}
      </div>
      <MarketplaceSessionConnectDialog triggerLabel="Authorize" onConnected={onConnected} intent={intent} />
    </div>
  );
}
