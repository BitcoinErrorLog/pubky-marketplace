import { z } from 'zod';
import {
  DIGITAL_TEXT_MAX_CHARS,
  isDigitalDeliveryLink,
  marketplaceDigitalDeliveryKindSchema,
} from '@/libs/commerce/digital';

export const DIGITAL_DELIVERY_FORM_FIELDS = {
  KIND: 'kind',
  URL: 'url',
  TEXT: 'text',
} as const;

/**
 * The seller's digital delivery choice (digital delivery design §2). The
 * file itself is not a form field: it lives in `useDigitalFilePicker` and is
 * checked there.
 */
export const digitalDeliveryFormSchema = z
  .object({
    kind: marketplaceDigitalDeliveryKindSchema,
    url: z.string().trim(),
    text: z.string(),
  })
  .superRefine((data, context) => {
    if (data.kind === 'link' && !isDigitalDeliveryLink(data.url)) {
      context.addIssue({
        code: 'custom',
        path: [DIGITAL_DELIVERY_FORM_FIELDS.URL],
        message: 'Enter an https:// link.',
      });
    }
    if (data.kind === 'text') {
      if (data.text.trim() === '') {
        context.addIssue({
          code: 'custom',
          path: [DIGITAL_DELIVERY_FORM_FIELDS.TEXT],
          message: 'Enter the text every buyer receives.',
        });
      } else if (Array.from(data.text).length > DIGITAL_TEXT_MAX_CHARS) {
        context.addIssue({
          code: 'custom',
          path: [DIGITAL_DELIVERY_FORM_FIELDS.TEXT],
          message: 'Keep the text to 4,000 characters or fewer.',
        });
      }
    }
  });

export type DigitalDeliveryFormData = z.infer<typeof digitalDeliveryFormSchema>;

export const digitalDeliveryFormDefaults: DigitalDeliveryFormData = {
  kind: 'file',
  url: '',
  text: '',
};

/** The five kinds in the order the studio offers them, with the seller-facing label and line. */
export const DIGITAL_DELIVERY_KIND_OPTIONS = [
  { kind: 'file', label: 'A file', description: 'Up to 50 MB. Buyers download it from the order page after payment.' },
  { kind: 'link', label: 'A link', description: 'A Dropbox, Drive or course link, hidden until payment.' },
  { kind: 'text', label: 'Text or a licence key', description: 'The same text for every buyer, shown after payment.' },
  {
    kind: 'email',
    label: "I'll email it",
    description: 'You see the buyer\u2019s email after payment and send it yourself.',
  },
  {
    kind: 'message',
    label: "I'll send it in messages",
    description: 'You send it in the order\u2019s message thread.',
  },
] as const satisfies ReadonlyArray<{ kind: DigitalDeliveryFormData['kind']; label: string; description: string }>;
