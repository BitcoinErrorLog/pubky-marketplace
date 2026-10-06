import { Typography } from '@/atoms/Typography/Typography';
import { cn } from '@/libs/utils/utils';

/**
 * The one plain sentence shown beside a QR or deeplink whose approval also
 * produces a marketplace session. Renders nothing without a sentence.
 */
export function MarketplaceApprovalDisclosure({
  sentence,
  className,
}: {
  sentence: string | null;
  className?: string;
}) {
  if (!sentence) return null;
  return (
    <Typography
      as="p"
      data-testid="session-approval-disclosure"
      className={cn('max-w-xs text-center text-sm text-muted-foreground', className)}
    >
      {sentence}
    </Typography>
  );
}
