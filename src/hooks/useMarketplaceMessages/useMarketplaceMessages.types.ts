import { z } from 'zod';

export const marketplaceMessageSchema = z.object({
  text: z.string().trim().min(1, 'Message is required.').max(2_000, 'Message must be 2,000 characters or fewer.'),
});

export type MarketplaceMessageData = z.infer<typeof marketplaceMessageSchema>;

export const marketplaceMessageDefaults: MarketplaceMessageData = {
  text: '',
};
