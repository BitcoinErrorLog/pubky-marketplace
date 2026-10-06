'use client';

import { useEffect, useState } from 'react';
import { Copy, KeyRound, Loader2, RefreshCw, Smartphone } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/atoms/Dialog/Dialog';
import { Typography } from '@/atoms/Typography/Typography';
import { useIsGrantSession } from '@/hooks/useIsGrantSession/useIsGrantSession';
import { useStepUpReauth } from '@/hooks/useStepUpReauth/useStepUpReauth';
import { Logger } from '@/libs/logger/logger';
import { MarketplaceApprovalDisclosure } from '@/molecules/MarketplaceApprovalDisclosure/MarketplaceApprovalDisclosure';
import { QrCodeSlot } from '@/molecules/QrCodeSlot/QrCodeSlot';
import { toast } from '@/molecules/Toaster/use-toast';
import { signInApprovalDisclosure } from '@/services/marketplace/marketplace-session-grant';
import { MarketplaceSessionConnectDialog } from './MarketplaceSessionConnectDialog';

/**
 * Who refused: the homeserver (the Shop session's grant cannot write
 * `/priv/pubky.app/`, the `needs_reauth` states) or the marketplace, which
 * would not release the private data key to the current purchase session
 * (the `needs_marketplace_approval` states and the recovery-key export).
 */
export type MarketplaceReauthRefusal = 'homeserver' | 'purchase_session';

type MarketplaceReauthDialogProps = {
  triggerLabel: string;
  refusal: MarketplaceReauthRefusal;
  onReauthenticated?: () => void | Promise<void>;
};

/**
 * The shared re-approval affordance (docs/ecommerce/step-up-approval.md) for
 * scope-gated features: watchlist sync, portable receipts and the recovery
 * key.
 *
 * It routes on who raised the refusal, never on session facts. A
 * purchase-session refusal is repaired only by a marketplace session approval
 * that includes `/priv/pubky.app/`, so every signer gets
 * `MarketplaceSessionConnectDialog`: the grant bootstrap or the grant
 * reconnect (Bitkit or Pubky Ring) when the grant flow is on, the Ring connect
 * QR otherwise. A homeserver refusal gets the Pubky Ring step-up for a cookie
 * sign-in. A Bitkit (grant) sign-in cannot run that step-up
 * (`AuthController.getStepUpAuthUrl` refuses it) and always holds the full
 * grant, so it gets the marketplace session approval there too.
 */
export function MarketplaceReauthDialog({ triggerLabel, refusal, onReauthenticated }: MarketplaceReauthDialogProps) {
  const isGrantSession = useIsGrantSession();
  if (refusal === 'purchase_session' || isGrantSession) {
    return <MarketplaceSessionConnectDialog triggerLabel={triggerLabel} onConnected={onReauthenticated} />;
  }
  return <HomeserverStepUpDialog triggerLabel={triggerLabel} onReauthenticated={onReauthenticated} />;
}

/**
 * Mirrors the sign-in / session-connect precedent: the `pubkyauth://`
 * authorization URL renders as a QR for a cross-device Pubky Ring scan, and
 * as a deeplink/copy affordance for same-device Ring.
 *
 * Every open starts a FRESH flow and closing cancels it — auth flows are
 * single-use, so a failed or abandoned flow's QR is never shown again. On
 * approval the controller swaps the auth-store session for the widened
 * (superset-grant) one, which is what makes watchlist sync, receipts, and
 * messaging cookie-resume capable without a reload.
 */
function HomeserverStepUpDialog({ triggerLabel, onReauthenticated }: Omit<MarketplaceReauthDialogProps, 'refusal'>) {
  const [open, setOpen] = useState(false);
  const reauth = useStepUpReauth({
    onReauthenticated: async () => {
      toast({
        title: 'Signed in again with full permissions',
        description: 'Watchlist sync, portable receipts, and messaging now work in this session.',
      });
      setOpen(false);
      await onReauthenticated?.();
    },
  });

  // Referencing `reauth.start`/`reauth.cancel` directly keeps the effect
  // dependency-stable: both are useCallback-memoized in the hook.
  const { start, cancel } = reauth;
  useEffect(() => {
    if (open) {
      start();
      return;
    }
    cancel();
  }, [open, start, cancel]);

  const approvalDisclosure = reauth.authorizationUrl ? signInApprovalDisclosure(reauth.authorizationUrl) : null;

  const copyUrl = async () => {
    try {
      await reauth.copyAuthUrl();
      toast({ variant: 'info', title: 'Authorization link copied' });
    } catch (error) {
      Logger.error('Failed to copy the re-authentication link', { error });
      toast({ variant: 'error', description: 'Could not copy to clipboard' });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm" className="rounded-full">
          <KeyRound className="mr-2 size-4" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="border-border bg-popover">
        <DialogHeader>
          <DialogTitle>Sign in again</DialogTitle>
        </DialogHeader>

        <Typography as="p" className="text-sm text-muted-foreground">
          Sign in again for this device.
        </Typography>

        {reauth.status === 'error' ? (
          <div className="grid gap-3">
            <div role="alert" className="rounded-xl border border-destructive/40 p-4 text-sm">
              {reauth.errorMessage}
            </div>
            <Button className="w-fit rounded-full" onClick={reauth.start}>
              <RefreshCw className="mr-2 size-4" />
              Try again
            </Button>
          </div>
        ) : (
          <div className="grid justify-items-center gap-4">
            <button
              type="button"
              className="group relative flex size-48 cursor-pointer items-center justify-center rounded-md bg-foreground p-2"
              onClick={() => void copyUrl()}
              disabled={!reauth.authorizationUrl}
              aria-label="Copy authorization link"
            >
              <QrCodeSlot
                isLoading={reauth.status !== 'awaiting'}
                isExpired={false}
                url={reauth.authorizationUrl}
                generatingLabel="Generating QR Code..."
                clickToReloadLabel="Click to reload"
                activeQrHasHoverEffect
              />
            </button>

            <MarketplaceApprovalDisclosure sentence={approvalDisclosure} />

            {reauth.status === 'awaiting' && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
                <Loader2 className="size-4 animate-spin" />
                Waiting for approval on your signer…
              </div>
            )}

            <div className="flex flex-wrap justify-center gap-2">
              <Button
                variant="secondary"
                className="rounded-full"
                onClick={reauth.openInRing}
                disabled={!reauth.authorizationUrl || reauth.isOpeningRing}
                aria-busy={reauth.isOpeningRing}
              >
                {reauth.isOpeningRing ? (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                ) : (
                  <Smartphone className="mr-2 size-4" />
                )}
                {reauth.isOpeningRing ? 'Opening Pubky Ring...' : 'Open in Pubky Ring'}
              </Button>
              <Button
                variant="ghost"
                className="rounded-full"
                onClick={() => void copyUrl()}
                disabled={!reauth.authorizationUrl}
              >
                <Copy className="mr-2 size-4" />
                Copy link
              </Button>
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="secondary" className="rounded-full" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
