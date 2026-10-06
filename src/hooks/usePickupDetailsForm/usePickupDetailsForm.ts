'use client';

import { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  PICKUP_NOTHING_PUBLISHED_TOAST,
  PICKUP_REVERT_FAILED_TOAST,
  pickupCommandEnvelopeToastDescription,
  pickupCommandToastDescription,
  pickupRefusalFromUnknown,
} from '@/libs/commerce/pickup';
import { browserAddressCountry, DEFAULT_ADDRESS_COUNTRY } from '@/libs/commerce/postal-address';
import { isMarketplaceRevisionConflict } from '@/libs/commerce/transaction-commands';
import { isMarketplaceSessionRequiredError } from '@/libs/error/error.utils';
import { toast } from '@/molecules/Toaster/use-toast';
import {
  type PickupDetailsFormData,
  pickupDetailsFormDefaults,
  pickupDetailsFormSchema,
  pickupDetailsFormValuesFromDetails,
  toPickupDetails,
} from './usePickupDetailsForm.types';

export type PickupDetailsCapability = 'loading' | 'available' | 'unavailable';
export type PickupDetailsReadState = 'loading' | 'ready' | 'failed';

export type UsePickupDetailsFormOptions = {
  /**
   * When `pickup_details.set` is refused because the listing does not yet
   * publish pickup, persist the listing form first and retry the set once.
   * Must be listing-only (no nested pickup save) to avoid a loop.
   */
  persistListing?: () => Promise<boolean>;
  /**
   * After a persist that flipped the listing to pickup, restore the previous
   * fulfilment if the following `pickup_details.set` fails — otherwise the
   * listing stays pickup-only with no sealed meeting point.
   */
  revertListing?: () => Promise<boolean>;
};

export interface UsePickupDetailsFormResult {
  /** The deployment capability (`pickup_available`, §A7): off without the sealing key or on sandbox payments. */
  capability: PickupDetailsCapability;
  /** The owner read (§A4): the editor refuses to save over an unread row. */
  readState: PickupDetailsReadState;
  form: UseFormReturn<PickupDetailsFormData>;
  /** The saved details version; null when none exists (never set, or cleared). */
  currentVersion: number | null;
  /** The surviving per-listing version counter — the CAS base for the next set (post-clear CAS, §A3). */
  lastVersion: number;
  updatedAt: string | null;
  isSaving: boolean;
  /** True only when a save may be attempted: capability on, owner read succeeded, form dirty. */
  canSave: boolean;
  canClear: boolean;
  save: () => Promise<boolean>;
  clearDetails: () => Promise<boolean>;
  /** Retries the capability + owner read after a failure. */
  reload: () => void;
}

/**
 * The seller's pickup-details editor (local pickup design §A4): the service
 * is the source of truth, so the editor always reads first — a failed read
 * blocks the save rather than risking a blind overwrite (the self-heal
 * rule). Writes go through `pickup_details.set` / `pickup_details.clear`
 * with the payload-level CAS (`expected_version`): the current version when
 * details exist, otherwise the surviving counter (post-clear CAS, §A3).
 * Nothing is persisted locally — the details live only in the form and on
 * the service, and telemetry masking is structural (the editor surface
 * carries `data-sentry-mask`; the owner read arrives `MaskedPickupDetails`-wrapped).
 */
export function usePickupDetailsForm(
  listingId: string,
  options: UsePickupDetailsFormOptions = {},
): UsePickupDetailsFormResult {
  const [capability, setCapability] = useState<PickupDetailsCapability>('loading');
  const [readState, setReadState] = useState<PickupDetailsReadState>('loading');
  const [currentVersion, setCurrentVersion] = useState<number | null>(null);
  const [lastVersion, setLastVersion] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);
  const form = useForm<PickupDetailsFormData>({
    resolver: zodResolver(pickupDetailsFormSchema),
    // The device timezone is the honest default for the windows' IANA zone —
    // the seller authors windows in the pickup location's wall clock (§B2
    // timezones; in Wave 7 the windows are informational only).
    // The country is the default until the owner read resets the form with
    // the browser's country, after mount.
    defaultValues: pickupDetailsFormDefaults(
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      DEFAULT_ADDRESS_COUNTRY,
    ),
    mode: 'onChange',
  });

  useEffect(() => {
    let active = true;
    setCapability('loading');
    setReadState('loading');
    const load = async () => {
      let available: boolean;
      try {
        available = await CommerceController.fetchPickupAvailable();
      } catch {
        // A capability read that fails outright degrades to the unavailable
        // note — never a stuck loading state.
        if (!active) return;
        setCapability('unavailable');
        setReadState('failed');
        return;
      }
      if (!active) return;
      if (!available) {
        setCapability('unavailable');
        setReadState('failed');
        return;
      }
      setCapability('available');
      try {
        const ownerRead = await CommerceController.fetchSellerPickupDetails(listingId);
        if (!active) return;
        setLastVersion(ownerRead.lastVersion);
        setCurrentVersion(ownerRead.current?.version ?? null);
        setUpdatedAt(ownerRead.current?.updatedAt ?? null);
        // The plaintext is unwrapped for the edit surface only — never
        // logged, never persisted (MaskedPickupDetails makes that structural).
        form.reset(
          ownerRead.current
            ? pickupDetailsFormValuesFromDetails(ownerRead.current.details.value, browserAddressCountry())
            : pickupDetailsFormDefaults(
                Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
                browserAddressCountry(),
              ),
        );
        setReadState('ready');
      } catch {
        // The owner read failing leaves the cache marked stale — the editor
        // refuses to save over an unread row (§A4).
        if (active) setReadState('failed');
      }
    };
    void load();
    return () => {
      active = false;
    };
    // `form` is a stable hook result; re-running on it would clobber edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listingId, reloadNonce]);

  const save = async (): Promise<boolean> => {
    if (capability !== 'available' || readState !== 'ready') return false;
    let succeeded = false;
    setIsSaving(true);
    try {
      await form.handleSubmit(async (data) => {
        const expectedVersion = currentVersion ?? lastVersion;
        const details = toPickupDetails(data);
        const commit = () =>
          CommerceController.commitSetPickupDetails(listingId, {
            expectedVersion,
            details,
          });
        const applyResponse = async (response: Awaited<ReturnType<typeof commit>>): Promise<boolean> => {
          if (!response.ok) {
            if (isMarketplaceRevisionConflict(response)) {
              setReloadNonce((nonce) => nonce + 1);
              toast({
                variant: 'error',
                description:
                  'The pickup details changed since you loaded them (another device, perhaps). The latest version was reloaded — review and save again.',
              });
              return false;
            }
            toast({
              variant: 'error',
              description: pickupCommandEnvelopeToastDescription(response.error.code, response.error.message),
            });
            return false;
          }
          toast({ title: 'Pickup details saved', description: 'Buyers see them only after their payment confirms.' });
          setReloadNonce((nonce) => nonce + 1);
          return true;
        };
        const toastSaveError = (saveError: unknown) => {
          if (isMarketplaceSessionRequiredError(saveError)) {
            toast({ variant: 'error', description: saveError.message });
            return;
          }
          toast({
            variant: 'error',
            description: pickupCommandToastDescription(pickupRefusalFromUnknown(saveError)),
          });
        };
        const revertPersistedPickup = async () => {
          if (!options.revertListing) return;
          let reverted = false;
          try {
            reverted = await options.revertListing();
          } catch {
            reverted = false;
          }
          toast({
            variant: 'error',
            description: reverted ? PICKUP_NOTHING_PUBLISHED_TOAST : PICKUP_REVERT_FAILED_TOAST,
          });
        };
        try {
          // CAS base: the current version, or the surviving counter after a
          // clear — never a hidden second read (§A3).
          succeeded = await applyResponse(await commit());
        } catch (saveError) {
          if (isMarketplaceSessionRequiredError(saveError)) {
            toast({ variant: 'error', description: saveError.message });
            return;
          }
          const refusal = pickupRefusalFromUnknown(saveError);
          if (refusal === 'pickup_not_published' && options.persistListing) {
            let persisted = false;
            try {
              persisted = await options.persistListing();
            } catch {
              persisted = false;
            }
            if (persisted) {
              try {
                succeeded = await applyResponse(await commit());
                if (!succeeded) await revertPersistedPickup();
                return;
              } catch (retryError) {
                await revertPersistedPickup();
                toastSaveError(retryError);
                return;
              }
            }
          }
          toastSaveError(saveError);
        }
      })();
    } finally {
      setIsSaving(false);
    }
    return succeeded;
  };

  const clearDetails = async (): Promise<boolean> => {
    if (capability !== 'available' || readState !== 'ready' || currentVersion === null) return false;
    setIsSaving(true);
    try {
      const response = await CommerceController.commitClearPickupDetails(listingId, currentVersion);
      if (!response.ok) {
        if (isMarketplaceRevisionConflict(response)) {
          setReloadNonce((nonce) => nonce + 1);
          toast({
            variant: 'error',
            description: 'The pickup details changed since you loaded them. The latest version was reloaded — retry.',
          });
          return false;
        }
        toast({
          variant: 'error',
          description: pickupCommandEnvelopeToastDescription(response.error.code, response.error.message),
        });
        return false;
      }
      toast({ title: 'Pickup details removed', description: 'Paid buyers keep the terms they were shown at payment.' });
      setReloadNonce((nonce) => nonce + 1);
      return true;
    } catch (clearError) {
      if (isMarketplaceSessionRequiredError(clearError)) {
        toast({ variant: 'error', description: clearError.message });
        return false;
      }
      toast({ variant: 'error', description: 'The pickup details could not be removed.' });
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  return {
    capability,
    readState,
    form,
    currentVersion,
    lastVersion,
    updatedAt,
    isSaving,
    canSave: capability === 'available' && readState === 'ready' && form.formState.isDirty && !isSaving,
    canClear: capability === 'available' && readState === 'ready' && currentVersion !== null && !isSaving,
    save,
    clearDetails,
    reload: () => setReloadNonce((nonce) => nonce + 1),
  };
}
