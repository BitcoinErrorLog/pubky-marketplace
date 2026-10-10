'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Bitcoin,
  CheckCircle2,
  ChevronDown,
  ExternalLink,
  HandCoins,
  KeyRound,
  Loader2,
  LoaderCircle,
  RefreshCw,
  Save,
} from 'lucide-react';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/atoms/Collapsible/Collapsible';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/atoms/Dialog/Dialog';
import { Heading } from '@/atoms/Heading/Heading';
import { Input } from '@/atoms/Input/Input';
import { Label } from '@/atoms/Label/Label';
import { Switch } from '@/atoms/Switch/Switch';
import { Typography } from '@/atoms/Typography/Typography';
import { getLocksUrl } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useMarketplaceSellerPaymentConfig } from '@/hooks/useMarketplaceSellerPaymentConfig/useMarketplaceSellerPaymentConfig';
import { useUsdtPaymentsCapability } from '@/hooks/useUsdtPaymentsCapability/useUsdtPaymentsCapability';
import { Tether } from '@/icons';
import { type SellerPaymentConfigOwnView } from '@/libs/commerce/payment-methods';
import { deriveUsdtSellerReadiness } from '@/libs/commerce/usdt-seller-setup';
import { SettingsSectionContent } from '@/molecules/Settings/SettingsSectionContent/SettingsSectionContent';
import { toast } from '@/molecules/Toaster/use-toast';
import { MarketplaceSessionConnectDialog } from '@/organisms/Marketplace/MarketplaceSessionConnectDialog';
import { MarketplaceUsdtSellerSetup } from '@/organisms/Marketplace/MarketplaceUsdtSellerSetup';
import { locksCreatorMatchesShopPubky } from '@/services/locks/locks-frontend-session';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import {
  deriveBitcoinStatus,
  derivePaypalStatus,
  deriveUsdtStatus,
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

type PaykitSetupStatus = 'idle' | 'error' | 'mismatch' | 'verifying' | 'timeout' | 'usdt-missing';

/** `setup` opens `/setup` (Bitcoin account, optional USDT address); `reconnect` adds a USDT address to an existing account. */
type PaykitSetupMode = 'setup' | 'reconnect';

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
const PAYKIT_RECONNECT_EXPLANATION =
  'Scan the code with Bitkit, or open this page on your phone and tap Open in Bitkit, to share a USDT address. Your Bitkit account and Bitcoin setup stay the same.';

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
    <Badge variant={variant} role="status" data-testid={testId} className="shrink-0">
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
    <Card className="rounded-md p-0 shadow-lg">
      <CardContent className="grid gap-6 p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid grid-cols-[1.5rem_minmax(0,1fr)] items-center gap-x-3">
            <Icon className="size-6 shrink-0 text-brand" />
            <Heading level={2} size="md">
              {title}
            </Heading>
            <Typography as="p" className="col-start-2 text-sm text-muted-foreground">
              {promise}
            </Typography>
          </div>
          <StatusPill status={status} testId={statusTestId} />
        </div>

        <SettingsSectionContent>{children}</SettingsSectionContent>
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
  const refreshOwnConfig = payments.refreshOwnConfig;
  const { status: usdtCapability, recheck: recheckUsdtCapability } = useUsdtPaymentsCapability();
  // An unreadable `/health` keeps the card, in its "can't be checked right now"
  // state, instead of hiding USDT from a seller who may have it.
  const showUsdtCard = usdtCapability === 'available' || usdtCapability === 'unreadable';
  const paykitIframeRef = useRef<HTMLIFrameElement>(null);
  const paykitSetupGenerationRef = useRef<string | null>(null);
  const [paykitSetupOpen, setPaykitSetupOpen] = useState(false);
  const [paykitSetupUrl, setPaykitSetupUrl] = useState<string | null>(null);
  const [paykitSetupState, setPaykitSetupState] = useState<string | null>(null);
  const [paykitSetupCreator, setPaykitSetupCreator] = useState<string | null>(null);
  const [paykitSetupStatus, setPaykitSetupStatus] = useState<PaykitSetupStatus>('idle');
  const [paykitSetupMode, setPaykitSetupMode] = useState<PaykitSetupMode>('setup');
  const [isRetryingUsdt, setIsRetryingUsdt] = useState(false);

  const [railDraft, setRailDraft] = useState<{
    bitcoin: boolean | null;
    paypal: string | null;
    usdt: boolean | null;
  }>({ bitcoin: null, paypal: null, usdt: null });
  const [draftBaseline, setDraftBaseline] = useState<string | null>(null);

  function closePaykitSetup() {
    paykitSetupGenerationRef.current = null;
    setPaykitSetupOpen(false);
    setPaykitSetupUrl(null);
    setPaykitSetupState(null);
    setPaykitSetupCreator(null);
    setPaykitSetupStatus('idle');
    setPaykitSetupMode('setup');
  }

  const serverConfig =
    payments.config ?? (!payments.isLoading && !payments.loadError ? UNSAVED_SELLER_PAYMENT_CONFIG : null);
  const serverBaseline = serverConfig
    ? `${serverConfig.updatedAt}\0${serverConfig.bitcoinEnabled}\0${serverConfig.paypalMerchantEmail ?? ''}\0${serverConfig.stripePaymentLink ?? ''}\0${serverConfig.usdtEnabled ?? ''}`
    : null;
  if (serverBaseline !== draftBaseline) {
    setDraftBaseline(serverBaseline);
    setRailDraft({ bitcoin: null, paypal: null, usdt: null });
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
      if (paykitSetupMode === 'reconnect') {
        void refreshOwnConfig().then((next) => {
          if (paykitSetupGenerationRef.current !== event.data.state) return;
          if (next && deriveUsdtSellerReadiness(next) === 'ready') {
            closePaykitSetup();
            toast({ title: 'USDT is ready' });
            return;
          }
          setPaykitSetupStatus('usdt-missing');
        });
        return;
      }
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
  }, [
    commitAccountClaimed,
    paykitSetupMode,
    paykitSetupOpen,
    paykitSetupState,
    paykitSetupUrl,
    refreshOwnConfig,
    refreshPaymentConfig,
  ]);

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

  const openPaykitSetup = (mode: PaykitSetupMode) => {
    if (!marketplaceSession || !currentUserPubky) return;
    const state = createPaykitSetupState();
    const url =
      mode === 'reconnect'
        ? CommerceController.getPaykitReconnectUrl(window.location.href, state, currentUserPubky)
        : CommerceController.getPaykitSetupUrl(window.location.href, state, currentUserPubky);
    paykitSetupGenerationRef.current = state;
    setPaykitSetupMode(mode);
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
      // The service accepts the field only while its USDT flag is on, and it
      // reports `usdt_enabled` on the own config exactly then. Sending it on
      // any other signal would make a service without it refuse the whole save,
      // PayPal and Bitcoin included. Sending the stored value keeps those saves
      // from resetting the consent.
      ...(serverConfig.usdtEnabled !== undefined ? { usdtEnabled: railDraft.usdt ?? serverConfig.usdtEnabled } : {}),
    });
    if (saved) onSaved?.(saved);
  };

  const saveReady =
    Boolean(serverConfig) && !payments.isLoading && !payments.loadError && serverBaseline === draftBaseline;
  const paypalValue = railDraft.paypal ?? serverConfig?.paypalMerchantEmail ?? '';

  const saveButton = (
    <Button className="w-fit rounded-full" disabled={payments.isSaving || !saveReady} onClick={() => void onSave()}>
      {payments.isSaving ? <LoaderCircle className="size-4 animate-spin" /> : <Save className="size-4" />}
      Save changes
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
  const usdtReadiness = deriveUsdtSellerReadiness(serverConfig ?? {});
  const usdtStatus = deriveUsdtStatus(usdtReadiness);
  const usdtValue = railDraft.usdt ?? serverConfig?.usdtEnabled ?? false;
  const serverBitcoin = serverConfig?.bitcoinEnabled ?? false;
  const bitcoinValue = railDraft.bitcoin ?? serverBitcoin;
  const step1Connected = locksCreatorMatchesShopPubky(connectedCreator, currentUserPubky);
  const paykitCodeExpired = paykitSetupStatus === 'error' || paykitSetupStatus === 'timeout';

  // Stored rails need the marketplace session and the loaded config; the
  // bitcoin connect steps above them do not, so they render unconditionally.
  const renderStoredRailBody = (children: React.ReactNode) => {
    if (!marketplaceSession) {
      return (
        <div className="grid justify-items-start gap-3">
          <Typography as="p" className="text-sm text-muted-foreground">
            Enable selling to save your payment methods.
          </Typography>
          <MarketplaceSessionConnectDialog triggerLabel="Enable selling" intent="sell" />
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
      <MethodCard
        icon={HandCoins}
        title="PayPal"
        promise="Get paid directly to your PayPal account."
        status={paypalStatus}
        statusTestId="payment-method-status-paypal"
      >
        {renderStoredRailBody(
          <>
            <div className="grid gap-3">
              <div>
                <Label htmlFor="get-paid-paypal" className="font-medium">
                  PayPal email
                </Label>
              </div>
              <Input
                theme="dashed"
                id="get-paid-paypal"
                type="email"
                value={paypalValue}
                onChange={(event) => setRailDraft((draft) => ({ ...draft, paypal: event.target.value }))}
                placeholder="you@example.com"
                autoComplete="off"
                className="max-w-md"
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
        promise="Connect your wallet to accept bitcoin."
        status={bitcoinStatus}
        statusTestId="payment-method-status-bitcoin"
      >
        <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div>
            <Typography as="h3" className="text-sm font-semibold">
              1. Connect Lock Server
            </Typography>
            <Typography as="p" className="text-sm text-muted-foreground">
              Authorize with your keychain to enable secure delivery.
            </Typography>
            {step1Connected && (
              <Typography as="p" className="mt-2 flex items-center gap-2 text-sm text-brand">
                <CheckCircle2 className="size-4" />
                Connected to your account.
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
            <Button variant="secondary" className="w-fit" disabled={isExchanging} onClick={openConnect}>
              {isExchanging ? <LoaderCircle className="size-4 animate-spin" /> : <KeyRound className="size-4" />}
              Connect Lock Server
            </Button>
          )}
        </div>

        <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
          <div>
            <Typography as="h3" className="text-sm font-semibold">
              2. Connect Bitkit
            </Typography>
            <Typography as="p" className="text-sm text-muted-foreground">
              Approve payment setup in Bitkit to receive bitcoin.
            </Typography>
            {payments.accountClaimed === true && (
              <Typography as="p" className="mt-2 flex items-center gap-2 text-sm text-brand">
                <CheckCircle2 className="size-4" />
                Wallet connected.
              </Typography>
            )}
          </div>
          <Button
            variant="secondary"
            className="w-fit"
            disabled={!marketplaceSession || !currentUserPubky}
            onClick={() => openPaykitSetup('setup')}
          >
            Connect Bitkit
            <ExternalLink className="size-4" />
          </Button>
        </div>

        {renderStoredRailBody(
          <>
            <div className="grid gap-6 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div>
                <Typography as="label" htmlFor="get-paid-bitcoin" className="block text-sm font-semibold">
                  3. Accept bitcoin
                </Typography>
                <Typography as="p" className="text-sm text-muted-foreground">
                  Offer bitcoin payment option at checkout.
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
              <CollapsibleContent className="grid gap-3 pt-4 text-sm text-muted-foreground data-[state=closed]:hidden">
                <Typography as="p" className="text-sm text-muted-foreground">
                  Bitkit keeps your spending keys private and shares a watch-only account with Paykit to generate
                  payment addresses. Payments go directly to your wallet through private payment requests, without
                  exposing your identity secret to Shop.{' '}
                  <a
                    href={getLocksUrl()}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-4"
                  >
                    Locks Server
                  </a>{' '}
                  handles secure delivery.
                  {payments.accountClaimed !== true &&
                    (payments.accountClaimed === null
                      ? ' Your wallet status is currently unavailable.'
                      : ' Connect Bitkit to finish wallet setup.')}
                </Typography>
              </CollapsibleContent>
            </Collapsible>

            {saveButton}
          </>,
        )}
      </MethodCard>

      {showUsdtCard && (
        <MethodCard
          icon={Tether}
          title="USDT"
          promise="Get paid in USDT, directly to your Bitkit wallet."
          status={usdtStatus}
          statusTestId="payment-method-status-usdt"
        >
          {renderStoredRailBody(
            <>
              <MarketplaceUsdtSellerSetup
                readiness={usdtReadiness}
                enabled={usdtValue}
                onEnabledChange={(enabled) => {
                  if (enabled && usdtReadiness !== 'ready') return;
                  setRailDraft((draft) => ({ ...draft, usdt: enabled }));
                }}
                onSetup={() => openPaykitSetup('setup')}
                onReconnect={() => openPaykitSetup('reconnect')}
                onRetry={() => {
                  setIsRetryingUsdt(true);
                  void Promise.all([refreshOwnConfig(), recheckUsdtCapability()]).finally(() =>
                    setIsRetryingUsdt(false),
                  );
                }}
                isRetrying={isRetryingUsdt}
                canOpenBitkit={Boolean(marketplaceSession && currentUserPubky)}
              />
              {saveButton}
            </>,
          )}
        </MethodCard>
      )}

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
            Scan with your keychain to enable secure delivery.
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
            <div role="alert" className="grid gap-3 rounded-md border border-amber-500/40 p-3 text-sm">
              <Typography as="p">{locksError}</Typography>
              <Button variant="secondary" className="w-fit rounded-full" onClick={openConnect}>
                <RefreshCw className="size-4" />
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
            <DialogTitle>{paykitSetupMode === 'reconnect' ? 'Add USDT in Bitkit' : 'Connect Bitkit'}</DialogTitle>
          </DialogHeader>
          {paykitSetupStatus !== 'idle' && (
            <div role="alert" className="grid gap-3 rounded-md border border-amber-500/40 p-3 text-sm">
              <Typography as="p">
                {paykitSetupStatus === 'error'
                  ? 'Bitkit setup failed. Try again.'
                  : paykitSetupStatus === 'mismatch'
                    ? 'Bitkit approved a different account. In Bitkit, sign in with the same Pubky identity you use here, then try again.'
                    : paykitSetupStatus === 'verifying'
                      ? paykitSetupMode === 'reconnect'
                        ? 'Confirming your USDT address…'
                        : 'Confirming your Bitkit account…'
                      : paykitSetupStatus === 'usdt-missing'
                        ? 'Bitkit did not confirm a USDT address. Try again.'
                        : 'No approval received. Try again.'}
              </Typography>
              <Button
                variant="secondary"
                className="w-fit rounded-full"
                onClick={() => openPaykitSetup(paykitSetupMode)}
              >
                <RefreshCw className="size-4" />
                Retry
              </Button>
            </div>
          )}
          <Typography as="p" className="text-sm text-muted-foreground">
            {paykitSetupMode === 'reconnect' ? PAYKIT_RECONNECT_EXPLANATION : PAYKIT_SETUP_EXPLANATION}
          </Typography>
          {paykitSetupUrl && paykitCodeExpired ? (
            <div
              data-testid="paykit-setup-qr-expired"
              className="flex h-40 w-full items-center justify-center rounded-md bg-muted/40 p-6 text-center text-sm text-muted-foreground"
            >
              This code expired.
            </div>
          ) : (
            paykitSetupUrl && (
              <iframe
                ref={paykitIframeRef}
                key={paykitSetupUrl}
                src={`${paykitSetupUrl}#embed`}
                title={paykitSetupMode === 'reconnect' ? 'Add USDT in Bitkit' : 'Connect Bitkit'}
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
