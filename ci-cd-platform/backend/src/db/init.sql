-- CI/CD platform schema. Every statement is idempotent, so `npm run db:migrate`
-- can be rerun. PostgreSQL is the source of truth for everything except artifact
-- bytes and archived logs, which live in MinIO.

CREATE TABLE IF NOT EXISTS orgs (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  username       TEXT NOT NULL UNIQUE,
  display_name   TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  is_admin       BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS repositories (
  id                   TEXT PRIMARY KEY,
  org_id               TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  full_name            TEXT NOT NULL UNIQUE,
  default_branch       TEXT NOT NULL DEFAULT 'main',
  -- AES-256-GCM; the HMAC key has to be readable to verify a signature.
  webhook_secret_enc   TEXT NOT NULL,
  -- Per-repository limit on jobs holding a lease. Exact: claims per repository are serialized on this row.
  max_concurrent_jobs  INT NOT NULL DEFAULT 3 CHECK (max_concurrent_jobs > 0),
  -- Round robin between repositories: the least recently served goes first.
  last_claimed_at      TIMESTAMPTZ,
  -- Seeding only: real runners skip the repository while a story is materialized.
  claims_paused        BOOLEAN NOT NULL DEFAULT false,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Separate from `repositories` so an intake burst doesn't contend with the claim lock on the repository row.
CREATE TABLE IF NOT EXISTS repo_run_counters (
  repo_id      TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
  next_number  INT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS repo_members (
  repo_id  TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  user_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     TEXT NOT NULL CHECK (role IN ('maintainer', 'read')),
  PRIMARY KEY (repo_id, user_id)
);
CREATE INDEX IF NOT EXISTS repo_members_user_idx ON repo_members (user_id);

-- The stand-in for a Git host: commit SHA -> file tree, including .ci/workflow.yml.
CREATE TABLE IF NOT EXISTS fixture_commits (
  repo_id      TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  sha          TEXT NOT NULL,
  parent_sha   TEXT,
  branch       TEXT NOT NULL,
  message      TEXT NOT NULL,
  author       TEXT NOT NULL,
  scenario     TEXT NOT NULL,
  -- Set for a pull-request head that lives in a fork: the refs/pull/N/head equivalent.
  source_repo  TEXT,
  tree         JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, sha)
);

-- One row per delivery id, ever. The UNIQUE constraint is the deduplication.
CREATE TABLE IF NOT EXISTS trigger_events (
  id                TEXT PRIMARY KEY,
  repo_id           TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  delivery_id       TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  action            TEXT,
  ref               TEXT NOT NULL,
  branch            TEXT NOT NULL,
  commit_sha        TEXT NOT NULL,
  sender            TEXT NOT NULL,
  pr_number         INT,
  head_repo         TEXT,
  is_fork           BOOLEAN NOT NULL DEFAULT false,
  payload_sha256    TEXT NOT NULL,
  -- The event as received: for debugging, and what a redelivery sends again.
  payload           JSONB NOT NULL,
  -- created_run | no_workflow | filtered | unknown_commit
  outcome           TEXT NOT NULL,
  outcome_detail    TEXT,
  run_id            TEXT,
  redeliveries      INT NOT NULL DEFAULT 0,
  last_received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_id, delivery_id)
);
CREATE INDEX IF NOT EXISTS trigger_events_repo_idx ON trigger_events (repo_id, created_at DESC);

-- Content-addressed: the SHA is the hash of the content, so a row can never change meaning.
CREATE TABLE IF NOT EXISTS workflow_files (
  sha         TEXT PRIMARY KEY,
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workflow_runs (
  id                   TEXT PRIMARY KEY,
  repo_id              TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  run_number           INT NOT NULL,
  trigger_event_id     TEXT NOT NULL REFERENCES trigger_events(id) ON DELETE CASCADE,
  event_type           TEXT NOT NULL,
  ref                  TEXT NOT NULL,
  branch               TEXT NOT NULL,
  commit_sha           TEXT NOT NULL,
  commit_message       TEXT NOT NULL,
  workflow_path        TEXT NOT NULL,
  workflow_sha         TEXT NOT NULL REFERENCES workflow_files(sha),
  workflow_name        TEXT NOT NULL,
  is_fork              BOOLEAN NOT NULL DEFAULT false,
  head_repo            TEXT,
  pr_number            INT,
  sender               TEXT NOT NULL,
  status               TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting', 'needs_attention', 'success', 'failure', 'cancelled', 'invalid')),
  run_attempt          INT NOT NULL DEFAULT 1,
  error_code           TEXT,
  error_message        TEXT,
  error_details        JSONB,
  cancel_requested_at  TIMESTAMPTZ,
  cancelled_by         TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at           TIMESTAMPTZ,
  finished_at          TIMESTAMPTZ,
  UNIQUE (repo_id, run_number)
);
CREATE INDEX IF NOT EXISTS workflow_runs_repo_idx ON workflow_runs (repo_id, run_number DESC);

-- The pins never change: a later push or a re-run can't alter what this run means.
CREATE OR REPLACE FUNCTION workflow_runs_pins_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.commit_sha IS DISTINCT FROM OLD.commit_sha
     OR NEW.workflow_sha IS DISTINCT FROM OLD.workflow_sha
     OR NEW.workflow_path IS DISTINCT FROM OLD.workflow_path
     OR NEW.is_fork IS DISTINCT FROM OLD.is_fork
     OR NEW.trigger_event_id IS DISTINCT FROM OLD.trigger_event_id
     OR NEW.ref IS DISTINCT FROM OLD.ref THEN
    RAISE EXCEPTION 'workflow_runs pins are immutable (run %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS workflow_runs_pins_immutable_trg ON workflow_runs;
CREATE TRIGGER workflow_runs_pins_immutable_trg BEFORE UPDATE ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION workflow_runs_pins_immutable();

CREATE SEQUENCE IF NOT EXISTS fencing_token_seq;

-- A node in the dependency graph. The definition columns are copied from the pinned
-- workflow at run creation and never change; the rest is the job's state machine.
CREATE TABLE IF NOT EXISTS jobs (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  repo_id             TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  job_key             TEXT NOT NULL,
  name                TEXT NOT NULL,
  needs               TEXT[] NOT NULL DEFAULT '{}',
  runs_on             TEXT[] NOT NULL,
  environment         TEXT,
  requested_secrets   TEXT[] NOT NULL DEFAULT '{}',
  env                 JSONB NOT NULL DEFAULT '{}',
  steps               JSONB NOT NULL,
  uploads             JSONB NOT NULL DEFAULT '[]',
  matrix              JSONB,
  has_non_idempotent  BOOLEAN NOT NULL DEFAULT false,
  status              TEXT NOT NULL CHECK (status IN ('blocked', 'queued', 'waiting', 'running', 'success', 'failure', 'cancelled', 'skipped', 'needs_attention')),
  status_reason       TEXT,
  attempt             INT NOT NULL DEFAULT 1,
  -- Attempts created by lease expiry within the current human-started attempt chain; bounds a job that kills runners.
  auto_requeues       INT NOT NULL DEFAULT 0,
  cancel_requested    BOOLEAN NOT NULL DEFAULT false,
  runner_id           TEXT,
  runner_name         TEXT,
  fencing_token       BIGINT,
  lease_expires_at    TIMESTAMPTZ,
  last_heartbeat_at   TIMESTAMPTZ,
  queued_at           TIMESTAMPTZ,
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (run_id, job_key)
);
-- The claim path: queued jobs per repository, oldest first.
CREATE INDEX IF NOT EXISTS jobs_queued_idx ON jobs (repo_id, queued_at) WHERE status = 'queued';
-- The per-repository limit and the lease sweep only ever look at running jobs.
CREATE INDEX IF NOT EXISTS jobs_running_repo_idx ON jobs (repo_id) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS jobs_lease_idx ON jobs (lease_expires_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS jobs_run_idx ON jobs (run_id);

CREATE OR REPLACE FUNCTION jobs_definition_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.steps IS DISTINCT FROM OLD.steps
     OR NEW.needs IS DISTINCT FROM OLD.needs
     OR NEW.runs_on IS DISTINCT FROM OLD.runs_on
     OR NEW.environment IS DISTINCT FROM OLD.environment
     OR NEW.requested_secrets IS DISTINCT FROM OLD.requested_secrets
     OR NEW.env IS DISTINCT FROM OLD.env
     OR NEW.uploads IS DISTINCT FROM OLD.uploads THEN
    RAISE EXCEPTION 'job definitions are immutable (job %)', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS jobs_definition_immutable_trg ON jobs;
CREATE TRIGGER jobs_definition_immutable_trg BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_definition_immutable();

-- Every attempt of every job, kept forever: re-runs add rows, they never replace them.
CREATE TABLE IF NOT EXISTS job_attempts (
  job_id             TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt            INT NOT NULL,
  run_id             TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  run_attempt        INT NOT NULL,
  -- initial | rerun_job | rerun_failed | rerun_all | rerun_dependent | lease_expired | attention_retry
  trigger            TEXT NOT NULL,
  triggered_by       TEXT,
  confirmed_non_idempotent BOOLEAN NOT NULL DEFAULT false,
  status             TEXT NOT NULL,
  status_reason      TEXT,
  runner_id          TEXT,
  runner_name        TEXT,
  fencing_token      BIGINT,
  secrets_released   TEXT[] NOT NULL DEFAULT '{}',
  -- [{ name, reason }]: what the job asked for and did not get, shown in the UI.
  secrets_withheld   JSONB NOT NULL DEFAULT '[]',
  -- Who ended the attempt: runner | sweeper | human. A retried completion replays only a runner's own.
  closed_by          TEXT,
  -- A stale runner's completion is rejected as truth but kept as evidence for the person deciding.
  late_report        JSONB,
  resolved_decision  TEXT,
  resolved_note      TEXT,
  resolved_by        TEXT,
  resolved_at        TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  queued_at          TIMESTAMPTZ,
  started_at         TIMESTAMPTZ,
  finished_at        TIMESTAMPTZ,
  PRIMARY KEY (job_id, attempt)
);
CREATE INDEX IF NOT EXISTS job_attempts_started_idx ON job_attempts (started_at) WHERE started_at IS NOT NULL;

-- The write-ahead intent: a step's row says `running` BEFORE the process is spawned, so
-- a vanished runner always leaves evidence of what may have happened.
CREATE TABLE IF NOT EXISTS step_executions (
  job_id       TEXT NOT NULL,
  attempt      INT NOT NULL,
  step_index   INT NOT NULL,
  name         TEXT NOT NULL,
  idempotent   BOOLEAN NOT NULL,
  -- pending | running | success | failure | timed_out | killed | skipped | unknown
  status       TEXT NOT NULL DEFAULT 'pending',
  exit_code    INT,
  started_at   TIMESTAMPTZ,
  finished_at  TIMESTAMPTZ,
  PRIMARY KEY (job_id, attempt, step_index),
  FOREIGN KEY (job_id, attempt) REFERENCES job_attempts(job_id, attempt) ON DELETE CASCADE
);

-- Append-only, for the timeline and to prove "enqueued exactly once".
CREATE TABLE IF NOT EXISTS job_transitions (
  id           BIGSERIAL PRIMARY KEY,
  job_id       TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  run_id       TEXT NOT NULL,
  attempt      INT NOT NULL,
  from_status  TEXT,
  to_status    TEXT NOT NULL,
  reason       TEXT,
  actor        TEXT,
  at           TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS job_transitions_job_idx ON job_transitions (job_id, id);

CREATE TABLE IF NOT EXISTS runners (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  labels          TEXT[] NOT NULL,
  slots           INT NOT NULL DEFAULT 1,
  token_hash      TEXT NOT NULL,
  pid             INT,
  incarnation     INT NOT NULL DEFAULT 1,
  -- Chaos control for the demo: the next heartbeat tells this runner to SIGKILL itself.
  kill_requested  BOOLEAN NOT NULL DEFAULT false,
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One log stream per attempt. The assembly state lives here so any API instance can take the next chunk.
CREATE TABLE IF NOT EXISTS log_streams (
  job_id        TEXT NOT NULL,
  attempt       INT NOT NULL,
  next_seq      BIGINT NOT NULL DEFAULT 1,
  next_line     BIGINT NOT NULL DEFAULT 1,
  -- Encrypted, because a held-back partial line may contain part of a secret.
  partial_enc   TEXT,
  partial_step  INT NOT NULL DEFAULT 0,
  -- Encrypted snapshot of the values released to this attempt: what to mask.
  mask_enc      TEXT,
  gap_chunks    INT NOT NULL DEFAULT 0,
  closed_at     TIMESTAMPTZ,
  archived_key  TEXT,
  archived_at   TIMESTAMPTZ,
  line_count    BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (job_id, attempt),
  FOREIGN KEY (job_id, attempt) REFERENCES job_attempts(job_id, attempt) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS log_streams_to_archive_idx ON log_streams (closed_at) WHERE closed_at IS NOT NULL AND archived_at IS NULL;

-- Idempotency and out-of-order buffer. content_enc is cleared once the chunk is assembled
-- into log_lines; the row stays so a retried chunk is recognized as a duplicate.
CREATE TABLE IF NOT EXISTS log_chunks (
  job_id       TEXT NOT NULL,
  attempt      INT NOT NULL,
  seq          BIGINT NOT NULL,
  step_index   INT NOT NULL DEFAULT 0,
  content_enc  TEXT,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, attempt, seq),
  FOREIGN KEY (job_id, attempt) REFERENCES log_streams(job_id, attempt) ON DELETE CASCADE
);

-- Masked, contiguously numbered. line_no is the offset that Last-Event-ID carries.
CREATE TABLE IF NOT EXISTS log_lines (
  job_id      TEXT NOT NULL,
  attempt     INT NOT NULL,
  line_no     BIGINT NOT NULL,
  step_index  INT NOT NULL DEFAULT 0,
  text        TEXT NOT NULL,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, attempt, line_no),
  FOREIGN KEY (job_id, attempt) REFERENCES log_streams(job_id, attempt) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS environments (
  id                 TEXT PRIMARY KEY,
  repo_id            TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  required_approval  BOOLEAN NOT NULL DEFAULT false,
  allowed_branches   TEXT[] NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_id, name)
);

-- Approval is per attempt: a re-run has to be approved again.
CREATE TABLE IF NOT EXISTS environment_approvals (
  job_id      TEXT NOT NULL,
  attempt     INT NOT NULL,
  decision    TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  decided_by  TEXT NOT NULL,
  comment     TEXT,
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, attempt),
  FOREIGN KEY (job_id, attempt) REFERENCES job_attempts(job_id, attempt) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS secrets (
  id              TEXT PRIMARY KEY,
  repo_id         TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  environment_id  TEXT REFERENCES environments(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  -- AES-256-GCM, with (repo, environment, name) as associated data so a ciphertext can't be moved to another scope.
  ciphertext      TEXT NOT NULL,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS secrets_scope_name_idx ON secrets (repo_id, COALESCE(environment_id, ''), name);

-- Every release of a secret to a runner: who got what, for which attempt.
CREATE TABLE IF NOT EXISTS secret_releases (
  id           BIGSERIAL PRIMARY KEY,
  secret_id    TEXT,
  secret_name  TEXT NOT NULL,
  scope        TEXT NOT NULL,
  repo_id      TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  run_id       TEXT NOT NULL,
  job_id       TEXT NOT NULL,
  job_key      TEXT NOT NULL,
  attempt      INT NOT NULL,
  runner_id    TEXT NOT NULL,
  runner_name  TEXT NOT NULL,
  released_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS secret_releases_repo_idx ON secret_releases (repo_id, released_at DESC);

CREATE TABLE IF NOT EXISTS artifacts (
  id              TEXT PRIMARY KEY,
  repo_id         TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  run_id          TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  job_id          TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  job_key         TEXT NOT NULL,
  attempt         INT NOT NULL,
  name            TEXT NOT NULL,
  object_key      TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL,
  sha256          TEXT NOT NULL,
  retention_days  INT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  deleted_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (job_id, attempt, name)
);
CREATE INDEX IF NOT EXISTS artifacts_run_idx ON artifacts (run_id);
CREATE INDEX IF NOT EXISTS artifacts_expiry_idx ON artifacts (expires_at) WHERE deleted_at IS NULL;

-- Fixture panel only: "kill the runner when this step starts".
CREATE TABLE IF NOT EXISTS chaos_arms (
  run_id     TEXT NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_name  TEXT NOT NULL,
  armed_by   TEXT NOT NULL,
  fired_at   TIMESTAMPTZ,
  PRIMARY KEY (run_id, step_name)
);
