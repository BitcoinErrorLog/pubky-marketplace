'use client';

import { useEffect, useRef, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useLiveQuery } from 'dexie-react-hooks';
import { useForm, type UseFormReturn, useWatch } from 'react-hook-form';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { MarketplaceCartItem } from '@/hooks/useMarketplaceCart/useMarketplaceCart';
import {
  BIND_FAIL_CANCEL_REASON,
  listingAggregatesFromCheckoutLines,
  resolveCreatedCheckoutOrderIds,
} from '@/libs/commerce/checkout-phase';
import {
  classifyDigitalCheckoutRefusal,
  DIGITAL_CHECKOUT_REFUSAL_COPY,
  isInstantDigitalDeliveryKind,
  type MarketplaceDigitalDeliveryKind,
} from '@/libs/commerce/digital';
import {
  MARKETPLACE_FAILURE_MESSAGES,
  marketplaceCheckoutRefusalMessage,
  marketplaceErrorCode,
  marketplaceFailureMessage,
} from '@/libs/commerce/failure-messages';
import { commerceListingFulfillmentMethods } from '@/libs/commerce/marketplace-records';
import type { PaymentMethodKind } from '@/libs/commerce/payment-methods';
import type { MarketplaceFulfillmentMethod } from '@/libs/commerce/pickup';
import { pickupRefusalFailureMessage } from '@/libs/commerce/pickup';
import { browserAddressCountry } from '@/libs/commerce/postal-address';
import {
  buildMarketplaceListingAggregateId,
  buildMarketplaceOrderAggregateId,
  classifyMarketplacePickupCommandRefusal,
  isListingDeletedResponse,
  isMarketplaceRevisionConflict,
} from '@/libs/commerce/transaction-commands';
import { AppError } from '@/libs/error/error';
import { isMarketplaceSessionRequiredError } from '@/libs/error/error.utils';
import type { CommerceDeliveryAddressModelSchema } from '@/models/commerce/commerce.schema';
import { showPaymentMethodRefusalToast } from '@/molecules/Toaster/payment-method-refusal-toast';
import { toast } from '@/molecules/Toaster/use-toast';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';
import {
  MARKETPLACE_CHECKOUT_ADDRESS_FIELDS,
  type MarketplaceCheckoutData,
  marketplaceCheckoutDefaults,
  marketplaceCheckoutSchema,
} from './useMarketplaceCheckout.types';

/**
 * The bare (non-owner-prefixed) address id the controller works with — the
 * stored primary key is `${owner_id}:${addressId}`.
 */
function bareAddressId(address: CommerceDeliveryAddressModelSchema): string {
  return address.id.slice(address.owner_id.length + 1);
}

function addressFieldValues(
  address: CommerceDeliveryAddressModelSchema,
): Pick<MarketplaceCheckoutData, (typeof MARKETPLACE_CHECKOUT_ADDRESS_FIELDS)[number]> {
  return {
    name: address.name,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    region: address.region,
    postalCode: address.postal_code,
    countryCode: address.country_code,
  };
}

/**
 * One `listing.sync` attempt followed by one projection re-read — the
 * buyer-side heal for a cart line whose listing was published before
 * durable-mode registration existed. Sync failures fall through to the
 * caller's honest failure toast. A sync that reports the seller deleted the
 * listing sets `removed` so the caller can say so.
 */
async function syncLineProjection(ownerPubky: string, listingId: string) {
  try {
    const response = await CommerceController.syncListingRegistration(ownerPubky, listingId);
    if (!response.ok) return { projection: null, removed: false };
    if (isListingDeletedResponse(response, buildMarketplaceListingAggregateId(ownerPubky, listingId))) {
      return { projection: null, removed: true };
    }
    return {
      projection: await CommerceController.getMarketplaceListingProjection(ownerPubky, listingId),
      removed: false,
    };
  } catch {
    return { projection: null, removed: false };
  }
}

function formMatchesAddress(
  data: Pick<MarketplaceCheckoutData, (typeof MARKETPLACE_CHECKOUT_ADDRESS_FIELDS)[number]>,
  address: CommerceDeliveryAddressModelSchema,
): boolean {
  const fields = addressFieldValues(address);
  return MARKETPLACE_CHECKOUT_ADDRESS_FIELDS.every((field) => {
    const entered = field === 'countryCode' ? data[field].trim().toUpperCase() : data[field].trim();
    return entered === fields[field];
  });
}

export type MarketplacePayResult = {
  ok: boolean;
  orderIds: string[];
  boundOrders: MarketplaceOrder[];
};

/**
 * `award` is an accepted offer's checkout: its fulfillment choices come from
 * the accepted snapshot's methods (never the listing as it is now), filtered
 * by the deployment's pickup capability like a cart line's.
 */
export function useMarketplaceCheckout(
  items: MarketplaceCartItem[],
  clearCart: () => Promise<void>,
  award: { sellerPubky: string; fulfillmentMethods: readonly MarketplaceFulfillmentMethod[] } | null = null,
): {
  form: UseFormReturn<MarketplaceCheckoutData>;
  submit: () => Promise<boolean>;
  /** `onRetry` backs the Try again action of a wallet-setup refusal; it runs only on the buyer's click. */
  pay: (method: PaymentMethodKind | null, onRetry?: () => void) => Promise<MarketplacePayResult>;
  isPaying: boolean;
  needsSession: boolean;
  sessionError: string | null;
  /** True when the store holds session facts and getActiveSession still accepts them. */
  hasMarketplaceSession: boolean;
  /** Saved addresses in picker order (default first, then last used). */
  addresses: CommerceDeliveryAddressModelSchema[];
  /** Composite row id of the applied saved address; null while entering a new one. */
  selectedAddressId: string | null;
  selectAddress: (id: string | null) => void;
  /**
   * The fulfillment methods a seller group's lines ALL publish (the choice
   * is selectable only among these, §A2), filtered by the deployment's
   * `pickup_available` capability. Empty when the group's lines force
   * incompatible single methods — a conflict the cart must surface.
   */
  fulfillmentOptionsForSeller: (sellerPubky: string) => MarketplaceFulfillmentMethod[];
  /** The group's effective choice: the buyer's, else shipping when shippable. */
  fulfillmentForSeller: (sellerPubky: string) => MarketplaceFulfillmentMethod | undefined;
  setFulfillmentChoice: (sellerPubky: string, method: MarketplaceFulfillmentMethod) => void;
  /** True only when a line ships — pickup and digital lines send no address (§A2). */
  requiresDeliveryAddress: boolean;
  /**
   * The line's method: digital for a digital line (digital delivery design
   * §3 "Mixed carts"), else its seller group's choice. Undefined while a
   * capability it depends on loads, or when the group has no shared method.
   */
  fulfillmentForItem: (itemId: string) => MarketplaceFulfillmentMethod | undefined;
  /** True when the line's listing both ships (or offers pickup) and delivers digitally here. */
  canChooseDigitalForItem: (itemId: string) => boolean;
  /** Moves a line that offers both between digital delivery and its seller group's method. */
  setDigitalChoice: (itemId: string, digital: boolean) => void;
  /** The seller's delivery kind for a digital line; null when not set up yet, undefined while it loads. */
  digitalKindForItem: (itemId: string) => MarketplaceDigitalDeliveryKind | null | undefined;
  /** True while the deployment's digital capability is unknown and a line publishes digital. */
  isDigitalCapabilityLoading: boolean;
  /** Digital lines whose seller has not set delivery (§6 B4): Pay stays disabled. */
  digitalNotReadyItemIds: string[];
  /** False while a digital line's kind loads or a digital line is not ready. */
  isDigitalReady: boolean;
  /** True when a digital line is email-kind, so the checkout needs "Email for delivery" (§4.3). */
  requiresDeliveryEmail: boolean;
  /** Digital lines released at payment (file, link, text), and ones the seller sends (email, message). */
  hasInstantDigitalLine: boolean;
  hasManualDigitalLine: boolean;
  /** True when a group's lines force incompatible single fulfillments. */
  hasFulfillmentConflict: boolean;
  /**
   * True while the deployment's pickup capability is still unknown AND a line
   * in the seller's group publishes pickup — the only case where the answer
   * can change that group's options.
   */
  isPickupCapabilityLoadingForSeller: (sellerPubky: string) => boolean;
  /** The number of durable rows this checkout creates — one per (seller, fulfillment) group. */
  orderCount: number;
  /** Persist a used or newly saved address after a successful create (offer or cart). */
  rememberAddress: () => Promise<void>;
} {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  // Connecting a session replaces this store object; the flag below clears so
  // the cart's session-required card disappears without a submit attempt.
  const marketplaceSession = useCommerceStore((state) => state.marketplaceSession);
  const hasActiveServiceSession = CommerceController.hasActiveMarketplaceSession();
  const [needsSession, setNeedsSession] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [isPaying, setIsPaying] = useState(false);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [pickupAvailable, setPickupAvailable] = useState<boolean | null>(null);
  const [choiceOverrides, setChoiceOverrides] = useState<Record<string, MarketplaceFulfillmentMethod>>({});
  const [digitalAvailable, setDigitalAvailable] = useState<boolean | null>(null);
  const [digitalChoices, setDigitalChoices] = useState<Record<string, boolean>>({});
  const [digitalKinds, setDigitalKinds] = useState<{
    key: string;
    kinds: Record<string, MarketplaceDigitalDeliveryKind | null>;
  } | null>(null);
  const [digitalKindsAttempt, setDigitalKindsAttempt] = useState(0);
  const appliedInitialAddressRef = useRef(false);
  const form = useForm<MarketplaceCheckoutData>({
    resolver: zodResolver(marketplaceCheckoutSchema),
    defaultValues: marketplaceCheckoutDefaults,
    mode: 'onTouched',
  });

  const addresses = useLiveQuery(
    async () => {
      if (!currentUserPubky) return [];
      return await CommerceController.getDeliveryAddresses();
    },
    [currentUserPubky],
    [] as CommerceDeliveryAddressModelSchema[],
  );

  // If getActiveSession dropped the purchase bearer (TTL margin), null the
  // identity store copy so step 1 cannot stay "approved" after the service
  // would reject. Do not wipe the inventory session — checkout hold expiry
  // is not a Studio sign-out.
  useEffect(() => {
    if (marketplaceSession !== null && !CommerceController.hasActiveMarketplaceSession()) {
      CommerceController.clearIdentitySession();
    }
  }, [marketplaceSession]);

  // A new address starts in the browser's country. Set after mount, so the
  // server-rendered form and the first client render agree; a saved address
  // applied below replaces it.
  useEffect(() => {
    if (form.getFieldState('countryCode').isDirty) return;
    form.reset({ ...form.getValues(), countryCode: browserAddressCountry() }, { keepDirtyValues: true });
  }, [form]);

  // Pre-fill once from the picker's top address (default, else last used) —
  // but never over anything the buyer already typed.
  useEffect(() => {
    if (appliedInitialAddressRef.current) return;
    const first = addresses[0];
    if (!first) return;
    appliedInitialAddressRef.current = true;
    if (form.formState.isDirty) return;
    form.reset({ ...form.getValues(), ...addressFieldValues(first) });
    setSelectedAddressId(first.id);
  }, [addresses, form]);

  // Editing any address field after picking a saved address turns the entry
  // back into a "new address", which is what re-reveals the save controls.
  const watchedAddressValues = useWatch({
    control: form.control,
    name: MARKETPLACE_CHECKOUT_ADDRESS_FIELDS as unknown as Array<(typeof MARKETPLACE_CHECKOUT_ADDRESS_FIELDS)[number]>,
  });
  useEffect(() => {
    setSelectedAddressId((current) => {
      if (current === null) return null;
      const selected = addresses.find(({ id }) => id === current);
      if (!selected) return null;
      // The watched values only trigger this effect; the comparison reads the
      // live form state, which a just-applied `form.reset` already reflects.
      return formMatchesAddress(form.getValues(), selected) ? current : null;
    });
  }, [addresses, watchedAddressValues, form]);

  useEffect(() => {
    if (!marketplaceSession) return;
    setNeedsSession(false);
    setSessionError(null);
  }, [marketplaceSession]);

  // The deployment capability (§A7): pickup choices are offered only when
  // the service reports `pickup_available` (off without the sealing key, and
  // off on every sandbox-payments deployment — the sandbox included).
  useEffect(() => {
    let active = true;
    CommerceController.fetchPickupAvailable()
      .then((available) => {
        if (active) setPickupAvailable(available);
      })
      .catch(() => {
        if (active) setPickupAvailable(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const publishedByItem = new Map<string, MarketplaceFulfillmentMethod[]>();
  for (const item of items) {
    publishedByItem.set(
      item.id,
      commerceListingFulfillmentMethods(
        item.listing.record.fulfillmentMethods,
        item.listing.record.digitalLock !== undefined,
      ),
    );
  }
  const publishedFor = (item: MarketplaceCartItem) => publishedByItem.get(item.id) ?? [];
  const anyPublishesDigital = items.some((item) => publishedFor(item).includes('digital'));

  // The deployment's digital capability (digital delivery design §6 B5):
  // digital lines are offered only when /health reports it.
  useEffect(() => {
    if (!anyPublishesDigital) return;
    let active = true;
    CommerceController.fetchDigitalDeliveryCapability()
      .then(({ available }) => {
        if (active) setDigitalAvailable(available);
      })
      .catch(() => {
        if (active) setDigitalAvailable(false);
      });
    return () => {
      active = false;
    };
  }, [anyPublishesDigital]);

  // Per-line resolution (digital delivery design §3 "Mixed carts"): a line
  // whose listing only delivers digitally is digital; one that also ships or
  // offers pickup is digital only when the buyer picks it. Every other line
  // joins its seller group, which resolves as §A2 below.
  const physicalOptionsFor = (item: MarketplaceCartItem) =>
    publishedFor(item).filter((method) => method === 'shipping' || (method === 'pickup' && pickupAvailable === true));
  const digitalOffered = (item: MarketplaceCartItem) =>
    digitalAvailable === true && publishedFor(item).includes('digital');
  // A pickup line whose capability is still loading may yet be physical.
  const physicalPossible = (item: MarketplaceCartItem) =>
    physicalOptionsFor(item).length > 0 || (pickupAvailable === null && publishedFor(item).includes('pickup'));
  const digitalPending = (item: MarketplaceCartItem) =>
    digitalAvailable === null && publishedFor(item).includes('digital') && !physicalPossible(item);
  const goesDigital = (item: MarketplaceCartItem) =>
    digitalOffered(item) && (!physicalPossible(item) || digitalChoices[item.id] === true);
  const digitalItems = items.filter(goesDigital);
  const physicalItems = items.filter((item) => !goesDigital(item) && !digitalPending(item));

  // Per-seller-group fulfillment resolution (§A2): the intersection of the
  // methods every physical line in the group publishes — the choice is
  // selectable only among those, never silently rewritten to shipping (the
  // prior art's `?? 'shipping'` defect, PR 22 review item 1).
  const optionsBySeller = new Map<string, MarketplaceFulfillmentMethod[]>();
  const sellersPublishingPickup = new Set<string>();
  // An accepted offer settles through the snapshot's physical methods only
  // (offers never deliver digitally), filtered by the pickup capability.
  const fulfillmentSources = [
    ...physicalItems.map((item) => ({
      sellerPubky: item.listing.record.ownerPubky,
      published: publishedFor(item),
      allowed: physicalOptionsFor(item),
    })),
    ...(award
      ? [
          {
            sellerPubky: award.sellerPubky,
            published: [...award.fulfillmentMethods],
            allowed: award.fulfillmentMethods.filter(
              (method) => method === 'shipping' || (method === 'pickup' && pickupAvailable === true),
            ),
          },
        ]
      : []),
  ];
  for (const { sellerPubky, published, allowed } of fulfillmentSources) {
    if (published.includes('pickup')) sellersPublishingPickup.add(sellerPubky);
    const existing = optionsBySeller.get(sellerPubky);
    optionsBySeller.set(sellerPubky, existing ? existing.filter((method) => allowed.includes(method)) : [...allowed]);
  }
  const fulfillmentOptionsForSeller = (sellerPubky: string) => optionsBySeller.get(sellerPubky) ?? [];
  const fulfillmentForSeller = (sellerPubky: string): MarketplaceFulfillmentMethod | undefined => {
    const options = fulfillmentOptionsForSeller(sellerPubky);
    if (options.length === 0) return undefined;
    const override = choiceOverrides[sellerPubky];
    if (override && options.includes(override)) return override;
    return options.includes('shipping') ? 'shipping' : options[0];
  };
  const itemById = new Map(items.map((item) => [item.id, item]));
  const fulfillmentForItem = (itemId: string): MarketplaceFulfillmentMethod | undefined => {
    const item = itemById.get(itemId);
    if (!item || digitalPending(item)) return undefined;
    return goesDigital(item) ? 'digital' : fulfillmentForSeller(item.listing.record.ownerPubky);
  };
  const hasFulfillmentConflict = [...optionsBySeller.values()].some((options) => options.length === 0);
  const requiresDeliveryAddress =
    (items.length === 0 && award === null) ||
    physicalItems.some((item) => fulfillmentForItem(item.id) !== 'pickup') ||
    (award !== null && fulfillmentForSeller(award.sellerPubky) !== 'pickup');
  const orderCount = new Set([
    ...items.map((item) => `${item.listing.record.ownerPubky}|${fulfillmentForItem(item.id) ?? ''}`),
    ...(award ? [`${award.sellerPubky}|${fulfillmentForSeller(award.sellerPubky) ?? ''}`] : []),
  ]).size;

  // The seller's delivery kind per digital line, from the listing projection
  // (§6 B4: a line with none cannot check out). Re-read when the digital
  // lines change or a checkout refusal says the delivery moved.
  const digitalKindsKey = JSON.stringify({
    attempt: digitalKindsAttempt,
    lines: digitalItems.map((item) => [item.id, item.listing.record.ownerPubky, item.listing.record.listingId]),
  });
  useEffect(() => {
    const { lines } = JSON.parse(digitalKindsKey) as { lines: Array<[string, string, string]> };
    if (lines.length === 0) return;
    let active = true;
    void Promise.all(
      lines.map(async ([itemId, ownerPubky, listingId]) => {
        try {
          let projection = await CommerceController.getMarketplaceListingProjection(ownerPubky, listingId);
          if (!projection && isDurableCommerceMode(getCommerceAdapterMode())) {
            ({ projection } = await syncLineProjection(ownerPubky, listingId));
          }
          return [itemId, projection?.digitalDelivery?.kind ?? null] as const;
        } catch {
          return [itemId, null] as const;
        }
      }),
    ).then((entries) => {
      if (active) setDigitalKinds({ key: digitalKindsKey, kinds: Object.fromEntries(entries) });
    });
    return () => {
      active = false;
    };
  }, [digitalKindsKey]);
  const kindsLoaded = digitalItems.length === 0 || digitalKinds?.key === digitalKindsKey;
  const digitalKindForItem = (itemId: string): MarketplaceDigitalDeliveryKind | null | undefined => {
    const item = itemById.get(itemId);
    if (!item || !goesDigital(item) || !kindsLoaded) return undefined;
    return digitalKinds?.kinds[itemId] ?? null;
  };
  const digitalLineKinds = digitalItems.map((item) => digitalKindForItem(item.id));
  const digitalNotReadyItemIds = kindsLoaded
    ? digitalItems.filter((item) => digitalKindForItem(item.id) === null).map((item) => item.id)
    : [];
  const isDigitalCapabilityLoading = anyPublishesDigital && digitalAvailable === null;
  const isDigitalReady = !isDigitalCapabilityLoading && kindsLoaded && digitalNotReadyItemIds.length === 0;
  const requiresDeliveryEmail = digitalLineKinds.includes('email');

  // Keep the hidden schema flag in sync so the address requirement follows
  // the groups (a pickup-only checkout must not demand — or send — one, §A2).
  useEffect(() => {
    form.setValue('requiresDeliveryAddress', requiresDeliveryAddress, { shouldValidate: true });
  }, [form, requiresDeliveryAddress]);
  useEffect(() => {
    form.setValue('requiresDeliveryEmail', requiresDeliveryEmail, { shouldValidate: true });
  }, [form, requiresDeliveryEmail]);

  const setFulfillmentChoice = (sellerPubky: string, method: MarketplaceFulfillmentMethod) => {
    setChoiceOverrides((current) => ({ ...current, [sellerPubky]: method }));
  };
  const setDigitalChoice = (itemId: string, digital: boolean) => {
    setDigitalChoices((current) => ({ ...current, [itemId]: digital }));
  };

  const selectAddress = (id: string | null) => {
    if (id === null) {
      setSelectedAddressId(null);
      return;
    }
    const address = addresses.find((candidate) => candidate.id === id);
    if (!address) return;
    form.reset({ ...form.getValues(), ...addressFieldValues(address) });
    setSelectedAddressId(id);
  };

  /**
   * Address book bookkeeping after a successful order: a used saved address
   * gets its last-used timestamp; a new address the buyer opted to keep is
   * created (and immediately marked used). Local-only writes — the address
   * itself traveled exactly once, inside the checkout command.
   */
  const persistAddressBookAfterOrder = async (data: MarketplaceCheckoutData): Promise<void> => {
    try {
      const selected = addresses.find(({ id }) => id === selectedAddressId);
      if (selected && formMatchesAddress(data, selected)) {
        await CommerceController.commitMarkDeliveryAddressUsed(bareAddressId(selected));
        return;
      }
      if (!data.saveAddress || !data.saveLabel) return;
      const addressId = crypto.randomUUID().replaceAll('-', '');
      await CommerceController.commitUpsertDeliveryAddress(addressId, {
        label: data.saveLabel,
        name: data.name,
        line1: data.line1,
        line2: data.line2,
        city: data.city,
        region: data.region,
        postalCode: data.postalCode,
        countryCode: data.countryCode.toUpperCase(),
      });
      await CommerceController.commitMarkDeliveryAddressUsed(addressId);
    } catch {
      // The order already succeeded; failing to update the local address book
      // must not look like a failed checkout.
      toast({ variant: 'error', description: 'Checkout completed, but the address could not be saved.' });
    }
  };

  type CheckoutLine = {
    listingAggregateId: string;
    sellerPubky: string;
    publishedFulfillmentMethods: MarketplaceFulfillmentMethod[];
    fulfillmentChoice?: 'digital';
    expectedRevision: number;
    quantity: number;
    variantId?: string;
    variantOptions?: Array<{ name: string; value: string }>;
  };

  const handleCheckoutError = (checkoutError: unknown) => {
    if (isMarketplaceSessionRequiredError(checkoutError)) {
      setNeedsSession(true);
      setSessionError(MARKETPLACE_FAILURE_MESSAGES.session);
      toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.session });
      return;
    }
    if (checkoutError instanceof AppError) {
      toast({
        variant: 'error',
        description: marketplaceFailureMessage(
          marketplaceErrorCode(checkoutError),
          MARKETPLACE_FAILURE_MESSAGES.checkout,
          checkoutError,
        ),
      });
      return;
    }
    toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.checkout });
  };

  const createCheckout = async (
    data: MarketplaceCheckoutData,
  ): Promise<{ ok: true; result: unknown; lines: CheckoutLine[] } | { ok: false }> => {
    const freshKinds: Array<MarketplaceDigitalDeliveryKind | null> = [];
    let sawRemovedListing = false;
    const lines = await Promise.all(
      items.map(async (item) => {
        const record = item.listing.record;
        let projection = await CommerceController.getMarketplaceListingProjection(record.ownerPubky, record.listingId);
        if (!projection && isDurableCommerceMode(getCommerceAdapterMode())) {
          const healed = await syncLineProjection(record.ownerPubky, record.listingId);
          projection = healed.projection;
          if (healed.removed) sawRemovedListing = true;
        }
        if (!projection) return null;
        const digital = goesDigital(item);
        if (digital) freshKinds.push(projection.digitalDelivery?.kind ?? null);
        const variant = record.variants.find(({ id }) => id === item.variantId);
        const variantOptions = variant ? Object.entries(variant.options) : [];
        return {
          listingAggregateId: projection.aggregateId,
          sellerPubky: record.ownerPubky,
          publishedFulfillmentMethods: publishedFor(item),
          ...(digital ? { fulfillmentChoice: 'digital' as const } : {}),
          expectedRevision: projection.serverRevision,
          quantity: item.quantity,
          ...(variant ? { variantId: variant.id } : {}),
          ...(variantOptions.length
            ? { variantOptions: variantOptions.map(([name, value]) => ({ name, value })) }
            : {}),
        };
      }),
    );
    if (lines.some((line) => line === null)) {
      toast({
        variant: 'error',
        description: sawRemovedListing
          ? `${MARKETPLACE_FAILURE_MESSAGES.listingRemoved} Nothing was reserved.`
          : 'A listing in your cart could not be prepared for checkout. It may have been removed by the seller. Nothing was reserved.',
      });
      return { ok: false };
    }
    // The kinds read at Pay are the ones the service checks: a delivery that
    // moved since the page loaded is caught here, before anything is held.
    if (freshKinds.includes(null) || (freshKinds.includes('email') && !data.deliveryEmail)) {
      setDigitalKindsAttempt((attempt) => attempt + 1);
      toast({
        variant: 'error',
        description: freshKinds.includes(null)
          ? DIGITAL_CHECKOUT_REFUSAL_COPY.not_ready
          : DIGITAL_CHECKOUT_REFUSAL_COPY.email_required,
      });
      return { ok: false };
    }
    const fulfillmentChoiceBySeller: Record<string, MarketplaceFulfillmentMethod> = {};
    for (const sellerPubky of optionsBySeller.keys()) {
      const fulfillment = fulfillmentForSeller(sellerPubky);
      if (fulfillment) fulfillmentChoiceBySeller[sellerPubky] = fulfillment;
    }
    const checkoutLines = lines.filter((line): line is CheckoutLine => line !== null);
    const response = await CommerceController.commitCreateMarketplaceCheckout({
      lines: checkoutLines,
      fulfillmentChoiceBySeller,
      ...(freshKinds.includes('email') ? { deliveryEmail: data.deliveryEmail } : {}),
      ...(requiresDeliveryAddress
        ? {
            deliveryAddress: {
              name: data.name,
              line1: data.line1,
              line2: data.line2,
              city: data.city,
              region: data.region,
              postalCode: data.postalCode,
              countryCode: data.countryCode.toUpperCase(),
            },
          }
        : {}),
    });
    if (!response.ok) {
      if (isMarketplaceRevisionConflict(response)) {
        toast({
          variant: 'error',
          description: 'A listing changed while you were checking out. Review your cart and try again.',
        });
        return { ok: false };
      }
      const digitalRefusal = classifyDigitalCheckoutRefusal(response.error);
      if (digitalRefusal) {
        if (digitalRefusal !== 'invalid_email') setDigitalKindsAttempt((attempt) => attempt + 1);
        toast({ variant: 'error', description: DIGITAL_CHECKOUT_REFUSAL_COPY[digitalRefusal] });
        return { ok: false };
      }
      const pickupRefusal = classifyMarketplacePickupCommandRefusal(response);
      toast({
        variant: 'error',
        description: pickupRefusal
          ? pickupRefusalFailureMessage(pickupRefusal)
          : (marketplaceCheckoutRefusalMessage(response.error.code, response.error.message) ??
            marketplaceFailureMessage(response.error.code, MARKETPLACE_FAILURE_MESSAGES.checkout)),
      });
      return { ok: false };
    }
    return { ok: true, result: response.result, lines: checkoutLines };
  };

  const finishCreatedCheckout = async (data: MarketplaceCheckoutData) => {
    if (requiresDeliveryAddress) await persistAddressBookAfterOrder(data);
    try {
      await clearCart();
    } catch {
      toast({ variant: 'error', description: 'Checkout completed, but your cart could not be cleared.' });
    }
  };

  const cancelCreatedCheckouts = async (orderIds: string[]) => {
    let listed: MarketplaceOrder[] = [];
    try {
      listed = await CommerceController.getMarketplaceOrders();
    } catch {
      listed = [];
    }
    await Promise.all(
      orderIds.map(async (orderId) => {
        const order = listed.find((candidate) => candidate.id === orderId);
        try {
          await CommerceController.executeMarketplaceCommand({
            version: 1,
            commandId: crypto.randomUUID(),
            aggregateId: buildMarketplaceOrderAggregateId(orderId),
            expectedRevision: order?.revision ?? 1,
            issuedAt: new Date().toISOString(),
            kind: 'order.cancel_request',
            payload: { orderId, reason: BIND_FAIL_CANCEL_REASON },
          });
        } catch {
          // Bind already failed; a leftover cancel miss expires on the hold clock.
        }
      }),
    );
  };

  const submit = async (): Promise<boolean> => {
    if (!items.length) return false;
    let succeeded = false;
    await form.handleSubmit(async (data) => {
      try {
        const created = await createCheckout(data);
        if (!created.ok) return;
        succeeded = true;
        await finishCreatedCheckout(data);
      } catch (checkoutError) {
        handleCheckoutError(checkoutError);
      }
    })();
    return succeeded;
  };

  const pay = async (method: PaymentMethodKind | null, onRetry?: () => void): Promise<MarketplacePayResult> => {
    const empty: MarketplacePayResult = { ok: false, orderIds: [], boundOrders: [] };
    if (!items.length || isPaying) return empty;
    let outcome = empty;
    setIsPaying(true);
    await form.handleSubmit(async (data) => {
      let createdIds: string[] = [];
      try {
        const created = await createCheckout(data);
        if (!created.ok) return;
        let listed: MarketplaceOrder[] = [];
        try {
          listed = await CommerceController.getMarketplaceOrders();
        } catch {
          listed = [];
        }
        createdIds = resolveCreatedCheckoutOrderIds({
          result: created.result,
          orders: listed,
          listingAggregateIds: listingAggregatesFromCheckoutLines(created.lines),
          buyerPubky: currentUserPubky,
        });
        if (createdIds.length === 0) {
          toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.checkout });
          return;
        }
        const mode = getCommerceAdapterMode();
        // Sandbox checkout already creates its simulated payment. Binding a
        // real payment rail is only supported by the durable service.
        const skipBind = mode === 'sandbox';
        if (skipBind) {
          await finishCreatedCheckout(data);
          outcome = { ok: true, orderIds: createdIds, boundOrders: [] };
          return;
        }
        if (!method) {
          await cancelCreatedCheckouts(createdIds);
          toast({ variant: 'error', description: 'Choose a payment method to pay.' });
          return;
        }
        const boundOrders: MarketplaceOrder[] = [];
        try {
          for (const orderId of createdIds) {
            boundOrders.push(await CommerceController.bindPaymentMethod(orderId, method));
          }
        } catch (bindError) {
          await cancelCreatedCheckouts(createdIds);
          showPaymentMethodRefusalToast({ error: bindError, fallback: MARKETPLACE_FAILURE_MESSAGES.checkout, onRetry });
          return;
        }
        await finishCreatedCheckout(data);
        outcome = { ok: true, orderIds: createdIds, boundOrders };
      } catch (checkoutError) {
        if (createdIds.length > 0) await cancelCreatedCheckouts(createdIds);
        handleCheckoutError(checkoutError);
      }
    })();
    setIsPaying(false);
    return outcome;
  };

  return {
    form,
    submit,
    pay,
    isPaying,
    needsSession,
    sessionError,
    hasMarketplaceSession: marketplaceSession !== null && hasActiveServiceSession,
    addresses,
    selectedAddressId,
    selectAddress,
    fulfillmentOptionsForSeller,
    fulfillmentForSeller,
    setFulfillmentChoice,
    requiresDeliveryAddress,
    fulfillmentForItem,
    canChooseDigitalForItem: (itemId: string) => {
      const item = itemById.get(itemId);
      return item !== undefined && digitalOffered(item) && physicalOptionsFor(item).length > 0;
    },
    setDigitalChoice,
    digitalKindForItem,
    isDigitalCapabilityLoading,
    digitalNotReadyItemIds,
    isDigitalReady,
    requiresDeliveryEmail,
    hasInstantDigitalLine: digitalLineKinds.some((kind) => kind != null && isInstantDigitalDeliveryKind(kind)),
    hasManualDigitalLine: digitalLineKinds.some((kind) => kind === 'email' || kind === 'message'),
    hasFulfillmentConflict,
    isPickupCapabilityLoadingForSeller: (sellerPubky: string) =>
      pickupAvailable === null && sellersPublishingPickup.has(sellerPubky),
    orderCount,
    rememberAddress: async () => {
      await persistAddressBookAfterOrder(form.getValues());
    },
  };
}
