import { MARKETPLACE_STATIC_SEO } from '@/libs/commerce/seo';
import { Logger } from '@/libs/logger/logger';
import { getDefaultUrl } from '@/libs/runtime-config/runtime-config';
import { OG_COMMERCE_CACHE_HEADERS } from './ogCommerceData';
import { OgFrame } from './OgComponents';
import { OG_TOKENS } from './ogConstants';
import { PubkyMark } from './OgIcons';
import { ogImageResponse } from './ogImageResponse';
import { renderFallbackOg } from './renderFallbackOg';

/**
 * Hostname shown in the lime footer of marketplace OG cards. Derived from the
 * configured site URL so the card names the deployment it was rendered by
 * (e.g. `shop.pubky.app`) instead of a hardcoded domain.
 */
export function ogSiteHost(): string {
  return new URL(getDefaultUrl()).host;
}

/**
 * Shared footer for marketplace OG cards: lime host label, plus the brand mark
 * on the right unless the card already shows it elsewhere (`withMark={false}`).
 */
export function OgMarketplaceFooter({ withMark = true }: { withMark?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '100%',
        paddingLeft: 64,
        paddingRight: 64,
        paddingBottom: 56,
      }}
    >
      <div style={{ display: 'flex', fontSize: 36, fontWeight: 700, color: OG_TOKENS.brand }}>{ogSiteHost()}</div>
      {withMark ? <PubkyMark size={72} /> : null}
    </div>
  );
}

/**
 * The static marketplace brand card: keyhole mark, "Pubky Marketplace", and the
 * truthful static tagline. Used by the `/marketplace` OG route (which nested
 * auth-gated marketplace routes inherit) and as the generic fallback whenever a
 * listing/shop record cannot back a richer card.
 */
export async function renderMarketplaceOg(
  headers: Record<string, string> = OG_COMMERCE_CACHE_HEADERS,
): Promise<Response> {
  try {
    return ogImageResponse(
      <OgFrame style={{ justifyContent: 'space-between' }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            justifyContent: 'center',
            gap: 40,
            paddingLeft: 64,
            paddingRight: 64,
          }}
        >
          <PubkyMark size={120} />
          <div style={{ display: 'flex', fontSize: 88, fontWeight: 700, color: OG_TOKENS.foreground }}>
            Pubky Marketplace
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 40,
              fontWeight: 500,
              color: OG_TOKENS.mutedForeground,
              lineHeight: '52px',
              wordBreak: 'break-word',
              // Static copy fits in three lines; the cap only guards regressions.
              maxHeight: 156,
              overflow: 'hidden',
            }}
          >
            {MARKETPLACE_STATIC_SEO.description}
          </div>
        </div>
        <OgMarketplaceFooter withMark={false} />
      </OgFrame>,
      headers,
    );
  } catch (error) {
    Logger.warn('[renderMarketplaceOg] Failed to render marketplace OG image', { error });
    return renderFallbackOg();
  }
}
