'use client';

import { useEffect, useState } from 'react';
import { Copy, KeyRound, Loader2, type LucideIcon, RefreshCw, Smartphone, TriangleAlert } from 'lucide-react';
import { Button } from '@/atoms/Button/Button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/atoms/Dialog/Dialog';
import { Typography } from '@/atoms/Typography/Typography';
import { isPassportApprovalRefused } from '@/hooks/useGrantSigner/useGrantSigner';
import { useIsGrantSession } from '@/hooks/useIsGrantSession/useIsGrantSession';
import { useMarketplaceApprovalSigner } from '@/hooks/useMarketplaceApprovalSigner/useMarketplaceApprovalSigner';
import { useMarketplaceSessionConnect } from '@/hooks/useMarketplaceSessionConnect/useMarketplaceSessionConnect';
import type { MarketplaceSessionConnectStatus } from '@/hooks/useMarketplaceSessionConnect/useMarketplaceSessionConnect.types';
import { BOOTSTRAP_APPROVAL_EXPIRED, MARKETPLACE_FAILURE_MESSAGES } from '@/libs/commerce/failure-messages';
import { Logger } from '@/libs/logger/logger';
import { getMarketplaceGrantFlowEnabled } from '@/libs/runtime-config/runtime-config';
import { GrantSessionRefusal } from '@/molecules/GrantSessionRefusal/GrantSessionRefusal';
import { MarketplaceApprovalDisclosure } from '@/molecules/MarketplaceApprovalDisclosure/MarketplaceApprovalDisclosure';
import { QrCodeSlot } from '@/molecules/QrCodeSlot/QrCodeSlot';
import { type SignerOption, SignerToggle } from '@/molecules/SignerToggle/SignerToggle';
import { toast } from '@/molecules/Toaster/use-toast';
import { marketplaceApprovalDisclosure } from '@/services/marketplace/marketplace-session-grant';

const BITKIT_UNAVAILABLE = 'Bitkit cannot approve this request. Use Pubky Ring.';

const APPROVAL_COPY = {
  buy: {
    title: 'Enable purchases',
    success: 'Purchases approved',
    description: 'Authorize with your keychain to let the marketplace handle your purchases and marketplace data.',
    ringUnavailable: 'Use Bitkit to approve purchases for this sign-in.',
  },
  sell: {
    title: 'Enable selling',
    success: 'Selling enabled',
    description: 'Authorize with your keychain to let the marketplace handle your sales and marketplace data.',
    ringUnavailable: 'Use Bitkit to enable selling for this sign-in.',
  },
  sync: {
    title: 'Enable device sync',
    success: 'Device sync approved',
    description: 'Authorize with your keychain to sync your watchlist across devices and enable selling and buying.',
    ringUnavailable: 'Use Bitkit to enable device sync for this sign-in.',
  },
  messages: {
    title: 'Enable messages',
    success: 'Messaging preferences approved',
    description: 'Authorize with your keychain to access your messaging preferences and marketplace data.',
    ringUnavailable: 'Use Bitkit to enable messages for this sign-in.',
  },
} as const;

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
  triggerVariant = 'default',
  triggerIcon: TriggerIcon = KeyRound,
  onConnected,
  autoOpen = false,
  intent = 'buy',
  open: controlledOpen,
  onOpenChange,
  hideTrigger = false,
}: {
  triggerLabel?: string;
  triggerVariant?: 'default' | 'secondary' | 'outline';
  triggerIcon?: LucideIcon;
  onConnected?: () => void | Promise<void>;
  autoOpen?: boolean;
  intent?: keyof typeof APPROVAL_COPY;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
}) {
  const copy = APPROVAL_COPY[intent];
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = (nextOpen: boolean) => {
    setInternalOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };
  const grantFlowEnabled = getMarketplaceGrantFlowEnabled();
  const approvalSigner = useMarketplaceApprovalSigner();
  const isGrantSession = useIsGrantSession();
  const [signerChoice, setSignerChoice] = useState<SignerOption | null>(null);
  const signer: SignerOption =
    signerChoice ??
    (approvalSigner === 'Bitkit' || (isGrantSession && approvalSigner !== 'Pubky Passport') ? 'bitkit' : 'ring');
  const session = useMarketplaceSessionConnect({
    onConnected: () => {
      toast({
        title: copy.success,
      });
      setOpen(false);
      void onConnected?.();
    },
  });

  // Referencing `session.start`/`session.cancel` directly keeps the effect
  // dependency-stable: both are useCallback-memoized in the hook.
  const { start, cancel } = session;
  useEffect(() => {
    if (autoOpen) setInternalOpen(true);
  }, [autoOpen]);

  // A grant (Bitkit or Pubky Passport) sign-in has no AuthToken to redeem; it
  // connects through the grant bootstrap, so it is refused where that flow is
  // off, and a Passport sign-in also while the deploy switched Passport off.
  const refusesGrantSession = isGrantSession && (!grantFlowEnabled || isPassportApprovalRefused());
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
  const requestsGrantReconnect = session.requestsGrantReconnect;
  const requestsGrantBootstrap = session.requestsGrantBootstrap;
  const requestsPassport = session.requestsPassport;
  const sessionApprovalSigner = session.approvalSigner;
  // A Ring (cookie) sign-in's grant link can be approved by either phone
  // signer, so its copy names no single app.
  const bootstrapSigner = sessionApprovalSigner === 'Pubky Ring or Bitkit' ? null : sessionApprovalSigner;
  const approvalLapsed =
    session.status === 'expired' ||
    (session.status === 'error' &&
      (session.errorMessage === MARKETPLACE_FAILURE_MESSAGES.sessionTimeout ||
        session.errorMessage === BOOTSTRAP_APPROVAL_EXPIRED));
  const showsGrantSignerHint =
    approvalLapsed && !requestsPassport && (requestsGrantBootstrap || requestsGrantReconnect);
  const selectedSignerName = signer === 'ring' ? 'Pubky Ring' : 'Bitkit';
  // The grant link is one link either phone signer can approve; the toggle only
  // says which app to use. A Bitkit sign-in has no Ring identity to approve it,
  // and the AuthToken connect (grant flow off) is a Pubky Ring link Bitkit rejects.
  const approvesWithGrantLink = requestsGrantBootstrap || requestsGrantReconnect;
  const ringUnavailable = isGrantSession ? copy.ringUnavailable : undefined;
  const bitkitUnavailable = approvesWithGrantLink ? undefined : BITKIT_UNAVAILABLE;
  const introCopy = requestsGrantBootstrap
    ? bootstrapSigner
      ? `Approve with ${bootstrapSigner} to connect the marketplace for the identity signed in to Shop. Nothing is charged until you pay.`
      : 'Approve with Pubky Ring or Bitkit, whichever holds the pubky signed in to Shop. Nothing is charged until you pay.'
    : requestsGrantReconnect
      ? requestsPassport
        ? 'Approve with Pubky Passport to reconnect the marketplace session for the identity already signed in to Shop. Nothing is charged until you pay.'
        : `Approve with ${selectedSignerName} to reconnect the marketplace session for the identity already signed in to Shop. Nothing is charged until you pay.`
      : ['awaiting', 'creating'].includes(session.status)
        ? copy.description
        : null;
  const retry = () => {
    session.start();
    if (requestsPassport) session.startPassport();
  };
  const approvalDisclosure = session.authorizationUrl ? marketplaceApprovalDisclosure(session.authorizationUrl) : null;
  const showCopyLink =
    !refusesGrantSession &&
    !requestsPassport &&
    !['error', 'mismatch', 'expired', 'cancelled', 'joined'].includes(session.status);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {!hideTrigger && (
        <DialogTrigger asChild>
          <Button variant={triggerVariant} className="rounded-full">
            <TriggerIcon className="size-4" aria-hidden="true" />
            {triggerLabel}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="w-[386px] border-border bg-popover">
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
        </DialogHeader>

        {introCopy && (
          <Typography as="p" className="text-sm text-muted-foreground">
            {introCopy}
          </Typography>
        )}

        {!refusesGrantSession && !requestsPassport && session.status !== 'joined' && (
          <div className="mx-auto grid w-full max-w-xs gap-2">
            <SignerToggle
              value={signer}
              onValueChange={setSignerChoice}
              disabledReasons={{ ring: ringUnavailable, bitkit: bitkitUnavailable }}
            />
            {(ringUnavailable ?? bitkitUnavailable) && (
              <Typography as="p" className="text-center text-sm text-muted-foreground">
                {ringUnavailable ?? bitkitUnavailable}
              </Typography>
            )}
          </div>
        )}

        {refusesGrantSession ? (
          <GrantSessionRefusal />
        ) : ['error', 'mismatch', 'expired', 'cancelled'].includes(session.status) ? (
          <div className="grid gap-3">
            <div role="alert" className="flex items-center gap-3 rounded-md bg-destructive/60 px-6 py-3">
              <TriangleAlert className="size-4 shrink-0 text-destructive-foreground" aria-hidden="true" />
              <Typography as="p" size="sm" className="font-medium text-destructive-foreground">
                {session.status === 'mismatch'
                  ? 'That approval used a different identity. Approve with the same identity currently signed in to Shop.'
                  : session.status === 'expired'
                    ? 'This approval expired.'
                    : session.status === 'cancelled'
                      ? 'Approval cancelled.'
                      : session.errorMessage}
              </Typography>
            </div>
            {showsGrantSignerHint ? (
              <Typography as="p" className="text-sm text-muted-foreground" data-testid="grant-approval-signer-hint">
                {GRANT_APPROVAL_SIGNER_HINT}
              </Typography>
            ) : null}
            <Button className="w-fit rounded-full" onClick={retry}>
              <RefreshCw className="size-4" />
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
          <div role="status" className="rounded-md bg-muted/40 p-4 text-sm text-muted-foreground">
            An approval is already in progress on another surface. Approve it there — it also connects this marketplace
            session.
          </div>
        ) : (
          <div className="grid justify-items-center gap-4">
            <button
              type="button"
              className="group relative hidden size-48 cursor-pointer items-center justify-center rounded-md bg-foreground p-2 md:flex"
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
                logo={signer}
              />
            </button>

            <MarketplaceApprovalDisclosure sentence={approvalDisclosure} />

            {session.status === 'awaiting' && (
              <div className="flex items-center gap-2 text-sm font-bold text-muted-foreground" aria-live="polite">
                <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                {`Waiting for approval in ${selectedSignerName}…`}
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

            <div className="flex flex-wrap justify-center gap-2 md:hidden">
              <Button
                variant="secondary"
                className="rounded-full"
                onClick={session.openInRing}
                disabled={!session.authorizationUrl || session.isOpeningRing}
                aria-busy={session.isOpeningRing}
              >
                {session.isOpeningRing ? (
                  <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
                ) : (
                  <Smartphone className="size-4" />
                )}
                {session.isOpeningRing ? `Opening ${selectedSignerName}...` : `Authorize with ${selectedSignerName}`}
              </Button>
            </div>
          </div>
        )}

        <DialogFooter className="flex-row [&>*]:flex-1">
          <Button variant="secondary" className="rounded-full" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          {showCopyLink && (
            <Button
              variant="outline"
              className="rounded-full"
              onClick={() => void copyUrl()}
              disabled={!session.authorizationUrl}
            >
              <Copy className="size-4" />
              Copy link
            </Button>
          )}
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
        {inProgress ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : null}
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
