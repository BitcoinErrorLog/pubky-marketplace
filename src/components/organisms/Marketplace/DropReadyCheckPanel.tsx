'use client';

import { CheckCircle2, Circle } from 'lucide-react';
import { getMarketplaceAddressSettingsRoute } from '@/app/routes';
import { Button } from '@/atoms/Button/Button';
import { Heading } from '@/atoms/Heading/Heading';
import { Link } from '@/atoms/Link/Link';
import { Typography } from '@/atoms/Typography/Typography';
import { deriveDropReadyCheck } from '@/hooks/useMarketplaceDrop/drop-display';
import { cn } from '@/libs/utils/utils';
import type { MarketplaceDropReadyCheck } from '@/services/marketplace/marketplace';
import { MarketplaceSessionConnectDialog } from './MarketplaceSessionConnectDialog';

export interface DropReadyCheckPanelProps {
  hasSession: boolean;
  hasAddress: boolean;
  readyCheck: MarketplaceDropReadyCheck | null;
  returnTo?: string;
  /** Refetches the allowance after the session connects. */
  onSessionConnected?: () => void | Promise<void>;
}

/**
 * The pre-drop ready check (drops design, "Ready check"): three REAL,
 * verifiable preparations — session, address, allowance — rendered as a
 * checklist so at T-0 the only action left is one tap. Nothing is reserved
 * early; preparation is the buyer's, allocation is the service's.
 */
export function DropReadyCheckPanel({
  hasSession,
  hasAddress,
  readyCheck,
  returnTo,
  onSessionConnected,
}: DropReadyCheckPanelProps) {
  const view = deriveDropReadyCheck({ hasSession, hasAddress, readyCheck });

  return (
    <section
      aria-label="Drop ready check"
      className={cn(
        'flex flex-col gap-3 rounded-xl border p-4',
        view.allReady ? 'border-brand/40 bg-brand/10' : 'bg-card',
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Heading level={2} size="sm" className="text-base">
          Ready check
        </Heading>
        {view.allReady && (
          <Typography as="p" className="flex items-center gap-1.5 text-sm font-semibold text-brand" role="status">
            <CheckCircle2 className="size-4" />
            You&rsquo;re ready
          </Typography>
        )}
      </div>
      <Typography as="p" className="text-sm text-muted-foreground">
        Stage everything before T-0. Nothing is reserved early — when the drop opens, the claim is one tap.
      </Typography>
      <ul className="flex flex-col gap-3">
        {view.items.map((item) => (
          <li key={item.id} className="flex items-start gap-3">
            {item.ready ? (
              <CheckCircle2 aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-brand" />
            ) : (
              <Circle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
            )}
            <div className="flex flex-col gap-1">
              <Typography as="p" className="text-sm font-semibold">
                {item.label}
                <span className="sr-only">{item.ready ? ' — ready' : ' — not ready'}</span>
              </Typography>
              <Typography as="p" className="text-sm text-muted-foreground">
                {item.detail}
              </Typography>
              {item.id === 'session' && !item.ready && (
                <MarketplaceSessionConnectDialog onConnected={onSessionConnected} />
              )}
              {item.id === 'address' && !item.ready && (
                <Button asChild variant="secondary" size="sm" className="w-fit rounded-full">
                  <Link href={getMarketplaceAddressSettingsRoute(returnTo)} overrideDefaults>
                    Add a delivery address
                  </Link>
                </Button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
