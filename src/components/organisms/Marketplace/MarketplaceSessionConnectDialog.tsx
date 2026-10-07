'use client';

import { useEffect, useState } from 'react';
import { Copy, KeyRound, Loader2, RefreshCw, Smartphone } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/atoms/Dialog/Dialog';
import { Typography } from '@/atoms/Typography/Typography';
import { isPassportApprovalRefused } from '@/hooks/useGrantSigner/useGrantSigner';
import { useIsGrantSession } from '@/hooks/useIsGrantSession/useIsGrantSession';
import { useMarketplaceSessionConnect } from '@/hooks/useMarketplaceSessionConnect/useMarketplaceSessionConnect';
import type { MarketplaceSessionConnectStatus } from '@/hooks/useMarketplaceSessionConnect/useMarketplaceSessionConnect.types';
import { BOOTSTRAP_APPROVAL_EXPIRED, MARKETPLACE_FAILURE_MESSAGES } from '@/libs/commerce/failure-messages';
import { Logger } from '@/libs/logger/logger';
import { getMarketplaceGrantFlowEnabled } from '@/libs/runtime-config/runtime-config';
import { GrantSessionRefusal } from '@/molecules/GrantSessionRefusal/GrantSessionRefusal';
import { MarketplaceApprovalDisclosure } from '@/molecules/MarketplaceApprovalDisclosure/MarketplaceApprovalDisclosure';
import { QrCodeSlot } from '@/molecules/QrCodeSlot/QrCodeSlot';
import { toast } from '@/molecules/Toaster/use-toast';
import { marketplaceApprovalDisclosure } from '@/services/marketplace/marketplace-session-grant';

/**
 * Shown when a grant-link approval lapses unapproved. The usual cause is the
 * wrong app: a Pubky Ring older than 2.0 cannot approve it, and a
 * signer that cannot parse the link never answers, so the Shop only sees it expire.
 */
export const GRANT_APPROVAL_SIGNER_HINT =
  'Approve with the app that holds this pubky: Pubky Ring 2.0 or later, or Bitkit.';

/**
 * The in-app UX for establishing a marketplace transaction-service session
 * (durable modes only). Mirrors the sign-in precedent: the `pubkyauth://`
 * authorization URL renders as a QR for a cross-device Pubky Ring scan, and
 * as a deeplink/copy affordance for same-device Ring.
 *
 * Every open starts a FRESH flow and closing cancels it — AuthTokens are
 * single-use, so a failed or abandoned flow's QR is never shown again. On
 * approval the controller mirrors the session facts into the commerce store,
 * which is what makes the dependent durable-mode surfaces refetch.
 */
export function MarketplaceSessionConnectDialog({
  triggerLabel = 'Connect marketplace session',
  onConnected,
  autoOpen = false,
}: {
  triggerLabel?: string;
  onConnected?: () => void | Promise<void>;
  autoOpen?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const grantFlowEnabled = getMarketplaceGrantFlowEnabled();
  const session = useMarketplaceSessionConnect({
    onConnected: () => {
      toast({
        title: 'Purchases approved',
        description: 'This session stays on this device across tabs and restarts until it expires or you sign out.',
      });
      setOpen(false);
      void onConnected?.();
    },
  });

  // Referencing `session.start`/`session.cancel` directly keeps the effect
  // dependency-stable: both are useCallback-memoized in the hook.
  const { start, cancel } = session;
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);

  // A grant (Bitkit or Pubky Passport) sign-in has no AuthToken to redeem; it
  // connects through the grant bootstrap, so it is refused where that flow is
  // off, and a Passport sign-in also while the deploy switched Passport off.
  const refusesGrantSession = useIsGrantSession() && (!grantFlowEnabled || isPassportApprovalRefused());
  useEffect(() => {
    if (open) {
      if (!refusesGrantSession) start();
      return;
    }
    cancel();
  }, [open, start, cancel, refusesGrantSession]);

  const copyUrl = async () => {
    try {
      await session.copyAuthUrl();
      toast({ variant: 'info', title: 'Authorization link copied' });
    } catch (error) {
      Logger.error('Failed to copy the marketplace authorization link', { error });
      toast({ variant: 'error', description: 'Could not copy to clipboard' });
    }
  };

  // Which consent is being requested is decided ONCE by the hook (it also
  // picks the flow `start()` begins) — never re-evaluate it here, or the
  // copy could describe a different approval than the QR requests.
  const requestsFullGrant = session.requestsFullGrant;
  const requestsGrantReconnect = session.requestsGrantReconnect;
  const requestsGrantBootstrap = session.requestsGrantBootstrap;
  const requestsPassport = session.requestsPassport;
  const approvalSigner = session.approvalSigner;
  // A Ring (cookie) sign-in's grant link can be approved by either phone
  // signer, so its copy names no single app.
  const bootstrapSigner = approvalSigner === 'Pubky Ring or Bitkit' ? null : approvalSigner;
  const approvalLapsed =
    session.status === 'expired' ||
    (session.status === 'error' &&
      (session.errorMessage === MARKETPLACE_FAILURE_MESSAGES.sessionTimeout ||
        session.errorMessage === BOOTSTRAP_APPROVAL_EXPIRED));
  const showsGrantSignerHint =
    approvalLapsed && !requestsPassport && (requestsGrantBootstrap || requestsGrantReconnect);
  const retry = () => {
    session.start();
    if (requestsPassport) session.startPassport();
  };
  const approvalDisclosure = session.authorizationUrl ? marketplaceApprovalDisclosure(session.authorizationUrl) : null;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="rounded-full">
          <KeyRound className="mr-2 size-4" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="border-border bg-popover">
        <DialogHeader>
          <DialogTitle>
            {requestsGrantBootstrap
              ? `Approve purchases in ${approvalSigner}`
              : requestsGrantReconnect
                ? 'Approve purchases'
                : 'Approve purchases in Pubky Ring'}
          </DialogTitle>
        </DialogHeader>

        <Typography as="p" className="text-sm text-muted-foreground">
          {requestsGrantBootstrap
            ? bootstrapSigner
              ? `Approve with ${bootstrapSigner} to connect the marketplace for the identity signed in to Shop. Nothing is charged until you pay.`
              : 'Approve with Pubky Ring or Bitkit, whichever holds the pubky signed in to Shop. Nothing is charged until you pay.'
            : requestsGrantReconnect
              ? requestsPassport
                ? 'Approve with Pubky Passport to reconnect the marketplace session for the identity already signed in to Shop. Nothing is charged until you pay.'
                : 'Approve with Bitkit or Pubky Ring to reconnect the marketplace session for the identity already signed in to Shop. Nothing is charged until you pay.'
              : requestsFullGrant && !grantFlowEnabled
                ? 'Sign in to Pubky Shop.'
                : 'Approve with Pubky Ring to connect the marketplace on this device.'}
        </Typography>

        {refusesGrantSession ? (
          <GrantSessionRefusal />
        ) : ['error', 'mismatch', 'expired', 'cancelled'].includes(session.status) ? (
          <div className="grid gap-3">
            <div role="alert" className="rounded-xl border border-destructive/40 p-4 text-sm">
              {session.status === 'mismatch'
                ? 'That approval used a different identity. Approve with the same identity currently signed in to Shop.'
                : session.status === 'expired'
                  ? 'This approval expired.'
                  : session.status === 'cancelled'
                    ? 'Approval cancelled.'
                    : session.errorMessage}
            </div>
            {showsGrantSignerHint ? (
              <Typography as="p" className="text-sm text-muted-foreground" data-testid="grant-approval-signer-hint">
                {GRANT_APPROVAL_SIGNER_HINT}
              </Typography>
            ) : null}
            <Button className="w-fit rounded-full" onClick={retry}>
              <RefreshCw className="mr-2 size-4" />
              Try again
            </Button>
          </div>
        ) : requestsPassport ? (
          <MarketplacePassportApproval
            status={session.status}
            approvalDisclosure={approvalDisclosure}
            confirmingHomeserver={requestsGrantBootstrap}
            onStart={session.startPassport}
          />
        ) : session.status === 'joined' ? (
          // The approval lives on another surface (e.g. a sign-in in
          // progress), which holds the only scannable URL. No QR, Copy, or
          // Open here — approving there settles this session too.
          <div role="status" className="rounded-xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
            An approval is already in progress on another surface. Approve it there — it also connects this marketplace
            session.
          </div>
        ) : (
          <div className="grid justify-items-center gap-4">
            <button
              type="button"
              className="group relative flex size-48 cursor-pointer items-center justify-center rounded-md bg-foreground p-2"
              onClick={() => void copyUrl()}
              disabled={!session.authorizationUrl}
              aria-label="Copy authorization link"
            >
              <QrCodeSlot
                isLoading={session.status !== 'awaiting'}
                isExpired={false}
                url={session.authorizationUrl}
                generatingLabel="Generating QR Code..."
                clickToReloadLabel="Click to reload"
                activeQrHasHoverEffect
                showRingLogo={!requestsGrantBootstrap}
              />
            </button>

            <MarketplaceApprovalDisclosure sentence={approvalDisclosure} />

            {session.status === 'awaiting' && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                {requestsGrantBootstrap && bootstrapSigner
                  ? `Waiting for approval in ${bootstrapSigner}…`
                  : 'Waiting for approval on your signer…'}
              </div>
            )}
            {['creating', 'verifying', 'claiming'].includes(session.status) && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                {session.status === 'creating'
                  ? requestsGrantBootstrap
                    ? 'Confirming with your homeserver…'
                    : 'Preparing secure approval…'
                  : session.status === 'verifying'
                    ? 'Verifying approval…'
                    : 'Connecting marketplace…'}
              </div>
            )}

            <div className="flex flex-wrap justify-center gap-2">
              <Button
                variant="secondary"
                className="rounded-full"
                onClick={session.openInRing}
                disabled={!session.authorizationUrl || session.isOpeningRing}
                aria-busy={session.isOpeningRing}
              >
                {session.isOpeningRing ? (
                  <Loader2 className="mr-2 size-4 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Smartphone className="mr-2 size-4" />
                )}
                {session.isOpeningRing
                  ? requestsGrantBootstrap && bootstrapSigner
                    ? `Opening ${bootstrapSigner}...`
                    : requestsGrantBootstrap || requestsGrantReconnect
                      ? 'Opening signer...'
                      : 'Opening Pubky Ring...'
                  : requestsGrantBootstrap && bootstrapSigner
                    ? `Open in ${bootstrapSigner}`
                    : requestsGrantBootstrap || requestsGrantReconnect
                      ? 'Open in signer'
                      : 'Open in Pubky Ring'}
              </Button>
              <Button
                variant="ghost"
                className="rounded-full"
                onClick={() => void copyUrl()}
                disabled={!session.authorizationUrl}
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

/**
 * The purchase approval for a Pubky Passport sign-in: a button that opens
 * Passport in a popup (it needs a click), then the progress while Passport
 * and the marketplace finish. No QR, copy link or deeplink: Passport is a
 * web signer, not a phone app.
 */
function MarketplacePassportApproval({
  status,
  approvalDisclosure,
  confirmingHomeserver,
  onStart,
}: {
  status: MarketplaceSessionConnectStatus;
  approvalDisclosure: string | null;
  confirmingHomeserver: boolean;
  onStart: () => void;
}) {
  const inProgress = status !== 'idle';
  return (
    <div className="grid justify-items-center gap-4" data-testid="marketplace-passport-approval">
      <Button
        className="rounded-full"
        onClick={onStart}
        disabled={inProgress}
        aria-busy={inProgress}
        data-testid="marketplace-passport-approve"
      >
        {inProgress ? <Loader2 className="mr-2 size-4 animate-spin motion-reduce:animate-none" /> : null}
        Continue in Pubky Passport
      </Button>
      <MarketplaceApprovalDisclosure sentence={approvalDisclosure} />
      {inProgress ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
          {status === 'awaiting'
            ? 'Waiting for approval in Pubky Passport…'
            : status === 'creating'
              ? confirmingHomeserver
                ? 'Confirming with your homeserver…'
                : 'Preparing secure approval…'
              : 'Connecting marketplace…'}
        </div>
      ) : null}
    </div>
  );
}
