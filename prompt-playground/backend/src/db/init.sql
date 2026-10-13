-- Prompt Playground schema. Idempotent: `npm run db:migrate` runs this file on every start.
-- gen_random_uuid() is built into PostgreSQL 13+.

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members (user_id);

-- The mutable head of a prompt. Its text lives in immutable versions.
CREATE TABLE IF NOT EXISTS prompts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  title        TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  description  TEXT NOT NULL DEFAULT '',
  -- Highest saved version number; 0 means nothing saved yet. Saving a version
  -- compares against this value (optimistic concurrency).
  head_version INT  NOT NULL DEFAULT 0 CHECK (head_version >= 0),
  created_by   UUID NOT NULL REFERENCES users(id),
  updated_by   UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prompts_workspace ON prompts (workspace_id, updated_at DESC);

-- Content-addressed prompt text. Saved versions and runs of unsaved drafts both
-- point here, so every run records exactly the text it executed, and identical
-- text is stored once per prompt.
CREATE TABLE IF NOT EXISTS prompt_snapshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_id     UUID NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  content_hash  CHAR(64) NOT NULL,
  system_text   TEXT NOT NULL,
  template_text TEXT NOT NULL,
  variables     TEXT[] NOT NULL DEFAULT '{}',
  created_by    UUID NOT NULL REFERENCES users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (prompt_id, content_hash)
);

-- Named, numbered history: a version is a label on a snapshot. Never updated.
CREATE TABLE IF NOT EXISTS prompt_versions (
  prompt_id   UUID NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  version     INT  NOT NULL CHECK (version > 0),
  snapshot_id UUID NOT NULL REFERENCES prompt_snapshots(id),
  message     TEXT NOT NULL DEFAULT '',
  created_by  UUID NOT NULL REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (prompt_id, version)
);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_snapshot ON prompt_versions (snapshot_id);

-- Shared model configurations. `revision` guards concurrent edits (If-Match).
CREATE TABLE IF NOT EXISTS model_presets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  config       JSONB NOT NULL,
  revision     INT  NOT NULL DEFAULT 1,
  created_by   UUID NOT NULL REFERENCES users(id),
  updated_by   UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

-- One execution. Pins the snapshot and a copy of the model config, so editing
-- the prompt or a preset later never changes what a run means.
CREATE TABLE IF NOT EXISTS runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  prompt_id           UUID NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  snapshot_id         UUID NOT NULL REFERENCES prompt_snapshots(id),
  -- Saved version whose text matched when the run was created; NULL = unsaved draft.
  version             INT,
  -- Runs started together for side-by-side comparison share this ID.
  comparison_id       UUID,
  model               TEXT NOT NULL,
  config              JSONB NOT NULL,
  variables           JSONB NOT NULL DEFAULT '{}',
  rendered_system     TEXT NOT NULL,
  rendered_input      TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'completed', 'cancelled', 'failed')),
  output              TEXT NOT NULL DEFAULT '',
  output_truncated    BOOLEAN NOT NULL DEFAULT false,
  finish_reason       TEXT,
  error_code          TEXT,
  error_message       TEXT,
  input_tokens        INT,
  output_tokens       INT,
  -- Executor ownership: a claim increments attempt and sets a lease; every later
  -- write by that executor is conditioned on (attempt, status = 'running').
  attempt             INT NOT NULL DEFAULT 0,
  lease_owner         TEXT,
  lease_expires_at    TIMESTAMPTZ,
  created_by          UUID NOT NULL REFERENCES users(id),
  idempotency_key     TEXT NOT NULL,
  request_hash        CHAR(64) NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  enqueued_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at          TIMESTAMPTZ,
  first_token_at      TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  UNIQUE (created_by, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_runs_prompt ON runs (prompt_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_active ON runs (status, created_at) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_runs_user_active ON runs (created_by) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_runs_comparison ON runs (comparison_id) WHERE comparison_id IS NOT NULL;

-- A share link identifies one immutable thing: a saved version or a finished run.
CREATE TABLE IF NOT EXISTS shares (
  token        TEXT PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  prompt_id    UUID NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
  snapshot_id  UUID NOT NULL REFERENCES prompt_snapshots(id),
  version      INT,
  run_id       UUID REFERENCES runs(id) ON DELETE CASCADE,
  created_by   UUID NOT NULL REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_shares_prompt ON shares (prompt_id, created_at DESC);
