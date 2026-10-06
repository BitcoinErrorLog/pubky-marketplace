'use client';

import { CheckCircle2, Circle } from 'lucide-react';
import { Typography } from '@/atoms/Typography/Typography';

export interface RequiredToPublishItem {
  id: string;
  label: string;
  onSelect: () => void;
  description?: string;
}

interface RequiredToPublishSummaryProps {
  items: RequiredToPublishItem[];
  emptyMessage?: string;
  className?: string;
  isComplete?: boolean;
  titleClassName?: string;
  listClassName?: string;
  itemClassName?: string;
}

export function RequiredToPublishSummary({
  items,
  emptyMessage = 'Every required field is valid.',
  className,
  isComplete,
  titleClassName = 'font-semibold',
  listClassName = 'mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground',
  itemClassName = 'text-muted-foreground hover:underline',
}: RequiredToPublishSummaryProps) {
  return (
    <div className={`flex items-start gap-3${className ? ` ${className}` : ''}`}>
      {isComplete === undefined ? null : isComplete ? (
        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden="true" />
      ) : (
        <Circle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <div>
        <Typography as="p" className={titleClassName}>
          Required to publish
        </Typography>
        {items.length > 0 ? (
          <ul className={listClassName}>
            {items.map((item) => (
              <li key={item.id}>
                <a
                  href={`#${item.id}`}
                  className={itemClassName}
                  onClick={(event) => {
                    event.preventDefault();
                    item.onSelect();
                  }}
                >
                  {item.label}
                </a>
                {item.description ? ` — ${item.description}` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <Typography as="p" className="mt-1 text-sm text-muted-foreground">
            {emptyMessage}
          </Typography>
        )}
      </div>
    </div>
  );
}
