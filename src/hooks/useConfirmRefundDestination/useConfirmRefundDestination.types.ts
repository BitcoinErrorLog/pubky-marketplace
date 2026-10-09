import { z } from 'zod';
import { isValidArbitrumAddress, USDT_REFUND_COPY } from '@/libs/commerce/usdt-refund';

export const CONFIRM_REFUND_DESTINATION_FIELDS = {
  SOURCE: 'source',
  ADDRESS: 'address',
  NETWORK_CONFIRMED: 'networkConfirmed',
} as const;

/** `payment` is the address the buyer paid from, offered only when the order projection carries it. */
export const REFUND_DESTINATION_SOURCES = ['another', 'payment'] as const;

export const confirmRefundDestinationFormSchema = z
  .object({
    [CONFIRM_REFUND_DESTINATION_FIELDS.SOURCE]: z.enum(REFUND_DESTINATION_SOURCES),
    [CONFIRM_REFUND_DESTINATION_FIELDS.ADDRESS]: z.string().trim(),
    [CONFIRM_REFUND_DESTINATION_FIELDS.NETWORK_CONFIRMED]: z.boolean(),
  })
  .superRefine((data, context) => {
    if (data.source === 'another') {
      if (data.address.length === 0) {
        context.addIssue({ code: 'custom', path: ['address'], message: USDT_REFUND_COPY.addressRequired });
      } else if (!isValidArbitrumAddress(data.address)) {
        context.addIssue({ code: 'custom', path: ['address'], message: USDT_REFUND_COPY.addressInvalid });
      }
    }
    if (!data.networkConfirmed) {
      context.addIssue({
        code: 'custom',
        path: ['networkConfirmed'],
        message: USDT_REFUND_COPY.networkConfirmationRequired,
      });
    }
  });

export type ConfirmRefundDestinationFormData = z.infer<typeof confirmRefundDestinationFormSchema>;

export const confirmRefundDestinationFormDefaults: ConfirmRefundDestinationFormData = {
  source: 'another',
  address: '',
  networkConfirmed: false,
};
