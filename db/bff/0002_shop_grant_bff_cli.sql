BEGIN;

ALTER TABLE shop_grant_bff.schema_version
  DROP CONSTRAINT IF EXISTS schema_version_version_check;
UPDATE shop_grant_bff.schema_version
  SET version = 2, applied_at = now()
  WHERE singleton;
ALTER TABLE shop_grant_bff.schema_version
  ADD CONSTRAINT schema_version_version_check CHECK (version = 2);

CREATE TABLE shop_grant_bff.cli_challenges (
  challenge_id UUID PRIMARY KEY,
  pubky TEXT NOT NULL CHECK (char_length(pubky) = 52),
  result_cpk TEXT NOT NULL CHECK (char_length(result_cpk) = 52),
  result_delivery_id_hash BYTEA NOT NULL
    CHECK (octet_length(result_delivery_id_hash) = 32),
  nonce_hash BYTEA NOT NULL CHECK (octet_length(nonce_hash) = 32),
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > created_at)
);
CREATE INDEX cli_challenges_expiry_idx
  ON shop_grant_bff.cli_challenges (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE shop_grant_bff.cli_flow_state (
  state_id UUID PRIMARY KEY,
  challenge_id UUID NOT NULL UNIQUE
    REFERENCES shop_grant_bff.cli_challenges(challenge_id),
  flow_id UUID UNIQUE,
  pubky TEXT NOT NULL CHECK (char_length(pubky) = 52),
  result_cpk TEXT NOT NULL CHECK (char_length(result_cpk) = 52),
  token_hash BYTEA NOT NULL UNIQUE
    CHECK (octet_length(token_hash) = 32),
  context_sealed BYTEA,
  result_token_sealed BYTEA,
  key_epoch SMALLINT NOT NULL
    CHECK (key_epoch BETWEEN 1 AND 32767),
  status TEXT NOT NULL CHECK (status IN
    ('creating','awaiting','claiming','claimed','mismatch','expired',
     'cancelled','failed','abandoned')),
  lease_owner UUID,
  lease_until TIMESTAMPTZ,
  version BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  terminal_at TIMESTAMPTZ,
  CHECK (expires_at > created_at),
  CHECK (
    (status = 'claiming' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
    OR
    (status <> 'claiming' AND lease_owner IS NULL AND lease_until IS NULL)
  ),
  CHECK (
    (status IN ('claimed','mismatch','expired','cancelled','failed','abandoned')
      AND terminal_at IS NOT NULL AND context_sealed IS NULL
      AND result_token_sealed IS NULL)
    OR
    (status IN ('creating','awaiting','claiming')
      AND terminal_at IS NULL AND context_sealed IS NOT NULL)
  )
);
CREATE INDEX cli_flow_state_expiry_idx
  ON shop_grant_bff.cli_flow_state (expires_at, created_at)
  WHERE status IN ('creating','awaiting','claiming');
CREATE INDEX cli_flow_state_stale_claim_idx
  ON shop_grant_bff.cli_flow_state (lease_until)
  WHERE status = 'claiming';

CREATE TABLE shop_grant_bff.cli_rate_buckets (
  bucket_key TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  updated_at TIMESTAMPTZ NOT NULL
);

COMMIT;
