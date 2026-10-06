import { getMarketplaceNexusUrl } from '@/config/nexus';
import { NEXUS_STREAM_LISTINGS_ROUTE } from '@/libs/commerce/nexus-routes';
import {
  MARKETPLACE_TAGS_PATH_PARAMS,
  type TListingDetailsParams,
  type TListingReviewsParams,
  type TListingStreamParams,
  type TListingTagsParams,
  type TShopReputationParams,
  type TShopReviewsParams,
  type TShopTagsParams,
} from '@/services/nexus/marketplace/marketplace.types';
import { buildUrlWithQuery, encodePathSegment } from '@/services/nexus/nexus.utils';

/**
 * Marketplace API Endpoints
 *
 * URL builders for the Nexus marketplace index. The listing stream feeds the
 * catalog grid from its projections, while canonical record content is
 * hydrated from the owner homeserver on demand (ADR-0020). The per-listing
 * projection endpoint (`v0/listing/{seller_id}/{listing_id}`) serves the
 * watchlist's bounded freshness checks (revision, price, state, auction
 * deadline for one watched listing); `v0/shop/{seller_id}` still has no
 * client consumer.
 *
 * Every builder here MUST route through `getMarketplaceNexusUrl()`: the
 * marketplace index endpoints may live on a dedicated Nexus deployment
 * (`PUBKY_RUNTIME_MARKETPLACE_NEXUS_URL`) while social reads stay on the main
 * `nexusUrl`. When the override is unset both resolve to the same Nexus.
 *
 * The tag endpoints mirror the post tag routes and are served by the
 * marketplace Nexus (tag aggregation shipped in `308b985e`, deployed
 * 2026-08-28). The client still treats a 404 as "aggregation not on this
 * deployment" and degrades to local-only tags.
 */

const LISTING_PREFIX = 'v0/listing';
const SHOP_PREFIX = 'v0/shop';

export const marketplaceApi = {
  listingStream: (params: TListingStreamParams) =>
    buildUrlWithQuery({ baseRoute: NEXUS_STREAM_LISTINGS_ROUTE, params, baseUrl: getMarketplaceNexusUrl() }),
  listingDetails: (params: TListingDetailsParams) => {
    const seller = encodePathSegment(params.seller_id);
    const listing = encodePathSegment(params.listing_id);
    return buildUrlWithQuery({
      baseRoute: `${LISTING_PREFIX}/${seller}/${listing}`,
      params,
      excludeKeys: MARKETPLACE_TAGS_PATH_PARAMS,
      baseUrl: getMarketplaceNexusUrl(),
    });
  },
  listingTags: (params: TListingTagsParams) => {
    const seller = encodePathSegment(params.seller_id);
    const listing = encodePathSegment(params.listing_id);
    return buildUrlWithQuery({
      baseRoute: `${LISTING_PREFIX}/${seller}/${listing}/tags`,
      params,
      excludeKeys: MARKETPLACE_TAGS_PATH_PARAMS,
      baseUrl: getMarketplaceNexusUrl(),
    });
  },
  shopTags: (params: TShopTagsParams) => {
    const seller = encodePathSegment(params.seller_id);
    return buildUrlWithQuery({
      baseRoute: `${SHOP_PREFIX}/${seller}/tags`,
      params,
      excludeKeys: MARKETPLACE_TAGS_PATH_PARAMS,
      baseUrl: getMarketplaceNexusUrl(),
    });
  },
  shopReviews: (params: TShopReviewsParams) => {
    const seller = encodePathSegment(params.seller_id);
    return buildUrlWithQuery({
      baseRoute: `${SHOP_PREFIX}/${seller}/reviews`,
      params,
      excludeKeys: MARKETPLACE_TAGS_PATH_PARAMS,
      baseUrl: getMarketplaceNexusUrl(),
    });
  },
  shopReputation: (params: TShopReputationParams) => {
    const seller = encodePathSegment(params.seller_id);
    return buildUrlWithQuery({
      baseRoute: `${SHOP_PREFIX}/${seller}/reputation`,
      params,
      excludeKeys: MARKETPLACE_TAGS_PATH_PARAMS,
      baseUrl: getMarketplaceNexusUrl(),
    });
  },
  listingReviews: (params: TListingReviewsParams) => {
    const seller = encodePathSegment(params.seller_id);
    const listing = encodePathSegment(params.listing_id);
    return buildUrlWithQuery({
      baseRoute: `${LISTING_PREFIX}/${seller}/${listing}/reviews`,
      params,
      excludeKeys: MARKETPLACE_TAGS_PATH_PARAMS,
      baseUrl: getMarketplaceNexusUrl(),
    });
  },
};

export type MarketplaceApiEndpoint = keyof typeof marketplaceApi;
