import {
  getCdnUrl,
  getMarketplaceNexusUrl,
  getNexusUrl,
  getStreamCacheMaxAgeMs,
} from '@/libs/runtime-config/runtime-config';

// Runtime-configurable: read via getters at call time (PUBKY_RUNTIME_*, staging defaults in
// dev/test). See @/libs/runtime-config. `getMarketplaceNexusUrl` is for commerce/marketplace
// index reads ONLY and falls back to `getNexusUrl` when the override is unset.
export { getCdnUrl, getMarketplaceNexusUrl, getNexusUrl, getStreamCacheMaxAgeMs };

export const NEXUS_LISTINGS_PER_PAGE = 30; // Nexus caps the marketplace listing stream `limit` at 30
export const NEXUS_NOTIFICATIONS_LIMIT = 30;
export const NEXUS_POSTS_PER_PAGE = 10; // Number of posts to fetch per page in streams
export const NEXUS_STREAM_MAX_LIMIT = 50; // Hard cap Nexus enforces on a single stream `limit`; requests above this are rejected
// The user-ids stream (`/v0/stream/users/ids`) enforces a SMALLER cap than the
// general stream limit: `limit` above 20 is rejected with 400 "limit exceeds
// maximum of 20" (verified against the official staging Nexus 2026-08-22 —
// this silently broke inbox counterparty discovery when the messaging sync
// asked for 25).
export const NEXUS_USER_IDS_MAX_LIMIT = 20;
export const NEXUS_USERS_PER_PAGE = 10; // Number of users to fetch per page in streams
