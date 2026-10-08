import { z } from 'zod';

/**
 * Paykit rc59 and later (Bitkit 2.6+) publish one identity-wide App Registry
 * here instead of the per-receiver markers that the Shop's Paykit server
 * (rc55) links to. Such a wallet no longer answers on markers an older
 * Bitkit left behind, so the server cannot deliver it a payment request.
 */
export const PAYKIT_APP_REGISTRY_PATH = '/pub/paykit/v0/app-registry.json';

/**
 * Whether a buyer can receive a Bitcoin payment request from the Shop:
 * - `payable`: a Paykit receiver marker takes payment requests (Bitkit 2.5);
 * - `not_payable`: nothing published takes them;
 * - `unsupported`: the wallet takes them only on Paykit rc59+ (Bitkit 2.6+),
 *   which the Shop's Paykit server cannot reach yet.
 */
export type BuyerPaykitWallet = 'payable' | 'not_payable' | 'unsupported';

const appRegistrySchema = z.object({
  version: z.literal(1),
  kind: z.literal('paykit.app_registry'),
  apps: z.record(
    z.string(),
    z.object({
      capabilities: z.object({ private_payments: z.boolean(), payment_requests: z.boolean() }),
    }),
  ),
});

export function paykitAppRegistryUrl(ownerPubky: string): string {
  return `pubky://${ownerPubky}${PAYKIT_APP_REGISTRY_PATH}`;
}

/**
 * True when `json` is a v1 Paykit App Registry listing an app that takes
 * payment requests over a private link. Anything else is not a registry the
 * buyer's wallet receives through.
 */
export function appRegistryReceivesPaymentRequests(json: unknown): boolean {
  const parsed = appRegistrySchema.safeParse(json);
  if (!parsed.success) return false;
  return Object.values(parsed.data.apps).some(
    ({ capabilities }) => capabilities.private_payments && capabilities.payment_requests,
  );
}

export const BITCOIN_WALLET_UNSUPPORTED_TITLE = 'Bitcoin checkout does not support Bitkit 2.6 yet';

export function bitcoinWalletUnsupportedBody(canPayWithPaypal: boolean): string {
  return `This Pubky account uses Bitkit 2.6 or later. The Shop can't send it a Bitcoin payment request yet; that comes with an upcoming Shop update.${canPayWithPaypal ? ' You can pay with PayPal instead.' : ''}`;
}

export function bitcoinWalletUnsupportedPayReason(canPayWithPaypal: boolean): string {
  return `Bitcoin checkout does not support Bitkit 2.6 yet.${canPayWithPaypal ? ' Choose PayPal to pay now.' : ''}`;
}
