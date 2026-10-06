'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { CommerceDeliveryAddressModelSchema } from '@/models/commerce/commerce.schema';
import { toast } from '@/molecules/Toaster/use-toast';
import { useAuthStore } from '@/stores/auth/auth.store';
import type { MarketplaceAddressFormData } from './useMarketplaceAddressBook.types';

/** The stored primary key is `${owner_id}:${addressId}`; the controller takes the bare id. */
export function bareDeliveryAddressId(address: CommerceDeliveryAddressModelSchema): string {
  return address.id.slice(address.owner_id.length + 1);
}

/**
 * CRUD over the buyer's private, device-local address book
 * (`commerce_delivery_addresses`). Addresses never touch the homeserver and
 * are never readable back from the transaction service (ADR-0019 §8) — this
 * hook and the checkout command are the only things that ever see them.
 */
export function useMarketplaceAddressBook() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);

  const addresses = useLiveQuery(
    async () => {
      if (!currentUserPubky) return [];
      return await CommerceController.getDeliveryAddresses();
    },
    [currentUserPubky],
    undefined,
  );

  const save = async (addressId: string | null, data: MarketplaceAddressFormData): Promise<boolean> => {
    try {
      await CommerceController.commitUpsertDeliveryAddress(addressId ?? crypto.randomUUID().replaceAll('-', ''), {
        label: data.label,
        name: data.name,
        line1: data.line1,
        line2: data.line2,
        city: data.city,
        region: data.region,
        postalCode: data.postalCode,
        countryCode: data.countryCode.toUpperCase(),
      });
      return true;
    } catch {
      toast({ variant: 'error', description: 'The address could not be saved.' });
      return false;
    }
  };

  const remove = async (address: CommerceDeliveryAddressModelSchema): Promise<void> => {
    try {
      await CommerceController.commitDeleteDeliveryAddress(bareDeliveryAddressId(address));
    } catch {
      toast({ variant: 'error', description: 'The address could not be deleted.' });
    }
  };

  const setDefault = async (address: CommerceDeliveryAddressModelSchema): Promise<void> => {
    try {
      await CommerceController.commitSetDefaultDeliveryAddress(bareDeliveryAddressId(address));
    } catch {
      toast({ variant: 'error', description: 'The default address could not be changed.' });
    }
  };

  return {
    addresses: addresses ?? [],
    isLoading: addresses === undefined,
    save,
    remove,
    setDefault,
  };
}
