-- LLM Inference API schema. Idempotent: `npm run db:migrate` can be rerun.
-- PostgreSQL is the source of truth for tenants, keys, the request record
-- (its state machine) and usage. Valkey holds buckets, queues and event logs.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Tier limits. Token limits are per minute and are charged by cost
-- (estimated input tokens + max_tokens), not by request count.
CREATE TABLE IF NOT EXISTS tiers (
  name                    TEXT PRIMARY KEY,
  tokens_per_minute       INTEGER NOT NULL CHECK (tokens_per_minute > 0),
  requests_per_minute     INTEGER NOT NULL CHECK (requests_per_minute > 0),
  -- A tenant's share of each class queue; over it the tenant gets 429, not the system 529.
  max_queued_interactive  INTEGER NOT NULL CHECK (max_queued_interactive > 0),
  max_queued_batch        INTEGER NOT NULL CHECK (max_queued_batch > 0),
  -- Deficit-round-robin weight in the dispatcher.
  weight                  INTEGER NOT NULL DEFAULT 1 CHECK (weight > 0)
);

CREATE TABLE IF NOT EXISTS orgs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  tier        TEXT NOT NULL REFERENCES tiers(name),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username       TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  is_admin       BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memberships (
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id   UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  role     TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  PRIMARY KEY (user_id, org_id)
);

-- Only a hash of the secret is stored; the prefix is for display.
CREATE TABLE IF NOT EXISTS api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  key_prefix    TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS api_keys_org_idx ON api_keys (org_id);

-- One row per inference request. The id is assigned at the edge (gateway)
-- and owns the work. status follows shared/state-machine.ts:
--   queued → running → completed | cancelled | failed   (queued → cancelled | failed too)
CREATE TABLE IF NOT EXISTS requests (
  id                 TEXT PRIMARY KEY,
  org_id             UUID NOT NULL REFERENCES orgs(id),
  api_key_id         UUID NOT NULL REFERENCES api_keys(id),
  model              TEXT NOT NULL,
  mode               TEXT NOT NULL CHECK (mode IN ('sync', 'stream', 'async')),
  priority_class     TEXT NOT NULL CHECK (priority_class IN ('interactive', 'batch')),
  status             TEXT NOT NULL DEFAULT 'queued'
                       CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
  max_tokens         INTEGER NOT NULL CHECK (max_tokens > 0),
  est_input_tokens   INTEGER NOT NULL,
  -- Reserved against the token bucket at admission; the unused part is refunded.
  est_cost_tokens    INTEGER NOT NULL,
  prefix_key         TEXT NOT NULL,
  prefix_tokens      INTEGER NOT NULL DEFAULT 0,
  idempotency_key    TEXT,
  input              JSONB NOT NULL,
  output_text        TEXT,
  stop_reason        TEXT,
  error_type         TEXT,
  error_message      TEXT,
  cancel_reason      TEXT,
  backend_id         TEXT,
  model_version      TEXT,
  batch_id           UUID,
  attempts           INTEGER NOT NULL DEFAULT 0,
  affinity           TEXT CHECK (affinity IN ('primary', 'spill')),
  deadline_at        TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at      TIMESTAMPTZ,
  first_token_at     TIMESTAMPTZ,
  finished_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS requests_org_created_idx ON requests (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS requests_key_created_idx ON requests (api_key_id, created_at DESC);
CREATE INDEX IF NOT EXISTS requests_open_idx ON requests (status, created_at) WHERE status IN ('queued', 'running');
-- An Idempotency-Key maps to at most one live or completed request per org. A
-- cancelled or failed attempt leaves the index, so a retry with the same key
-- starts a fresh request instead of replaying the failure.
CREATE UNIQUE INDEX IF NOT EXISTS requests_idempotency_idx ON requests (org_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status NOT IN ('cancelled', 'failed');

-- Written once per request when it reaches a terminal state (ON CONFLICT DO
-- NOTHING makes finalization idempotent; the refund happens only on insert).
CREATE TABLE IF NOT EXISTS usage (
  request_id           TEXT PRIMARY KEY REFERENCES requests(id) ON DELETE CASCADE,
  org_id               UUID NOT NULL REFERENCES orgs(id),
  api_key_id           UUID NOT NULL REFERENCES api_keys(id),
  priority_class       TEXT NOT NULL,
  status               TEXT NOT NULL,
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  cached_input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  reserved_tokens      INTEGER NOT NULL DEFAULT 0,
  refunded_tokens      INTEGER NOT NULL DEFAULT 0,
  -- Latency split: time waiting for capacity vs time on the model.
  queue_ms             INTEGER,
  ttft_ms              INTEGER,
  exec_ms              INTEGER,
  total_ms             INTEGER,
  tokens_per_sec       REAL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_org_created_idx ON usage (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_created_idx ON usage (created_at DESC);

-- One row per dispatched batch: how full it was and why it left.
CREATE TABLE IF NOT EXISTS batches (
  id              UUID PRIMARY KEY,
  priority_class  TEXT NOT NULL,
  size            INTEGER NOT NULL,
  max_size        INTEGER NOT NULL,
  trigger         TEXT NOT NULL CHECK (trigger IN ('full', 'max_wait', 'deadline')),
  oldest_wait_ms  INTEGER NOT NULL,
  backends        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS batches_created_idx ON batches (created_at DESC);
