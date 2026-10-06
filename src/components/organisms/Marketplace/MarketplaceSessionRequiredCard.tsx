'use client';

import { KeyRound } from 'lucide-react';
import { Heading } from '@/atoms/Heading/Heading';
import { Typography } from '@/atoms/Typography/Typography';
import { useMarketplaceApprovalSigner } from '@/hooks/useMarketplaceApprovalSigner/useMarketplaceApprovalSigner';
import { MarketplaceSessionConnectDialog } from './MarketplaceSessionConnectDialog';

/**
 * Shows static approval copy on durable marketplace surfaces when the durable
 * transport reports `isMarketplaceSessionRequiredError`: Bitkit for a Bitkit
 * (grant) sign-in that can bootstrap, Pubky Ring otherwise. Sandbox surfaces
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
}: {
  onConnected?: () => void | Promise<void>;
  note?: string;
}) {
  const signer = useMarketplaceApprovalSigner();
  return (
    <div
      role="alert"
      className="flex min-h-56 flex-col items-center justify-center gap-4 rounded-xl border border-dashed px-6 py-8 text-center"
    >
      <KeyRound className="size-10 text-muted-foreground" />
      <div>
        <Heading level={2} size="md">
          Approve purchases in {signer}
        </Heading>
        <Typography as="p" className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
          One approval lets you buy, bid, and make offers on this marketplace. Nothing is charged until you pay.
        </Typography>
        {note ? (
          <Typography as="p" className="mx-auto max-w-lg text-sm text-muted-foreground">
            {note}
          </Typography>
        ) : null}
      </div>
      <MarketplaceSessionConnectDialog triggerLabel={`Approve in ${signer}`} onConnected={onConnected} />
    </div>
  );
}
