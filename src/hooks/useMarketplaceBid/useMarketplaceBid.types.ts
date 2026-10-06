import { z } from 'zod';

export function marketplaceBidMinimum(
  currentPriceMinor: number,
  minimumIncrementMinor: number,
  viewerMinimumMinor?: number,
): number {
  return Math.max(currentPriceMinor + minimumIncrementMinor, viewerMinimumMinor ?? 0);
}

export const marketplaceBidSchema = z.object({
  maximumAmount: z
    .string()
    .trim()
    .regex(/^\d+(?:\.\d{1,2})?$/, 'Enter a valid maximum bid.')
    .refine((value) => Number(value) > 0, 'Maximum bid must be greater than zero.'),
});

export type MarketplaceBidData = z.infer<typeof marketplaceBidSchema>;

export const marketplaceBidDefaults: MarketplaceBidData = {
  maximumAmount: '',
};
