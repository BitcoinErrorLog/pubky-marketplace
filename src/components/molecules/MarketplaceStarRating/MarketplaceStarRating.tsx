import { Check, Star } from 'lucide-react';
import { Typography } from '@/atoms/Typography/Typography';
import { cn } from '@/libs/utils/utils';

export interface MarketplaceStarRatingProps {
  /** Star average on the 1–5 scale (callers never pass a fabricated 0). */
  rating: number;
  /** Total review count behind the average; rendered when provided. */
  count?: number;
  /**
   * Verified-review count (reviews whose purchase attestation
   * cryptographically verified at the index). Rendered as the "✓ n" affix
   * when provided and positive.
   */
  verifiedCount?: number;
  size?: 'sm' | 'md';
  className?: string;
}

/**
 * The shared star row for cards, rating headers, and review items: five
 * stars with fractional fill, the numeric average, and the optional
 * count / verified affixes. Purely presentational — the truthfulness rules
 * (absence over zeros, "New seller" instead of 0.0) live with the callers,
 * which must simply not render this component without real data.
 */
export function MarketplaceStarRating({
  rating,
  count,
  verifiedCount,
  size = 'sm',
  className,
}: MarketplaceStarRatingProps) {
  const starSize = size === 'sm' ? 'size-3.5' : 'size-4.5';
  const textSize = size === 'sm' ? 'text-[11px]' : 'text-sm';
  const clamped = Math.min(5, Math.max(0, rating));

  return (
    <div
      className={cn('flex items-center gap-1.5', className)}
      role="img"
      aria-label={`Rated ${clamped.toFixed(1)} out of 5${count !== undefined ? ` from ${count} ${count === 1 ? 'review' : 'reviews'}` : ''}${verifiedCount !== undefined && verifiedCount > 0 ? `, ${verifiedCount} verified ${verifiedCount === 1 ? 'purchase' : 'purchases'}` : ''}`}
    >
      <div className="relative inline-flex" aria-hidden="true">
        <div className="flex gap-0.5">
          {[0, 1, 2, 3, 4].map((index) => (
            <Star key={index} className={cn(starSize, 'text-muted-foreground/40')} />
          ))}
        </div>
        <div className="absolute inset-0 overflow-hidden" style={{ width: `${(clamped / 5) * 100}%` }}>
          <div className="flex gap-0.5">
            {[0, 1, 2, 3, 4].map((index) => (
              <Star key={index} className={cn(starSize, 'shrink-0 fill-chart-6 text-chart-6')} />
            ))}
          </div>
        </div>
      </div>
      <Typography as="span" className={cn(textSize, 'font-semibold text-foreground')}>
        {clamped.toFixed(1)}
      </Typography>
      {count !== undefined && (
        <Typography
          as="span"
          className={cn(textSize, 'ml-2 inline-flex items-center gap-1 text-muted-foreground')}
          title={`${count} ${count === 1 ? 'review' : 'reviews'}`}
        >
          <Star className={starSize} aria-hidden="true" />
          {count}
        </Typography>
      )}
      {verifiedCount !== undefined && verifiedCount > 0 && (
        <Typography
          as="span"
          className={cn(textSize, 'inline-flex items-center gap-1 text-muted-foreground')}
          title={`${verifiedCount} verified ${verifiedCount === 1 ? 'purchase' : 'purchases'}`}
        >
          <Check className={starSize} aria-hidden="true" />
          {verifiedCount}
        </Typography>
      )}
    </div>
  );
}
