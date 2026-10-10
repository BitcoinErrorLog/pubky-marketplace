'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Bitcoin, HandCoins, LoaderCircle, ShoppingCart } from 'lucide-react';
import { Controller, useWatch } from 'react-hook-form';
import { APP_ROUTES, getMarketplaceDropRoute, getMarketplaceListingRoute, MARKETPLACE_ROUTES } from '@/app/routes';
import { Button } from '@/atoms/Button/Button';
import { Card, CardContent } from '@/atoms/Card/Card';
import { Checkbox } from '@/atoms/Checkbox/Checkbox';
import { Container } from '@/atoms/Container/Container';
import { Heading } from '@/atoms/Heading/Heading';
import { Image } from '@/atoms/Image/Image';
import { Label } from '@/atoms/Label/Label';
import { Link } from '@/atoms/Link/Link';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/atoms/Select/Select';
import { Skeleton } from '@/atoms/Skeleton/Skeleton';
import { Typography } from '@/atoms/Typography/Typography';
import { withBasePath } from '@/config/base-path';
import {
  getCommerceAdapterMode,
  getPaykitServerApi,
  isDurableCommerceMode,
  isLocksPaykitCommerceMode,
} from '@/config/commerce';
import { MARKETPLACE_DELIVERY_ADDRESS_DISCLOSURE } from '@/config/commerce-copy';
import { CommerceController } from '@/controllers/commerce/commerce';
import { isMarketplaceAwardCheckoutEligible } from '@/core/services/marketplace/marketplace-projections';
import { useBuyerPaykitWallet } from '@/hooks/useBuyerPaykitWallet/useBuyerPaykitWallet';
import {
  groupMarketplaceCartItems,
  type MarketplaceCartItem,
  marketplaceCartShippingTotals,
  useMarketplaceCart,
} from '@/hooks/useMarketplaceCart/useMarketplaceCart';
import { useMarketplaceCheckout } from '@/hooks/useMarketplaceCheckout/useMarketplaceCheckout';
import { marketplaceCheckoutSchema } from '@/hooks/useMarketplaceCheckout/useMarketplaceCheckout.types';
import { useMarketplaceFirstMediaUrls } from '@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl';
import { useMarketplaceOfferCheckout } from '@/hooks/useMarketplaceOfferCheckout/useMarketplaceOfferCheckout';
import { useMarketplaceOffers } from '@/hooks/useMarketplaceOffers/useMarketplaceOffers';
import { useMarketplaceOrders } from '@/hooks/useMarketplaceOrders/useMarketplaceOrders';
import { useUsdtPaymentsAvailable } from '@/hooks/useUsdtPaymentsAvailable/useUsdtPaymentsAvailable';
import { Tether } from '@/icons';
import { buyerCheckoutProgressCopy } from '@/libs/commerce/bitcoin-buyer-status';
import { BITCOIN_PAYMENT_CODE_CHECKOUT_NOTE } from '@/libs/commerce/bitcoin-payment-code';
import {
  getMarketplaceCheckoutRoute,
  intersectPaymentMethods,
  readCheckoutHashOrderId,
} from '@/libs/commerce/checkout-phase';
import { DELIVERY_EMAIL_MAX_CHARS, DIGITAL_CHECKOUT_COPY, digitalCheckoutLineLabel } from '@/libs/commerce/digital';
import {
  marketplaceOfferCheckoutFailureMessage,
  marketplacePaymentMethodReasonMessage,
} from '@/libs/commerce/failure-messages';
import { formatCommerceMoney } from '@/libs/commerce/format';
import { LOCKS_MIXED_CHECKOUT_COPY, locksCheckoutRoute } from '@/libs/commerce/locks-payment';
import {
  BITCOIN_WALLET_UNSUPPORTED_TITLE,
  BITCOIN_WALLET_UNVERIFIED_TITLE,
  bitcoinWalletUnsupportedBody,
  bitcoinWalletUnsupportedPayReason,
  bitcoinWalletUnverifiedBody,
  bitcoinWalletUnverifiedPayReason,
} from '@/libs/commerce/paykit-wallet';
import { availablePaymentMethods, type PaymentMethodKind } from '@/libs/commerce/payment-methods';
import { formatUsdt } from '@/libs/commerce/payment-options';
import {
  isUsdPricedTotals,
  USDT_NETWORK_LABEL,
  USDT_WALLET_HINT,
  usdtParityMillionths,
} from '@/libs/commerce/usdt-buyer-status';
import { navigateTop } from '@/libs/navigation/navigate-top';
import { getDeployEnv } from '@/libs/runtime-config/runtime-config';
import type { CommerceListingModelSchema } from '@/models/commerce/commerce.schema';
import { ControlledInputField } from '@/molecules/ControlledInputField/ControlledInputField';
import { MarketplaceCheckoutSteps } from '@/molecules/Marketplace/MarketplaceCheckoutSteps';
import { MarketplacePaymentStatusBadge } from '@/molecules/Marketplace/MarketplacePaymentStatusBadge';
import { MarketplaceSellerLink } from '@/molecules/Marketplace/MarketplaceSellerLink';
import { MarketplaceAddressFields } from '@/molecules/MarketplaceAddressFields/MarketplaceAddressFields';
import { SettingsSectionContent } from '@/molecules/Settings/SettingsSectionContent/SettingsSectionContent';
import { ContentLayout } from '@/organisms/ContentLayout/ContentLayout';
import { MarketplaceCheckoutItem } from '@/organisms/Marketplace/MarketplaceCheckoutItem';
import { MarketplaceIndicativePrice } from '@/organisms/Marketplace/MarketplaceIndicativePrice';
import { MarketplaceOrderActions } from '@/organisms/Marketplace/MarketplaceOrderActions';
import { MarketplaceOrderReference } from '@/organisms/Marketplace/MarketplaceOrderReference';
import { MarketplacePaymentStatusCard } from '@/organisms/Marketplace/MarketplacePaymentStatusCard';
import { MarketplaceSectionNav } from '@/organisms/Marketplace/MarketplaceSectionNav';
import { MarketplaceSessionRequiredCard } from '@/organisms/Marketplace/MarketplaceSessionRequiredCard';
import type { MarketplaceOfferAward } from '@/services/marketplace/marketplace';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import { MarketplaceCartSkeleton } from './MarketplaceCart.skeleton';

type AwardPayOutcome = 'expired' | 'converted' | 'error' | 'success' | 'unavailable' | 'session';

const EMPTY_CHECKOUT_ITEMS: MarketplaceCartItem[] = [];

const CHECKOUT_RAILS = ['bitcoin', 'usdt', 'paypal'] as const;
type CheckoutRail = (typeof CHECKOUT_RAILS)[number];

// The sandbox simulates payments and can bind no real rail, so it never offers USDT.
const SANDBOX_CHECKOUT_RAILS = ['bitcoin', 'paypal'] as const;

const METHOD_COPY: Record<CheckoutRail, string> = {
  bitcoin: 'Bitcoin',
  usdt: 'USDT',
  paypal: 'PayPal',
};

function checkoutRails(methods: readonly PaymentMethodKind[]): CheckoutRail[] {
  return CHECKOUT_RAILS.filter((method) => methods.includes(method));
}

export function MarketplaceCheckout() {
  return <MarketplaceCartCheckout />;
}

function MarketplaceCartCheckout() {
  const searchParams = useSearchParams();
  const offerReference = searchParams.get('offer');
  const dropSeller = searchParams.get('seller');
  const dropId = searchParams.get('drop');
  const dropListingId = searchParams.get('listing');
  const isOfferCheckout = Boolean(offerReference);
  const isDropCheckout = Boolean(dropSeller && dropId && dropListingId);

  const cart = useMarketplaceCart();
  const offers = useMarketplaceOffers();
  const offerPay = useMarketplaceOfferCheckout();
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const [dropItem, setDropItem] = useState<MarketplaceCartItem | null>(null);
  const [dropLoadState, setDropLoadState] = useState<'idle' | 'loading' | 'ready' | 'missing'>(() =>
    dropSeller && dropListingId ? 'loading' : 'idle',
  );
  const [awardOutcome, setAwardOutcome] = useState<AwardPayOutcome | null>(null);
  const [awardErrorCode, setAwardErrorCode] = useState<string | null>(null);

  const offer = offers.offers.find((item) => item.id === offerReference || item.award?.id === offerReference);
  const award: MarketplaceOfferAward | undefined = offer?.award;
  const offerEligible = Boolean(
    offer &&
    award &&
    award.state === 'active' &&
    offer.buyerPubky === currentUserPubky &&
    isMarketplaceAwardCheckoutEligible(award),
  );

  useEffect(() => {
    if (!dropSeller || !dropListingId) {
      setDropItem(null);
      setDropLoadState('idle');
      return;
    }
    let active = true;
    setDropLoadState('loading');
    void (async () => {
      try {
        try {
          await CommerceController.getOrFetchListing(dropSeller, dropListingId);
        } catch {
          // Local Dexie may still have the listing after a homeserver miss.
        }
        const listing = await CommerceController.getListing(dropSeller, dropListingId);
        if (!active) return;
        const variant =
          listing?.record.variants.find((candidate) => candidate.enabled !== false) ?? listing?.record.variants[0];
        if (!listing || !variant) {
          setDropItem(null);
          setDropLoadState('missing');
          return;
        }
        setDropItem(dropCheckoutItem(listing, variant.id));
        setDropLoadState('ready');
      } catch {
        if (!active) return;
        setDropItem(null);
        setDropLoadState('missing');
      }
    })();
    return () => {
      active = false;
    };
  }, [dropSeller, dropListingId]);

  // An accepted offer settles only through the methods its accepted snapshot
  // published (the service authorizes award checkout from the same
  // snapshot), never from the listing as it is now.
  const awardSeller = offerEligible && award ? award.listing.sellerPubky : null;
  const awardFulfillmentMethods = award?.fulfillmentMethods;
  const awardFulfillment =
    awardSeller && awardFulfillmentMethods
      ? { sellerPubky: awardSeller, fulfillmentMethods: awardFulfillmentMethods }
      : null;

  const ordinaryItems = cart.ordinaryItems ?? cart.items;
  const checkoutItems = useMemo(() => {
    if (isOfferCheckout) return EMPTY_CHECKOUT_ITEMS;
    if (isDropCheckout) return dropItem ? [dropItem] : EMPTY_CHECKOUT_ITEMS;
    return ordinaryItems;
  }, [dropItem, isDropCheckout, isOfferCheckout, ordinaryItems]);
  const checkout = useMarketplaceCheckout(
    checkoutItems,
    isOfferCheckout || isDropCheckout ? async () => undefined : cart.clear,
    awardFulfillment,
  );
  const orders = useMarketplaceOrders();
  const adapterMode = getCommerceAdapterMode();
  const isSandbox = adapterMode === 'sandbox';
  const usdtPaymentsAvailable = useUsdtPaymentsAvailable(!isSandbox);
  const isStaging = getDeployEnv() === 'staging';
  const formValues = useWatch({ control: checkout.form.control });
  const formValid = marketplaceCheckoutSchema.safeParse(formValues).success;
  const displayGroups = useMemo(() => groupMarketplaceCartItems(checkoutItems), [checkoutItems]);
  const checkoutMediaUrls = useMarketplaceFirstMediaUrls(
    checkoutItems.map((item) => item.listing.record.media.filter(({ type }) => type === 'image').map(({ url }) => url)),
  );
  // The award renders as its own fulfillment section (no cart line cards).
  const fulfillmentGroups = awardSeller ? [{ sellerPubky: awardSeller, items: [], subtotals: [] }] : displayGroups;
  const shipping = marketplaceCartShippingTotals(displayGroups, (item) => checkout.fulfillmentForItem(item.id));
  // A pickup award pays the accepted merchandise only; its shipping is zero.
  const isPickupAward = Boolean(awardSeller && checkout.fulfillmentForSeller(awardSeller) === 'pickup');
  const lineMethods = [
    ...checkoutItems.map((item) => checkout.fulfillmentForItem(item.id)),
    ...(awardSeller ? [checkout.fulfillmentForSeller(awardSeller)] : []),
  ];
  const allPickup = lineMethods.length > 0 && lineMethods.every((method) => method === 'pickup');
  const allDigital = lineMethods.length > 0 && lineMethods.every((method) => method === 'digital');
  const itemSubtotals =
    isOfferCheckout && award
      ? [award.subtotal]
      : isDropCheckout
        ? displayGroups.flatMap((group) => group.subtotals)
        : cart.subtotals;
  const shippingTotals =
    isOfferCheckout && award
      ? [isPickupAward ? { ...award.shipping, amountMinor: 0 } : award.shipping]
      : shipping.totals;
  const totalSubtotals =
    isOfferCheckout && award
      ? [isPickupAward ? award.subtotal : award.merchandiseTotal]
      : [...itemSubtotals, ...shipping.totals].reduce<
          Array<{ amountMinor: number; currency: string; exponent: number }>
        >((totals, money) => {
          const existing = totals.find(
            (candidate) => candidate.currency === money.currency && candidate.exponent === money.exponent,
          );
          if (existing) existing.amountMinor += money.amountMinor;
          else totals.push({ ...money });
          return totals;
        }, []);
  const sessionExpired = Boolean(checkout.needsSession && checkout.sessionError);
  const approvalNeeded = isDurableCommerceMode(adapterMode) && (!checkout.hasMarketplaceSession || sessionExpired);
  const [hashOrderId, setHashOrderId] = useState<string | null>(null);
  const [payingOrderIds, setPayingOrderIds] = useState<string[]>([]);
  const [preferredMethod, setSelectedMethod] = useState<CheckoutRail | null>(null);
  const [loadedMethods, setLoadedMethods] = useState<{
    sellerKey: string;
    attempt: number;
    methods: PaymentMethodKind[] | null;
  } | null>(null);
  const [railAttempt, setRailAttempt] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const sellerKey =
    isOfferCheckout && award
      ? award.listing.sellerPubky
      : [...new Set(checkoutItems.map((item) => item.listing.record.ownerPubky))].join('|');
  // Rails loaded for an earlier seller set (or before the cart hydrated) are
  // still loading for this one, never "no payment method".
  const loadedForCart =
    sellerKey.length > 0 && loadedMethods?.sellerKey === sellerKey && loadedMethods.attempt === railAttempt
      ? loadedMethods
      : null;
  // A Locks checkout on upstream Paykit pays in Bitcoin from the order page,
  // whatever rails the seller configured, and binds no method here.
  const locksRoute = isOfferCheckout ? 'method' : locksCheckoutRoute(adapterMode, getPaykitServerApi(), checkoutItems);
  const isLocksCheckout = locksRoute === 'locks';
  // A failed config read says nothing about the seller's rails; sandbox offers every rail regardless.
  const railsFailed = loadedForCart !== null && loadedForCart.methods === null && !isSandbox && !isLocksCheckout;
  // After the service refuses a USDT bind for these sellers, USDT is no longer
  // offered for this browser session: Pay would only be refused again. The
  // toast already told the buyer why; the picker just stops offering it.
  const usdtRefusal = useCommerceStore((state) => state.usdtRefusals[sellerKey] ?? null);
  const loadedMethodsForCart = isLocksCheckout
    ? (['bitcoin'] satisfies PaymentMethodKind[])
    : loadedForCart === null
      ? null
      : (loadedForCart.methods ?? []);
  const sharedMethods =
    usdtRefusal && loadedMethodsForCart
      ? loadedMethodsForCart.filter((method) => method !== 'usdt')
      : loadedMethodsForCart;
  const usdtRefusedOnly =
    usdtRefusal !== null &&
    !isSandbox &&
    sharedMethods?.length === 0 &&
    loadedMethodsForCart?.includes('usdt') === true;
  // USDT is quoted at parity against a USD total, so it is offered only when every total is USD.
  // An accepted offer without a merchandise total is withheld, so it prices nothing here.
  const usdtOffered = totalSubtotals.every((money) => money !== undefined) && isUsdPricedTotals(totalSubtotals);
  const availableCheckoutMethods = checkoutRails(
    isSandbox ? SANDBOX_CHECKOUT_RAILS : (sharedMethods ?? []).filter((method) => method !== 'usdt' || usdtOffered),
  );
  const selectedMethod =
    preferredMethod && availableCheckoutMethods.includes(preferredMethod)
      ? preferredMethod
      : (availableCheckoutMethods[0] ?? null);
  const isMultiSeller = sellerKey.includes('|');
  const isPaying = isOfferCheckout ? offerPay.isSubmitting : checkout.isPaying;
  const listingRoute = award && getMarketplaceListingRoute(award.listing.sellerPubky, award.listing.listingId);
  const backHref =
    isDropCheckout && dropSeller && dropId ? getMarketplaceDropRoute(dropSeller, dropId) : MARKETPLACE_ROUTES.CART;
  const backLabel = isDropCheckout ? 'Back to drop' : 'Back to cart';

  useEffect(() => {
    const syncHash = () => setHashOrderId(readCheckoutHashOrderId(window.location.hash));
    syncHash();
    window.addEventListener('hashchange', syncHash);
    return () => window.removeEventListener('hashchange', syncHash);
  }, []);

  useEffect(() => {
    const sellers = sellerKey.length === 0 ? [] : sellerKey.split('|');
    if (sellers.length === 0) return;
    let active = true;
    void Promise.all(
      sellers.map(async (sellerPubky) => {
        try {
          return availablePaymentMethods(await CommerceController.getSellerPaymentConfig(sellerPubky), {
            usdtPaymentsAvailable,
          });
        } catch {
          return null;
        }
      }),
    ).then((results) => {
      if (!active) return;
      const sets = results.filter((set): set is PaymentMethodKind[] => set !== null);
      if (sets.length !== results.length) {
        setLoadedMethods({ sellerKey, attempt: railAttempt, methods: null });
        return;
      }
      const next = intersectPaymentMethods(sets);
      setLoadedMethods({ sellerKey, attempt: railAttempt, methods: next });
    });
    return () => {
      active = false;
    };
  }, [sellerKey, railAttempt, usdtPaymentsAvailable]);

  const targetPayingIds = [...new Set([...payingOrderIds, ...(hashOrderId ? [hashOrderId] : [])])];
  const focusedPaying = orders.orders.filter((view) => targetPayingIds.includes(view.order.id));
  const showPaying = targetPayingIds.length > 0;
  const allPaymentsConfirmed =
    targetPayingIds.length > 0 &&
    focusedPaying.length === targetPayingIds.length &&
    focusedPaying.every(({ payment }) => payment?.state === 'confirmed');
  const payingView = focusedPaying[0];
  const payingOrder = payingView?.order;
  const holdCopy = payingOrder ? buyerCheckoutProgressCopy(payingOrder, payingView.payment, nowMs) : null;

  useEffect(() => {
    if (!showPaying) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [showPaying]);

  // A Bitcoin payment request is delivered to the buyer's Paykit wallet;
  // without one, Pay cannot succeed, so it is gated before the attempt.
  const bitcoinSelected = !isSandbox && isDurableCommerceMode(adapterMode) && selectedMethod === 'bitcoin';
  const usdtSelected = !isSandbox && selectedMethod === 'usdt';
  const usdtMillionths = usdtSelected ? usdtParityMillionths(totalSubtotals) : null;
  const buyerWallet = useBuyerPaykitWallet(currentUserPubky ?? null, bitcoinSelected);
  const buyerWalletMissing = bitcoinSelected && buyerWallet.state === 'not_payable';
  const buyerWalletUnsupported = bitcoinSelected && buyerWallet.state === 'unsupported';
  const buyerWalletUnverified = bitcoinSelected && buyerWallet.state === 'unverified';
  const buyerWalletChecking = bitcoinSelected && buyerWallet.state === 'checking';
  const canPayWithPaypal = sharedMethods?.includes('paypal') ?? false;

  const canPay =
    !approvalNeeded &&
    formValid &&
    !checkout.hasFulfillmentConflict &&
    locksRoute !== 'mixed' &&
    checkout.isDigitalReady &&
    !isPaying &&
    !buyerWalletMissing &&
    !buyerWalletUnsupported &&
    !buyerWalletUnverified &&
    !buyerWalletChecking &&
    (!isOfferCheckout || offerEligible) &&
    (isSandbox || (sharedMethods !== null && sharedMethods.length > 0 && selectedMethod !== null));

  const checkoutPayDisabledReason = checkout.hasFulfillmentConflict
    ? "Some items can't be checked out together — see the note above."
    : !checkout.isDigitalReady
      ? checkout.digitalNotReadyItemIds.length > 0
        ? DIGITAL_CHECKOUT_COPY.payReasonNotReady
        : DIGITAL_CHECKOUT_COPY.payReasonLoading
      : buyerWalletMissing
        ? 'Connect Bitkit to pay with Bitcoin, or choose another payment method.'
        : buyerWalletUnsupported
          ? bitcoinWalletUnsupportedPayReason(canPayWithPaypal)
          : buyerWalletUnverified
            ? bitcoinWalletUnverifiedPayReason(canPayWithPaypal)
            : buyerWalletChecking
              ? 'Pay unlocks once your Bitcoin wallet is checked.'
              : railsFailed
                ? 'Pay unlocks once payment options load.'
                : usdtRefusedOnly
                  ? 'Pay unlocks once a payment method is available.'
                  : sharedMethods && sharedMethods.length === 0 && !isSandbox
                    ? isMultiSeller
                      ? 'Choose sellers that share a payment method.'
                      : 'Pay unlocks once this seller sets up a payment method.'
                    : 'Fill in delivery details, accept the guarantee, and choose a payment method to pay.';
  const payDisabledReason = locksRoute === 'mixed' ? LOCKS_MIXED_CHECKOUT_COPY : checkoutPayDisabledReason;

  const removeAwardLine = async () => {
    const line = cart.awardItems.find((item) => item.awardId === award?.id);
    if (line) await cart.remove(line.listingId, line.variantId, line.awardId ?? undefined, false);
  };

  const payOffer = async () => {
    if (!offer || !award || !offerEligible) return;
    const method = isSandbox && selectedMethod === null ? null : selectedMethod;
    const values = checkout.form.getValues();
    if (!marketplaceCheckoutSchema.safeParse(values).success) return;
    const result = await offerPay.submit(
      offer,
      isPickupAward
        ? null
        : {
            name: values.name,
            line1: values.line1,
            line2: values.line2,
            city: values.city,
            region: values.region,
            postalCode: values.postalCode,
            countryCode: values.countryCode,
          },
      method,
      () => void pay(),
    );
    if (result.ok) {
      await removeAwardLine();
      await offers.refresh();
      if (!isPickupAward) await checkout.rememberAddress();
      if (result.boundOrder?.fiatCheckoutUrl) {
        navigateTop(result.boundOrder.fiatCheckoutUrl);
        return;
      }
      if (result.orderId) {
        setPayingOrderIds([result.orderId]);
        window.history.replaceState(null, '', withBasePath(getMarketplaceCheckoutRoute(result.orderId)));
        setHashOrderId(result.orderId);
        await orders.refresh();
        return;
      }
      setAwardOutcome('success');
      return;
    }
    if (result.code === 'AWARD_UNAVAILABLE') {
      await removeAwardLine();
      await offers.refresh();
      setAwardOutcome('unavailable');
    } else if (result.code === 'SESSION_REQUIRED') {
      setAwardOutcome('session');
    } else if (result.code === 'AWARD_EXPIRED') {
      await removeAwardLine();
      await offers.refresh();
      setAwardOutcome('expired');
    } else if (result.code === 'AWARD_ALREADY_CONVERTED' || result.code === 'REVISION_CONFLICT') {
      await removeAwardLine();
      await offers.refresh();
      setAwardOutcome('converted');
    } else {
      setAwardErrorCode(result.code);
      setAwardOutcome('error');
    }
  };

  const pay = async () => {
    if (isOfferCheckout) {
      await payOffer();
      return;
    }
    // Sandbox creates its simulated payment with the order; it cannot bind a
    // real rail. A Locks checkout binds none either (`locksCheckoutRoute`).
    const method = isSandbox || isLocksCheckout ? null : selectedMethod;
    const result = await checkout.pay(method, () => void pay());
    if (!result.ok) return;
    setPayingOrderIds(result.orderIds);
    if (result.orderIds[0]) {
      window.history.replaceState(null, '', withBasePath(getMarketplaceCheckoutRoute(result.orderIds[0])));
      setHashOrderId(result.orderIds[0]);
    }
    const fiatBound = result.boundOrders.filter((order) => order.fiatCheckoutUrl);
    if (fiatBound.length === 1 && fiatBound[0].fiatCheckoutUrl) {
      navigateTop(fiatBound[0].fiatCheckoutUrl);
      return;
    }
    await orders.refresh();
  };

  return (
    <ContentLayout
      showLeftSidebar={false}
      showRightSidebar={false}
      showLeftMobileButton={false}
      showRightMobileButton={false}
      className="pb-28"
    >
      <Container
        overrideDefaults
        className="flex w-full flex-col gap-6"
        data-surface="marketplace-checkout"
        data-testid="marketplace-checkout"
      >
        <MarketplaceSectionNav />
        <div className="grid items-end gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
          <div className="min-w-0">
            <Heading level={1} size="xl" className="text-4xl sm:text-6xl">
              Checkout
            </Heading>
            <Typography as="p" className="mt-2 text-muted-foreground">
              {showPaying
                ? 'Review your items and payment status.'
                : isOfferCheckout && offerEligible && award
                  ? `Checkout window closes ${new Date(award.convertBy).toLocaleString('en-US')}`
                  : `Enter delivery details and choose how to pay.${
                      checkout.orderCount > 1 ? ' Each order requires a separate payment.' : ''
                    }`}
            </Typography>
          </div>
          <div className="justify-self-end">
            <MarketplaceCheckoutSteps
              currentStep={showPaying || awardOutcome === 'success' ? 3 : 2}
              completed={allPaymentsConfirmed}
            />
          </div>
        </div>

        {awardOutcome && isOfferCheckout ? (
          <MarketplaceAwardOutcome
            outcome={awardOutcome}
            award={award}
            errorCode={awardErrorCode}
            listingRoute={listingRoute}
            onRetry={() => setAwardOutcome(null)}
          />
        ) : showPaying ? (
          <div className="grid gap-4" data-testid="marketplace-checkout-paying">
            {holdCopy &&
              !allPaymentsConfirmed &&
              !(
                payingOrder?.state === 'pending_payment' &&
                payingOrder.paymentMethod === 'paypal' &&
                payingView?.payment?.state === 'awaiting_entitlement'
              ) && (
                <Typography as="p" className="rounded-md bg-card/60 px-4 py-3 text-sm">
                  {holdCopy}
                </Typography>
              )}
            {orders.isLoading && focusedPaying.length === 0 ? (
              <Skeleton className="h-40 w-full" aria-label="Loading checkout" />
            ) : focusedPaying.length === 0 ? (
              <Card className="rounded-md p-0">
                <CardContent className="grid gap-3 p-6">
                  <Typography as="p">This checkout is no longer waiting for payment.</Typography>
                  <Button asChild className="w-fit rounded-full">
                    <Link href={MARKETPLACE_ROUTES.ORDERS} overrideDefaults>
                      View orders
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            ) : (
              focusedPaying.map(({ order, payment }) => (
                <Card className="rounded-md p-0" key={order.id}>
                  <CardContent className="grid min-w-0 gap-4 p-6">
                    <MarketplaceOrderReference
                      order={order}
                      isBuyer
                      status={
                        payment?.state === 'confirmed' && order.paymentMethod !== 'usdt' ? (
                          <MarketplacePaymentStatusBadge order={order} payment={payment} />
                        ) : undefined
                      }
                    />
                    {order.lines.map((line, index) => (
                      <MarketplaceCheckoutItem
                        key={`${line.listingAggregateId}:${line.variantId ?? index}`}
                        line={line}
                      />
                    ))}
                    {(payment?.state !== 'confirmed' || order.paymentMethod === 'usdt') && (
                      <MarketplacePaymentStatusCard
                        order={order}
                        payment={payment}
                        isBuyer
                        adapterMode={adapterMode}
                        advancePayment={orders.advancePayment}
                        onPaymentChanged={orders.refresh}
                        showStagingNotice={false}
                        checkoutActions={
                          order.state === 'pending_payment' && order.paymentMethod === 'paypal' ? (
                            <MarketplaceOrderActions
                              order={order}
                              isBuyer
                              canEditReview={false}
                              cancelButtonSize="default"
                              actOnOrder={orders.actOnOrder}
                              onChanged={orders.refresh}
                            />
                          ) : undefined
                        }
                      />
                    )}
                  </CardContent>
                </Card>
              ))
            )}
            {isStaging && !isSandbox && (
              <Typography
                as="p"
                role="note"
                className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
              >
                Staging environment. No real funds move.
              </Typography>
            )}
          </div>
        ) : cart.isLoading || (isOfferCheckout && offers.isLoading) || dropLoadState === 'loading' ? (
          <MarketplaceCartSkeleton />
        ) : isOfferCheckout && !offerEligible ? (
          <Card className="rounded-md p-0">
            <CardContent className="grid gap-3 p-6">
              <Heading level={2} size="lg">
                Checkout unavailable
              </Heading>
              <Typography as="p">Checkout for this offer is unavailable right now.</Typography>
              <Link href={APP_ROUTES.MARKETPLACE} overrideDefaults>
                Browse the marketplace
              </Link>
            </CardContent>
          </Card>
        ) : dropLoadState === 'missing' || (!isOfferCheckout && checkoutItems.length === 0) ? (
          <div className="flex min-h-64 flex-col items-center justify-center rounded-md text-center">
            <Heading level={2} size="md">
              Nothing to check out
            </Heading>
            <Typography as="p" className="mt-2 text-muted-foreground">
              {isDropCheckout ? 'This drop listing could not be loaded.' : 'Add items in your cart first.'}
            </Typography>
            <Button asChild className="mt-6 rounded-full">
              <Link href={backHref} overrideDefaults>
                {backLabel}
              </Link>
            </Button>
          </div>
        ) : (
          <div className="grid gap-6 lg:grid-cols-[1fr_420px]">
            <div className="flex flex-col gap-6 lg:col-start-1 lg:row-start-1">
              {isOfferCheckout && award ? <MarketplaceAwardTerms award={award} /> : null}
              {fulfillmentGroups.map((group) => {
                const fulfillmentOptions = checkout.fulfillmentOptionsForSeller(group.sellerPubky);
                const fulfillment = checkout.fulfillmentForSeller(group.sellerPubky);
                const isPickupGroup = fulfillment === 'pickup';
                const isPickupCapabilityLoading = checkout.isPickupCapabilityLoadingForSeller(group.sellerPubky);
                // A shipping-only award has no fulfillment step to show.
                const hasFulfillmentStep =
                  isPickupCapabilityLoading || isPickupGroup || fulfillmentOptions.length !== 1;
                if (group.items.length === 0 && !hasFulfillmentStep) return null;
                // The award group has no cart lines and always ships or is picked up.
                const shipsOrPicksUp =
                  group.items.length === 0 ||
                  group.items.some((item) => checkout.fulfillmentForItem(item.id) !== 'digital');
                return (
                  <section
                    key={group.sellerPubky}
                    className="grid gap-3"
                    aria-label={`Items from ${group.sellerPubky}`}
                    data-surface={isPickupGroup ? 'checkout-pickup-group' : undefined}
                  >
                    {isPickupCapabilityLoading ? (
                      <Skeleton
                        className="h-16 w-full"
                        data-testid="pickup-capability-skeleton"
                        aria-label="Checking pickup availability"
                      />
                    ) : null}
                    {!isPickupCapabilityLoading && fulfillmentOptions.length > 1 && fulfillment && (
                      <div className="flex flex-wrap items-center gap-3 rounded-md bg-card/60 px-4 py-3">
                        <Label htmlFor={`fulfillment-${group.sellerPubky}`}>Fulfillment</Label>
                        <Select
                          value={fulfillment}
                          onValueChange={(value) => {
                            if (value === 'shipping' || value === 'pickup') {
                              checkout.setFulfillmentChoice(group.sellerPubky, value);
                            }
                          }}
                        >
                          <SelectTrigger
                            theme="secondary"
                            id={`fulfillment-${group.sellerPubky}`}
                            className="w-56"
                            aria-label={`Fulfillment for items from ${group.sellerPubky}`}
                          >
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {fulfillmentOptions.includes('shipping') && (
                              <SelectItem value="shipping">Ship it</SelectItem>
                            )}
                            {fulfillmentOptions.includes('pickup') && (
                              <SelectItem value="pickup">Local pickup</SelectItem>
                            )}
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    {!isPickupCapabilityLoading && isPickupGroup && (
                      <Typography as="p" className="rounded-md bg-card/60 px-4 py-3 text-sm text-muted-foreground">
                        Local pickup — no delivery address or shipping for these items. The meeting point is revealed
                        after payment confirms.
                      </Typography>
                    )}
                    {!isPickupCapabilityLoading &&
                      !checkout.isDigitalCapabilityLoading &&
                      shipsOrPicksUp &&
                      fulfillmentOptions.length === 0 && (
                        <Typography
                          as="p"
                          role="alert"
                          className="rounded-md border border-destructive/40 px-4 py-3 text-sm"
                        >
                          {isOfferCheckout
                            ? 'This listing is local pickup only, and pickup is unavailable on this deployment right now.'
                            : "These items can't be checked out together: they don't share a fulfillment method this deployment supports (one ships while another is pickup-only). Remove one in the cart to continue."}
                        </Typography>
                      )}
                    {group.items.map((item) => {
                      const variant = item.listing.record.variants.find(({ id }) => id === item.variantId);
                      const price =
                        variant?.priceOverride ??
                        (item.listing.record.sale.format === 'fixed_price' ? item.listing.record.sale.unitPrice : null);
                      const listingRoute = getMarketplaceListingRoute(
                        item.listing.record.ownerPubky,
                        item.listing.listing_id,
                      );
                      const coverUrl = checkoutMediaUrls[checkoutItems.findIndex(({ id }) => id === item.id)] ?? null;
                      const variantLabel = variant ? Object.values(variant.options).filter(Boolean).join(' · ') : '';
                      return (
                        <Card key={item.id} className="rounded-md p-0">
                          <CardContent className="flex flex-wrap items-center gap-4 p-6">
                            <Link href={listingRoute} overrideDefaults aria-label={`View ${item.listing.record.title}`}>
                              <div className="relative flex size-20 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-brand/15">
                                <ShoppingCart className="size-7 text-brand" />
                                {coverUrl && (
                                  <Image
                                    src={coverUrl}
                                    alt={item.listing.record.title}
                                    fill
                                    sizes="80px"
                                    className="absolute inset-0 object-cover object-center"
                                  />
                                )}
                              </div>
                            </Link>
                            <div className="min-w-0 flex-1">
                              <Typography as="h2" className="truncate font-semibold">
                                <Link href={listingRoute} overrideDefaults className="hover:text-brand">
                                  {item.listing.record.title}
                                </Link>
                              </Typography>
                              <MarketplaceSellerLink sellerPubky={group.sellerPubky} />
                              {(variantLabel || item.quantity > 1) && (
                                <Typography as="p" className="text-sm text-muted-foreground">
                                  {variantLabel}
                                  {variantLabel && item.quantity > 1 ? ' · ' : ''}
                                  {item.quantity > 1 ? `Quantity ${item.quantity}` : ''}
                                </Typography>
                              )}
                              {price && (
                                <Typography as="p" className="mt-1 font-bold text-brand">
                                  {formatCommerceMoney(price)}{' '}
                                  {!usdtSelected && (
                                    <MarketplaceIndicativePrice money={price} className="font-normal" />
                                  )}
                                </Typography>
                              )}
                              {checkout.fulfillmentForItem(item.id) === 'digital' && (
                                <Typography
                                  as="p"
                                  role={checkout.digitalKindForItem(item.id) === null ? 'alert' : undefined}
                                  className="mt-1 text-sm text-muted-foreground"
                                  data-testid="checkout-digital-line"
                                >
                                  {digitalCheckoutLineLabel(checkout.digitalKindForItem(item.id))}
                                </Typography>
                              )}
                            </div>
                            {checkout.canChooseDigitalForItem(item.id) && (
                              <Select
                                value={checkout.fulfillmentForItem(item.id) === 'digital' ? 'digital' : 'physical'}
                                onValueChange={(value) => checkout.setDigitalChoice(item.id, value === 'digital')}
                              >
                                <SelectTrigger
                                  theme="secondary"
                                  className="w-full shrink-0 sm:w-44"
                                  aria-label={`Delivery for ${item.listing.record.title}`}
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="physical">{DIGITAL_CHECKOUT_COPY.physicalOption}</SelectItem>
                                  <SelectItem value="digital">{DIGITAL_CHECKOUT_COPY.digitalOption}</SelectItem>
                                </SelectContent>
                              </Select>
                            )}
                          </CardContent>
                        </Card>
                      );
                    })}
                  </section>
                );
              })}

              {approvalNeeded && <MarketplaceSessionRequiredCard />}

              {checkout.requiresDeliveryAddress && (
                <section className="grid min-w-0 gap-6 rounded-md bg-card p-6 shadow-lg" aria-label="Delivery address">
                  <Heading level={2} size="sm" className="text-xl font-semibold">
                    Delivery address
                  </Heading>
                  <SettingsSectionContent>
                    {checkout.addresses.length > 0 && (
                      <div className="grid gap-2">
                        <div className="flex items-center justify-between gap-2">
                          <Label htmlFor="checkout-address-picker">Saved addresses</Label>
                          <Link
                            href={MARKETPLACE_ROUTES.SETTINGS_ADDRESSES}
                            overrideDefaults
                            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                          >
                            Manage
                          </Link>
                        </div>
                        <Select
                          value={checkout.selectedAddressId ?? 'new'}
                          onValueChange={(value) => checkout.selectAddress(value === 'new' ? null : value)}
                        >
                          <SelectTrigger theme="secondary" id="checkout-address-picker" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {checkout.addresses.map((address) => (
                              <SelectItem key={address.id} value={address.id}>
                                {address.label} · {address.city}
                                {address.is_default ? ' (default)' : ''}
                              </SelectItem>
                            ))}
                            <SelectItem value="new">New address</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                    <ControlledInputField name="name" control={checkout.form.control} label="Full name" />
                    <MarketplaceAddressFields control={checkout.form.control} setValue={checkout.form.setValue} />
                    <div className="grid gap-4">
                      <Typography as="p" className="text-sm text-muted-foreground">
                        {MARKETPLACE_DELIVERY_ADDRESS_DISCLOSURE}
                      </Typography>
                      {checkout.selectedAddressId === null && (
                        <div className="grid gap-3">
                          <Controller
                            name="saveAddress"
                            control={checkout.form.control}
                            render={({ field }) => (
                              <Label className="items-start gap-3">
                                <Checkbox checked={field.value} onCheckedChange={field.onChange} />
                                <span>Save this address on this device for next time</span>
                              </Label>
                            )}
                          />
                          {checkout.form.watch('saveAddress') && (
                            <ControlledInputField
                              name="saveLabel"
                              control={checkout.form.control}
                              label="Label"
                              placeholder="Home"
                            />
                          )}
                        </div>
                      )}
                    </div>
                  </SettingsSectionContent>
                </section>
              )}

              {checkout.requiresDeliveryEmail && (
                <section
                  className="grid min-w-0 gap-6 rounded-md bg-card p-6 shadow-lg"
                  aria-label={DIGITAL_CHECKOUT_COPY.emailHeading}
                  data-surface="checkout-delivery-email"
                >
                  <Heading level={2} size="sm" className="text-xl font-semibold">
                    {DIGITAL_CHECKOUT_COPY.emailHeading}
                  </Heading>
                  <Typography as="p" className="rounded-md bg-card/60 px-4 py-3 text-sm text-muted-foreground">
                    {DIGITAL_CHECKOUT_COPY.emailDisclosure}
                  </Typography>
                  <SettingsSectionContent>
                    <ControlledInputField
                      name="deliveryEmail"
                      control={checkout.form.control}
                      label="Email"
                      placeholder="you@example.com"
                      maxLength={DELIVERY_EMAIL_MAX_CHARS}
                    />
                  </SettingsSectionContent>
                </section>
              )}
            </div>

            <div className="grid min-w-0 gap-4 lg:col-start-2 lg:row-start-1 lg:self-start">
              <Card className="h-fit rounded-md p-0 shadow-lg" data-testid="marketplace-checkout-summary">
                <CardContent className="grid min-w-0 gap-6 p-6">
                  <section className="grid min-w-0 gap-6" aria-label="Order summary">
                    <Heading level={2} size="sm" className="text-xl font-semibold">
                      Order summary
                    </Heading>
                    <SettingsSectionContent>
                      <div className="grid gap-6">
                        <div className="flex justify-between">
                          <Typography as="span">Items</Typography>
                          <div className="flex flex-col items-end">
                            {itemSubtotals.map((subtotal) => (
                              <Typography
                                key={`${subtotal.currency}:${subtotal.exponent}`}
                                as="span"
                                className="flex flex-col items-end font-bold"
                              >
                                {formatCommerceMoney(subtotal)}
                                {!usdtSelected && (
                                  <MarketplaceIndicativePrice money={subtotal} className="font-normal" />
                                )}
                              </Typography>
                            ))}
                          </div>
                        </div>
                        <hr className="m-0 border-border" />
                        <div className="grid gap-1">
                          <div className="flex justify-between">
                            <Typography as="span" className="text-foreground">
                              Shipping
                            </Typography>
                            {shippingTotals.length > 0 && (
                              <div className="flex flex-col items-end">
                                {shippingTotals.map((subtotal) => (
                                  <Typography
                                    key={`${subtotal.currency}:${subtotal.exponent}`}
                                    as="span"
                                    className="flex flex-col items-end font-bold"
                                  >
                                    {formatCommerceMoney(subtotal)}
                                    {!usdtSelected && (
                                      <MarketplaceIndicativePrice money={subtotal} className="font-normal" />
                                    )}
                                  </Typography>
                                ))}
                              </div>
                            )}
                          </div>
                          {(shipping.hasCalculatedShipping ||
                            shippingTotals.length === 0 ||
                            allPickup ||
                            allDigital) && (
                            <Typography as="p" className="text-xs text-muted-foreground">
                              {shipping.hasCalculatedShipping || checkout.requiresDeliveryAddress
                                ? 'Shipping is calculated at checkout.'
                                : allPickup
                                  ? 'No shipping — pickup is arranged with the seller after payment.'
                                  : allDigital
                                    ? DIGITAL_CHECKOUT_COPY.noShippingDigital
                                    : DIGITAL_CHECKOUT_COPY.noShippingMixed}
                            </Typography>
                          )}
                        </div>
                        <hr className="m-0 border-border" />
                        <div className="flex justify-between">
                          <Typography as="span" className="font-semibold">
                            {isOfferCheckout ? 'Merchandise total' : 'Total'}
                          </Typography>
                          <div className="flex flex-col items-end">
                            {totalSubtotals.map((subtotal) => (
                              <Typography
                                key={`${subtotal.currency}:${subtotal.exponent}`}
                                as="span"
                                className="flex flex-col items-end font-bold"
                              >
                                {formatCommerceMoney(subtotal)}
                                {!usdtSelected && (
                                  <MarketplaceIndicativePrice money={subtotal} className="font-normal" />
                                )}
                              </Typography>
                            ))}
                          </div>
                        </div>
                      </div>
                    </SettingsSectionContent>
                  </section>
                  <section
                    className="grid min-w-0 gap-6"
                    aria-label="Payment method"
                    data-testid="marketplace-checkout-payment-method"
                  >
                    <Heading level={2} size="sm" className="text-xl font-semibold">
                      Payment method
                    </Heading>
                    <SettingsSectionContent>
                      {railsFailed ? (
                        <div role="alert" className="flex flex-wrap items-center gap-3">
                          <Typography as="p" className="text-sm text-muted-foreground">
                            Couldn&apos;t load payment options.
                          </Typography>
                          <Button
                            type="button"
                            size="sm"
                            variant="secondary"
                            className="rounded-full"
                            data-testid="marketplace-checkout-methods-retry"
                            onClick={() => setRailAttempt((attempt) => attempt + 1)}
                          >
                            Retry
                          </Button>
                        </div>
                      ) : sharedMethods === null ? (
                        <Skeleton className="h-11 w-full" aria-label="Loading payment methods" />
                      ) : sharedMethods.length === 0 && !isSandbox ? (
                        <Typography as="p" role="alert" className="text-sm text-muted-foreground">
                          {usdtRefusedOnly && usdtRefusal
                            ? marketplacePaymentMethodReasonMessage(usdtRefusal, 'usdt')
                            : isMultiSeller
                              ? 'These sellers do not share a payment method, so Pay stays disabled. Remove a seller in the cart or ask them to add a shared rail.'
                              : "This seller hasn't set up a payment method this cart can use, so Pay stays disabled. Message the seller to ask them to add one."}
                        </Typography>
                      ) : (
                        <div className="grid grid-cols-2 gap-3" role="group" aria-label="Payment method">
                          {availableCheckoutMethods.map((method) => (
                            <Button
                              key={method}
                              type="button"
                              variant={selectedMethod === method ? 'default' : 'secondary'}
                              className="h-20 w-full gap-3 rounded-md px-4 text-base"
                              aria-pressed={selectedMethod === method}
                              data-testid={`marketplace-checkout-method-${method}`}
                              onClick={() => setSelectedMethod(method)}
                            >
                              {method === 'bitcoin' && <Bitcoin className="size-6" aria-hidden="true" />}
                              {method === 'usdt' && <Tether className="size-6" aria-hidden="true" />}
                              {method === 'paypal' && <HandCoins className="size-6" aria-hidden="true" />}
                              {METHOD_COPY[method]}
                            </Button>
                          ))}
                        </div>
                      )}
                      {bitcoinSelected && (
                        <Typography
                          as="p"
                          className="text-xs text-muted-foreground"
                          data-testid="marketplace-checkout-bitcoin-amount-note"
                        >
                          {BITCOIN_PAYMENT_CODE_CHECKOUT_NOTE}
                        </Typography>
                      )}
                      {usdtMillionths !== null && (
                        <div className="grid gap-1" data-testid="marketplace-checkout-usdt-amount-note">
                          <Typography
                            as="p"
                            className="text-sm font-medium"
                            data-testid="marketplace-checkout-usdt-amount"
                          >
                            {formatUsdt(usdtMillionths)} · {USDT_NETWORK_LABEL} · pay with Bitkit
                          </Typography>
                          <Typography as="p" className="text-xs text-muted-foreground">
                            {USDT_WALLET_HINT}
                          </Typography>
                        </div>
                      )}
                      {buyerWalletChecking && (
                        <Typography as="p" aria-live="polite" className="text-xs text-muted-foreground">
                          Checking your Bitcoin wallet…
                        </Typography>
                      )}
                      {buyerWalletMissing && (
                        <div
                          role="alert"
                          className="grid gap-2 rounded-md border bg-card/60 p-6"
                          data-testid="marketplace-checkout-bitkit-required"
                        >
                          <Typography as="p" className="text-sm font-medium">
                            Connect Bitkit to pay with Bitcoin
                          </Typography>
                          <Typography as="p" className="text-xs text-muted-foreground">
                            Bitcoin payments arrive in your Paykit wallet as a payment request. This account has no
                            Paykit wallet that can receive one yet. Connect Bitkit to this Pubky account, then check
                            again.
                            {canPayWithPaypal ? ' You can also pay with PayPal.' : ''}
                          </Typography>
                          <div>
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              className="rounded-full"
                              data-testid="marketplace-checkout-bitkit-recheck"
                              onClick={buyerWallet.recheck}
                            >
                              Check again
                            </Button>
                          </div>
                        </div>
                      )}
                      {buyerWalletUnsupported && (
                        <div
                          role="alert"
                          className="grid gap-2 rounded-xl border bg-card/60 p-4"
                          data-testid="marketplace-checkout-bitkit-unsupported"
                        >
                          <Typography as="p" className="text-sm font-medium">
                            {BITCOIN_WALLET_UNSUPPORTED_TITLE}
                          </Typography>
                          <Typography as="p" className="text-xs text-muted-foreground">
                            {bitcoinWalletUnsupportedBody(canPayWithPaypal)}
                          </Typography>
                        </div>
                      )}
                      {buyerWalletUnverified && (
                        <div
                          role="alert"
                          className="grid gap-2 rounded-xl border bg-card/60 p-4"
                          data-testid="marketplace-checkout-bitkit-unverified"
                        >
                          <Typography as="p" className="text-sm font-medium">
                            {BITCOIN_WALLET_UNVERIFIED_TITLE}
                          </Typography>
                          <Typography as="p" className="text-xs text-muted-foreground">
                            {bitcoinWalletUnverifiedBody(canPayWithPaypal)}
                          </Typography>
                          <div>
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              className="rounded-full"
                              data-testid="marketplace-checkout-bitkit-unverified-recheck"
                              onClick={buyerWallet.recheck}
                            >
                              Check again
                            </Button>
                          </div>
                        </div>
                      )}
                      <div className="grid gap-3" data-testid="marketplace-checkout-guarantee">
                        {allPickup && (
                          <div className="rounded-md bg-card/60 p-6">
                            <Typography as="p" className="text-sm font-medium">
                              Local pickup
                            </Typography>
                            <Typography as="p" className="mt-1 text-xs text-muted-foreground">
                              No delivery address is needed — every item here is collected in person. The seller&apos;s
                              meeting point is revealed as soon as your payment confirms.
                            </Typography>
                          </div>
                        )}
                        <Controller
                          name="acceptsGuarantee"
                          control={checkout.form.control}
                          render={({ field, fieldState }) => (
                            <div className="grid gap-2">
                              <Label className="items-start gap-3">
                                <Checkbox
                                  checked={field.value}
                                  onCheckedChange={field.onChange}
                                  onBlur={field.onBlur}
                                  aria-invalid={fieldState.error ? true : undefined}
                                />
                                <span>
                                  {isSandbox
                                    ? 'I accept sandbox guarantee policy v1. This is not legal escrow and moves no real funds.'
                                    : isLocksPaykitCommerceMode(adapterMode)
                                      ? 'I accept guarantee policy v1. This is not legal escrow — payment goes from your wallet directly to the seller, and this marketplace never holds funds.'
                                      : 'I accept guarantee policy v1. This is not legal escrow, and no payment rails are live in this deployment — no real funds move.'}
                                </span>
                              </Label>
                              {fieldState.error && (
                                <Typography as="p" role="alert" className="text-sm text-destructive">
                                  {fieldState.error.message}
                                </Typography>
                              )}
                            </div>
                          )}
                        />
                      </div>
                      {checkout.hasInstantDigitalLine && (
                        <Typography
                          as="p"
                          className="text-xs text-muted-foreground"
                          data-testid="checkout-consent-instant"
                        >
                          {DIGITAL_CHECKOUT_COPY.consentInstant}
                        </Typography>
                      )}
                      {checkout.hasManualDigitalLine && (
                        <Typography
                          as="p"
                          className="text-xs text-muted-foreground"
                          data-testid="checkout-consent-manual"
                        >
                          {DIGITAL_CHECKOUT_COPY.consentManual}
                        </Typography>
                      )}
                      <Button
                        className="w-full rounded-full"
                        onClick={() => void pay()}
                        disabled={!canPay}
                        data-testid="marketplace-checkout-pay"
                        aria-describedby={!canPay && !approvalNeeded ? 'checkout-pay-reason' : undefined}
                      >
                        {isPaying ? (
                          <>
                            <LoaderCircle className="size-4 animate-spin" />
                            Paying
                          </>
                        ) : isSandbox ? (
                          'Pay sandbox'
                        ) : (
                          'Pay'
                        )}
                      </Button>
                      {!isStaging && !isSandbox && (
                        <Typography as="p" className="text-xs text-muted-foreground">
                          Paid directly to the seller.
                        </Typography>
                      )}
                      {!canPay && !approvalNeeded && (
                        <Typography id="checkout-pay-reason" as="p" className="text-xs text-muted-foreground">
                          {payDisabledReason}
                        </Typography>
                      )}
                    </SettingsSectionContent>
                  </section>
                </CardContent>
              </Card>
              {isStaging && (
                <Typography
                  as="p"
                  role="note"
                  className="rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-200"
                >
                  Staging environment. No real funds move.
                </Typography>
              )}
            </div>
          </div>
        )}
      </Container>
    </ContentLayout>
  );
}

function dropCheckoutItem(listing: CommerceListingModelSchema, variantId: string): MarketplaceCartItem {
  return {
    id: `${listing.id}:${variantId}:drop`,
    listingId: listing.id,
    variantId,
    quantity: 1,
    listing,
    pricingSource: 'listing',
  };
}

function MarketplaceAwardTerms({ award }: { award: NonNullable<MarketplaceOfferAward> }) {
  const listingRoute = getMarketplaceListingRoute(award.listing.sellerPubky, award.listing.listingId);
  const variantLabel = award.variant.options
    .map((item) => item.value)
    .filter(Boolean)
    .join(' · ');
  return (
    <section className="grid gap-3" aria-label="Accepted offer">
      <Card className="rounded-md p-0">
        <CardContent className="grid gap-2 p-6">
          <Typography as="h2" className="truncate font-semibold">
            <Link href={listingRoute} overrideDefaults className="hover:text-brand">
              {award.listing.title}
            </Link>
          </Typography>
          <MarketplaceSellerLink sellerPubky={award.listing.sellerPubky} />
          <Typography as="p" className="text-sm text-muted-foreground">
            {variantLabel ? `${variantLabel} · ` : ''}Quantity {award.quantity}
          </Typography>
        </CardContent>
      </Card>
    </section>
  );
}

function MarketplaceAwardOutcome({
  outcome,
  award,
  errorCode,
  listingRoute,
  onRetry,
}: {
  outcome: AwardPayOutcome;
  award: MarketplaceOfferAward | undefined;
  errorCode: string | null;
  listingRoute: string | null | undefined;
  onRetry: () => void;
}) {
  if (outcome === 'success') {
    return (
      <Card className="rounded-md p-0">
        <CardContent className="grid gap-4 p-6">
          <Heading level={2} size="lg">
            Checkout started
          </Heading>
          <Typography as="p">
            Your agreed merchandise total is {award ? formatCommerceMoney(award.merchandiseTotal) : ''}.
          </Typography>
        </CardContent>
      </Card>
    );
  }
  if (outcome === 'expired') {
    return (
      <Card className="rounded-md p-0">
        <CardContent className="grid gap-4 p-6">
          <Heading level={2} size="lg">
            Offer expired
          </Heading>
          <Typography as="p">This accepted offer expired before checkout. Nothing was reserved.</Typography>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="secondary" className="rounded-full">
              <Link href={MARKETPLACE_ROUTES.OFFERS} overrideDefaults>
                View offers
              </Link>
            </Button>
            {listingRoute && (
              <Button asChild className="rounded-full">
                <Link href={listingRoute} overrideDefaults>
                  Buy at current price
                </Link>
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }
  if (outcome === 'converted') {
    return (
      <Card className="rounded-md p-0">
        <CardContent className="grid gap-4 p-6">
          <Heading level={2} size="lg">
            Offer already converted
          </Heading>
          <Typography as="p">This accepted offer has already been converted.</Typography>
          <Button asChild className="w-fit rounded-full">
            <Link href={MARKETPLACE_ROUTES.ORDERS} overrideDefaults>
              View orders
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (outcome === 'unavailable') {
    return (
      <Card className="rounded-md p-0">
        <CardContent className="grid gap-3 p-6">
          <Heading level={2} size="lg">
            Checkout unavailable
          </Heading>
          <Typography as="p">This offer is no longer available.</Typography>
          <Link href={MARKETPLACE_ROUTES.OFFERS} overrideDefaults>
            View offers
          </Link>
        </CardContent>
      </Card>
    );
  }
  if (outcome === 'session') {
    return <MarketplaceSessionRequiredCard />;
  }
  return (
    <Card className="rounded-md p-0">
      <CardContent className="grid gap-4 p-6">
        <Heading level={2} size="lg">
          Checkout could not be completed
        </Heading>
        <Typography as="p">{marketplaceOfferCheckoutFailureMessage(errorCode)}</Typography>
        <Button className="w-fit rounded-full" onClick={onRetry}>
          Retry
        </Button>
      </CardContent>
    </Card>
  );
}
