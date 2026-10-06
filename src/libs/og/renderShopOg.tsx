import { buildShopDescription } from '@/libs/commerce/seo';
import { Logger } from '@/libs/logger/logger';
import { truncateByGraphemes } from '@/libs/utils/truncate';
import {
  fetchOgMediaAsDataUri,
  fetchShopForMetadata,
  OG_COMMERCE_CACHE_HEADERS,
  OG_NO_STORE_CACHE_HEADERS,
} from './ogCommerceData';
import { OgAvatar, OgFrame } from './OgComponents';
import { OG_TOKENS, OG_TRUNCATE } from './ogConstants';
import { ogImageResponse } from './ogImageResponse';
import { OgMarketplaceFooter, renderMarketplaceOg } from './renderMarketplaceOg';

/**
 * Renders the dynamic OG image for a marketplace shop: avatar (brand-circle
 * fallback when unset), shop name, bio, and the deployment host footer. When
 * the shop record carries a banner it renders as a full-bleed background under
 * a dark overlay that keeps the text legible. A missing/unparseable record
 * falls back to the generic marketplace card; failed avatar/banner fetches
 * degrade to the card without that asset.
 */
export async function renderShopOg({ sellerPubky }: { sellerPubky: string }): Promise<Response> {
  const result = await fetchShopForMetadata(sellerPubky);
  if (result.kind === 'not_found') return renderMarketplaceOg();
  if (result.kind === 'unavailable') {
    Logger.warn('[renderShopOg] Shop metadata unavailable', { reason: result.reason });
    return renderMarketplaceOg(OG_NO_STORE_CACHE_HEADERS);
  }

  try {
    const [avatarSrc, bannerSrc] = await Promise.all([
      result.record.avatarUrl ? fetchOgMediaAsDataUri(result.record.avatarUrl) : Promise.resolve(null),
      result.record.bannerUrl ? fetchOgMediaAsDataUri(result.record.bannerUrl) : Promise.resolve(null),
    ]);

    const bio = truncateByGraphemes(buildShopDescription(result.record), OG_TRUNCATE.bio);

    return ogImageResponse(
      <OgFrame style={{ position: 'relative', justifyContent: 'space-between' }}>
        {bannerSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={bannerSrc}
            alt=""
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
            }}
          />
        ) : null}
        {bannerSrc ? (
          // Dark scrim over the banner so the text stays legible on any image.
          <div
            style={{
              display: 'flex',
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              backgroundColor: 'rgba(5, 5, 10, 0.82)',
            }}
          />
        ) : null}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            flex: 1,
            gap: 56,
            paddingTop: 64,
            paddingLeft: 64,
            paddingRight: 64,
          }}
        >
          <OgAvatar src={avatarSrc} size={280} />
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0, gap: 24 }}>
            <div
              style={{
                display: 'flex',
                fontSize: 30,
                fontWeight: 700,
                letterSpacing: 4,
                color: OG_TOKENS.mutedForeground,
              }}
            >
              SHOP ON PUBKY MARKETPLACE
            </div>
            <div
              style={{
                display: 'flex',
                fontSize: 76,
                fontWeight: 700,
                color: OG_TOKENS.foreground,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {result.record.name}
            </div>
            {bio ? (
              <div
                style={{
                  display: 'flex',
                  fontSize: 44,
                  fontWeight: 500,
                  color: OG_TOKENS.secondaryForeground,
                  lineHeight: '56px',
                  wordBreak: 'break-word',
                  // Two 56px lines (satori's line-clamp is unreliable; the
                  // grapheme cap above supplies the visible ellipsis).
                  maxHeight: 112,
                  overflow: 'hidden',
                }}
              >
                {bio}
              </div>
            ) : null}
          </div>
        </div>
        <OgMarketplaceFooter />
      </OgFrame>,
      { ...OG_COMMERCE_CACHE_HEADERS },
    );
  } catch (error) {
    Logger.warn('[renderShopOg] Failed to render shop OG image', { sellerPubky, error });
    return renderMarketplaceOg();
  }
}
