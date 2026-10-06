import postgres, { type Sql } from 'postgres';
import type { MarketplaceGrantConfig } from './config';

export const CLI_RATE_BUCKET_TTL_SECONDS = 120;

export type BridgeRow = {
  bridge_id: string;
  cookie_hash: Uint8Array;
  pubky: string;
  marketplace_session_id: string;
  bearer_sealed: Uint8Array;
  key_epoch: number;
  created_at: Date;
  expires_at: Date;
  last_verified_at: Date;
};

export type FlowRow = {
  state_id: string;
  bridge_id: string;
  flow_id: string | null;
  result_binding_hash: Uint8Array;
  context_sealed: Uint8Array | null;
  key_epoch: number;
  status: string;
  lease_owner: string | null;
  lease_until: Date | null;
  version: string;
  created_at: Date;
  expires_at: Date;
  terminal_at: Date | null;
};

let sql: Sql | undefined;

export function grantSql(config: MarketplaceGrantConfig): Sql {
  sql ??= postgres(config.databaseUrl, {
    max: 5,
    connect_timeout: Math.ceil(config.databaseTimeoutMs / 1000),
    idle_timeout: 20,
    max_lifetime: 60 * 30,
    prepare: true,
    onnotice: () => {},
  });
  return sql;
}

export async function assertGrantSchema(config: MarketplaceGrantConfig): Promise<void> {
  const db = grantSql(config);
  const rows = await db<{ version: number }[]>`
    SELECT version FROM shop_grant_bff.schema_version
    WHERE singleton = TRUE
  `;
  if (rows.length !== 1 || (rows[0].version !== 1 && rows[0].version !== 2)) {
    throw new Error('Shop grant BFF schema is not ready');
  }
}

export async function assertCliGrantSchema(config: MarketplaceGrantConfig): Promise<void> {
  const db = grantSql(config);
  const rows = await db<{ version: number }[]>`
    SELECT version FROM shop_grant_bff.schema_version
    WHERE singleton = TRUE
  `;
  if (rows.length !== 1 || rows[0].version !== 2) throw new Error('Shop grant BFF CLI schema is not ready');
}

export async function replaceBridge(
  config: MarketplaceGrantConfig,
  row: {
    bridgeId: string;
    cookieHash: Uint8Array;
    pubky: string;
    marketplaceSessionId: string;
    bearerSealed: Uint8Array;
    keyEpoch: number;
    expiresAt: Date;
  },
): Promise<void> {
  const db = grantSql(config);
  await db.begin(async (tx) => {
    await tx`DELETE FROM shop_grant_bff.session_bridge WHERE pubky = ${row.pubky}`;
    await tx`
      INSERT INTO shop_grant_bff.session_bridge
        (bridge_id, cookie_hash, pubky, marketplace_session_id, bearer_sealed,
         key_epoch, created_at, expires_at, last_verified_at)
      VALUES
        (${row.bridgeId}, ${row.cookieHash}, ${row.pubky}, ${row.marketplaceSessionId},
         ${row.bearerSealed}, ${row.keyEpoch}, now(), ${row.expiresAt}, now())
    `;
  });
}

export async function getBridge(config: MarketplaceGrantConfig, bridgeId: string): Promise<BridgeRow | null> {
  const rows = await grantSql(config)<BridgeRow[]>`
    SELECT * FROM shop_grant_bff.session_bridge
    WHERE bridge_id = ${bridgeId} AND expires_at > now()
  `;
  return rows[0] ?? null;
}

export async function touchBridge(config: MarketplaceGrantConfig, bridgeId: string): Promise<boolean> {
  const result = await grantSql(config)`
    UPDATE shop_grant_bff.session_bridge
    SET last_verified_at = now()
    WHERE bridge_id = ${bridgeId} AND expires_at > now()
  `;
  return result.count === 1;
}

export async function deleteBridge(config: MarketplaceGrantConfig, bridgeId: string): Promise<void> {
  await grantSql(config)`DELETE FROM shop_grant_bff.session_bridge WHERE bridge_id = ${bridgeId}`;
}

/**
 * Deletes the bridge only while it still pairs `marketplaceSessionId`.
 * Returns whether the cookie naming this bridge may be dropped: the row was
 * deleted, or no row is left for it.
 */
export async function deleteBridgeForSession(
  config: MarketplaceGrantConfig,
  bridgeId: string,
  marketplaceSessionId: string,
): Promise<boolean> {
  const db = grantSql(config);
  const deleted = await db`
    DELETE FROM shop_grant_bff.session_bridge
    WHERE bridge_id = ${bridgeId} AND marketplace_session_id = ${marketplaceSessionId}
  `;
  if (deleted.count === 1) return true;
  const remaining = await db`SELECT 1 FROM shop_grant_bff.session_bridge WHERE bridge_id = ${bridgeId}`;
  return remaining.length === 0;
}

export async function insertCreatingFlow(
  config: MarketplaceGrantConfig,
  row: {
    stateId: string;
    bridgeId: string;
    resultBindingHash: Uint8Array;
    contextSealed: Uint8Array;
    keyEpoch: number;
    expiresAt: Date;
  },
): Promise<void> {
  await grantSql(config)`
    INSERT INTO shop_grant_bff.flow_state
      (state_id, bridge_id, result_binding_hash, context_sealed, key_epoch,
       status, created_at, expires_at)
    VALUES
      (${row.stateId}, ${row.bridgeId}, ${row.resultBindingHash}, ${row.contextSealed},
       ${row.keyEpoch}, 'creating', now(), ${row.expiresAt})
  `;
}

export async function bindFlow(
  config: MarketplaceGrantConfig,
  stateId: string,
  flowId: string,
  expiresAt: Date,
): Promise<boolean> {
  const result = await grantSql(config)`
    UPDATE shop_grant_bff.flow_state
    SET flow_id = ${flowId}, expires_at = LEAST(expires_at, ${expiresAt}),
        status = 'awaiting', version = version + 1
    WHERE state_id = ${stateId} AND status = 'creating'
  `;
  return result.count === 1;
}

export async function getFlow(config: MarketplaceGrantConfig, stateId: string): Promise<FlowRow | null> {
  const rows = await grantSql(config)<FlowRow[]>`
    SELECT * FROM shop_grant_bff.flow_state WHERE state_id = ${stateId}
  `;
  return rows[0] ?? null;
}

export async function terminalizeFlow(config: MarketplaceGrantConfig, stateId: string, status: string): Promise<void> {
  await grantSql(config)`
    UPDATE shop_grant_bff.flow_state
    SET status = ${status}, context_sealed = NULL, terminal_at = now(),
        lease_owner = NULL, lease_until = NULL, version = version + 1
    WHERE state_id = ${stateId}
      AND status IN ('creating','awaiting','claiming')
  `;
}

export async function acquireClaim(
  config: MarketplaceGrantConfig,
  stateId: string,
  owner: string,
): Promise<FlowRow | null> {
  const rows = await grantSql(config)<FlowRow[]>`
    UPDATE shop_grant_bff.flow_state
    SET status = 'claiming', lease_owner = ${owner},
        lease_until = now() + (${config.claimLeaseSeconds} * interval '1 second'),
        version = version + 1
    WHERE state_id = ${stateId} AND status = 'awaiting' AND expires_at > now()
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function renewClaim(config: MarketplaceGrantConfig, stateId: string, owner: string): Promise<boolean> {
  const rows = await grantSql(config)<FlowRow[]>`
    UPDATE shop_grant_bff.flow_state
    SET lease_until = now() + (${config.claimLeaseSeconds} * interval '1 second'),
        version = version + 1
    WHERE state_id = ${stateId} AND status = 'claiming' AND lease_owner = ${owner}
    RETURNING *
  `;
  return rows.length === 1;
}

export async function completeClaim(config: MarketplaceGrantConfig, stateId: string, owner: string): Promise<boolean> {
  const result = await grantSql(config)`
    UPDATE shop_grant_bff.flow_state
    SET status = 'claimed', context_sealed = NULL, terminal_at = now(),
        lease_owner = NULL, lease_until = NULL, version = version + 1
    WHERE state_id = ${stateId} AND status = 'claiming' AND lease_owner = ${owner}
  `;
  return result.count === 1;
}

export async function abandonClaim(config: MarketplaceGrantConfig, stateId: string, owner: string): Promise<void> {
  await grantSql(config)`
    UPDATE shop_grant_bff.flow_state
    SET status = 'abandoned', context_sealed = NULL, terminal_at = now(),
        lease_owner = NULL, lease_until = NULL, version = version + 1
    WHERE state_id = ${stateId} AND status = 'claiming' AND lease_owner = ${owner}
  `;
}

export async function cleanupGrantState(config: MarketplaceGrantConfig): Promise<{
  expiredFlows: number;
  abandonedClaims: number;
  deletedFlows: number;
  deletedBridges: number;
  deletedRateBuckets: number;
}> {
  const db = grantSql(config);
  return await db.begin(async (tx) => {
    const expired = await tx`
      UPDATE shop_grant_bff.flow_state
      SET status = 'expired', context_sealed = NULL, terminal_at = now(),
          lease_owner = NULL, lease_until = NULL, version = version + 1
      WHERE status IN ('creating','awaiting') AND expires_at <= now()
    `;
    const abandoned = await tx`
      UPDATE shop_grant_bff.flow_state
      SET status = 'abandoned', context_sealed = NULL, terminal_at = now(),
          lease_owner = NULL, lease_until = NULL, version = version + 1
      WHERE status = 'claiming' AND lease_until <= now()
    `;
    const deletedFlows = await tx`
      DELETE FROM shop_grant_bff.flow_state
      WHERE terminal_at < now() - interval '24 hours'
    `;
    const deletedBridges = await tx`
      DELETE FROM shop_grant_bff.session_bridge WHERE expires_at <= now()
    `;
    const versionRows = await tx<{ version: number }[]>`
      SELECT version FROM shop_grant_bff.schema_version WHERE singleton = TRUE
    `;
    let deletedRateBuckets = 0;
    if (versionRows[0]?.version === 2) {
      await tx`
        UPDATE shop_grant_bff.cli_flow_state
        SET status = 'expired', context_sealed = NULL, result_token_sealed = NULL,
            terminal_at = now(), lease_owner = NULL, lease_until = NULL, version = version + 1
        WHERE status IN ('creating','awaiting') AND expires_at <= now()
      `;
      await tx`
        UPDATE shop_grant_bff.cli_flow_state
        SET status = 'abandoned', context_sealed = NULL, result_token_sealed = NULL,
            terminal_at = now(), lease_owner = NULL, lease_until = NULL, version = version + 1
        WHERE status = 'claiming' AND lease_until <= now()
      `;
      await tx`DELETE FROM shop_grant_bff.cli_flow_state WHERE terminal_at < now() - interval '24 hours'`;
      await tx`
        DELETE FROM shop_grant_bff.cli_challenges
        WHERE consumed_at IS NULL AND expires_at <= now()
          AND NOT EXISTS (
            SELECT 1 FROM shop_grant_bff.cli_flow_state s WHERE s.challenge_id = cli_challenges.challenge_id
          )
      `;
      const prunedBuckets = await tx`
        DELETE FROM shop_grant_bff.cli_rate_buckets
        WHERE updated_at < now() - (${CLI_RATE_BUCKET_TTL_SECONDS} * interval '1 second')
      `;
      deletedRateBuckets = prunedBuckets.count;
    }
    return {
      expiredFlows: expired.count,
      abandonedClaims: abandoned.count,
      deletedFlows: deletedFlows.count,
      deletedBridges: deletedBridges.count,
      deletedRateBuckets,
    };
  });
}

export function setGrantSqlForTests(client: Sql | undefined): void {
  sql = client;
}

export async function resetGrantSqlForTests(): Promise<void> {
  if (sql) await sql.end({ timeout: 1 });
  sql = undefined;
}

export type CliChallengeRow = {
  challenge_id: string;
  pubky: string;
  result_cpk: string;
  result_delivery_id_hash: Uint8Array;
  nonce_hash: Uint8Array;
  consumed_at: Date | null;
  created_at: Date;
  expires_at: Date;
};

export type CliFlowRow = {
  state_id: string;
  challenge_id: string;
  flow_id: string | null;
  pubky: string;
  result_cpk: string;
  token_hash: Uint8Array;
  context_sealed: Uint8Array | null;
  result_token_sealed: Uint8Array | null;
  key_epoch: number;
  status: string;
  lease_owner: string | null;
  lease_until: Date | null;
  version: string;
  created_at: Date;
  expires_at: Date;
  terminal_at: Date | null;
};

export async function insertCliChallenge(
  config: MarketplaceGrantConfig,
  row: {
    challengeId: string;
    pubky: string;
    resultCpk: string;
    resultDeliveryIdHash: Uint8Array;
    nonceHash: Uint8Array;
    expiresAt: Date;
  },
): Promise<void> {
  await grantSql(config)`
    INSERT INTO shop_grant_bff.cli_challenges
      (challenge_id, pubky, result_cpk, result_delivery_id_hash, nonce_hash, created_at, expires_at)
    VALUES
      (${row.challengeId}, ${row.pubky}, ${row.resultCpk}, ${row.resultDeliveryIdHash},
       ${row.nonceHash}, now(), ${row.expiresAt})
  `;
}

export async function getCliChallenge(
  config: MarketplaceGrantConfig,
  challengeId: string,
): Promise<CliChallengeRow | null> {
  const rows = await grantSql(config)<CliChallengeRow[]>`
    SELECT * FROM shop_grant_bff.cli_challenges WHERE challenge_id = ${challengeId}
  `;
  return rows[0] ?? null;
}

export async function consumeCliChallenge(config: MarketplaceGrantConfig, challengeId: string): Promise<boolean> {
  const result = await grantSql(config)`
    UPDATE shop_grant_bff.cli_challenges
    SET consumed_at = now()
    WHERE challenge_id = ${challengeId}
      AND consumed_at IS NULL
      AND expires_at > now()
  `;
  return result.count === 1;
}

export class CliChallengeConsumeConflict extends Error {
  constructor(readonly reason: 'consumed' | 'missing') {
    super(reason);
    this.name = 'CliChallengeConsumeConflict';
  }
}

export async function consumeChallengeAndInsertCliFlow(
  config: MarketplaceGrantConfig,
  challengeId: string,
  row: {
    stateId: string;
    pubky: string;
    resultCpk: string;
    tokenHash: Uint8Array;
    contextSealed: Uint8Array;
    keyEpoch: number;
    expiresAt: Date;
  },
): Promise<void> {
  const db = grantSql(config);
  await db.begin(async (tx) => {
    const consumed = await tx<{ challenge_id: string }[]>`
      UPDATE shop_grant_bff.cli_challenges
      SET consumed_at = now()
      WHERE challenge_id = ${challengeId}
        AND consumed_at IS NULL
        AND expires_at > now()
      RETURNING challenge_id
    `;
    if (consumed.length !== 1) {
      const existing = await tx<{ consumed_at: Date | null }[]>`
        SELECT consumed_at FROM shop_grant_bff.cli_challenges WHERE challenge_id = ${challengeId}
      `;
      throw new CliChallengeConsumeConflict(existing[0]?.consumed_at ? 'consumed' : 'missing');
    }
    await tx`
      INSERT INTO shop_grant_bff.cli_flow_state
        (state_id, challenge_id, pubky, result_cpk, token_hash, context_sealed, key_epoch,
         status, created_at, expires_at)
      VALUES
        (${row.stateId}, ${challengeId}, ${row.pubky}, ${row.resultCpk}, ${row.tokenHash},
         ${row.contextSealed}, ${row.keyEpoch}, 'creating', now(), ${row.expiresAt})
    `;
  });
}

export async function insertCreatingCliFlow(
  config: MarketplaceGrantConfig,
  row: {
    stateId: string;
    challengeId: string;
    pubky: string;
    resultCpk: string;
    tokenHash: Uint8Array;
    contextSealed: Uint8Array;
    keyEpoch: number;
    expiresAt: Date;
  },
): Promise<void> {
  await grantSql(config)`
    INSERT INTO shop_grant_bff.cli_flow_state
      (state_id, challenge_id, pubky, result_cpk, token_hash, context_sealed, key_epoch,
       status, created_at, expires_at)
    VALUES
      (${row.stateId}, ${row.challengeId}, ${row.pubky}, ${row.resultCpk}, ${row.tokenHash},
       ${row.contextSealed}, ${row.keyEpoch}, 'creating', now(), ${row.expiresAt})
  `;
}

export async function bindCliFlow(
  config: MarketplaceGrantConfig,
  stateId: string,
  flowId: string,
  expiresAt: Date,
): Promise<boolean> {
  const result = await grantSql(config)`
    UPDATE shop_grant_bff.cli_flow_state
    SET flow_id = ${flowId}, expires_at = LEAST(expires_at, ${expiresAt}),
        status = 'awaiting', version = version + 1
    WHERE state_id = ${stateId} AND status = 'creating'
  `;
  return result.count === 1;
}

export async function getCliFlow(config: MarketplaceGrantConfig, stateId: string): Promise<CliFlowRow | null> {
  const rows = await grantSql(config)<CliFlowRow[]>`
    SELECT * FROM shop_grant_bff.cli_flow_state WHERE state_id = ${stateId}
  `;
  return rows[0] ?? null;
}

export async function terminalizeCliFlow(
  config: MarketplaceGrantConfig,
  stateId: string,
  status: string,
): Promise<void> {
  await grantSql(config)`
    UPDATE shop_grant_bff.cli_flow_state
    SET status = ${status}, context_sealed = NULL, result_token_sealed = NULL,
        terminal_at = now(), lease_owner = NULL, lease_until = NULL, version = version + 1
    WHERE state_id = ${stateId}
      AND status IN ('creating','awaiting','claiming')
  `;
}

export async function acquireCliClaim(
  config: MarketplaceGrantConfig,
  stateId: string,
  owner: string,
): Promise<CliFlowRow | null> {
  const rows = await grantSql(config)<CliFlowRow[]>`
    UPDATE shop_grant_bff.cli_flow_state
    SET status = 'claiming', lease_owner = ${owner},
        lease_until = now() + (${config.claimLeaseSeconds} * interval '1 second'),
        version = version + 1
    WHERE state_id = ${stateId} AND status = 'awaiting' AND expires_at > now()
    RETURNING *
  `;
  return rows[0] ?? null;
}

export async function renewCliClaim(config: MarketplaceGrantConfig, stateId: string, owner: string): Promise<boolean> {
  const rows = await grantSql(config)<CliFlowRow[]>`
    UPDATE shop_grant_bff.cli_flow_state
    SET lease_until = now() + (${config.claimLeaseSeconds} * interval '1 second'),
        version = version + 1
    WHERE state_id = ${stateId} AND status = 'claiming' AND lease_owner = ${owner}
    RETURNING *
  `;
  return rows.length === 1;
}

export async function storeCliResultToken(
  config: MarketplaceGrantConfig,
  stateId: string,
  sealed: Uint8Array,
): Promise<boolean> {
  const result = await grantSql(config)`
    UPDATE shop_grant_bff.cli_flow_state
    SET result_token_sealed = ${sealed}, version = version + 1
    WHERE state_id = ${stateId}
      AND status = 'awaiting'
      AND result_token_sealed IS NULL
      AND expires_at > now()
  `;
  return result.count === 1;
}

export async function completeCliClaim(
  config: MarketplaceGrantConfig,
  stateId: string,
  owner: string,
): Promise<boolean> {
  const result = await grantSql(config)`
    UPDATE shop_grant_bff.cli_flow_state
    SET status = 'claimed', context_sealed = NULL, result_token_sealed = NULL, terminal_at = now(),
        lease_owner = NULL, lease_until = NULL, version = version + 1
    WHERE state_id = ${stateId} AND status = 'claiming' AND lease_owner = ${owner}
  `;
  return result.count === 1;
}

export async function abandonCliClaim(config: MarketplaceGrantConfig, stateId: string, owner: string): Promise<void> {
  await grantSql(config)`
    UPDATE shop_grant_bff.cli_flow_state
    SET status = 'abandoned', context_sealed = NULL, result_token_sealed = NULL, terminal_at = now(),
        lease_owner = NULL, lease_until = NULL, version = version + 1
    WHERE state_id = ${stateId} AND status = 'claiming' AND lease_owner = ${owner}
  `;
}

/**
 * Abandons a claim whose lease lapsed (its claimer crashed or timed out).
 * The database clock decides the lapse, the same rule as the cleanup job.
 */
export async function abandonLapsedCliClaim(config: MarketplaceGrantConfig, stateId: string): Promise<boolean> {
  const result = await grantSql(config)`
    UPDATE shop_grant_bff.cli_flow_state
    SET status = 'abandoned', context_sealed = NULL, result_token_sealed = NULL, terminal_at = now(),
        lease_owner = NULL, lease_until = NULL, version = version + 1
    WHERE state_id = ${stateId} AND status = 'claiming' AND lease_until <= now()
  `;
  return result.count === 1;
}

export async function consumeCliRateLimit(
  config: MarketplaceGrantConfig,
  bucketKey: string,
  limit: number,
): Promise<boolean> {
  const rows = await grantSql(config)<{ count: number }[]>`
    INSERT INTO shop_grant_bff.cli_rate_buckets (bucket_key, window_start, count, updated_at)
    VALUES (${bucketKey}, date_trunc('minute', now()), 1, now())
    ON CONFLICT (bucket_key) DO UPDATE
    SET
      count = CASE
        WHEN shop_grant_bff.cli_rate_buckets.window_start = date_trunc('minute', now())
        THEN shop_grant_bff.cli_rate_buckets.count + 1
        ELSE 1
      END,
      window_start = date_trunc('minute', now()),
      updated_at = now()
    RETURNING count
  `;
  return (rows[0]?.count ?? 1) <= limit;
}
