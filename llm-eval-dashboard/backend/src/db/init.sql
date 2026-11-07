-- LLM Eval Dashboard schema. Idempotent: `npm run db:migrate` runs this file on every start.
--
-- Inputs are immutable versions (datasets, prompts, model configs, scorers); a
-- trigger rejects UPDATE/DELETE on them, so "editing" can only create a version.
-- An eval run pins one of each. case_results are both the work queue (claimed
-- with FOR UPDATE SKIP LOCKED) and the results, keyed (run, case, sample).
-- Scores live in their own table keyed (case_result, scorer_version), so
-- re-scoring adds rows and never touches outputs or older scores.

CREATE TABLE IF NOT EXISTS workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rejects any change to a row that other records pin. TRUNCATE (used by the seed) is unaffected.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% rows are immutable: create a new version instead', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

-- ── Datasets ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS datasets (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name         TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description  TEXT NOT NULL DEFAULT '',
  -- Highest version number; a new version must name it as its base (optimistic concurrency).
  head_version INT  NOT NULL DEFAULT 0,
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS dataset_versions (
  id           TEXT PRIMARY KEY,
  dataset_id   TEXT NOT NULL REFERENCES datasets(id),
  version      INT  NOT NULL CHECK (version > 0),
  message      TEXT NOT NULL DEFAULT '',
  case_count   INT  NOT NULL,
  content_hash CHAR(64) NOT NULL,
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dataset_id, version)
);

-- One row per (version, case). case_key is the case's identity across versions;
-- content_hash covers input, reference and tags.
CREATE TABLE IF NOT EXISTS dataset_cases (
  id                 TEXT PRIMARY KEY,
  dataset_version_id TEXT NOT NULL REFERENCES dataset_versions(id),
  case_key           TEXT NOT NULL,
  ordinal            INT  NOT NULL,
  input              JSONB NOT NULL,
  reference          TEXT NOT NULL,
  tags               TEXT[] NOT NULL DEFAULT '{}',
  content_hash       CHAR(64) NOT NULL,
  UNIQUE (dataset_version_id, case_key)
);
CREATE INDEX IF NOT EXISTS idx_dataset_cases_version ON dataset_cases (dataset_version_id, ordinal);

-- ── Prompts and model configs ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS prompts (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name         TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  description  TEXT NOT NULL DEFAULT '',
  head_version INT  NOT NULL DEFAULT 0,
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id          TEXT PRIMARY KEY,
  prompt_id   TEXT NOT NULL REFERENCES prompts(id),
  version     INT  NOT NULL CHECK (version > 0),
  system_text TEXT NOT NULL DEFAULT '',
  template    TEXT NOT NULL,
  variables   TEXT[] NOT NULL DEFAULT '{}',
  message     TEXT NOT NULL DEFAULT '',
  created_by  TEXT NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (prompt_id, version)
);

-- Immutable: "editing" a config creates a new row, so a run's pin never drifts.
CREATE TABLE IF NOT EXISTS model_configs (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name         TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  model        TEXT NOT NULL,
  temperature  NUMERIC(3,2) NOT NULL CHECK (temperature BETWEEN 0 AND 2),
  max_tokens   INT NOT NULL CHECK (max_tokens BETWEEN 1 AND 4096),
  seed         INT NOT NULL,
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

-- ── Scorers ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scorers (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name         TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  kind         TEXT NOT NULL CHECK (kind IN ('exact_match', 'regex', 'contains', 'json_shape', 'model_graded', 'human')),
  description  TEXT NOT NULL DEFAULT '',
  head_version INT  NOT NULL DEFAULT 0,
  created_by   TEXT NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS scorer_versions (
  id         TEXT PRIMARY KEY,
  scorer_id  TEXT NOT NULL REFERENCES scorers(id),
  version    INT  NOT NULL CHECK (version > 0),
  config     JSONB NOT NULL,
  message    TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scorer_id, version)
);

DROP TRIGGER IF EXISTS dataset_versions_immutable ON dataset_versions;
CREATE TRIGGER dataset_versions_immutable BEFORE UPDATE OR DELETE ON dataset_versions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
DROP TRIGGER IF EXISTS dataset_cases_immutable ON dataset_cases;
CREATE TRIGGER dataset_cases_immutable BEFORE UPDATE OR DELETE ON dataset_cases FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
DROP TRIGGER IF EXISTS prompt_versions_immutable ON prompt_versions;
CREATE TRIGGER prompt_versions_immutable BEFORE UPDATE OR DELETE ON prompt_versions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
DROP TRIGGER IF EXISTS model_configs_immutable ON model_configs;
CREATE TRIGGER model_configs_immutable BEFORE UPDATE OR DELETE ON model_configs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
DROP TRIGGER IF EXISTS scorer_versions_immutable ON scorer_versions;
CREATE TRIGGER scorer_versions_immutable BEFORE UPDATE OR DELETE ON scorer_versions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ── Eval runs ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS eval_runs (
  id                  TEXT PRIMARY KEY,
  workspace_id        TEXT NOT NULL REFERENCES workspaces(id),
  name                TEXT NOT NULL,
  dataset_version_id  TEXT NOT NULL REFERENCES dataset_versions(id),
  prompt_version_id   TEXT NOT NULL REFERENCES prompt_versions(id),
  model_config_id     TEXT NOT NULL REFERENCES model_configs(id),
  samples_per_case    INT  NOT NULL CHECK (samples_per_case BETWEEN 1 AND 20),
  concurrency_limit   INT  NOT NULL CHECK (concurrency_limit BETWEEN 1 AND 64),
  status              TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
  total_tasks         INT  NOT NULL,
  -- Incremented by "retry errored cases", which reopens a finished run.
  retry_round         INT  NOT NULL DEFAULT 0,
  failure_reason      TEXT,
  created_by          TEXT NOT NULL REFERENCES users(id),
  idempotency_key     TEXT NOT NULL,
  request_hash        CHAR(64) NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  -- Fairness: the claim query serves the run claimed longest ago first (round robin).
  last_claimed_at     TIMESTAMPTZ,
  UNIQUE (workspace_id, created_by, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_eval_runs_workspace ON eval_runs (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_runs_active ON eval_runs (last_claimed_at NULLS FIRST, created_at) WHERE status IN ('queued', 'running');

-- Scorer versions attached to a run: pinned at creation, or added later by re-scoring.
CREATE TABLE IF NOT EXISTS run_scorers (
  run_id            TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  scorer_version_id TEXT NOT NULL REFERENCES scorer_versions(id),
  origin            TEXT NOT NULL CHECK (origin IN ('pinned', 'rescore')),
  added_by          TEXT NOT NULL REFERENCES users(id),
  added_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, scorer_version_id)
);

-- One row per (run, case, sample): the task AND its result. The unique key is
-- why a retried or re-leased task can never produce a second result.
CREATE TABLE IF NOT EXISTS case_results (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  case_id          TEXT NOT NULL REFERENCES dataset_cases(id),
  case_key         TEXT NOT NULL,
  sample_index     INT  NOT NULL CHECK (sample_index >= 0),
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'running', 'succeeded', 'errored', 'cancelled')),
  attempts         INT  NOT NULL DEFAULT 0,
  round_attempts   INT  NOT NULL DEFAULT 0,
  available_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner      TEXT,
  lease_token      TEXT,
  lease_expires_at TIMESTAMPTZ,
  output           TEXT,
  finish_reason    TEXT,
  input_tokens     INT,
  output_tokens    INT,
  queue_ms         INT,
  ttft_ms          INT,
  generation_ms    INT,
  error_code       TEXT,
  error_message    TEXT,
  enqueued_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ,
  UNIQUE (run_id, case_id, sample_index)
);
CREATE INDEX IF NOT EXISTS idx_case_results_claimable ON case_results (run_id, available_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_case_results_leased ON case_results (run_id, lease_expires_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_case_results_run_status ON case_results (run_id, status);

-- Every attempt at a task, including ones whose worker died (lease_expired).
CREATE TABLE IF NOT EXISTS case_attempts (
  case_result_id TEXT NOT NULL REFERENCES case_results(id) ON DELETE CASCADE,
  attempt        INT  NOT NULL,
  worker_id      TEXT NOT NULL,
  outcome        TEXT NOT NULL DEFAULT 'in_progress'
                 CHECK (outcome IN ('in_progress', 'succeeded', 'retry_scheduled', 'errored', 'lease_expired', 'cancelled', 'superseded')),
  error_code     TEXT,
  http_status    INT,
  delay_ms       INT,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  PRIMARY KEY (case_result_id, attempt)
);

-- Scores are separate from outputs: (case_result, scorer_version) is the key.
-- Deterministic scorers are written inline when a generation succeeds; judge
-- scores and re-scores are queued here and claimed like generation tasks.
CREATE TABLE IF NOT EXISTS scores (
  case_result_id    TEXT NOT NULL REFERENCES case_results(id) ON DELETE CASCADE,
  scorer_version_id TEXT NOT NULL REFERENCES scorer_versions(id),
  run_id            TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'scored', 'errored', 'cancelled')),
  score             NUMERIC(6,4),
  passed            BOOLEAN,
  confidence        NUMERIC(4,3),
  rationale         TEXT,
  attempts          INT NOT NULL DEFAULT 0,
  available_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_owner       TEXT,
  lease_token       TEXT,
  lease_expires_at  TIMESTAMPTZ,
  error_code        TEXT,
  error_message     TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  scored_at         TIMESTAMPTZ,
  PRIMARY KEY (case_result_id, scorer_version_id)
);
CREATE INDEX IF NOT EXISTS idx_scores_claimable ON scores (available_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_scores_leased ON scores (lease_expires_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_scores_run ON scores (run_id, scorer_version_id, status);

-- Human labels. One label per output; editing it keeps who and when.
CREATE TABLE IF NOT EXISTS annotations (
  case_result_id TEXT PRIMARY KEY REFERENCES case_results(id) ON DELETE CASCADE,
  run_id         TEXT NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  label          TEXT NOT NULL CHECK (label IN ('pass', 'fail')),
  note           TEXT NOT NULL DEFAULT '',
  annotated_by   TEXT NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_annotations_run ON annotations (run_id);
