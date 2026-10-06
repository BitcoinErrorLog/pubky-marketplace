import {
  listingConditionLabel,
  listingPriceLabel,
  listingStateNotice,
  resolveListingOgCoverUri,
} from '@/libs/commerce/seo';
import { Logger } from '@/libs/logger/logger';
import { truncateByGraphemes } from '@/libs/utils/truncate';
import {
  fetchListingForMetadata,
  fetchOgMediaAsDataUri,
  OG_COMMERCE_CACHE_HEADERS,
  OG_NO_STORE_CACHE_HEADERS,
} from './ogCommerceData';
import { OgFrame } from './OgComponents';
import { OG_TOKENS } from './ogConstants';
import { ogImageResponse } from './ogImageResponse';
import { OgMarketplaceFooter, renderMarketplaceOg } from './renderMarketplaceOg';

/**
 * Grapheme cap for the card title: ~2 lines at 64px in the text column (the
 * narrower with-photo layout also height-caps, so the ellipsis from grapheme
 * truncation is the visible clamp).
 */
const OG_LISTING_TITLE_MAX_GRAPHEMES = 60;

function Badge({ label, emphasized = false }: { label: string; emphasized?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        paddingTop: 10,
        paddingBottom: 10,
        paddingLeft: 28,
        paddingRight: 28,
        borderRadius: 999,
        border: `2px solid ${emphasized ? OG_TOKENS.brand : OG_TOKENS.avatarMuted}`,
        backgroundColor: emphasized ? 'rgba(200, 255, 0, 0.12)' : 'transparent',
        fontSize: 30,
        fontWeight: 500,
        color: emphasized ? OG_TOKENS.brand : OG_TOKENS.secondaryForeground,
      }}
    >
      {label}
    </div>
  );
}

/**
 * Renders the dynamic OG image for a marketplace listing: brand-dark card with
 * the record's title, price (lime), condition badge, an honest state badge for
 * paused/ended listings, and the deployment host footer.
 *
 * When the listing has a public cover photo (first image, and NEVER for
 * adult-only listings — see `resolveListingOgCoverUri`), it renders as a
 * right-side inset; a failed photo fetch degrades to the text-only branded
 * card. A missing/removed/unparseable record falls back to the generic
 * marketplace card, and any render error to the static brand preview.
 */
export async function renderListingOg({
  sellerPubky,
  listingId,
}: {
  sellerPubky: string;
  listingId: string;
}): Promise<Response> {
  const result = await fetchListingForMetadata(sellerPubky, listingId);
  if (result.kind === 'not_found') return renderMarketplaceOg();
  if (result.kind === 'unavailable') {
    Logger.warn('[renderListingOg] Listing metadata unavailable', { reason: result.reason });
    return renderMarketplaceOg(OG_NO_STORE_CACHE_HEADERS);
  }

  try {
    const coverUri = resolveListingOgCoverUri(result.record);
    const coverSrc = coverUri ? await fetchOgMediaAsDataUri(coverUri) : null;

    const title = truncateByGraphemes(result.record.title, OG_LISTING_TITLE_MAX_GRAPHEMES);
    const stateNotice = listingStateNotice(result.record);

    return ogImageResponse(
      <OgFrame style={{ flexDirection: 'row' }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            flex: 1,
            minWidth: 0,
            justifyContent: 'space-between',
          }}
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              flex: 1,
              justifyContent: 'center',
              gap: 36,
              paddingTop: 64,
              paddingLeft: 64,
              paddingRight: coverSrc ? 48 : 64,
            }}
          >
            <div
              style={{
                display: 'flex',
                fontSize: 30,
                fontWeight: 700,
                letterSpacing: 4,
                color: OG_TOKENS.mutedForeground,
              }}
            >
              PUBKY MARKETPLACE
            </div>
            <div
              style={{
                display: 'flex',
                fontSize: 64,
                fontWeight: 700,
                color: OG_TOKENS.foreground,
                lineHeight: '76px',
                wordBreak: 'break-word',
                // Two 76px lines (satori's line-clamp is unreliable; the
                // grapheme cap above supplies the visible ellipsis).
                maxHeight: 152,
                overflow: 'hidden',
              }}
            >
              {title}
            </div>
            <div style={{ display: 'flex', fontSize: 56, fontWeight: 700, color: OG_TOKENS.brand }}>
              {listingPriceLabel(result.record)}
            </div>
            <div style={{ display: 'flex', gap: 20 }}>
              <Badge label={listingConditionLabel(result.record)} />
              {stateNotice ? <Badge label={stateNotice} emphasized /> : null}
            </div>
          </div>
          <OgMarketplaceFooter />
        </div>
        {coverSrc ? (
          <div
            style={{
              display: 'flex',
              width: 440,
              height: '100%',
              paddingTop: 40,
              paddingRight: 40,
              paddingBottom: 40,
            }}
          >
            <div style={{ display: 'flex', width: '100%', height: '100%', borderRadius: 24, overflow: 'hidden' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={coverSrc} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </div>
          </div>
        ) : null}
      </OgFrame>,
      { ...OG_COMMERCE_CACHE_HEADERS },
    );
  } catch (error) {
    Logger.warn('[renderListingOg] Failed to render listing OG image', { sellerPubky, listingId, error });
    return renderMarketplaceOg();
  }
}
