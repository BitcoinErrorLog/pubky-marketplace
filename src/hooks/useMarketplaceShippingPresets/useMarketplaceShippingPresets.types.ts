import type { CreateMarketplaceListingData } from '@/hooks/useCreateMarketplaceListing/useCreateMarketplaceListing.types';
import type { CommerceShippingPresetModelSchema } from '@/models/commerce/commerce.schema';
import type { CommerceShippingPresetInput } from '@/pipes/commerce/commerce.normalizer';

/** The sell studio fields a shipping preset fills. */
export type MarketplaceShippingPresetFields = Pick<
  CreateMarketplaceListingData,
  'shippingLabel' | 'shippingPrice' | 'shippingMinDays' | 'shippingMaxDays'
>;

/**
 * Applies a stored preset to the sell studio's shipping form fields. Pure
 * authoring convenience: the published record shape is untouched — the same
 * single flat-rate shipping option is built from these fields either way.
 */
export function presetToShippingFields(preset: CommerceShippingPresetModelSchema): MarketplaceShippingPresetFields {
  return {
    shippingLabel: preset.label,
    shippingPrice: (preset.price_minor / 100).toFixed(2),
    shippingMinDays: String(preset.estimated_min_days),
    shippingMaxDays: String(preset.estimated_max_days),
  };
}

/**
 * Converts the sell studio's current shipping fields into a storable preset,
 * or null when the fields would not validate (mirrors the sell form's own
 * physical-fulfillment rules, so only publishable configurations are saved).
 */
export function shippingFieldsToPresetInput(
  fields: MarketplaceShippingPresetFields,
): CommerceShippingPresetInput | null {
  const label = fields.shippingLabel.trim();
  if (!label || label.length > 100) return null;
  if (!/^\d+(?:\.\d{1,2})?$/.test(fields.shippingPrice.trim())) return null;
  const priceMinor = Math.round(Number(fields.shippingPrice) * 100);
  if (!Number.isSafeInteger(priceMinor) || priceMinor <= 0) return null;
  if (!/^\d+$/.test(fields.shippingMinDays.trim()) || !/^\d+$/.test(fields.shippingMaxDays.trim())) return null;
  const estimatedMinDays = Number(fields.shippingMinDays);
  const estimatedMaxDays = Number(fields.shippingMaxDays);
  if (estimatedMinDays > 365 || estimatedMaxDays > 365 || estimatedMaxDays < estimatedMinDays) return null;
  return { label, priceMinor, currency: 'USD', estimatedMinDays, estimatedMaxDays };
}
