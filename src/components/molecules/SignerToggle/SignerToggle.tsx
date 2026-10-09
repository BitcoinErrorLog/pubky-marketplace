'use client';

import { ToggleGroup } from 'radix-ui';
import { Bitkit, PubkyIcon } from '@/icons';
import { cn } from '@/libs/utils/utils';

export type SignerOption = 'ring' | 'bitkit';

export function SignerToggle({
  value,
  onValueChange,
  label = 'Approval app',
  className,
  disabledReasons,
}: {
  value: SignerOption;
  onValueChange: (value: SignerOption) => void;
  label?: string;
  className?: string;
  disabledReasons?: Partial<Record<SignerOption, string>>;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(option) => {
        if (option === 'ring' || option === 'bitkit') onValueChange(option);
      }}
      aria-label={label}
      className={cn('flex w-full', className)}
    >
      {(['ring', 'bitkit'] as const).map((option) => (
        <ToggleGroup.Item
          key={option}
          value={option}
          disabled={Boolean(disabledReasons?.[option])}
          title={disabledReasons?.[option]}
          className={cn(
            'group relative inline-flex min-h-12 flex-1 shrink-0 cursor-pointer items-center justify-center gap-2 border-b px-4 py-2 text-sm font-medium whitespace-nowrap transition-colors hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50',
            value === option ? 'border-white text-white' : 'border-border text-muted-foreground',
          )}
        >
          {option === 'ring' ? (
            <PubkyIcon
              className={cn(
                'size-5 shrink-0 text-white transition-opacity [&_path]:fill-current',
                value !== option && 'opacity-50 group-hover:opacity-100',
              )}
              aria-hidden="true"
            />
          ) : (
            <Bitkit
              className={cn(
                'size-5 shrink-0 transition-opacity',
                value !== option && 'opacity-50 group-hover:opacity-100',
              )}
              aria-hidden="true"
            />
          )}
          {option === 'ring' ? 'Pubky Ring' : 'Bitkit'}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}
