import { Client, Pubky, PublicKey, resolvePubky } from '@synonymdev/pubky';
import { getPkarrRelays } from '@/config/network';
import { isValidMarketplaceMediaUri } from '@/libs/commerce/media-url';
import { ServerErrorCode } from '@/libs/error/error.codes';
import { Err } from '@/libs/error/error.factories';
import { ErrorService } from '@/libs/error/error.types';

const mediaClient = new Client({ pkarr: { relays: getPkarrRelays() } });
const mediaSdk = Pubky.withClient(mediaClient);

export class MarketplaceMediaService {
  private constructor() {}

  static async getOwnerHomeserver(owner: string): Promise<string | null> {
    const homeserver = await mediaSdk.getHomeserverOf(PublicKey.from(owner));
    return homeserver?.z32() ?? null;
  }

  static async fetchMedia(uri: string): Promise<Blob> {
    if (!isValidMarketplaceMediaUri(uri)) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'Marketplace media URI is not public marketplace media.', {
        service: ErrorService.Marketplace,
        operation: 'fetchMedia',
      });
    }
    const response = await mediaClient.fetch(resolvePubky(uri));
    if (!response.ok) {
      throw Err.server(ServerErrorCode.INVALID_RESPONSE, 'Marketplace media request failed.', {
        service: ErrorService.Marketplace,
        operation: 'fetchMedia',
        context: { statusCode: response.status },
      });
    }
    return await response.blob();
  }
}
