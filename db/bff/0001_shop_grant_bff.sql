BEGIN;

CREATE SCHEMA IF NOT EXISTS shop_grant_bff;

CREATE TABLE shop_grant_bff.schema_version (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  version INTEGER NOT NULL CHECK (version = 1),
  applied_at TIMESTAMPTZ NOT NULL
);

INSERT INTO shop_grant_bff.schema_version(singleton, version, applied_at)
VALUES (TRUE, 1, now());

CREATE TABLE shop_grant_bff.session_bridge (
  bridge_id UUID PRIMARY KEY,
  cookie_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(cookie_hash) = 32),
  pubky TEXT NOT NULL CHECK (char_length(pubky) = 52),
  marketplace_session_id UUID NOT NULL,
  bearer_sealed BYTEA NOT NULL,
  key_epoch SMALLINT NOT NULL CHECK (key_epoch BETWEEN 1 AND 32767),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  last_verified_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX session_bridge_pubky_idx
  ON shop_grant_bff.session_bridge (pubky);
CREATE INDEX session_bridge_expiry_idx
  ON shop_grant_bff.session_bridge (expires_at);

CREATE TABLE shop_grant_bff.flow_state (
  state_id UUID PRIMARY KEY,
  bridge_id UUID NOT NULL
    REFERENCES shop_grant_bff.session_bridge(bridge_id) ON DELETE CASCADE,
  flow_id UUID UNIQUE,
  result_binding_hash BYTEA NOT NULL CHECK (octet_length(result_binding_hash) = 32),
  context_sealed BYTEA,
  key_epoch SMALLINT NOT NULL CHECK (key_epoch BETWEEN 1 AND 32767),
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
      AND terminal_at IS NOT NULL AND context_sealed IS NULL)
    OR
    (status IN ('creating','awaiting','claiming')
      AND terminal_at IS NULL AND context_sealed IS NOT NULL)
  )
);

CREATE INDEX flow_state_bridge_idx
  ON shop_grant_bff.flow_state (bridge_id, created_at DESC);
CREATE INDEX flow_state_expiry_idx
  ON shop_grant_bff.flow_state (expires_at, created_at)
  WHERE status IN ('creating','awaiting','claiming');
CREATE INDEX flow_state_stale_claim_idx
  ON shop_grant_bff.flow_state (lease_until)
  WHERE status = 'claiming';
CREATE INDEX flow_state_terminal_cleanup_idx
  ON shop_grant_bff.flow_state (terminal_at)
  WHERE terminal_at IS NOT NULL;

COMMIT;
