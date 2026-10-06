'use client';

import { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { CommerceController } from '@/controllers/commerce/commerce';
import {
  useDigitalFilePicker,
  type UseDigitalFilePickerResult,
} from '@/hooks/useDigitalFilePicker/useDigitalFilePicker';
import {
  classifyDigitalDeliverySetupRefusal,
  DIGITAL_DELIVERY_SETUP_COPY,
  DIGITAL_READ_REFUSAL_COPY,
  digitalDeliveryVersionLine,
  digitalFileTooLargeCopy,
  type MarketplaceDigitalDeliveryInput,
  type MarketplaceSellerDigitalDelivery,
} from '@/libs/commerce/digital';
import { isAppError } from '@/libs/error/error';
import { ErrorService } from '@/libs/error/error.types';
import { toast } from '@/molecules/Toaster/use-toast';
import {
  type DigitalDeliveryFormData,
  digitalDeliveryFormDefaults,
  digitalDeliveryFormSchema,
} from './useDigitalDeliveryEditor.types';

export type DigitalDeliveryEditorReadState = 'idle' | 'loading' | 'ready' | 'failed';

export interface UseDigitalDeliveryEditorResult {
  form: UseFormReturn<DigitalDeliveryFormData>;
  picker: UseDigitalFilePickerResult;
  readState: DigitalDeliveryEditorReadState;
  /** The owner read: the seller's own delivery, held in memory only. */
  delivery: MarketplaceSellerDigitalDelivery | null;
  /** "Version 2 is live. 3 buyers still download version 1." */
  versionLine: string | null;
  isSaving: boolean;
  /** A plain-language failure for the last save or clear, never the service's message. */
  error: string | null;
  reload: () => Promise<void>;
  submit: () => Promise<boolean>;
  clear: () => Promise<boolean>;
}

/** Homeserver refusals of the upload itself: a full quota reads as "storage is full" (§2 "Size"). */
/**
 * Why a file set threw: the encryption on this device (nothing left it), the
 * seller's homeserver refusing the ciphertext, or anything after the upload
 * (the command itself), which is not the homeserver's doing.
 */
function fileSetFailureCopy(error: unknown): string {
  if (!isAppError(error)) return DIGITAL_DELIVERY_SETUP_COPY.failed;
  if (error.context?.refusal === 'encrypt_failed') return DIGITAL_DELIVERY_SETUP_COPY.encryptFailed;
  if (error.service !== ErrorService.Homeserver) return DIGITAL_DELIVERY_SETUP_COPY.failed;
  const status = error.context?.statusCode;
  return status === 413 || status === 507
    ? DIGITAL_DELIVERY_SETUP_COPY.uploadStorageFull
    : DIGITAL_DELIVERY_SETUP_COPY.uploadFailed;
}

/**
 * The seller's Digital delivery panel (digital delivery design §2, §6
 * C1–C5): reads the listing's current delivery, sets a new one (a file is
 * encrypted on this device before it leaves), and clears it. `enabled`
 * gates the owner read on the deployment's capability and on the published
 * record already selling by digital delivery.
 */
export function useDigitalDeliveryEditor({
  listingId,
  enabled,
  maxBytes,
}: {
  listingId: string;
  enabled: boolean;
  maxBytes: number | null;
}): UseDigitalDeliveryEditorResult {
  const form = useForm<DigitalDeliveryFormData>({
    resolver: zodResolver(digitalDeliveryFormSchema),
    defaultValues: digitalDeliveryFormDefaults,
    mode: 'onChange',
  });
  const picker = useDigitalFilePicker(maxBytes);
  const [readState, setReadState] = useState<DigitalDeliveryEditorReadState>('idle');
  const [delivery, setDelivery] = useState<MarketplaceSellerDigitalDelivery | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<MarketplaceSellerDigitalDelivery | null> => {
    setReadState('loading');
    try {
      const read = await CommerceController.fetchSellerDigitalDelivery(listingId);
      setDelivery(read);
      setReadState('ready');
      const current = read.current;
      form.reset({
        kind: current?.kind ?? digitalDeliveryFormDefaults.kind,
        url: current?.url ?? '',
        text: current?.text ?? '',
      });
      return read;
    } catch {
      setDelivery(null);
      setReadState('failed');
      return null;
    }
  };

  useEffect(() => {
    if (!enabled) {
      setReadState('idle');
      setDelivery(null);
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the read follows the listing and the gate only
  }, [enabled, listingId]);

  const inputFor = async (values: DigitalDeliveryFormData): Promise<MarketplaceDigitalDeliveryInput | null> => {
    switch (values.kind) {
      case 'file': {
        const file = picker.file;
        if (!file) return null;
        return {
          kind: 'file',
          bytes: new Uint8Array(await file.arrayBuffer()),
          fileName: file.name,
          contentType: file.type,
        };
      }
      case 'link':
        return { kind: 'link', url: values.url.trim() };
      case 'text':
        return { kind: 'text', text: values.text };
      case 'email':
        return { kind: 'email' };
      case 'message':
        return { kind: 'message' };
    }
  };

  const submit = async (): Promise<boolean> => {
    if (!delivery) return false;
    setError(null);
    const valid = await form.trigger();
    if (!valid) return false;
    const values = form.getValues();
    if (values.kind === 'file' && !picker.file) {
      setError(picker.error ?? 'Choose the file buyers receive.');
      return false;
    }
    setIsSaving(true);
    try {
      const input = await inputFor(values);
      if (!input) return false;
      let response;
      try {
        response = await CommerceController.commitSetDigitalDelivery(listingId, {
          expectedVersion: delivery.lastVersion,
          delivery: input,
        });
      } catch (caught) {
        setError(input.kind === 'file' ? fileSetFailureCopy(caught) : DIGITAL_DELIVERY_SETUP_COPY.failed);
        return false;
      }
      if (!response.ok) {
        const refusal = classifyDigitalDeliverySetupRefusal(response.error);
        setError(
          refusal === 'too_large'
            ? digitalFileTooLargeCopy(maxBytes)
            : refusal
              ? DIGITAL_DELIVERY_SETUP_COPY[refusal]
              : DIGITAL_DELIVERY_SETUP_COPY.failed,
        );
        if (refusal === 'changed') await load();
        return false;
      }
      picker.reset();
      const read = await load();
      toast({
        description: (read && digitalDeliveryVersionLine(read)) ?? 'Delivery saved.',
      });
      return true;
    } finally {
      setIsSaving(false);
    }
  };

  const clear = async (): Promise<boolean> => {
    if (!delivery?.current) return false;
    setError(null);
    setIsSaving(true);
    try {
      const response = await CommerceController.commitClearDigitalDelivery(listingId, delivery.lastVersion);
      if (!response.ok) {
        const refusal = classifyDigitalDeliverySetupRefusal(response.error);
        setError(refusal ? DIGITAL_DELIVERY_SETUP_COPY[refusal] : DIGITAL_DELIVERY_SETUP_COPY.failed);
        if (refusal === 'changed') await load();
        return false;
      }
      await load();
      toast({ description: 'Delivery removed. Buyers cannot check out until you set it again.' });
      return true;
    } catch {
      setError(DIGITAL_DELIVERY_SETUP_COPY.failed);
      return false;
    } finally {
      setIsSaving(false);
    }
  };

  return {
    form,
    picker,
    readState,
    delivery,
    versionLine: delivery ? digitalDeliveryVersionLine(delivery) : null,
    isSaving,
    error: error ?? (readState === 'failed' ? DIGITAL_READ_REFUSAL_COPY.failed : null),
    reload: async () => {
      await load();
    },
    submit,
    clear,
  };
}
