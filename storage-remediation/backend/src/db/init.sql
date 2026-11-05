-- Storage remediation schema. Every statement is idempotent so `npm run db:migrate` can rerun.
-- PostgreSQL is the source of truth for inventory, findings, evidence, campaign step state,
-- exceptions and the audit log. Valkey holds sessions, the dispatch stream, token buckets
-- and live campaign events, all of which can be rebuilt from these tables.

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('security', 'owner', 'approver')),
  team          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subscriptions (
  subscription_id  TEXT PRIMARY KEY,
  display_name     TEXT NOT NULL,
  management_group TEXT NOT NULL,
  environment      TEXT NOT NULL,
  owner_team       TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Control metadata and the current Azure Policy effect. Rule logic is versioned in code
-- (domain/controls.ts); findings record the version that produced them.
CREATE TABLE IF NOT EXISTS controls (
  id                TEXT PRIMARY KEY,
  version           INT NOT NULL,
  key               TEXT NOT NULL UNIQUE,
  title             TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('account', 'blobService', 'diagnostics')),
  severity          TEXT NOT NULL,
  breaking          BOOLEAN NOT NULL,
  policy_effect     TEXT NOT NULL DEFAULT 'audit',
  policy_updated_at TIMESTAMPTZ,
  policy_updated_by TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per storage account. properties_modified_at (systemData.lastModifiedAt) is the
-- version guard: a lagging Resource Graph read never overwrites a fresher ARM read.
CREATE TABLE IF NOT EXISTS storage_accounts (
  id                       TEXT PRIMARY KEY,
  subscription_id          TEXT NOT NULL,
  resource_group           TEXT NOT NULL,
  name                     TEXT NOT NULL UNIQUE,
  location                 TEXT NOT NULL,
  tags                     JSONB NOT NULL DEFAULT '{}',
  owner                    TEXT,
  owner_source             TEXT NOT NULL DEFAULT 'tag' CHECK (owner_source IN ('tag', 'subscription')),
  environment              TEXT NOT NULL,
  data_classification      TEXT,
  properties               JSONB NOT NULL,
  properties_modified_at   TIMESTAMPTZ NOT NULL,
  blob_service             JSONB,
  blob_service_modified_at TIMESTAMPTZ,
  diagnostics              JSONB,
  diagnostics_modified_at  TIMESTAMPTZ,
  children_read_at         TIMESTAMPTZ,
  observed_via             TEXT NOT NULL CHECK (observed_via IN ('graph', 'arm', 'event')),
  observed_at              TIMESTAMPTZ NOT NULL,
  traffic_per_min          NUMERIC NOT NULL DEFAULT 0,
  first_seen_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at               TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS storage_accounts_subscription_idx ON storage_accounts (subscription_id);
CREATE INDEX IF NOT EXISTS storage_accounts_owner_idx ON storage_accounts (owner);
CREATE INDEX IF NOT EXISTS storage_accounts_env_idx ON storage_accounts (environment);

-- Only non-compliant results are stored (plus resolved history). Compliance is
-- (accounts evaluated) - open - exempt, per control.
CREATE TABLE IF NOT EXISTS findings (
  id              BIGSERIAL PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES storage_accounts(id),
  control_id      TEXT NOT NULL REFERENCES controls(id),
  control_version INT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'exempt')),
  severity        TEXT NOT NULL,
  risk_score      INT NOT NULL DEFAULT 0,
  observed        JSONB,
  evidence_class  TEXT CHECK (evidence_class IN ('safe_to_fix', 'needs_owner_migration', 'insufficient_evidence')),
  evidence_reason TEXT,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  reopened_count  INT NOT NULL DEFAULT 0,
  due_at          TIMESTAMPTZ,
  UNIQUE (account_id, control_id)
);
CREATE INDEX IF NOT EXISTS findings_control_status_idx ON findings (control_id, status);
CREATE INDEX IF NOT EXISTS findings_status_risk_idx ON findings (status, risk_score DESC);

-- Latest usage evidence per account, from access logs (StorageBlobLogs).
CREATE TABLE IF NOT EXISTS usage_evidence (
  account_id    TEXT PRIMARY KEY REFERENCES storage_accounts(id),
  computed_at   TIMESTAMPTZ NOT NULL,
  lookback_days INT NOT NULL,
  window_days   INT NOT NULL,
  has_logs      BOOLEAN NOT NULL,
  counts        JSONB NOT NULL,
  callers       JSONB NOT NULL,
  stale         BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS exceptions (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES storage_accounts(id),
  control_id     TEXT NOT NULL REFERENCES controls(id),
  status         TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'revoked')),
  justification  TEXT NOT NULL,
  requested_by   TEXT NOT NULL REFERENCES users(id),
  requested_days INT NOT NULL,
  decided_by     TEXT REFERENCES users(id),
  decided_at     TIMESTAMPTZ,
  decision_note  TEXT,
  expires_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- At most one live (pending or approved) exception per account and control.
CREATE UNIQUE INDEX IF NOT EXISTS exceptions_one_live_idx ON exceptions (account_id, control_id) WHERE status IN ('pending', 'approved');
CREATE INDEX IF NOT EXISTS exceptions_expiry_idx ON exceptions (expires_at) WHERE status = 'approved';

CREATE TABLE IF NOT EXISTS campaigns (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  control_id      TEXT NOT NULL REFERENCES controls(id),
  status          TEXT NOT NULL CHECK (status IN ('draft', 'running', 'paused', 'completed', 'killed')),
  status_reason   TEXT,
  config          JSONB NOT NULL,
  plan_summary    JSONB NOT NULL,
  self_service    BOOLEAN NOT NULL DEFAULT false,
  created_by      TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT UNIQUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS campaigns_status_idx ON campaigns (status);

CREATE TABLE IF NOT EXISTS campaign_waves (
  campaign_id  TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  wave_no      INT NOT NULL,
  ring         TEXT NOT NULL,
  label        TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('pending', 'running', 'completed', 'halted')),
  target_count INT NOT NULL,
  -- Failures a human already looked at when resuming a paused wave; the budget counts only new ones.
  acknowledged_failures INT NOT NULL DEFAULT 0,
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  PRIMARY KEY (campaign_id, wave_no)
);

-- Durable step state for each account in a campaign. The executor writes intent
-- (before_value, etag_before, baseline) before touching the cloud, so a crash at any
-- point resumes without a second write and rollback always restores the true original.
-- fence increments on every claim; a worker whose lease expired matches zero rows.
CREATE TABLE IF NOT EXISTS campaign_targets (
  id              BIGSERIAL PRIMARY KEY,
  campaign_id     TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  account_id      TEXT NOT NULL REFERENCES storage_accounts(id),
  subscription_id TEXT NOT NULL,
  wave_no         INT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('pending', 'queued', 'applying', 'baking', 'rolling_back', 'verified', 'rolled_back', 'skipped', 'escalated', 'failed', 'cancelled')),
  -- Server errors and timeouts (bounded by EXECUTOR_MAX_ATTEMPTS) and 429s (bounded by EXECUTOR_MAX_THROTTLES), counted separately.
  attempts        INT NOT NULL DEFAULT 0,
  throttle_count  INT NOT NULL DEFAULT 0,
  fence           BIGINT NOT NULL DEFAULT 0,
  claimed_by      TEXT,
  lease_until     TIMESTAMPTZ,
  not_before      TIMESTAMPTZ,
  enqueued_at     TIMESTAMPTZ,
  -- Identity of the write, sent as x-ms-client-request-id and recorded before the call, so a lost
  -- response can be matched to the platform's activity log. The fast path reconciles on actual state.
  operation_id    TEXT,
  before_value    JSONB,
  etag_before     TEXT,
  after_value     JSONB,
  etag_after      TEXT,
  write_outcome   TEXT,
  baseline        JSONB,
  applied_at      TIMESTAMPTZ,
  bake_until      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  rollback_reason TEXT,
  last_error      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, account_id)
);
CREATE INDEX IF NOT EXISTS campaign_targets_wave_idx ON campaign_targets (campaign_id, wave_no, state);
CREATE INDEX IF NOT EXISTS campaign_targets_active_idx ON campaign_targets (state, lease_until) WHERE state IN ('queued', 'applying', 'baking', 'rolling_back');
CREATE INDEX IF NOT EXISTS campaign_targets_account_idx ON campaign_targets (account_id);

-- Append-only audit trail: who changed what, when, from what to what.
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  account_id  TEXT,
  control_id  TEXT,
  campaign_id TEXT,
  before      JSONB,
  after       JSONB,
  details     JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at DESC);
CREATE INDEX IF NOT EXISTS audit_log_account_idx ON audit_log (account_id, at DESC);
CREATE INDEX IF NOT EXISTS audit_log_campaign_idx ON audit_log (campaign_id, at DESC);

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

CREATE TABLE IF NOT EXISTS notifications (
  id          BIGSERIAL PRIMARY KEY,
  audience    TEXT NOT NULL CHECK (audience IN ('owner', 'security', 'approver')),
  team        TEXT,
  kind        TEXT NOT NULL,
  account_id  TEXT,
  control_id  TEXT,
  message     TEXT NOT NULL,
  due_at      TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at     TIMESTAMPTZ,
  dedupe_key  TEXT UNIQUE
);
CREATE INDEX IF NOT EXISTS notifications_team_idx ON notifications (audience, team, created_at DESC);

CREATE TABLE IF NOT EXISTS posture_snapshots (
  taken_at   TIMESTAMPTZ NOT NULL,
  control_id TEXT NOT NULL REFERENCES controls(id),
  total      INT NOT NULL,
  compliant  INT NOT NULL,
  open       INT NOT NULL,
  exempt     INT NOT NULL,
  source     TEXT NOT NULL DEFAULT 'scan' CHECK (source IN ('scan', 'seed')),
  PRIMARY KEY (taken_at, control_id)
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id          BIGSERIAL PRIMARY KEY,
  shard       INT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('full', 'evidence')),
  status      TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  stats       JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS scan_runs_kind_idx ON scan_runs (kind, started_at DESC);

CREATE TABLE IF NOT EXISTS scanner_cursors (
  shard          INT PRIMARY KEY,
  change_seq     BIGINT NOT NULL DEFAULT 0,
  last_event_at  TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
