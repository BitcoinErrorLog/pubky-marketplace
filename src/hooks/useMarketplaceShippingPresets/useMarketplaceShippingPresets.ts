'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { CommerceController } from '@/controllers/commerce/commerce';
import type { CommerceShippingPresetModelSchema } from '@/models/commerce/commerce.schema';
import { toast } from '@/molecules/Toaster/use-toast';
import { useAuthStore } from '@/stores/auth/auth.store';
import {
  type MarketplaceShippingPresetFields,
  shippingFieldsToPresetInput,
} from './useMarketplaceShippingPresets.types';

/** The stored primary key is `${owner_id}:${presetId}`; the controller takes the bare id. */
export function bareShippingPresetId(preset: CommerceShippingPresetModelSchema): string {
  return preset.id.slice(preset.owner_id.length + 1);
}

/**
 * The seller's device-local shipping preset templates
 * (`commerce_shipping_presets`). Presets are authoring convenience only —
 * nothing about them is published; applying one just fills the sell studio's
 * shipping fields, and the listing record keeps its existing shape.
 */
export function useMarketplaceShippingPresets() {
  const currentUserPubky = useAuthStore((state) => state.currentUserPubky);

  const presets = useLiveQuery(
    async () => {
      if (!currentUserPubky) return [];
      return await CommerceController.getShippingPresets();
    },
    [currentUserPubky],
    undefined,
  );

  const saveFromFields = async (presetId: string | null, fields: MarketplaceShippingPresetFields): Promise<boolean> => {
    const input = shippingFieldsToPresetInput(fields);
    if (!input) {
      toast({
        variant: 'error',
        description: 'Complete the shipping label, price, and delivery estimates before saving a preset.',
      });
      return false;
    }
    try {
      await CommerceController.commitUpsertShippingPreset(presetId ?? crypto.randomUUID().replaceAll('-', ''), input);
      toast({ title: 'Shipping preset saved', description: `"${input.label}" is ready to apply to future listings.` });
      return true;
    } catch {
      toast({ variant: 'error', description: 'The shipping preset could not be saved.' });
      return false;
    }
  };

  const remove = async (preset: CommerceShippingPresetModelSchema): Promise<void> => {
    try {
      await CommerceController.commitDeleteShippingPreset(bareShippingPresetId(preset));
    } catch {
      toast({ variant: 'error', description: 'The shipping preset could not be deleted.' });
    }
  };

  return {
    presets: presets ?? [],
    isLoading: presets === undefined,
    saveFromFields,
    remove,
  };
}
