'use client';

import { type ChangeEvent, type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { COMMERCE_CONTRACT_VERSION } from '@/config/commerce';
import { IMAGE_MAX_RAW_SIZE } from '@/config/images';
import { CommerceController } from '@/controllers/commerce/commerce';
import { useMarketplaceMediaUrl } from '@/hooks/useMarketplaceMediaUrl/useMarketplaceMediaUrl';
import {
  MARKETPLACE_FAILURE_MESSAGES,
  marketplaceErrorCode,
  marketplaceFailureMessage,
} from '@/libs/commerce/failure-messages';
import type { CommerceShopRecord } from '@/libs/commerce/marketplace-records';
import { HOMESERVER_WRITE_SCOPE_REMEDY, isHomeserverWriteScopeError } from '@/libs/error/error.utils';
import { stripImageMetadata } from '@/libs/image/stripImageMetadata';
import { toast } from '@/molecules/Toaster/use-toast';
import { useAuthStore } from '@/stores/auth/auth.store';
import {
  type MarketplaceShopSettingsData,
  marketplaceShopSettingsDefaults,
  marketplaceShopSettingsSchema,
} from './useMarketplaceShopSettings.types';

export type ShopImageSlotError = 'invalid-type' | 'too-large';

/**
 * One shop image (avatar or banner) in the settings form. Mirrors the sell
 * studio's media manager, reduced to a single image: an already-published
 * homeserver file, a freshly picked file awaiting upload, or nothing.
 */
type ShopImageSlotState =
  | { kind: 'empty' }
  | { kind: 'existing'; url: string }
  | { kind: 'pending'; file: File; previewUrl: string };

export interface ShopImageSlot {
  /** Browser-loadable preview: object URL for a picked file, resolved homeserver URL for a published one. */
  previewUrl: string | null;
  hasImage: boolean;
  error: ShopImageSlotError | null;
  inputRef: RefObject<HTMLInputElement | null>;
  choose: () => void;
  onInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  /** Clears the slot; saving afterwards publishes the shop record without this field. */
  remove: () => void;
}

interface ShopImageSlotInternal {
  slot: ShopImageSlot;
  /** Hydrates the slot from the published record (undefined clears it). */
  setExisting: (url: string | undefined) => void;
  /**
   * Returns the marketplace media URI to publish in the shop record: uploads
   * a picked file (sanitized, content-addressed on the owner's homeserver),
   * passes an already-published URL through, and yields undefined for an
   * empty slot. Throws when sanitizing or uploading fails.
   */
  resolveForPublish: () => Promise<string | undefined>;
}

function useShopImageSlot(maxSize: number): ShopImageSlotInternal {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [state, setState] = useState<ShopImageSlotState>({ kind: 'empty' });
  const [error, setError] = useState<ShopImageSlotError | null>(null);
  const existingPreviewUrl = useMarketplaceMediaUrl(state.kind === 'existing' ? state.url : null);
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(
    () => () => {
      if (stateRef.current.kind === 'pending') URL.revokeObjectURL(stateRef.current.previewUrl);
    },
    [],
  );

  const replaceState = useCallback((next: ShopImageSlotState) => {
    setState((current) => {
      if (current.kind === 'pending') URL.revokeObjectURL(current.previewUrl);
      return next;
    });
  }, []);

  const onInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (event.target) event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('invalid-type');
      return;
    }
    if (file.size > maxSize) {
      setError('too-large');
      return;
    }
    setError(null);
    replaceState({ kind: 'pending', file, previewUrl: URL.createObjectURL(file) });
  };

  const remove = () => {
    setError(null);
    replaceState({ kind: 'empty' });
  };

  const setExisting = useCallback(
    (url: string | undefined) => {
      setError(null);
      replaceState(url ? { kind: 'existing', url } : { kind: 'empty' });
    },
    [replaceState],
  );

  const resolveForPublish = async (): Promise<string | undefined> => {
    const current = stateRef.current;
    if (current.kind === 'empty') return undefined;
    if (current.kind === 'existing') return current.url;

    const sanitized = await stripImageMetadata(current.file);
    const bytes = new Uint8Array(await sanitized.arrayBuffer());
    const mediaId = crypto.randomUUID().replaceAll('-', '');
    const url = await CommerceController.commitCreateMedia(mediaId, bytes);
    // The bytes are on the homeserver now; keep the record URL so a retry of
    // a later failing step (or the next edit session) never re-uploads them.
    setExisting(url);
    return url;
  };

  return {
    slot: {
      previewUrl: state.kind === 'pending' ? state.previewUrl : state.kind === 'existing' ? existingPreviewUrl : null,
      hasImage: state.kind !== 'empty',
      error,
      inputRef,
      choose: () => inputRef.current?.click(),
      onInputChange,
      remove,
    },
    setExisting,
    resolveForPublish,
  };
}

export function useMarketplaceShopSettings() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);
  const [revision, setRevision] = useState(0);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  // The full fetched record, spread on save so members this form does not
  // edit — transactionService, and any field a newer writer added — survive
  // the read-modify-write (open-world records, social/v1 alignment).
  const [existingRecord, setExistingRecord] = useState<CommerceShopRecord | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const avatar = useShopImageSlot(IMAGE_MAX_RAW_SIZE);
  const banner = useShopImageSlot(IMAGE_MAX_RAW_SIZE);
  const form = useForm<MarketplaceShopSettingsData>({
    resolver: zodResolver(marketplaceShopSettingsSchema),
    defaultValues: marketplaceShopSettingsDefaults,
    mode: 'onChange',
  });
  const setAvatarExisting = avatar.setExisting;
  const setBannerExisting = banner.setExisting;

  useEffect(() => {
    if (!currentUserPubky) return;
    let active = true;
    // Network-first so a seller on a fresh device edits their published shop
    // instead of unknowingly starting a competing revision-1 record; the
    // local cache remains the fallback when the homeserver is unreachable.
    CommerceController.getOrFetchShop(currentUserPubky)
      .then((record) => (active ? hydrate(record) : undefined))
      .catch(async () => {
        const cached = await CommerceController.getShop(currentUserPubky).catch(() => null);
        if (!active) return;
        if (cached) hydrate(cached.record);
        else setIsLoading(false);
      });

    function hydrate(record: CommerceShopRecord) {
      setExistingRecord(record);
      setRevision(record.revision);
      setCreatedAt(record.createdAt);
      setAvatarExisting(record.avatarUrl);
      setBannerExisting(record.bannerUrl);
      form.reset({
        name: record.name,
        bio: record.bio,
        countryCode: record.location.countryCode,
        region: record.location.region ?? '',
        shippingPolicy: record.shippingPolicy,
        returnPolicy: record.returnPolicy,
        vacationMode: record.vacationMode,
      });
      setIsLoading(false);
    }

    return () => {
      active = false;
    };
  }, [currentUserPubky, form, setAvatarExisting, setBannerExisting]);

  const submit = async () => {
    if (!currentUserPubky) return false;
    let succeeded = false;
    setIsSaving(true);
    await form.handleSubmit(async (data) => {
      const now = new Date().toISOString();
      const isFirstSave = revision === 0;

      let avatarUrl: string | undefined;
      let bannerUrl: string | undefined;
      try {
        avatarUrl = await avatar.resolveForPublish();
      } catch (uploadError) {
        toast({
          variant: 'error',
          description: isHomeserverWriteScopeError(uploadError)
            ? HOMESERVER_WRITE_SCOPE_REMEDY
            : marketplaceFailureMessage(
                marketplaceErrorCode(uploadError),
                'Could not upload the shop avatar image. Nothing was saved.',
              ),
        });
        return;
      }
      try {
        bannerUrl = await banner.resolveForPublish();
      } catch (uploadError) {
        toast({
          variant: 'error',
          description: isHomeserverWriteScopeError(uploadError)
            ? HOMESERVER_WRITE_SCOPE_REMEDY
            : marketplaceFailureMessage(
                marketplaceErrorCode(uploadError),
                'Could not upload the shop banner image. Nothing was saved.',
              ),
        });
        return;
      }

      try {
        await CommerceController.commitUpsertShop({
          // Unedited members of the fetched record survive the save verbatim.
          ...(existingRecord ?? {}),
          schemaVersion: COMMERCE_CONTRACT_VERSION,
          recordType: 'shop',
          ownerPubky: currentUserPubky,
          revision: revision + 1,
          createdAt: createdAt ?? now,
          updatedAt: now,
          name: data.name,
          bio: data.bio,
          location: { countryCode: data.countryCode.toUpperCase(), region: data.region || undefined },
          avatarUrl,
          bannerUrl,
          shippingPolicy: data.shippingPolicy,
          returnPolicy: data.returnPolicy,
          vacationMode: data.vacationMode,
        });
        setRevision((current) => current + 1);
        setCreatedAt((current) => current ?? now);
        succeeded = true;
        toast(
          isFirstSave
            ? { title: 'Shop created', description: 'Your shop page is now live for buyers.' }
            : { title: 'Shop settings saved' },
        );
      } catch {
        toast({ variant: 'error', description: MARKETPLACE_FAILURE_MESSAGES.shopSettings });
      }
    })();
    setIsSaving(false);
    return succeeded;
  };

  return {
    form,
    revision,
    isLoading,
    /** True while images upload and the record publishes; the form disables its controls. */
    isSaving,
    /** True once an owner-signed shop record exists (locally cached or just saved). */
    hasShop: revision > 0,
    avatar: avatar.slot,
    banner: banner.slot,
    submit,
  };
}
