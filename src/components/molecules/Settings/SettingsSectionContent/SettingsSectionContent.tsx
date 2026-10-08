import type { ComponentProps } from 'react';
import { cn } from '@/libs/utils/utils';

export const SETTINGS_SECTION_CONTENT_CLASSNAME =
  'grid w-full min-w-0 gap-9 rounded-md border border-border bg-card p-6 shadow-lg';

/** Shared inset surface for grouped settings and marketplace sections. */
export function SettingsSectionContent({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="settings-section-content"
      className={cn(SETTINGS_SECTION_CONTENT_CLASSNAME, className)}
      {...props}
    />
  );
}
