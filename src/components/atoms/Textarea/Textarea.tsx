import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { FORM_FIELD_SURFACE_CLASSES } from '@/config/forms';
import { cn } from '@/libs/utils/utils';

const textareaVariants = cva(
  'flex field-sizing-content w-full rounded-md bg-transparent text-base wrap-anywhere outline-none placeholder:text-input disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-destructive/40 transition-[color,box-shadow]',
  {
    variants: {
      variant: {
        default:
          'min-h-16 border border-input bg-background px-3 py-2 shadow-xs focus-visible:border-ring focus-visible:ring-ring/50',
        dashed: [FORM_FIELD_SURFACE_CLASSES, 'min-h-25 px-5 py-4 shadow-none focus-visible:border-ring'],
        inline:
          'min-h-6 resize-none border-none p-0 font-medium text-secondary-foreground shadow-none focus-visible:ring-0 focus-visible:ring-offset-0',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

function Textarea({
  className,
  variant,
  ...props
}: React.ComponentProps<'textarea'> & VariantProps<typeof textareaVariants>) {
  return <textarea data-slot="textarea" {...props} className={cn(textareaVariants({ variant }), className)} />;
}

export { Textarea, textareaVariants };
