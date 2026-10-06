import { z } from 'zod';

/**
 * Canonical PostgreSQL uuid text: 8-4-4-4-12 lowercase hex, any version
 * and variant nibble. Migration 0035 stored md5 hex in that shape, so
 * `z.uuid()` rejects it. `uuidBytes` and `shop_grant_bff.session_bridge`
 * both require this text. Match a parsed id by exact equality.
 */
export const marketplaceSessionIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
