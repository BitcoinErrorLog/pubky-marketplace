import { Badge } from '@/atoms/Badge/Badge';
import type { MarketplaceFulfillmentMethod } from '@/libs/commerce/pickup';

/**
 * The badge label for the methods a listing sells by (local pickup design
 * §A1; digital delivery design §2).
 */
export function marketplaceFulfillmentLabel(methods: readonly MarketplaceFulfillmentMethod[]): string {
  const pickup = methods.includes('pickup');
  const shipping = methods.includes('shipping');
  const digital = methods.includes('digital');
  if (pickup && shipping && digital) return 'Pickup, shipping or digital';
  if (pickup && shipping) return 'Pickup or shipping';
  if (pickup && digital) return 'Pickup or digital';
  if (shipping && digital) return 'Shipping or digital';
  if (digital) return 'Digital delivery';
  if (pickup) return 'Local pickup';
  return 'Shipping';
}

/**
 * How a listing reaches the buyer: the public record publishes only THAT
 * pickup is offered — never the meeting point — and only that it is
 * delivered digitally, never what. Renders nothing when the source does not
 * carry the vocabulary (an index row predating it) rather than guessing.
 */
export function MarketplaceFulfillmentBadge({
  methods,
  className,
}: {
  methods: readonly MarketplaceFulfillmentMethod[] | null | undefined;
  className?: string;
}) {
  if (!methods || methods.length === 0) return null;
  return (
    <Badge variant="secondary" className={className}>
      {marketplaceFulfillmentLabel(methods)}
    </Badge>
  );
}
