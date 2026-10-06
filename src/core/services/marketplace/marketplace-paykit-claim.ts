import { getPaykitSetupUrl } from '@/config/commerce';
import { ClientErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { safeFetch } from '@/libs/error/error.http';
import { ErrorService } from '@/libs/error/error.types';

function paykitServerOrigin(): string {
  return new URL(getPaykitSetupUrl()).origin;
}

/**
 * Paykit watch-only account lookup. Registration is the Bitkit setup grant
 * (`Open Bitkit setup`). The manual `POST /v0/accounts/claim` route is a 410
 * tombstone and is not called.
 */
export class MarketplacePaykitClaimService {
  private constructor() {}

  /** `GET /v0/accounts/{creator}` — public existence lookup. */
  static async isAccountClaimed(pubky: string): Promise<boolean> {
    const url = `${paykitServerOrigin()}/v0/accounts/${encodeURIComponent(`pubky${pubky}`)}`;
    const response = await safeFetch(url, { method: 'GET' }, ErrorService.Paykit, 'isAccountClaimed');
    if (!response.ok) {
      throw Err.client(ClientErrorCode.BAD_REQUEST, 'The Paykit server could not report the account state.', {
        service: ErrorService.Paykit,
        operation: 'isAccountClaimed',
        context: { statusCode: response.status },
      });
    }
    const body = (await response.json()) as { claimed?: boolean };
    return body.claimed === true;
  }
}
