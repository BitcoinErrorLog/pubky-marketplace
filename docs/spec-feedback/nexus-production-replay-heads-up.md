# Marketplace production Nexus replay heads-up

**To:** Pubky Nexus team  
**From:** Pubky Marketplace integration  
**Date:** 2026-09-08

Shop uses a dedicated production Nexus for marketplace discovery: listing, shop, review, reputation, and drop reads use the marketplace Nexus, while social reads remain on the social Nexus. The Shop production alias currently exposes a catalog problem: the production Nexus serves 26 listing IDs that are identical to the staging catalog. Those rows came from an earlier crash-loop period when this Nexus ran with default configuration and indexed staging-derived data.

The current production configuration is correct: `NEXUS_HOMESERVER` points at the production homeserver, and the Redis and Neo4j stores are project-private. The old staging-derived data remains in those stores, however, so catalog cards can point at staging listings whose production detail pages return “Listing unavailable.”

The marketplace plan is to wipe the production Redis and Neo4j volumes, redeploy `nexusd`, and replay the production homeserver event stream from cursor zero. The stream is approximately 213,006 events and is expected to take roughly one day. This is destructive to the current index state but does not change canonical homeserver records; during replay, marketplace streams may be empty or incomplete until relevant production events are indexed.

Before proceeding, is replay from cursor zero the Nexus team’s recommended remediation for this stale-store state? If Nexus has a supported reindex path that clears only derived data while preserving the intended production cursor behavior, please point us to it. We will use the supported path rather than inventing one.
