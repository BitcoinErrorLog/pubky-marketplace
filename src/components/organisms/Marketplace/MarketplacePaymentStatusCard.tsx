'use client';

import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  Banknote,
  CheckCircle2,
  Clock3,
  Download,
  FileWarning,
  KeyRound,
  LoaderCircle,
  WalletCards,
} from 'lucide-react';
import { Controller, type UseFormReturn } from 'react-hook-form';
import { Badge } from '@/atoms/Badge/Badge';
import { Button } from '@/atoms/Button/Button';
import { Typography } from '@/atoms/Typography/Typography';
import { type CommerceAdapterMode, isDurableCommerceMode, isLocksPaykitCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useBuyerPaykitWallet } from '@/hooks/useBuyerPaykitWallet/useBuyerPaykitWallet';
import { useMarketplaceLocksPayment } from '@/hooks/useMarketplaceLocksPayment/useMarketplaceLocksPayment';
import { useMarketplaceOrderPayment } from '@/hooks/useMarketplaceOrderPayment/useMarketplaceOrderPayment';
import {
  type SellerPaymentConfirmationForm,
  type SellerPaymentConfirmationSubmission,
  type SellerPaymentResolutionForm,
  type SellerPaymentResolutionSubmission,
  useMarketplaceSellerPaymentReviewForm,
} from '@/hooks/useMarketplaceSellerPaymentReview/useMarketplaceSellerPaymentReviewForm';
import { useNowMs } from '@/hooks/useNowMs/useNowMs';
import {
  BITCOIN_WALLET_SENT_COPY,
  BITCOIN_WALLET_WAITING_COPY,
  bitcoinPaidConfirmation,
  bitcoinSeenBadgeLabel,
  buyerBitcoinReviewCopy,
  buyerBitcoinWalletCopy,
  holdCountdownCopy,
  PAYMENT_CONFIRMED_ON_CHAIN_LABEL,
  PAYMENT_SEEN_HOLD_COPY,
  PAYMENT_SELLER_CONFIRMED_LABEL,
  SELLER_CONFIRMED_BEFORE_CHAIN_BUYER_COPY,
  SELLER_CONFIRMED_BEFORE_CHAIN_SELLER_COPY,
  sellerBitcoinConfirmPrompt,
  sellerConfirmsByCopy,
} from '@/libs/commerce/bitcoin-buyer-status';
import {
  CHECKOUT_HOLD_COPY,
  formatOrderInstant,
  holderBoundCopy,
  holderUnboundCopy,
  isHoldExpiredNoLateMoney,
  isLateCompletionOrder,
  isRefundRequiredPayment,
  refundRequiredCopyForRole,
  UNBOUND_BACK_CANCEL_REASON,
} from '@/libs/commerce/checkout-hold';
import { MARKETPLACE_FAILURE_MESSAGES } from '@/libs/commerce/failure-messages';
import { type BuyerVisiblePaymentStatus, buyerVisiblePaymentStatus } from '@/libs/commerce/locks-payment';
import type { CommerceDigitalLock } from '@/libs/commerce/marketplace-records';
import {
  BITCOIN_WALLET_UNSUPPORTED_TITLE,
  BITCOIN_WALLET_UNVERIFIED_TITLE,
  bitcoinWalletUnsupportedBody,
  bitcoinWalletUnverifiedBody,
} from '@/libs/commerce/paykit-wallet';
import { buildMarketplaceOrderAggregateId } from '@/libs/commerce/transaction-commands';
import { getDeployEnv } from '@/libs/runtime-config/runtime-config';
import type { MarketplaceOrder, MarketplacePayment } from '@/services/marketplace/marketplace';
import { useAuthStore } from '@/stores/auth/auth.store';
import { MarketplaceBitcoinAmountBreakdown } from './MarketplaceBitcoinAmountBreakdown';

const PAYKIT_DELIVERY_FAILED_COPY =
  "Your wallet didn't receive the request. In Bitkit, add the seller as a contact, then try again.";

/**
 * The buyer-visible payment status vocabulary is deliberately small
 * (implementation plan, "Paykit, Locks, and payment confirmation"): awaiting
 * entitlement, confirmed, marketplace-expired, and manual review. Detection,
 * underpayment/overpayment, and confirmation counts stay internal to
 * Locks/Paykit Server and are never rendered as real facts — only the
 * visibly-labeled sandbox demonstrates the finer-grained simulated states.
 */
const BUYER_VISIBLE_STATUS_LABELS: Record<BuyerVisiblePaymentStatus, string> = {
  awaiting_entitlement: 'Awaiting payment',
  confirmed: 'Payment confirmed',
  expired: 'Payment window expired',
  manual_review: 'Under manual review',
};

function parseListingAggregateId(aggregateId: string): { sellerPubky: string; listingId: string } | null {
  if (!aggregateId.startsWith('listing:')) return null;
  const rest = aggregateId.slice('listing:'.length);
  if (rest.length < 54 || rest[52] !== '_') return null;
  return { sellerPubky: rest.slice(0, 52), listingId: rest.slice(53) };
}

/**
 * Truthful payment status for one order. Renders only the buyer-visible
 * states; never claims settlement detail the upstream contract keeps
 * internal; never advances a payment itself — in `locks-paykit` mode the
 * buyer's only actions are creating the payment request (proof bundle +
 * `payment.register_locks`) and, after server-side confirmation, unlocking
 * the purchased digital content.
 */
export function MarketplacePaymentStatusCard({
  order,
  payment,
  isBuyer,
  adapterMode,
  advancePayment,
  onPaymentChanged,
}: {
  order: MarketplaceOrder;
  payment: MarketplacePayment | null;
  isBuyer: boolean;
  adapterMode: CommerceAdapterMode;
  advancePayment: (
    payment: MarketplacePayment,
    target: 'detected' | 'confirmed' | 'expired' | 'manual_review',
    confirmations: number,
  ) => Promise<boolean>;
  onPaymentChanged: () => void | Promise<void>;
}) {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const isSandbox = adapterMode === 'sandbox';
  const isStaging = getDeployEnv() === 'staging';
  const isLocksPaykit = isLocksPaykitCommerceMode(adapterMode);
  const [digitalLock, setDigitalLock] = useState<CommerceDigitalLock | null>(null);

  // The digital lock lives on the seller-signed listing record (cached
  // locally when the buyer browsed it; fetched from the seller's homeserver
  // otherwise). Without it there is nothing to pay through Locks.
  useEffect(() => {
    if (!isLocksPaykit) return;
    let active = true;
    const load = async () => {
      for (const line of order.lines) {
        const parsed = parseListingAggregateId(line.listingAggregateId);
        if (!parsed) continue;
        try {
          const record = await CommerceController.getOrFetchListing(parsed.sellerPubky, parsed.listingId);
          if (record.digitalLock) {
            if (active) setDigitalLock(record.digitalLock);
            return;
          }
        } catch {
          // An unreachable listing record just means no Locks flow is offered.
        }
      }
      if (active) setDigitalLock(null);
    };
    void load();
    return () => {
      active = false;
    };
  }, [isLocksPaykit, order.lines]);

  const locks = useMarketplaceLocksPayment({
    order,
    payment,
    digitalLock,
    isBuyer,
    onPaymentChanged,
  });

  const isDurable = isDurableCommerceMode(adapterMode);
  const isTerminal = ['completed', 'cancelled', 'refunded_external', 'refunded_partial', 'closed'].includes(
    order.state,
  );
  const isSeller = currentUserPubky !== null && currentUserPubky === order.sellerPubky;
  const visibleStatus = payment ? buyerVisiblePaymentStatus(payment.state) : null;
  const isAwaiting = visibleStatus === 'awaiting_entitlement' && !isTerminal;
  // Digital Locks orders keep the Locks/Paykit flow; everything else in the
  // durable modes goes through the seller-configured payment methods.
  const usesMethodFlow = isDurable && isAwaiting && !digitalLock;
  const methodPayment = useMarketplaceOrderPayment({
    order,
    enabled: usesMethodFlow && isBuyer,
    onPaymentChanged,
  });
  const bitcoinBindOffered =
    usesMethodFlow && isBuyer && !order.paymentMethod && (methodPayment.availableMethods?.includes('bitcoin') ?? false);
  const buyerWallet = useBuyerPaykitWallet(currentUserPubky, bitcoinBindOffered);
  const bitcoinWalletUnsupported = bitcoinBindOffered && buyerWallet.state === 'unsupported';
  const bitcoinWalletUnverified = bitcoinBindOffered && buyerWallet.state === 'unverified';
  const bitcoinWalletChecking = bitcoinBindOffered && buyerWallet.state === 'checking';
  const sellerReview = useMarketplaceSellerPaymentReviewForm(order.id, onPaymentChanged);
  const [paypalTransactionRef, setPaypalTransactionRef] = useState('');
  const [isReleasingHold, setIsReleasingHold] = useState(false);
  const [releaseHoldError, setReleaseHoldError] = useState<string | null>(null);
  const lateCompletion = isLateCompletionOrder(order);
  const refundRequired = isRefundRequiredPayment(payment);
  const expiredNoLateMoney = isHoldExpiredNoLateMoney(order, payment);

  const releaseUnboundHold = async () => {
    setReleaseHoldError(null);
    setIsReleasingHold(true);
    try {
      const response = await CommerceController.executeMarketplaceCommand({
        version: 1,
        commandId: crypto.randomUUID(),
        aggregateId: buildMarketplaceOrderAggregateId(order.id),
        expectedRevision: order.revision,
        issuedAt: new Date().toISOString(),
        kind: 'order.cancel_request',
        payload: { orderId: order.id, reason: UNBOUND_BACK_CANCEL_REASON },
      });
      if (!response.ok) {
        setReleaseHoldError(MARKETPLACE_FAILURE_MESSAGES.orderChanged);
        return;
      }
      await onPaymentChanged();
    } catch {
      setReleaseHoldError(MARKETPLACE_FAILURE_MESSAGES.orderChanged);
    } finally {
      setIsReleasingHold(false);
    }
  };

  if (!payment || visibleStatus === null) return null;

  const seenBadge =
    visibleStatus === 'awaiting_entitlement' && !isTerminal ? bitcoinSeenBadgeLabel(order, payment) : null;
  const paidBitcoin = bitcoinPaidConfirmation(order, payment);
  const paidBitcoinBadge = paidBitcoin
    ? paidBitcoin.sellerConfirmed
      ? PAYMENT_SELLER_CONFIRMED_LABEL
      : PAYMENT_CONFIRMED_ON_CHAIN_LABEL
    : null;
  const visibleStatusLabel =
    seenBadge ??
    paidBitcoinBadge ??
    (isTerminal && visibleStatus === 'awaiting_entitlement'
      ? order.state === 'cancelled'
        ? 'Order cancelled'
        : 'Not paid'
      : BUYER_VISIBLE_STATUS_LABELS[visibleStatus]);

  return (
    <div className="grid min-w-0 gap-3 rounded-xl border p-4" data-surface="marketplace-payment-status-card">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={visibleStatus === 'confirmed' ? 'default' : 'outline'}>{visibleStatusLabel}</Badge>
        {paidBitcoin?.sellerConfirmed && paidBitcoin.onChain && (
          <Badge variant="secondary" data-testid="bitcoin-on-chain-badge">
            {PAYMENT_CONFIRMED_ON_CHAIN_LABEL}
          </Badge>
        )}
        {payment.adapter === 'locks' && <Badge variant="secondary">Locks/Paykit</Badge>}
        {order.paymentMethod === 'bitcoin' && <Badge variant="secondary">₿ Bitcoin</Badge>}
        {order.paymentMethod === 'paypal' && <Badge variant="secondary">PayPal</Badge>}
        {/* How a fiat rail is verified stays on the order: a gateway-notified
            PayPal payment was confirmed by PayPal's own notification;
            seller-attested is the seller saying so. */}
        {order.fiatVerification === 'processor' && <Badge variant="secondary">Processor-verified</Badge>}
        {order.fiatVerification === 'gateway-notified' && <Badge variant="secondary">PayPal-verified</Badge>}
        {order.fiatVerification === 'seller-attested' && <Badge variant="outline">Seller-attested</Badge>}
        {isSandbox && <Badge variant="secondary">Sandbox · simulated payment · no real funds</Badge>}
      </div>
      <MarketplaceBitcoinAmountBreakdown
        order={order}
        showExact={isBuyer && isAwaiting && buyerBitcoinWalletCopy(order, payment).kind === 'pay'}
        explainCode={isBuyer}
      />
      {!isSandbox && isBuyer && isAwaiting && isStaging && (
        <Typography
          as="p"
          role="note"
          className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
        >
          Staging environment — test rails, no real funds move
        </Typography>
      )}
      {paidBitcoin?.sellerConfirmed && !paidBitcoin.onChain && (
        <Typography
          as="p"
          className="min-w-0 text-sm break-words whitespace-normal text-muted-foreground"
          data-testid="bitcoin-seller-confirmed-before-chain"
        >
          {isBuyer ? SELLER_CONFIRMED_BEFORE_CHAIN_BUYER_COPY : SELLER_CONFIRMED_BEFORE_CHAIN_SELLER_COPY}
        </Typography>
      )}
      {visibleStatus === 'confirmed' && order.fiatVerification === 'gateway-notified' && (
        <Typography
          as="p"
          data-testid="paypal-verified-explanation"
          className="min-w-0 text-sm break-words whitespace-normal text-muted-foreground"
        >
          This payment was confirmed automatically by a verified notification from PayPal&rsquo;s servers, matched
          against the seller&rsquo;s configured PayPal address and the exact order total.
        </Typography>
      )}
      {visibleStatus === 'confirmed' && order.fiatVerification === 'seller-attested' && (
        <Typography as="p" className="min-w-0 text-sm break-words whitespace-normal text-muted-foreground">
          This payment was confirmed by the seller reporting receipt in their own PayPal account — not by automatic
          processor verification. The confirmation is the seller&rsquo;s attestation.
        </Typography>
      )}

      {lateCompletion && (
        <Typography as="p" className="text-sm text-muted-foreground">
          {isBuyer ? CHECKOUT_HOLD_COPY.lateCompleteBuyer : CHECKOUT_HOLD_COPY.lateCompleteSeller}
        </Typography>
      )}
      {refundRequired && (
        <Typography as="p" className="text-sm text-muted-foreground">
          {refundRequiredCopyForRole(isBuyer, order.paymentMethod)}
        </Typography>
      )}

      {visibleStatus === 'expired' && (
        <Typography as="p" className="text-sm text-muted-foreground">
          {expiredNoLateMoney
            ? CHECKOUT_HOLD_COPY.expiredNoLateMoney
            : 'The marketplace payment window elapsed before a verified payment arrived, so this checkout was not completed. A payment verified after expiry is reconciled manually — never silently applied or discarded.'}
        </Typography>
      )}
      {visibleStatus === 'expired' &&
        isBuyer &&
        order.paymentMethod === 'bitcoin' &&
        order.paykitDeliveryState !== 'delivered' && (
          <Typography as="p" role="alert" className="text-sm text-amber-300" data-testid="paykit-delivery-failed">
            {PAYKIT_DELIVERY_FAILED_COPY}
          </Typography>
        )}
      {visibleStatus === 'manual_review' && !refundRequired && (
        <Typography as="p" className="text-sm text-muted-foreground" data-testid="payment-manual-review-copy">
          {isBuyer && order.paymentMethod === 'bitcoin'
            ? buyerBitcoinReviewCopy(order, payment)
            : 'A verified event arrived outside the normal flow (for example after the payment window expired), so the seller must resolve this order manually. No funds are held by this marketplace.'}
        </Typography>
      )}

      {isDurable &&
        isSeller &&
        order.paymentMethod === 'bitcoin' &&
        payment.adapter === 'paykit' &&
        order.paykitRequestState === 'awaiting_seller_confirmation' && (
          <SellerBitcoinConfirmationReview
            prompt={sellerBitcoinConfirmPrompt(order)}
            observation={order.paykitObservation ?? null}
            deadline={order.paykitSellerConfirmationDeadline}
            form={sellerReview.confirmForm}
            isSubmitting={sellerReview.isSubmitting}
            error={sellerReview.error}
            onConfirm={() => void sellerReview.submitConfirm()}
          />
        )}

      {isDurable &&
        isSeller &&
        order.paymentMethod === 'bitcoin' &&
        payment.adapter === 'paykit' &&
        payment.state === 'manual_review' && (
          <SellerBitcoinResolutionReview
            enteredAt={payment.manualReviewEnteredAt}
            form={sellerReview.resolveForm}
            isSubmitting={sellerReview.isSubmitting}
            error={sellerReview.error}
            allowPaid={!refundRequired}
            onResolve={() => void sellerReview.submitResolve()}
          />
        )}

      {/* Sandbox-only simulated detail, always under the visible sandbox label. */}
      {isSandbox && isBuyer && payment.state !== 'confirmed' && (
        <div className="flex flex-wrap gap-2">
          {payment.state === 'awaiting_entitlement' && (
            <Button
              variant="secondary"
              size="sm"
              className="rounded-full"
              onClick={() => void advancePayment(payment, 'detected', 0)}
            >
              <Clock3 className="mr-2 size-4" />
              Simulate detected
            </Button>
          )}
          {(payment.state === 'awaiting_entitlement' || payment.state === 'detected') && (
            <Button size="sm" className="rounded-full" onClick={() => void advancePayment(payment, 'confirmed', 1)}>
              <CheckCircle2 className="mr-2 size-4" />
              Simulate confirmation
            </Button>
          )}
          {payment.state === 'detected' && (
            <Typography as="p" className="self-center text-xs text-muted-foreground">
              Simulated detection — a real deployment never shows unconfirmed detection as payment.
            </Typography>
          )}
        </div>
      )}

      {/* Seller-configured payment methods: the buyer picks a rail. */}
      {usesMethodFlow && isBuyer && !order.paymentMethod && (
        <div className="grid gap-2">
          {methodPayment.configError ? (
            <Typography as="p" role="alert" className="text-sm text-amber-300">
              {methodPayment.configError}
            </Typography>
          ) : methodPayment.availableMethods === null ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" />
              Loading the seller&rsquo;s payment methods…
            </div>
          ) : methodPayment.availableMethods.length === 0 ? (
            <>
              <Typography as="p" className="text-sm text-muted-foreground">
                The seller has not set up any payment methods yet, so this checkout cannot be paid right now. Message
                the seller — once they configure a method in their payment settings, it appears here.
              </Typography>
              <Button
                size="sm"
                variant="secondary"
                className="w-fit rounded-full"
                disabled={isReleasingHold}
                onClick={() => void releaseUnboundHold()}
              >
                {isReleasingHold ? (
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                ) : (
                  <ArrowLeft className="mr-2 size-4" />
                )}
                Back
              </Button>
            </>
          ) : (
            <>
              {methodPayment.bitcoinOfferUnavailable && (
                <Typography as="p" className="text-sm text-muted-foreground">
                  {MARKETPLACE_FAILURE_MESSAGES.bitcoinOfferUnavailable}
                </Typography>
              )}
              <Typography as="p" className="text-sm text-muted-foreground">
                {holderUnboundCopy(order.holdExpiresAt)}
              </Typography>
              <div className="flex flex-wrap gap-2">
                {methodPayment.availableMethods.includes('bitcoin') && (
                  <Button
                    size="sm"
                    className="rounded-full"
                    disabled={
                      methodPayment.pendingAction !== null ||
                      bitcoinWalletChecking ||
                      bitcoinWalletUnsupported ||
                      bitcoinWalletUnverified
                    }
                    onClick={() => void methodPayment.bind('bitcoin')}
                  >
                    <WalletCards className="mr-2 size-4" />₿ Bitcoin
                  </Button>
                )}
                {methodPayment.availableMethods.includes('paypal') && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="rounded-full"
                    disabled={methodPayment.pendingAction !== null}
                    onClick={() => void methodPayment.bind('paypal')}
                  >
                    <Banknote className="mr-2 size-4" />
                    PayPal
                  </Button>
                )}
              </div>
              {bitcoinWalletChecking && (
                <Typography as="p" aria-live="polite" className="text-xs text-muted-foreground">
                  Checking your Bitcoin wallet…
                </Typography>
              )}
              {bitcoinWalletUnsupported && (
                <div
                  role="alert"
                  className="grid gap-1 rounded-xl border bg-card/60 p-4"
                  data-testid="order-payment-bitkit-unsupported"
                >
                  <Typography as="p" className="text-sm font-medium">
                    {BITCOIN_WALLET_UNSUPPORTED_TITLE}
                  </Typography>
                  <Typography as="p" className="text-xs text-muted-foreground">
                    {bitcoinWalletUnsupportedBody(methodPayment.availableMethods.includes('paypal'))}
                  </Typography>
                </div>
              )}
              {bitcoinWalletUnverified && (
                <div
                  role="alert"
                  className="grid gap-2 rounded-xl border bg-card/60 p-4"
                  data-testid="order-payment-bitkit-unverified"
                >
                  <Typography as="p" className="text-sm font-medium">
                    {BITCOIN_WALLET_UNVERIFIED_TITLE}
                  </Typography>
                  <Typography as="p" className="text-xs text-muted-foreground">
                    {bitcoinWalletUnverifiedBody(methodPayment.availableMethods.includes('paypal'))}
                  </Typography>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="w-fit rounded-full"
                    data-testid="order-payment-bitkit-unverified-recheck"
                    onClick={buyerWallet.recheck}
                  >
                    Check again
                  </Button>
                </div>
              )}
              {methodPayment.pendingAction === 'bind' && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" />
                  Setting up the payment…
                </div>
              )}
              <Button
                size="sm"
                variant="secondary"
                className="w-fit rounded-full"
                disabled={isReleasingHold || methodPayment.pendingAction !== null}
                onClick={() => void releaseUnboundHold()}
              >
                {isReleasingHold ? (
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                ) : (
                  <ArrowLeft className="mr-2 size-4" />
                )}
                Back
              </Button>
              {releaseHoldError && (
                <Typography as="p" role="alert" className="text-sm text-amber-300">
                  {releaseHoldError}
                </Typography>
              )}
            </>
          )}
        </div>
      )}

      {/* Bound bitcoin: the wallet instructions stay up only until the payment is seen. */}
      {usesMethodFlow && isBuyer && order.paymentMethod === 'bitcoin' && (
        <BuyerBitcoinPaymentProgress order={order} payment={payment} />
      )}

      {/* Bound paypal: hosted checkout; PayPal's verified notification pays
          the order automatically. The buyer report + seller confirmation
          remain as the fallback when no notification arrives. */}
      {usesMethodFlow && isBuyer && order.paymentMethod === 'paypal' && order.fiatCheckoutUrl && (
        <div className="grid gap-2">
          <Typography as="p" className="text-sm text-muted-foreground">
            {holderBoundCopy(order.holdExpiresAt)}
          </Typography>
          {order.paymentReportedAt ? (
            <Typography as="p" className="text-sm text-muted-foreground">
              You reported this payment{order.fiatTransactionRef ? ` (ref ${order.fiatTransactionRef})` : ''}. The order
              completes when PayPal&rsquo;s notification arrives or the seller confirms receipt in their PayPal account.
            </Typography>
          ) : (
            <>
              <Typography as="p" className="text-sm text-muted-foreground">
                Pay through PayPal — this page updates by itself once PayPal confirms the payment to the marketplace,
                usually within seconds. If it doesn&rsquo;t, you can report the payment here as a fallback and the
                seller confirms receipt.
              </Typography>
              <Typography as="p" className="text-xs text-muted-foreground">
                Use this only if automatic confirmation fails. The seller must verify your PayPal transaction ID before
                shipping.
              </Typography>
              <div className="flex flex-wrap items-center gap-2">
                <Button asChild size="sm" className="rounded-full">
                  <a href={order.fiatCheckoutUrl} target="_blank" rel="noopener noreferrer">
                    <Banknote className="mr-2 size-4" />
                    Open PayPal checkout
                  </a>
                </Button>
                <input
                  value={paypalTransactionRef}
                  onChange={(event) => setPaypalTransactionRef(event.target.value)}
                  placeholder="PayPal transaction ID (optional)"
                  className="h-9 max-w-56 rounded-md border bg-transparent px-3 text-sm"
                  aria-label="PayPal transaction ID"
                />
                <Button
                  size="sm"
                  variant="secondary"
                  className="rounded-full"
                  disabled={methodPayment.pendingAction !== null}
                  onClick={() => void methodPayment.markPaid(paypalTransactionRef)}
                >
                  {methodPayment.pendingAction === 'mark-paid' ? (
                    <LoaderCircle className="mr-2 size-4 animate-spin" />
                  ) : null}
                  I&rsquo;ve paid
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Seller side: the PayPal receipt confirmation is what pays the order. */}
      {usesMethodFlow && !isBuyer && order.paymentMethod === 'paypal' && (
        <div className="grid gap-2">
          {order.paymentReportedAt ? (
            <>
              <Typography as="p" className="text-sm text-muted-foreground">
                The buyer reported a PayPal payment
                {order.fiatTransactionRef ? ` (ref ${order.fiatTransactionRef})` : ''}. Check your PayPal account;
                confirming receipt marks this order paid.
              </Typography>
              <Button
                size="sm"
                className="w-fit rounded-full"
                disabled={methodPayment.pendingAction !== null}
                onClick={() => void methodPayment.confirmReceived()}
              >
                {methodPayment.pendingAction === 'confirm' ? (
                  <LoaderCircle className="mr-2 size-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-2 size-4" />
                )}
                Confirm payment received
              </Button>
            </>
          ) : (
            <Typography as="p" className="text-sm text-muted-foreground">
              Awaiting the buyer&rsquo;s PayPal payment. PayPal&rsquo;s notification usually completes the order
              automatically; if the buyer reports the payment instead, you will be asked to confirm receipt.
            </Typography>
          )}
        </div>
      )}

      {isLocksPaykit && isBuyer && isAwaiting && digitalLock && !locks.correlation && (
        <div className="grid gap-2">
          <Typography as="p" className="text-sm text-muted-foreground">
            Paykit delivers the Bitcoin payment request privately to your wallet. This app never holds wallet keys and
            never confirms a payment itself — the marketplace verifies the Locks entitlement server-side.
          </Typography>
          <Button className="w-fit rounded-full" disabled={locks.isStarting} onClick={() => void locks.start()}>
            {locks.isStarting ? (
              <LoaderCircle className="mr-2 size-4 animate-spin" />
            ) : (
              <WalletCards className="mr-2 size-4" />
            )}
            Request payment in your wallet
          </Button>
        </div>
      )}
      {isLocksPaykit && isBuyer && isAwaiting && digitalLock && locks.correlation && !locks.correlation.registered && (
        <div className="grid gap-2">
          <Typography as="p" className="text-sm text-muted-foreground">
            The payment request was created but its registration with the marketplace did not complete. Retry the
            registration — the same request is reused, nothing is charged twice.
          </Typography>
          <Button
            variant="secondary"
            className="w-fit rounded-full"
            disabled={locks.isStarting}
            onClick={() => void locks.start()}
          >
            Retry registration
          </Button>
        </div>
      )}
      {isLocksPaykit && isBuyer && isAwaiting && locks.correlation?.registered && (
        <div className="grid gap-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            Payment request sent. Check your wallet for the private Paykit request; this page updates once the
            marketplace independently verifies the payment.
          </div>
          {locks.pollExhausted && (
            <Button variant="secondary" size="sm" className="w-fit rounded-full" onClick={locks.resumePolling}>
              Keep checking
            </Button>
          )}
        </div>
      )}

      {/* Digital delivery after server-side confirmation. */}
      {isLocksPaykit && isBuyer && visibleStatus === 'confirmed' && locks.correlation && (
        <div className="grid gap-2 rounded-lg bg-brand/10 p-3">
          <div className="flex items-center gap-2 text-sm text-brand">
            <KeyRound className="size-4" />
            Digital delivery is ready: a short-lived Locks access credential unlocks the purchased content.
          </div>
          {locks.delivery ? (
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <CheckCircle2 className="size-4 text-brand" />
              <span>
                {locks.delivery.fileName} · {locks.delivery.byteSize} bytes · integrity verified
              </span>
              <Button asChild size="sm" variant="secondary" className="rounded-full">
                <a href={locks.delivery.objectUrl} download={locks.delivery.fileName}>
                  <Download className="mr-2 size-4" />
                  Save file
                </a>
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              className="w-fit rounded-full"
              disabled={locks.isUnlocking}
              onClick={() => void locks.unlock()}
            >
              {locks.isUnlocking ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : null}
              Unlock content
            </Button>
          )}
        </div>
      )}

      {locks.error && (
        <Typography as="p" role="alert" className="flex items-center gap-2 text-sm text-amber-300">
          <FileWarning className="size-4" />
          {locks.error}
        </Typography>
      )}
    </div>
  );
}

function BuyerBitcoinPaymentProgress({ order, payment }: { order: MarketplaceOrder; payment: MarketplacePayment }) {
  const progress = buyerBitcoinWalletCopy(order, payment);
  const confirmDeadline = order.paykitSellerConfirmationDeadline ?? order.holdExpiresAt;
  const nowMs = useNowMs(progress.kind === 'seen');
  const countdown = holdCountdownCopy(confirmDeadline, nowMs);
  // Manual review and refund copy are rendered by the card paragraphs above.
  if (progress.kind === 'refund' || progress.kind === 'review') return null;
  if (progress.kind === 'seen') {
    const awaitingSeller =
      order.paykitRequestState === 'detected' || order.paykitRequestState === 'awaiting_seller_confirmation';
    return (
      <div className="grid gap-2" data-testid="bitcoin-payment-seen">
        {awaitingSeller && (
          <>
            <Typography as="p" className="text-sm text-muted-foreground" data-testid="bitcoin-seller-confirms-by">
              {sellerConfirmsByCopy(confirmDeadline)}
              {countdown ? (
                <>
                  {' '}
                  <span className="font-medium text-foreground tabular-nums" data-testid="bitcoin-hold-countdown">
                    {countdown}
                  </span>
                </>
              ) : null}
            </Typography>
            <Typography as="p" className="text-sm text-muted-foreground" data-testid="bitcoin-seen-hold-copy">
              {PAYMENT_SEEN_HOLD_COPY}
            </Typography>
          </>
        )}
        <Typography as="p" className="text-sm text-muted-foreground">
          {progress.text}
        </Typography>
      </div>
    );
  }
  return (
    <div className="grid gap-2">
      <Typography as="p" className="text-sm text-muted-foreground">
        {holderBoundCopy(order.holdExpiresAt)}
      </Typography>
      {order.paykitDeliveryState === 'failed' ? (
        <Typography as="p" role="alert" className="text-sm text-amber-300" data-testid="paykit-delivery-failed">
          {PAYKIT_DELIVERY_FAILED_COPY}
        </Typography>
      ) : (
        <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="paykit-delivery-status">
          <LoaderCircle className="size-4 animate-spin" />
          {progress.text === BITCOIN_WALLET_SENT_COPY ? BITCOIN_WALLET_SENT_COPY : BITCOIN_WALLET_WAITING_COPY}
        </div>
      )}
    </div>
  );
}

function SellerBitcoinConfirmationReview({
  prompt,
  observation,
  deadline,
  form,
  isSubmitting,
  error,
  onConfirm,
}: {
  prompt: string;
  observation: MarketplaceOrder['paykitObservation'] | null;
  deadline?: string | null;
  form: UseFormReturn<SellerPaymentConfirmationForm, unknown, SellerPaymentConfirmationSubmission>;
  isSubmitting: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const nowMs = useNowMs(formatOrderInstant(deadline) !== null);
  const countdown = holdCountdownCopy(deadline, nowMs);
  return (
    <section
      className="grid gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4"
      aria-labelledby="bitcoin-review-title"
    >
      <Typography
        as="h3"
        id="bitcoin-review-title"
        className="font-semibold"
        data-testid="seller-bitcoin-confirm-prompt"
      >
        {prompt}
      </Typography>
      <Typography as="p" className="text-sm text-muted-foreground">
        Confirm these service-observed facts before attesting that you received the payment.
      </Typography>
      {observation && (
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <ReviewFact label="Transaction ID" value={observation.txid} />
          <ReviewFact label="Observed sats" value={observation.observedSats} />
          <ReviewFact label="Confirmations" value={observation.confirmations} />
          <ReviewFact label="Amount matched" value={formatBooleanFact(observation.amountMatched)} />
          <ReviewFact label="Payment disappeared" value={formatBooleanFact(observation.disappeared)} />
          <ReviewFact label="Observed at" value={formatOrderInstant(observation.observedAt)} />
          <div data-testid="seller-bitcoin-confirm-deadline">
            <dt className="text-muted-foreground">Confirm by</dt>
            <dd className="break-words">
              {formatOrderInstant(deadline) ?? 'Not provided'}
              {countdown ? (
                <>
                  {' · '}
                  <span className="font-medium text-foreground tabular-nums">{countdown}</span>
                </>
              ) : null}
            </dd>
          </div>
        </dl>
      )}
      <Controller
        control={form.control}
        name="reason"
        render={({ field, fieldState }) => (
          <label className="grid gap-1 text-sm" htmlFor="bitcoin-confirm-reason">
            Seller note (optional)
            <input
              {...field}
              id="bitcoin-confirm-reason"
              maxLength={500}
              aria-describedby="bitcoin-confirm-error"
              className="h-9 rounded-md border bg-transparent px-3"
            />
            {fieldState.error && <span className="text-amber-300">{fieldState.error.message}</span>}
          </label>
        )}
      />
      {error && (
        <Typography id="bitcoin-confirm-error" role="alert" className="text-sm text-amber-300">
          {error}
        </Typography>
      )}
      <Button className="w-fit rounded-full" disabled={isSubmitting} onClick={onConfirm}>
        {isSubmitting ? (
          <LoaderCircle className="mr-2 size-4 animate-spin" />
        ) : (
          <CheckCircle2 className="mr-2 size-4" />
        )}
        Confirm payment received
      </Button>
    </section>
  );
}

function SellerBitcoinResolutionReview({
  enteredAt,
  form,
  isSubmitting,
  error,
  onResolve,
  allowPaid = true,
}: {
  enteredAt?: string | null;
  form: UseFormReturn<SellerPaymentResolutionForm, unknown, SellerPaymentResolutionSubmission>;
  isSubmitting: boolean;
  error: string | null;
  onResolve: () => void;
  allowPaid?: boolean;
}) {
  const outcome = form.watch('outcome');
  const refundReference = form.watch('externalRefundReference') ?? '';
  const validRefundReference = /^[\x20-\x7E]{1,64}$/.test(refundReference);
  const canResolve =
    !isSubmitting && (allowPaid || outcome !== 'paid') && (outcome !== 'refunded' || validRefundReference);
  return (
    <section
      className="grid gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-4"
      aria-labelledby="bitcoin-resolution-title"
    >
      <Typography
        as="h3"
        id="bitcoin-resolution-title"
        className="font-semibold"
        data-testid="seller-bitcoin-resolve-prompt"
      >
        Resolve Bitcoin payment review
      </Typography>
      <Typography as="p" className="text-sm text-muted-foreground">
        This payment is held for manual review. Choose the server-validated outcome; the marketplace remains the
        authority.
      </Typography>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <ReviewFact label="Manual review entered" value={enteredAt ?? 'Not provided'} />
      </dl>
      <label className="grid gap-1 text-sm" htmlFor="bitcoin-resolution-outcome">
        Outcome
        <Controller
          control={form.control}
          name="outcome"
          render={({ field }) => (
            <select {...field} id="bitcoin-resolution-outcome" className="h-9 rounded-md border bg-background px-3">
              {allowPaid && <option value="paid">Paid</option>}
              <option value="refunded">Refunded</option>
              <option value="abandoned">Abandoned</option>
            </select>
          )}
        />
      </label>
      {outcome === 'refunded' && (
        <Controller
          control={form.control}
          name="externalRefundReference"
          render={({ field, fieldState }) => (
            <label className="grid gap-1 text-sm" htmlFor="bitcoin-refund-reference">
              External refund reference (required)
              <input
                {...field}
                id="bitcoin-refund-reference"
                maxLength={64}
                aria-describedby="bitcoin-resolution-reference-error bitcoin-resolution-error"
                aria-invalid={!validRefundReference}
                className="h-9 rounded-md border bg-transparent px-3"
                inputMode="text"
              />
              {fieldState.error && <span className="text-amber-300">{fieldState.error.message}</span>}
            </label>
          )}
        />
      )}
      <Controller
        control={form.control}
        name="reason"
        render={({ field, fieldState }) => (
          <label className="grid gap-1 text-sm" htmlFor="bitcoin-resolution-reason">
            Reason (optional)
            <input
              {...field}
              id="bitcoin-resolution-reason"
              maxLength={500}
              className="h-9 rounded-md border bg-transparent px-3"
            />
            {fieldState.error && <span className="text-amber-300">{fieldState.error.message}</span>}
          </label>
        )}
      />
      {outcome === 'refunded' && !validRefundReference && (
        <Typography id="bitcoin-resolution-reference-error" role="alert" className="text-sm text-amber-300">
          Enter a printable ASCII refund reference from 1 to 64 characters.
        </Typography>
      )}
      {error && (
        <Typography id="bitcoin-resolution-error" role="alert" className="text-sm text-amber-300">
          {error}
        </Typography>
      )}
      <Button className="w-fit rounded-full" disabled={!canResolve} onClick={onResolve}>
        {isSubmitting ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : null}
        Resolve payment
      </Button>
    </section>
  );
}

function ReviewFact({ label, value }: { label: string; value: string | number | boolean | null | undefined }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="break-all">{value === null || value === undefined ? 'Not provided' : value}</dd>
    </div>
  );
}

function formatBooleanFact(value: boolean | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value ? 'Yes' : 'No';
}
