'use client';

import { useEffect, useRef, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { getCommerceAdapterMode, isDurableCommerceMode } from '@/config/commerce';
import { commerceAttributeFieldsFor } from '@/config/taxonomy/taxonomy';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  buildListingVariants,
  buildPackageRecord,
  deriveTags,
  describeMediaFailure,
  listingAttributesFromFormData,
  uploadListingMedia,
} from '@/hooks/useCreateMarketplaceListing/useCreateMarketplaceListing';
import {
  type CreateMarketplaceListingData,
  createMarketplaceListingDefaults,
  createMarketplaceListingSchema,
  fulfillmentFormValueFromRecord,
  fulfillmentMethodsFromForm,
  fulfillmentRequiresShipping,
  listingAttributeFormField,
} from '@/hooks/useCreateMarketplaceListing/useCreateMarketplaceListing.types';
import {
  useListingMediaManager,
  type UseListingMediaManagerResult,
} from '@/hooks/useListingMediaManager/useListingMediaManager';
import { useMeasurementSystem } from '@/hooks/useMeasurementSystem/useMeasurementSystem';
import {
  evaluateDurableListingPublishGuards,
  type ListingPublishBlockReason,
  listingPublishBlockToast,
} from '@/libs/commerce/listing-publish-guards';
import { type CommerceListingRecord, commerceListingRecordSchema } from '@/libs/commerce/marketplace-records';
import {
  amountInputFromMoney,
  amountInputToMoney,
  assetForListingCurrency,
  type ListingCurrencyChoice,
  listingCurrencyChoiceForAsset,
} from '@/libs/commerce/pricing';
import type { CommerceMoney } from '@/libs/commerce/transaction-contracts';
import { dimensionInputFromMillimeters, type MeasurementSystem, weightInputFromGrams } from '@/libs/commerce/units';
import { stockFormFields } from '@/libs/commerce/unlimited-stock';
import { toast } from '@/molecules/Toaster/use-toast';
import { useAuthStore } from '@/stores/auth/auth.store';
import { useCommerceStore } from '@/stores/commerce/commerce.store';

export type EditMarketplaceListingStatus = 'loading' | 'ready' | 'not-found' | 'not-owner' | 'unsupported';

export interface UseEditMarketplaceListingResult {
  status: EditMarketplaceListingStatus;
  form: UseFormReturn<CreateMarketplaceListingData>;
  media: UseListingMediaManagerResult;
  /** True for auction listings: the sale terms were fixed at publish time. */
  saleTermsLocked: boolean;
  publishBlocked: ListingPublishBlockReason | null;
  publishGuardReady: boolean;
  submit: (options?: { silent?: boolean }) => Promise<string | null>;
}

/**
 * The edit side of the sell studio: hydrates the form and photo set from the
 * seller's published record and republishes the SAME listing (same
 * `listingId`, same `createdAt`) with a bumped revision. Already-uploaded
 * photos are reused as-is — only newly added photos upload bytes.
 *
 * Honest scope limits, enforced as `unsupported` instead of destructive
 * saves: Locks listings (a `digitalLock` this studio cannot author) cannot
 * be edited here; listings priced in an asset the studio
 * cannot author (anything that is neither USD cents nor BTC base units) cannot
 * be edited here, because "editing" one would silently rewrite its price
 * into a different asset; and auction sale terms are locked because
 * rewriting a live auction's window or starting price would falsify terms
 * bidders may already have acted on. Item facts (title, description, photos,
 * inventory, delivery) stay editable for auctions.
 */
export function useEditMarketplaceListing(sellerPubky: string, listingId: string): UseEditMarketplaceListingResult {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const marketplaceSession = useCommerceStore((state) => state.marketplaceSession);
  const measurementSystem = useMeasurementSystem();
  const media = useListingMediaManager();
  const [status, setStatus] = useState<EditMarketplaceListingStatus>('loading');
  const [record, setRecord] = useState<CommerceListingRecord | null>(null);
  const hydratedReservePriceRef = useRef<CommerceMoney | null | undefined>(undefined);
  const durablePublish = isDurableCommerceMode(getCommerceAdapterMode());
  const [publishBlocked, setPublishBlocked] = useState<ListingPublishBlockReason | null>(null);
  const [publishGuardReady, setPublishGuardReady] = useState(!durablePublish);
  const form = useForm<CreateMarketplaceListingData>({
    resolver: zodResolver(createMarketplaceListingSchema),
    defaultValues: createMarketplaceListingDefaults,
    mode: 'onChange',
  });

  useEffect(() => {
    let active = true;
    if (!currentUserPubky) return;
    if (currentUserPubky !== sellerPubky) {
      setStatus('not-owner');
      return;
    }
    CommerceController.getOrFetchListing(sellerPubky, listingId)
      .then(async (loaded) => {
        const sellerProjection =
          loaded.sale.format === 'auction' && isDurableCommerceMode(getCommerceAdapterMode())
            ? await CommerceController.getMarketplaceSellerListingProjection(sellerPubky, listingId)
            : null;
        if (!active) return;
        if (loaded.digitalLock !== undefined) {
          setStatus('unsupported');
          return;
        }
        const primaryPrice = loaded.sale.format === 'fixed_price' ? loaded.sale.unitPrice : loaded.sale.startingPrice;
        const currency = listingCurrencyChoiceForAsset(primaryPrice);
        if (currency === null) {
          setStatus('unsupported');
          return;
        }
        hydratedReservePriceRef.current = sellerProjection?.reservePrice;
        setRecord(loaded);
        form.reset(formDataFromRecord(loaded, currency, measurementSystem, sellerProjection?.reservePrice ?? null));
        media.seed(loaded.media);
        setStatus('ready');
      })
      .catch(() => {
        if (active) setStatus('not-found');
      });
    return () => {
      active = false;
    };
    // `form` and `media` are stable hook results; re-running on their identity
    // would re-seed and clobber in-progress edits. `measurementSystem` is read
    // once at hydration for the same reason: converting in-progress inputs
    // under the user would silently change what the numbers mean.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUserPubky, sellerPubky, listingId]);

  useEffect(() => {
    if (!durablePublish) {
      setPublishBlocked(null);
      setPublishGuardReady(true);
      return;
    }
    let active = true;
    setPublishGuardReady(false);
    void evaluateDurableListingPublishGuards({
      ownerPubky: currentUserPubky,
      hasMarketplaceSession: Boolean(marketplaceSession),
      loadPaymentConfig: (pubky) => CommerceController.getSellerPaymentConfig(pubky),
    }).then((reason) => {
      if (!active) return;
      setPublishBlocked(reason);
      setPublishGuardReady(true);
    });
    return () => {
      active = false;
    };
  }, [currentUserPubky, durablePublish, marketplaceSession]);

  const submit = async (options?: { silent?: boolean }): Promise<string | null> => {
    if (!currentUserPubky || !record) return null;
    setPublishBlocked(null);
    if (durablePublish) {
      const reason = await evaluateDurableListingPublishGuards({
        ownerPubky: currentUserPubky,
        hasMarketplaceSession: Boolean(marketplaceSession),
        loadPaymentConfig: (pubky) => CommerceController.getSellerPaymentConfig(pubky),
      });
      if (reason) {
        setPublishBlocked(reason);
        if (!options?.silent) toast(listingPublishBlockToast(reason));
        return null;
      }
    }
    let savedListingId: string | null = null;

    await form.handleSubmit(async (data) => {
      const preparedMedia = await media.prepare(currentUserPubky);
      if (!preparedMedia.ok) {
        toast({ variant: 'error', description: describeMediaFailure(preparedMedia.reason) });
        return;
      }

      try {
        await uploadListingMedia(preparedMedia.uploads);
        const updated = buildUpdatedRecord(record, data, preparedMedia.media);
        const reservePrice =
          updated.sale.format === 'auction' && data.reservePrice !== ''
            ? amountInputToMoney(data.reservePrice, assetForListingCurrency(data.currency))
            : hydratedReservePriceRef.current === undefined
              ? undefined
              : null;
        const { verified } = await CommerceController.commitUpsertListing(updated, reservePrice);
        setRecord(updated);
        savedListingId = `${currentUserPubky}:${updated.listingId}`;
        if (!options?.silent) {
          if (verified) {
            toast({ title: 'Listing updated', description: `Revision ${updated.revision} is now published.` });
          } else {
            // Acked write, read-back lagging — never "Could not save", which
            // sends the seller into a re-save that bumps the revision again.
            toast({
              title: 'Changes saved — confirmation pending',
              description:
                'Your homeserver accepted the update but has not served it back yet. Check the listing in a moment before saving again.',
            });
          }
        }
      } catch {
        toast({ variant: 'error', description: 'Could not save these changes.' });
      }
    })();

    return savedListingId;
  };

  return {
    status,
    form,
    media,
    saleTermsLocked: record?.sale.format === 'auction',
    publishBlocked,
    publishGuardReady,
    submit,
  };
}

/**
 * Splits a record's attributes into values the studio form can manage
 * (keys in the record category's attribute set whose values fit the field's
 * shape and vocabulary) and everything else — foreign keys, foreign
 * vocabulary values, unexpected shapes. The passthrough half is preserved
 * verbatim on save so editing unrelated facts never destroys attributes this
 * client cannot express; form-managed keys are rewritten from the form.
 */
export function partitionListingAttributes(record: Pick<CommerceListingRecord, 'categoryId' | 'attributes'>): {
  formValues: Partial<CreateMarketplaceListingData>;
  passthrough: Record<string, string | string[]>;
} {
  const formValues: Partial<CreateMarketplaceListingData> = {};
  const passthrough: Record<string, string | string[]> = {};
  const fieldsByKey = new Map(commerceAttributeFieldsFor(record.categoryId).map((field) => [field.key, field]));

  for (const [key, value] of Object.entries(record.attributes ?? {})) {
    const field = fieldsByKey.get(key);
    const formField = field ? listingAttributeFormField(field.key) : null;
    if (!field || !formField) {
      passthrough[key] = value;
      continue;
    }
    if (field.input === 'multi-select') {
      const allowed = new Set((field.options ?? []).map((option) => option.value));
      if (
        Array.isArray(value) &&
        (field.maxValues === undefined || value.length <= field.maxValues) &&
        value.every((entry) => allowed.has(entry))
      ) {
        (formValues as Record<string, string | string[]>)[formField] = value;
      } else {
        passthrough[key] = value;
      }
      continue;
    }
    if (typeof value !== 'string') {
      passthrough[key] = value;
      continue;
    }
    if (field.input === 'select') {
      const allowed = new Set((field.options ?? []).map((option) => option.value));
      if (allowed.has(value)) {
        (formValues as Record<string, string | string[]>)[formField] = value;
      } else {
        passthrough[key] = value;
      }
      continue;
    }
    (formValues as Record<string, string | string[]>)[formField] = value;
  }

  return { formValues, passthrough };
}

export function formDataFromRecord(
  record: CommerceListingRecord,
  currency: ListingCurrencyChoice,
  measurementSystem: MeasurementSystem,
  reservePrice: CommerceMoney | null | undefined,
): CreateMarketplaceListingData {
  const price = record.sale.format === 'fixed_price' ? record.sale.unitPrice : record.sale.startingPrice;
  // Auctions are shipping-only (local pickup design §A2): an auction record
  // carrying pickup vocabulary predates the rule — the register path refuses
  // pickup auctions — so the editor hydrates it as shipping rather than
  // deadlocking the form on a combination the schema cannot accept.
  const fulfillment =
    record.sale.format === 'auction' ? 'shipping' : fulfillmentFormValueFromRecord(record.fulfillmentMethods);
  const flatShipping = record.shippingOptions.find((option) => option.pricing === 'flat');
  const freeShipping = record.shippingOptions.find((option) => option.pricing === 'free');
  const shippingOption = flatShipping ?? freeShipping;
  const returnDays =
    record.returnPolicy.acceptsReturns && record.returnPolicy.returnWindowDays !== undefined
      ? record.returnPolicy.returnWindowDays <= 14
        ? ('14' as const)
        : ('30' as const)
      : ('none' as const);

  return {
    ...createMarketplaceListingDefaults,
    ...partitionListingAttributes(record).formValues,
    title: record.title,
    description: record.description,
    categoryId: record.categoryId,
    condition: record.condition,
    countryCode: record.location.countryCode,
    region: record.location.region ?? '',
    saleFormat: record.sale.format,
    currency,
    price: amountInputFromMoney(price),
    reservePrice: reservePrice ? amountInputFromMoney(reservePrice) : '',
    variants: record.variants.map((variant) => ({
      sku: variant.sku ?? '',
      size: variant.options.size ?? '',
      color: variant.options.color ?? '',
      style: variant.options.style ?? '',
      ...stockFormFields(record, variant.quantity),
      priceOverride: variant.priceOverride ? amountInputFromMoney(variant.priceOverride) : '',
    })),
    fulfillment,
    shippingLabel: shippingOption ? shippingOption.label : createMarketplaceListingDefaults.shippingLabel,
    freeShipping: freeShipping !== undefined,
    shippingPrice: flatShipping ? amountInputFromMoney(flatShipping.price) : '',
    shippingMinDays: shippingOption
      ? String(shippingOption.estimatedMinDays)
      : createMarketplaceListingDefaults.shippingMinDays,
    shippingMaxDays: shippingOption
      ? String(shippingOption.estimatedMaxDays)
      : createMarketplaceListingDefaults.shippingMaxDays,
    measurementSystem,
    packageWeight: record.package ? weightInputFromGrams(record.package.weightGrams, measurementSystem) : '',
    packageLength: record.package
      ? dimensionInputFromMillimeters(record.package.lengthMillimeters, measurementSystem)
      : '',
    packageWidth: record.package
      ? dimensionInputFromMillimeters(record.package.widthMillimeters, measurementSystem)
      : '',
    packageHeight: record.package
      ? dimensionInputFromMillimeters(record.package.heightMillimeters, measurementSystem)
      : '',
    returnDays,
  };
}

function buildUpdatedRecord(
  record: CommerceListingRecord,
  data: CreateMarketplaceListingData,
  media: CommerceListingRecord['media'],
): CommerceListingRecord {
  const now = new Date().toISOString();
  const asset = assetForListingCurrency(data.currency);
  const unitPrice = amountInputToMoney(data.price, asset);
  // Auction sale terms are immutable after publish (see the hook doc); the
  // fixed-price branch rebuilds from the form but keeps the offers setting.
  const sale: CommerceListingRecord['sale'] =
    record.sale.format === 'auction'
      ? record.sale
      : { format: 'fixed_price', unitPrice, acceptsOffers: record.sale.acceptsOffers };
  const requiresShipping = fulfillmentRequiresShipping(data.fulfillment);
  const returnWindowDays = data.returnDays === 'none' ? undefined : Number(data.returnDays);

  // Attributes this client cannot express (foreign keys/values) survive the
  // save verbatim; the form's structured values win on shared keys.
  const attributes = {
    ...partitionListingAttributes(record).passthrough,
    ...listingAttributesFromFormData(data),
  };

  return commerceListingRecordSchema.parse({
    ...record,
    revision: record.revision + 1,
    updatedAt: now,
    title: data.title,
    description: data.description,
    categoryId: data.categoryId,
    attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
    condition: data.condition,
    tags: deriveTags(data.title),
    location: {
      countryCode: data.countryCode.toUpperCase(),
      region: data.region || undefined,
    },
    media,
    variants: buildListingVariants(data, media),
    sale,
    fulfillmentMethods: fulfillmentMethodsFromForm(data.fulfillment),
    package: requiresShipping ? buildPackageRecord(data) : undefined,
    shippingOptions: requiresShipping
      ? [
          data.freeShipping
            ? {
                id: 'seller_flat_rate',
                pricing: 'free' as const,
                label: data.shippingLabel,
                estimatedMinDays: Number(data.shippingMinDays),
                estimatedMaxDays: Number(data.shippingMaxDays),
              }
            : {
                id: 'seller_flat_rate',
                pricing: 'flat' as const,
                label: data.shippingLabel,
                price: amountInputToMoney(data.shippingPrice, asset),
                estimatedMinDays: Number(data.shippingMinDays),
                estimatedMaxDays: Number(data.shippingMaxDays),
              },
        ]
      : [],
    returnPolicy: {
      acceptsReturns: returnWindowDays !== undefined,
      returnWindowDays,
      buyerPaysReturnShipping: true,
    },
  });
}
