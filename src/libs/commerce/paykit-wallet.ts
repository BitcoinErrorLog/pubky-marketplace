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
 * - `payable`: a Paykit receiver marker takes payment requests (Bitkit 2.5),
 *   or, with the upstream Paykit Server, the App Registry does (Bitkit 2.6+);
 * - `not_payable`: nothing published takes them;
 * - `unsupported`: the wallet takes them only on Paykit rc59+ (Bitkit 2.6+),
 *   which the fork Paykit server cannot reach (fork mode only);
 * - `unverified`: the registry could not be read, so a Bitkit 2.6 wallet
 *   cannot be ruled out; Bitcoin waits for a successful recheck.
 */
export type BuyerPaykitWallet = 'payable' | 'not_payable' | 'unsupported' | 'unverified';

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
 * Whether a file found at {@link PAYKIT_APP_REGISTRY_PATH} shows a wallet on
 * Paykit rc59+. Only rc59+ writes that path, so anything there counts,
 * including a registry this parser cannot read (invalid JSON arrives as
 * `undefined`, or a later version or kind). The one exception is a v1
 * registry that lists no app taking payment requests over a private link:
 * it proves no such wallet, and the receiver markers decide.
 */
export function foundAppRegistryShowsNewWallet(json: unknown): boolean {
  const parsed = appRegistrySchema.safeParse(json);
  if (!parsed.success) return true;
  return Object.values(parsed.data.apps).some(
    ({ capabilities }) => capabilities.private_payments && capabilities.payment_requests,
  );
}

/**
 * Upstream Paykit Server (rc11, `paykitServerApi=upstream`) delivers payment
 * requests only to a wallet whose App Registry it can read: a v1 registry
 * listing an app that takes payment requests over a private link. Receiver
 * markers are not read, so a Bitkit 2.5 wallet is not payable, and a
 * registry of another version or kind is not either.
 */
export function appRegistryTakesPaymentRequests(json: unknown): boolean {
  const parsed = appRegistrySchema.safeParse(json);
  return (
    parsed.success &&
    Object.values(parsed.data.apps).some(
      ({ capabilities }) => capabilities.private_payments && capabilities.payment_requests,
    )
  );
}

export const BITCOIN_WALLET_UNSUPPORTED_TITLE = 'Bitcoin checkout does not support Bitkit 2.6 yet';

export function bitcoinWalletUnsupportedBody(canPayWithPaypal: boolean): string {
  return `This Pubky account uses Bitkit 2.6 or later. The Shop can't send it a Bitcoin payment request yet; that comes with an upcoming Shop update.${canPayWithPaypal ? ' You can pay with PayPal instead.' : ''}`;
}

export function bitcoinWalletUnsupportedPayReason(canPayWithPaypal: boolean): string {
  return `Bitcoin checkout does not support Bitkit 2.6 yet.${canPayWithPaypal ? ' Choose PayPal to pay now.' : ''}`;
}

export const BITCOIN_WALLET_UNVERIFIED_TITLE = "Couldn't verify your Bitcoin wallet";

export function bitcoinWalletUnverifiedBody(canPayWithPaypal: boolean): string {
  return `The Shop couldn't check which Bitkit version this Pubky account uses, so Bitcoin Pay is paused. Check again in a moment.${canPayWithPaypal ? ' You can also pay with PayPal.' : ''}`;
}

export function bitcoinWalletUnverifiedPayReason(canPayWithPaypal: boolean): string {
  return `Check your Bitcoin wallet again to pay with Bitcoin${canPayWithPaypal ? ', or choose PayPal' : ''}.`;
}
