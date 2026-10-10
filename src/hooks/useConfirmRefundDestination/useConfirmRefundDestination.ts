'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { CONFIRM_REFUND_DESTINATION_KIND } from '@/libs/commerce/usdt-refund';
import { toast } from '@/molecules/Toaster/use-toast';
import type { MarketplaceOrder } from '@/services/marketplace/marketplace';
import {
  type ConfirmRefundDestinationFormData,
  confirmRefundDestinationFormDefaults,
  confirmRefundDestinationFormSchema,
} from './useConfirmRefundDestination.types';

type UseConfirmRefundDestinationResult = {
  form: UseFormReturn<ConfirmRefundDestinationFormData>;
  /** The address the buyer paid from, when the service projects it; the "original address" choice exists only then. */
  paymentAddress: string | null;
  /** Validates and sends `refund.confirm_destination`; true when the service accepted it. */
  submit: () => Promise<boolean>;
  /** Back to a blank form, or to the current address when the buyer is replacing it. */
  reset: (currentAddress?: string) => void;
};

/**
 * The buyer's refund-address form on a USDT order (plan §2.6, W4). It sends
 * only the address: the service stores it as the buyer's confirmation, and
 * choosing "the address I paid from" simply submits that address.
 */
export function useConfirmRefundDestination(
  order: MarketplaceOrder,
  actOnOrder: (order: MarketplaceOrder, kind: string, payload: Record<string, unknown>) => Promise<boolean>,
): UseConfirmRefundDestinationResult {
  const paymentAddress = order.paymentAddress ?? null;
  const defaults: ConfirmRefundDestinationFormData = {
    ...confirmRefundDestinationFormDefaults,
    source: paymentAddress ? 'payment' : 'another',
  };
  const form = useForm<ConfirmRefundDestinationFormData>({
    resolver: zodResolver(confirmRefundDestinationFormSchema),
    defaultValues: defaults,
    mode: 'onChange',
  });

  const reset = (currentAddress?: string) => {
    form.reset({ ...defaults, ...(currentAddress ? { source: 'another', address: currentAddress } : {}) });
  };

  const submit = async (): Promise<boolean> => {
    let succeeded = false;
    await form.handleSubmit(async (data) => {
      const address = data.source === 'payment' && paymentAddress ? paymentAddress : data.address;
      succeeded = await actOnOrder(order, CONFIRM_REFUND_DESTINATION_KIND, { address });
      if (succeeded) toast({ title: 'Refund address confirmed' });
    })();
    return succeeded;
  };

  return { form, paymentAddress, submit, reset };
}
