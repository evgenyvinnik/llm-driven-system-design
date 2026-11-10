-- AI Code Review schema. Every statement is idempotent, so this is safe to rerun.
--
-- Two separate worlds:
--   githost.*  belongs to the fixture Git host process. Nothing else touches it.
--   public.*   belongs to the review system, which only knows the host through its API.

CREATE SCHEMA IF NOT EXISTS githost;

-- ── Fixture Git host ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS githost.repos (
  id              BIGSERIAL PRIMARY KEY,
  owner           TEXT NOT NULL,
  name            TEXT NOT NULL,
  default_branch  TEXT NOT NULL DEFAULT 'main',
  -- Files on the default branch, path -> content.
  tree            JSONB NOT NULL DEFAULT '{}',
  -- Protected-branch settings. Like GitHub's default, an approval survives a push
  -- unless dismissed. That is why the review system has to dismiss it itself.
  required_approvals     INT NOT NULL DEFAULT 1,
  dismiss_stale_reviews  BOOLEAN NOT NULL DEFAULT FALSE,
  required_checks        JSONB NOT NULL DEFAULT '["ci/build","ci/test"]',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner, name)
);

CREATE TABLE IF NOT EXISTS githost.pull_requests (
  id          BIGSERIAL PRIMARY KEY,
  repo_id     BIGINT NOT NULL REFERENCES githost.repos(id) ON DELETE CASCADE,
  number      INT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  author      TEXT NOT NULL,
  base_ref    TEXT NOT NULL DEFAULT 'main',
  head_ref    TEXT NOT NULL,
  head_sha    TEXT NOT NULL,
  -- Increases with every push; lets a receiver ignore out-of-order deliveries.
  head_seq    INT NOT NULL DEFAULT 1,
  state       TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed','merged')),
  merged_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_id, number)
);

CREATE TABLE IF NOT EXISTS githost.commits (
  repo_id    BIGINT NOT NULL REFERENCES githost.repos(id) ON DELETE CASCADE,
  sha        TEXT NOT NULL,
  pr_id      BIGINT NOT NULL REFERENCES githost.pull_requests(id) ON DELETE CASCADE,
  seq        INT NOT NULL,
  parent_sha TEXT,
  author     TEXT NOT NULL,
  message    TEXT NOT NULL,
  -- The pull request's cumulative diff at this commit, and the full tree.
  files      JSONB NOT NULL,
  tree       JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, sha)
);

CREATE TABLE IF NOT EXISTS githost.checks (
  repo_id    BIGINT NOT NULL REFERENCES githost.repos(id) ON DELETE CASCADE,
  head_sha   TEXT NOT NULL,
  name       TEXT NOT NULL,
  status     TEXT NOT NULL CHECK (status IN ('queued','in_progress','completed')),
  conclusion TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (repo_id, head_sha, name)
);

CREATE TABLE IF NOT EXISTS githost.reviews (
  id                BIGSERIAL PRIMARY KEY,
  pr_id             BIGINT NOT NULL REFERENCES githost.pull_requests(id) ON DELETE CASCADE,
  user_login        TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN ('APPROVED','CHANGES_REQUESTED','COMMENTED')),
  commit_id         TEXT NOT NULL,
  body              TEXT NOT NULL DEFAULT '',
  dismissed         BOOLEAN NOT NULL DEFAULT FALSE,
  dismissal_message TEXT,
  dismissed_at      TIMESTAMPTZ,
  -- A retried post with the same key returns the same review.
  idempotency_key   TEXT UNIQUE,
  submitted_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS githost.comments (
  id         BIGSERIAL PRIMARY KEY,
  pr_id      BIGINT NOT NULL REFERENCES githost.pull_requests(id) ON DELETE CASCADE,
  user_login TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Webhook outbox: written with the change it describes, so an event is never lost.
CREATE TABLE IF NOT EXISTS githost.deliveries (
  id              TEXT PRIMARY KEY,
  seq             BIGSERIAL,
  event           TEXT NOT NULL,
  action          TEXT NOT NULL,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed','dropped')),
  attempts        INT NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status     INT,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS githost_deliveries_pending ON githost.deliveries (seq) WHERE status = 'pending';

-- ── Accounts and tenancy ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS orgs (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  -- NULL only for the platform admin, who can see every org.
  org_id        TEXT REFERENCES orgs(id),
  role          TEXT NOT NULL CHECK (role IN ('reviewer','repo_admin','admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Repositories and policy (held here, never read from the repository) ───────

CREATE TABLE IF NOT EXISTS repositories (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES orgs(id),
  full_name          TEXT NOT NULL UNIQUE,
  mode               TEXT NOT NULL DEFAULT 'observe' CHECK (mode IN ('observe','narrow_auto')),
  kill_switch        BOOLEAN NOT NULL DEFAULT FALSE,
  protected_paths    JSONB NOT NULL,
  ci_config_paths    JSONB NOT NULL,
  policy_paths       JSONB NOT NULL,
  max_files          INT NOT NULL,
  max_changed_lines  INT NOT NULL,
  auto_approve_scope JSONB NOT NULL,
  required_checks    JSONB NOT NULL,
  required_reviewers JSONB NOT NULL,
  bot_logins         JSONB NOT NULL,
  link_allowlist     JSONB NOT NULL,
  -- Pinned: there is no "latest". Changing it drops the repository back to observe.
  model_version      TEXT NOT NULL,
  settings_version   INT NOT NULL DEFAULT 1,
  demoted_at         TIMESTAMPTZ,
  demoted_reason     TEXT,
  mode_changed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Refused promotions are recorded too: the attempt is evidence.
CREATE TABLE IF NOT EXISTS mode_changes (
  id            TEXT PRIMARY KEY,
  repo_id       TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('promote','promote_refused','demote')),
  from_mode     TEXT NOT NULL,
  to_mode       TEXT NOT NULL,
  actor         TEXT NOT NULL,
  reason        TEXT NOT NULL,
  evaluation_id TEXT,
  checks        JSONB NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mode_changes_repo ON mode_changes (repo_id, created_at DESC);

-- ── Local view of pull requests ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pull_requests (
  id         TEXT PRIMARY KEY,
  repo_id    TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  number     INT NOT NULL,
  title      TEXT NOT NULL,
  author     TEXT NOT NULL,
  base_ref   TEXT NOT NULL,
  head_sha   TEXT NOT NULL,
  head_seq   INT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_id, number)
);
CREATE INDEX IF NOT EXISTS pull_requests_updated ON pull_requests (repo_id, updated_at DESC);

-- ── Webhook inbox: one row per delivery id, written with the delivery's effects ─

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id  TEXT PRIMARY KEY,
  event        TEXT NOT NULL,
  action       TEXT,
  repo         TEXT,
  pr_number    INT,
  head_sha     TEXT,
  outcome      TEXT NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Durable review runs, which are also the worker queue ──────────────────────

CREATE TABLE IF NOT EXISTS review_runs (
  id               TEXT PRIMARY KEY,
  repo_id          TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  pr_id            TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  pr_number        INT NOT NULL,
  head_sha         TEXT NOT NULL,
  base_ref         TEXT NOT NULL,
  -- full calls the model; gate_only re-applies the gate to a stored assessment.
  kind             TEXT NOT NULL DEFAULT 'full' CHECK (kind IN ('full','gate_only')),
  trigger          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','cancelled','failed')),
  attempt          INT NOT NULL DEFAULT 0,
  claimed_by       TEXT,
  lease_token      TEXT,
  lease_expires_at TIMESTAMPTZ,
  cancel_reason    TEXT,
  superseded_by_sha TEXT,
  model_version    TEXT,
  model_outcome    TEXT,
  error_code       TEXT,
  error_detail     TEXT,
  diff_hash        TEXT,
  prompt_hash      TEXT,
  prompt_text      TEXT,
  files_snapshot   JSONB,
  raw_output       TEXT,
  parsed_output    JSONB,
  tool_calls       JSONB NOT NULL DEFAULT '[]',
  scanner_hits     JSONB NOT NULL DEFAULT '[]',
  input_tokens     INT NOT NULL DEFAULT 0,
  output_tokens    INT NOT NULL DEFAULT 0,
  queue_ms         INT,
  ttft_ms          INT,
  generation_ms    INT,
  model_calls      INT NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ
);
-- A redelivered event or a racing reconciler cannot create a second active run for one commit.
CREATE UNIQUE INDEX IF NOT EXISTS review_runs_one_active_per_sha ON review_runs (pr_id, head_sha) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS review_runs_claim ON review_runs (created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS review_runs_lease ON review_runs (lease_expires_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS review_runs_pr ON review_runs (pr_id, created_at DESC);

-- ── Decisions: exactly one active per pull request ────────────────────────────

CREATE TABLE IF NOT EXISTS decisions (
  id                 TEXT PRIMARY KEY,
  repo_id            TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  pr_id              TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  pr_number          INT NOT NULL,
  run_id             TEXT REFERENCES review_runs(id),
  head_sha           TEXT NOT NULL,
  mode               TEXT NOT NULL,
  outcome            TEXT NOT NULL CHECK (outcome IN ('auto_approved','escalated','shadow','waiting_ci','human_approved','human_rejected')),
  would              TEXT NOT NULL CHECK (would IN ('approve','escalate','wait_ci')),
  reason_code        TEXT NOT NULL,
  reason             TEXT NOT NULL,
  model_overruled    BOOLEAN NOT NULL DEFAULT FALSE,
  policy_version     TEXT NOT NULL,
  settings_version   INT NOT NULL,
  category           TEXT,
  gate               JSONB,
  model_version      TEXT,
  actor              TEXT NOT NULL,
  state              TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','invalidated')),
  invalidated_reason TEXT,
  invalidated_at     TIMESTAMPTZ,
  posted_review_id   BIGINT,
  posted_at          TIMESTAMPTZ,
  dismissed_at       TIMESTAMPTZ,
  -- What the human did at this SHA, for shadow agreement.
  human_outcome      TEXT,
  false_approval_reported_at TIMESTAMPTZ,
  false_approval_reported_by TEXT,
  false_approval_note TEXT,
  waiting_since      TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS decisions_one_active_per_pr ON decisions (pr_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS decisions_pr ON decisions (pr_id, created_at DESC);
CREATE INDEX IF NOT EXISTS decisions_waiting ON decisions (waiting_since) WHERE state = 'active' AND outcome = 'waiting_ci';
CREATE INDEX IF NOT EXISTS decisions_repo_mode ON decisions (repo_id, mode);

-- ── Post intents: the only way anything reaches the host ──────────────────────

CREATE TABLE IF NOT EXISTS post_intents (
  id               TEXT PRIMARY KEY,
  repo_id          TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  pr_id            TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  pr_number        INT NOT NULL,
  decision_id      TEXT REFERENCES decisions(id),
  head_sha         TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('approve','comment','dismiss')),
  body             TEXT NOT NULL DEFAULT '',
  actor            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','cancelled','failed')),
  outcome          TEXT,
  attempts         INT NOT NULL DEFAULT 0,
  claimed_by       TEXT,
  lease_token      TEXT,
  lease_expires_at TIMESTAMPTZ,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  review_ids       JSONB NOT NULL DEFAULT '[]',
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS post_intents_claim ON post_intents (next_attempt_at, created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS post_intents_lease ON post_intents (lease_expires_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS post_intents_pr ON post_intents (pr_id, status);

-- ── Human escalation queue ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS escalations (
  id                 TEXT PRIMARY KEY,
  repo_id            TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  pr_id              TEXT NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  pr_number          INT NOT NULL,
  decision_id        TEXT REFERENCES decisions(id),
  head_sha           TEXT NOT NULL,
  reason_code        TEXT NOT NULL,
  reason             TEXT NOT NULL,
  model_overruled    BOOLEAN NOT NULL DEFAULT FALSE,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','claimed','decided','invalidated')),
  claimed_by         TEXT,
  claimed_at         TIMESTAMPTZ,
  decided_by         TEXT,
  decided_at         TIMESTAMPTZ,
  resolution         TEXT CHECK (resolution IN ('approved','rejected')),
  note               TEXT,
  invalidated_reason TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS escalations_one_open_per_sha ON escalations (pr_id, head_sha) WHERE status IN ('open','claimed');
CREATE INDEX IF NOT EXISTS escalations_queue ON escalations (repo_id, status, created_at);

-- ── Audit log: append-only and hash-chained, one chain per repository ─────────

CREATE TABLE IF NOT EXISTS audit_chains (
  repo_id   TEXT PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
  last_seq  BIGINT NOT NULL DEFAULT 0,
  last_hash TEXT NOT NULL DEFAULT '0000000000000000000000000000000000000000000000000000000000000000'
);

CREATE TABLE IF NOT EXISTS audit_log (
  repo_id     TEXT NOT NULL,
  seq         BIGINT NOT NULL,
  prev_hash   TEXT NOT NULL,
  hash        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  actor       TEXT NOT NULL,
  pr_number   INT,
  head_sha    TEXT,
  run_id      TEXT,
  decision_id TEXT,
  payload     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (repo_id, seq)
);
CREATE INDEX IF NOT EXISTS audit_log_pr ON audit_log (repo_id, pr_number, seq);
CREATE INDEX IF NOT EXISTS audit_log_kind ON audit_log (kind, created_at DESC);

CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_change ON audit_log;
CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

-- ── Offline evaluation against labeled history ────────────────────────────────

CREATE TABLE IF NOT EXISTS evaluations (
  id             TEXT PRIMARY KEY,
  status         TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  model_version  TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  corpus_hash    TEXT NOT NULL,
  corpus_size    INT NOT NULL,
  -- True when a limit cut the corpus short. A partial run never qualifies a promotion.
  partial        BOOLEAN NOT NULL DEFAULT FALSE,
  summary        JSONB,
  created_by     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS evaluations_lookup ON evaluations (model_version, policy_version, created_at DESC);

CREATE TABLE IF NOT EXISTS evaluation_cases (
  evaluation_id    TEXT NOT NULL REFERENCES evaluations(id) ON DELETE CASCADE,
  case_id          TEXT NOT NULL,
  title            TEXT NOT NULL,
  class            TEXT NOT NULL,
  dangerous        BOOLEAN NOT NULL,
  injection        BOOLEAN NOT NULL,
  human_decision   TEXT NOT NULL,
  in_scope         BOOLEAN NOT NULL,
  model_verdict    TEXT NOT NULL,
  model_confidence NUMERIC,
  model_only       TEXT NOT NULL,
  gated            TEXT NOT NULL,
  observe_would    TEXT NOT NULL,
  reason_code      TEXT NOT NULL,
  reason           TEXT NOT NULL,
  failed_rules     JSONB NOT NULL,
  tools_denied     INT NOT NULL DEFAULT 0,
  scanner_hit      BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (evaluation_id, case_id)
);
