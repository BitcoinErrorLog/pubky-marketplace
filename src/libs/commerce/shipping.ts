import { z } from 'zod';

/**
 * Seller-configurable Shippo shipping integration. The trust shape mirrors
 * the payment rails (`payment-methods.ts`): the SELLER supplies their own
 * Shippo API token, sealed at rest on the service and never readable back —
 * a purchased label is real money charged by Shippo to the seller's own
 * account, and this marketplace holds no platform shipping credentials.
 *
 * Privacy: a purchased label PDF embeds the buyer's delivery address, so
 * everything label-related is SELLER-scoped on the service and never enters
 * the shared order projection. The buyer sees tracking when the seller
 * ships, exactly as with a manually entered tracking number.
 */

/** The ship-from address, in the checkout delivery-address vocabulary. */
export const shipFromAddressSchema = z.object({
  name: z.string().trim().min(1).max(100),
  line1: z.string().trim().min(1).max(200),
  line2: z.string().trim().max(200),
  city: z.string().trim().min(1).max(100),
  region: z.string().trim().max(100),
  postalCode: z.string().trim().min(1).max(20),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  phone: z.string().trim().max(30),
  email: z.string().trim().max(100),
});

export type ShipFromAddress = z.infer<typeof shipFromAddressSchema>;

/** The seller's own view; the Shippo token is write-only on the service. */
export const sellerShippingConfigSchema = z.object({
  shipFrom: shipFromAddressSchema.nullable(),
  shippoApiKeySet: z.boolean(),
  updatedAt: z.string(),
});

export type SellerShippingConfig = z.infer<typeof sellerShippingConfigSchema>;

/** One purchasable rate quoted by Shippo for a specific order's parcel. */
export const shippoRateSchema = z.object({
  rateId: z.string().min(1),
  provider: z.string(),
  servicelevel: z.string(),
  /** Decimal amount string exactly as Shippo quotes it (e.g. `"7.85"`). */
  amount: z.string(),
  currency: z.string(),
  estimatedDays: z.number().int().nullable().optional(),
  durationTerms: z.string().nullable().optional(),
});

export type ShippoRate = z.infer<typeof shippoRateSchema>;

/** A purchased label, stored seller-only on the order. */
export const shippingLabelSchema = z.object({
  transactionId: z.string(),
  carrier: z.string(),
  servicelevel: z.string(),
  amount: z.string(),
  currency: z.string(),
  trackingNumber: z.string(),
  trackingUrl: z.string().nullable().optional(),
  labelUrl: z.string(),
  purchasedAt: z.string(),
});

export type ShippingLabel = z.infer<typeof shippingLabelSchema>;

/** The metric parcel the seller confirms before quoting rates. */
export const shippingParcelSchema = z.object({
  weightGrams: z.number().int().min(1).max(1_000_000),
  lengthMm: z.number().int().min(1).max(10_000),
  widthMm: z.number().int().min(1).max(10_000),
  heightMm: z.number().int().min(1).max(10_000),
});

export type ShippingParcel = z.infer<typeof shippingParcelSchema>;

/**
 * Mirror of the service's token shape check, so a pasted non-Shippo secret
 * is caught before it ever leaves the browser.
 */
export function isPlausibleShippoApiKey(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed.startsWith('shippo_') &&
    trimmed.length >= 12 &&
    trimmed.length <= 200 &&
    [...trimmed].every((char) => char.charCodeAt(0) > 32 && char.charCodeAt(0) < 127)
  );
}
