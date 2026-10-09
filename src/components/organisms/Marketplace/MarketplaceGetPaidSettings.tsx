'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Bitcoin,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  HandCoins,
  Loader2,
  LoaderCircle,
  RefreshCw,
} from 'lucide-react';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/atoms/Collapsible/Collapsible';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/atoms/Dialog/Dialog';
import { Input } from '@/atoms/Input/Input';
import { Label } from '@/atoms/Label/Label';
import { Switch } from '@/atoms/Switch/Switch';
import { Typography } from '@/atoms/Typography/Typography';
import { getLocksUrl } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useMarketplaceSellerPaymentConfig } from '@/hooks/useMarketplaceSellerPaymentConfig/useMarketplaceSellerPaymentConfig';
import { type SellerPaymentConfigOwnView } from '@/libs/commerce/payment-methods';
import { toast } from '@/molecules/Toaster/use-toast';
import { MarketplaceSessionConnectDialog } from '@/organisms/Marketplace/MarketplaceSessionConnectDialog';
import { locksCreatorMatchesShopPubky } from '@/services/locks/locks-frontend-session';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import {
  atLeastOneMethodSentence,
  countReadyPaymentMethods,
  deriveBitcoinStatus,
  derivePaypalStatus,
  PAYMENT_METHOD_STATUS_LABELS,
  type PaymentMethodStatus,
} from './MarketplaceGetPaidSettings.utils';

type LocksConnectView = {
  connectedCreator: string | null;
  isExchanging: boolean;
  error: string | null;
  reapproveNotice?: string | null;
  connectOpen?: boolean;
  connectUrl?: string | null;
  setConnectIframe?: (element: HTMLIFrameElement | null) => void;
  openConnect: () => void;
  closeConnect?: () => void;
};

type MarketplaceGetPaidSettingsProps = {
  /** Step 1 of the bitcoin method, owned by the template (no session needed). */
  locksConnect: LocksConnectView;
  onSaved?: (config: SellerPaymentConfigOwnView) => void;
};

type PaykitSetupStatus = 'idle' | 'error' | 'mismatch' | 'verifying' | 'timeout';

const PAYKIT_SETUP_TIMEOUT_MS = 6 * 60 * 1_000;

/**
 * A seller who has never saved has no payment-config row. The service
 * returns null for that read. Save uses this empty start so the first
 * write can store PayPal or bitcoin. It is not used while the read is in
 * flight or has failed.
 */
const UNSAVED_SELLER_PAYMENT_CONFIG: SellerPaymentConfigOwnView = {
  bitcoinEnabled: false,
  stripePaymentLink: null,
  paypalMerchantEmail: null,
  stripeRestrictedKeySet: false,
  updatedAt: '',
};
const PAYKIT_SETUP_EXPLANATION = 'Scan the code with Bitkit, or open this page on your phone and tap Open in Bitkit.';
const PAYKIT_RING_IDENTITY_HELPER =
  'Your Shop identity must live in Bitkit. Signed up with Pubky Ring? Create a new Shop account by scanning the sign-up QR with Bitkit — Ring import is coming to Bitkit.';

function createPaykitSetupState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function StatusPill({ status, testId }: { status: PaymentMethodStatus; testId: string }) {
  const variant = status === 'connected' ? 'secondary' : status === 'needs_attention' ? 'destructive' : 'outline';
  return (
    <Badge variant={variant} role="status" data-testid={testId} className="mt-1">
      {PAYMENT_METHOD_STATUS_LABELS[status]}
    </Badge>
  );
}

function MethodCard({
  icon: Icon,
  title,
  promise,
  status,
  statusTestId,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  promise: string;
  status: PaymentMethodStatus;
  statusTestId: string;
  children: React.ReactNode;
}) {
  return (
    <Card className="border">
      <CardContent className="grid gap-4 px-6">
        <div className="flex items-start justify-between gap-4">
          <div className="flex gap-3">
            <Icon className="mt-1 size-5 text-brand" />
            <div>
              <Typography as="h2" className="font-semibold">
                {title}
              </Typography>
              <Typography as="p" className="text-sm text-muted-foreground">
                {promise}
              </Typography>
            </div>
          </div>
          <StatusPill status={status} testId={statusTestId} />
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/**
 * The seller's "How you get paid" methods: PayPal, then bitcoin. Card
 * payments are paused, so a stored card configuration is not shown and is
 * written back unchanged when another rail is saved. Bitcoin settles to the
 * seller's own claimed watch-only account. PayPal settles into the seller's
 * own account. This marketplace never receives funds on any rail.
 */
export function MarketplaceGetPaidSettings({ locksConnect, onSaved }: MarketplaceGetPaidSettingsProps) {
  const {
    connectedCreator,
    isExchanging,
    error: locksError,
    reapproveNotice,
    connectOpen,
    connectUrl,
    setConnectIframe,
    openConnect,
    closeConnect,
  } = locksConnect;
  const marketplaceSession = useCommerceStore((state) => state.marketplaceSession);
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const payments = useMarketplaceSellerPaymentConfig();
  const refreshPaymentConfig = payments.refresh;
  const commitAccountClaimed = payments.commitAccountClaimed;
  const paykitIframeRef = useRef<HTMLIFrameElement>(null);
  const paykitSetupGenerationRef = useRef<string | null>(null);
  const [paykitSetupOpen, setPaykitSetupOpen] = useState(false);
  const [paykitSetupUrl, setPaykitSetupUrl] = useState<string | null>(null);
  const [paykitSetupState, setPaykitSetupState] = useState<string | null>(null);
  const [paykitSetupCreator, setPaykitSetupCreator] = useState<string | null>(null);
  const [paykitSetupStatus, setPaykitSetupStatus] = useState<PaykitSetupStatus>('idle');

  const [railDraft, setRailDraft] = useState<{
    bitcoin: boolean | null;
    paypal: string | null;
  }>({ bitcoin: null, paypal: null });
  const [draftBaseline, setDraftBaseline] = useState<string | null>(null);

  function closePaykitSetup() {
    paykitSetupGenerationRef.current = null;
    setPaykitSetupOpen(false);
    setPaykitSetupUrl(null);
    setPaykitSetupState(null);
    setPaykitSetupCreator(null);
    setPaykitSetupStatus('idle');
  }

  const serverConfig =
    payments.config ?? (!payments.isLoading && !payments.loadError ? UNSAVED_SELLER_PAYMENT_CONFIG : null);
  const serverBaseline = serverConfig
    ? `${serverConfig.updatedAt}\0${serverConfig.bitcoinEnabled}\0${serverConfig.paypalMerchantEmail ?? ''}\0${serverConfig.stripePaymentLink ?? ''}`
    : null;
  if (serverBaseline !== draftBaseline) {
    setDraftBaseline(serverBaseline);
    setRailDraft({ bitcoin: null, paypal: null });
  }

  useEffect(() => {
    if (!paykitSetupOpen || !paykitSetupUrl || !paykitSetupState) return;
    const setupOrigin = new URL(paykitSetupUrl).origin;
    const onMessage = (event: MessageEvent) => {
      if (
        event.origin !== setupOrigin ||
        event.source !== paykitIframeRef.current?.contentWindow ||
        event.data?.type !== 'paykit-setup-callback' ||
        event.data.state !== paykitSetupState
      ) {
        return;
      }
      if (event.data.error === 'identity-mismatch') {
        setPaykitSetupStatus('mismatch');
        return;
      }
      if (event.data.error) {
        setPaykitSetupStatus('error');
        return;
      }
      setPaykitSetupStatus('verifying');
      void refreshPaymentConfig().then((claimed) => {
        if (paykitSetupGenerationRef.current !== event.data.state) return;
        if (claimed === true) {
          commitAccountClaimed(true);
          closePaykitSetup();
          toast({ title: 'Bitkit setup connected' });
          return;
        }
        setPaykitSetupStatus('mismatch');
      });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [commitAccountClaimed, paykitSetupOpen, paykitSetupState, paykitSetupUrl, refreshPaymentConfig]);

  useEffect(() => {
    if (!paykitSetupOpen || !paykitSetupUrl || !paykitSetupState || paykitSetupStatus !== 'idle') return;
    const timeout = window.setTimeout(() => setPaykitSetupStatus('timeout'), PAYKIT_SETUP_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [paykitSetupOpen, paykitSetupState, paykitSetupStatus, paykitSetupUrl]);

  useEffect(() => {
    if (paykitSetupOpen && (!marketplaceSession || !currentUserPubky || currentUserPubky !== paykitSetupCreator)) {
      closePaykitSetup();
    }
  }, [currentUserPubky, marketplaceSession, paykitSetupCreator, paykitSetupOpen]);

  const openPaykitSetup = () => {
    if (!marketplaceSession || !currentUserPubky) return;
    const state = createPaykitSetupState();
    const url = CommerceController.getPaykitSetupUrl(window.location.href, state, currentUserPubky);
    paykitSetupGenerationRef.current = state;
    setPaykitSetupState(state);
    setPaykitSetupUrl(url);
    setPaykitSetupCreator(currentUserPubky);
    setPaykitSetupStatus('idle');
    setPaykitSetupOpen(true);
  };

  const onSave = async () => {
    if (!serverConfig || payments.isLoading || serverBaseline !== draftBaseline) return;
    const saved = await payments.save({
      bitcoinEnabled: railDraft.bitcoin ?? serverConfig.bitcoinEnabled,
      stripePaymentLink: serverConfig.stripePaymentLink ?? '',
      stripeRestrictedKey: '',
      paypalMerchantEmail: railDraft.paypal ?? serverConfig.paypalMerchantEmail ?? '',
    });
    if (saved) onSaved?.(saved);
  };

  const saveReady =
    Boolean(serverConfig) && !payments.isLoading && !payments.loadError && serverBaseline === draftBaseline;
  const paypalValue = railDraft.paypal ?? serverConfig?.paypalMerchantEmail ?? '';

  const saveButton = (
    <Button className="w-fit rounded-full" disabled={payments.isSaving || !saveReady} onClick={() => void onSave()}>
      {payments.isSaving ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : null}
      Save payment settings
    </Button>
  );

  const paypalStatus = derivePaypalStatus(payments.config);
  const bitcoinStatus = deriveBitcoinStatus({
    connectedCreator,
    accountPubky: currentUserPubky,
    accountClaimed: payments.accountClaimed,
    locksError,
    claimError: null,
  });
  const serverBitcoin = serverConfig?.bitcoinEnabled ?? false;
  const bitcoinValue = railDraft.bitcoin ?? serverBitcoin;
  const readyCount = countReadyPaymentMethods([paypalStatus, bitcoinStatus]);
  const step1Connected = locksCreatorMatchesShopPubky(connectedCreator, currentUserPubky);
  const step1NeedsPrimary = !step1Connected && bitcoinStatus === 'needs_attention';
  const paykitCodeExpired = paykitSetupStatus === 'error' || paykitSetupStatus === 'timeout';

  // Stored rails need the marketplace session and the loaded config; the
  // bitcoin connect steps above them do not, so they render unconditionally.
  const renderStoredRailBody = (children: React.ReactNode) => {
    if (!marketplaceSession) {
      return (
        <div className="grid justify-items-start gap-3 rounded-xl border p-4">
          <Typography as="p" className="text-sm text-muted-foreground">
            Saving payment settings requires a marketplace session.
          </Typography>
          <MarketplaceSessionConnectDialog />
        </div>
      );
    }
    if (payments.isLoading) {
      return (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          Loading payment settings…
        </div>
      );
    }
    if (payments.loadError) {
      return (
        <Typography as="p" role="alert" className="text-sm text-amber-300">
          {payments.loadError}
        </Typography>
      );
    }
    return children;
  };

  return (
    <section aria-label="Payment methods" className="flex flex-col gap-6" data-surface="marketplace-get-paid">
      <Typography as="p" className="text-muted-foreground" data-testid="payment-methods-ready-summary">
        {atLeastOneMethodSentence(readyCount)}
      </Typography>
      <MethodCard
        icon={HandCoins}
        title="PayPal"
        promise="Buyers pay straight to your PayPal account — all you need is the email you use there."
        status={paypalStatus}
        statusTestId="payment-method-status-paypal"
      >
        {renderStoredRailBody(
          <>
            <div className="grid gap-3 rounded-xl border p-4">
              <div>
                <Label htmlFor="get-paid-paypal" className="font-medium">
                  PayPal email
                </Label>
                <Typography as="p" className="text-sm text-muted-foreground">
                  Buyers pay this PayPal email directly; payments are confirmed by PayPal, not by this marketplace.
                </Typography>
              </div>
              <Input
                id="get-paid-paypal"
                type="email"
                value={paypalValue}
                onChange={(event) => setRailDraft((draft) => ({ ...draft, paypal: event.target.value }))}
                placeholder="you@example.com"
                autoComplete="off"
                className="h-10 max-w-md"
                aria-label="PayPal merchant email"
              />
            </div>
            {saveButton}
          </>,
        )}
      </MethodCard>

      <MethodCard
        icon={Bitcoin}
        title="Bitcoin wallet"
        promise="Get paid in bitcoin, straight to your own wallet — set it up in two steps."
        status={bitcoinStatus}
        statusTestId="payment-method-status-bitcoin"
      >
        <div className="grid gap-4 rounded-xl border p-4 sm:grid-cols-[1fr_auto] sm:items-center">
          <div>
            <Typography as="h3" className="text-sm font-semibold">
              <span className="text-brand">Step 1</span> Connect your Lock Server
            </Typography>
            <Typography as="p" className="text-sm text-muted-foreground">
              Approve the connection in Pubky Ring or Bitkit. The Lock Server can then lock your content for buyers — it
              never sees your identity secret.
            </Typography>
            {step1Connected && (
              <Typography as="p" className="mt-2 flex items-center gap-2 text-sm text-brand">
                <CheckCircle2 className="size-4" />
                Creator authority connected: {connectedCreator?.slice(0, 12)}…
              </Typography>
            )}
            {locksError && (
              <Typography as="p" role="alert" className="mt-2 text-sm text-amber-300">
                {locksError}
              </Typography>
            )}
            {!step1Connected && !locksError && reapproveNotice && (
              <Typography as="p" className="mt-2 text-sm text-muted-foreground" data-testid="locks-reapprove-notice">
                {reapproveNotice}
              </Typography>
            )}
          </div>
          {step1Connected ? (
            <Badge variant="secondary" className="justify-self-start sm:justify-self-auto">
              Connected
            </Badge>
          ) : (
            <Button
              variant={step1NeedsPrimary ? 'default' : 'secondary'}
              className="rounded-full"
              disabled={isExchanging}
              onClick={openConnect}
            >
              {isExchanging ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : null}
              Open Locks connect
            </Button>
          )}
        </div>

        <div className="grid gap-4 rounded-xl border p-4 sm:grid-cols-[1fr_auto] sm:items-center">
          <div>
            <Typography as="h3" className="text-sm font-semibold">
              <span className="text-brand">Step 2</span> Approve Paykit in Bitkit
            </Typography>
            <Typography as="p" className="text-sm text-muted-foreground">
              Open the setup in Bitkit and approve it there. Payments settle to your own bitcoin wallet — your spending
              keys never leave it.
            </Typography>
            <Typography as="p" className="mt-2 text-sm text-muted-foreground">
              {PAYKIT_RING_IDENTITY_HELPER}
            </Typography>
            {payments.accountClaimed === true && (
              <Typography as="p" className="mt-2 flex items-center gap-2 text-sm text-brand">
                <CheckCircle2 className="size-4" />
                Watch-only account claimed — payment requests derive fresh addresses from it.
              </Typography>
            )}
          </div>
          <Button
            variant={step1NeedsPrimary ? 'secondary' : 'default'}
            className="rounded-full"
            disabled={!marketplaceSession || !currentUserPubky}
            onClick={openPaykitSetup}
          >
            Open Bitkit setup
            <ExternalLink className="ml-2 size-4" />
          </Button>
        </div>

        {renderStoredRailBody(
          <>
            <div className="flex items-center justify-between gap-4 rounded-xl border p-4">
              <div>
                <Label htmlFor="get-paid-bitcoin" className="font-medium">
                  Accept bitcoin
                </Label>
                <Typography as="p" className="text-sm text-muted-foreground">
                  Buyers see bitcoin as a payment option on your orders.
                </Typography>
              </div>
              <Switch
                id="get-paid-bitcoin"
                checked={bitcoinValue}
                onCheckedChange={(enabled) => {
                  if (enabled && bitcoinStatus !== 'connected') return;
                  setRailDraft((draft) => ({ ...draft, bitcoin: enabled }));
                }}
                disabled={!bitcoinValue && bitcoinStatus !== 'connected'}
                aria-label="Accept bitcoin"
              />
            </div>

            <Collapsible>
              <CollapsibleTrigger className="group flex w-fit items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground">
                <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
                Technical details
              </CollapsibleTrigger>
              <CollapsibleContent className="grid gap-3 rounded-xl border p-4 text-sm text-muted-foreground data-[state=closed]:hidden">
                <Typography as="p" className="text-sm text-muted-foreground">
                  No identity secret enters this app.
                </Typography>
                <Typography as="p" className="text-sm text-muted-foreground">
                  Bitkit sends a watch-only BIP84 account claim directly to Paykit Server. Spending keys remain in the
                  wallet. Completion is confirmed inside the setup window — this app has no API to verify Paykit setup
                  state and does not pretend to.
                </Typography>
                <Typography as="p" className="text-sm text-muted-foreground">
                  Payment requests are delivered privately via Paykit and settle to your claimed watch-only account.
                </Typography>
                <Typography as="p" className="text-sm text-muted-foreground">
                  Lock Server: {getLocksUrl()}
                </Typography>
                {payments.accountClaimed !== true && (
                  <Typography as="p" className="text-sm text-muted-foreground">
                    {payments.accountClaimed === null
                      ? 'The Paykit server could not report your account state right now.'
                      : 'No watch-only account is claimed yet. Use Open Bitkit setup above. Spending keys stay in Bitkit.'}
                  </Typography>
                )}
              </CollapsibleContent>
            </Collapsible>

            {saveButton}
          </>,
        )}
      </MethodCard>

      <Dialog
        open={Boolean(connectOpen)}
        onOpenChange={(open) => {
          if (open) openConnect();
          else closeConnect?.();
        }}
      >
        <DialogContent className="w-full max-w-lg overflow-hidden" centered>
          <DialogHeader>
            <DialogTitle>Connect Lock Server</DialogTitle>
          </DialogHeader>
          <Typography as="p" className="text-sm text-muted-foreground">
            Scan with Pubky Ring or Bitkit. The Lock Server can then lock your content for buyers — it never sees your
            identity secret.
          </Typography>
          {connectUrl && (
            <iframe
              ref={setConnectIframe}
              key={connectUrl}
              src={connectUrl}
              title="Connect Lock Server"
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation-to-custom-protocols"
              referrerPolicy="no-referrer"
              className="h-[min(22rem,45vh)] w-full rounded-lg border bg-popover"
            />
          )}
          {locksError && (
            <div role="alert" className="grid gap-3 rounded-lg border border-amber-500/40 p-3 text-sm">
              <Typography as="p">{locksError}</Typography>
              <Button variant="secondary" className="w-fit rounded-full" onClick={openConnect}>
                <RefreshCw className="mr-2 size-4" />
                Retry
              </Button>
            </div>
          )}
          {isExchanging && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" aria-live="polite">
              <Loader2 className="size-4 animate-spin" />
              Confirming your Lock Server connection…
            </div>
          )}
          <DialogFooter>
            <Button variant="secondary" className="rounded-full" onClick={() => closeConnect?.()}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={paykitSetupOpen} onOpenChange={(open) => (open ? setPaykitSetupOpen(true) : closePaykitSetup())}>
        <DialogContent className="w-full max-w-lg" centered>
          <DialogHeader>
            <DialogTitle>Connect Bitkit</DialogTitle>
          </DialogHeader>
          {paykitSetupStatus !== 'idle' && (
            <div role="alert" className="grid gap-3 rounded-lg border border-amber-500/40 p-3 text-sm">
              <Typography as="p">
                {paykitSetupStatus === 'error'
                  ? 'Bitkit setup failed. Try again.'
                  : paykitSetupStatus === 'mismatch'
                    ? 'Bitkit approved a different account. In Bitkit, sign in with the same Pubky identity you use here, then try again.'
                    : paykitSetupStatus === 'verifying'
                      ? 'Confirming your Bitkit account…'
                      : 'No approval received. Try again.'}
              </Typography>
              <Button variant="secondary" className="w-fit rounded-full" onClick={openPaykitSetup}>
                <RefreshCw className="mr-2 size-4" />
                Retry
              </Button>
            </div>
          )}
          <Typography as="p" className="text-sm text-muted-foreground">
            {PAYKIT_SETUP_EXPLANATION}
          </Typography>
          <Typography as="p" className="text-sm text-muted-foreground">
            {PAYKIT_RING_IDENTITY_HELPER}
          </Typography>
          {paykitSetupUrl && paykitCodeExpired ? (
            <div
              data-testid="paykit-setup-qr-expired"
              className="flex h-40 w-full items-center justify-center rounded-lg border border-dashed bg-muted/40 p-6 text-center text-sm text-muted-foreground"
            >
              This code expired.
            </div>
          ) : (
            paykitSetupUrl && (
              <iframe
                ref={paykitIframeRef}
                key={paykitSetupUrl}
                src={`${paykitSetupUrl}#embed`}
                title="Connect Bitkit"
                sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-top-navigation-to-custom-protocols"
                referrerPolicy="no-referrer"
                scrolling="no"
                className="h-[40rem] w-full rounded-lg border bg-popover"
              />
            )
          )}
          <DialogFooter>
            <Button variant="secondary" className="rounded-full" onClick={closePaykitSetup}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
