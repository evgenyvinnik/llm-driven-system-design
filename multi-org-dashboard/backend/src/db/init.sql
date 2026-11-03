-- Multi-Org Dashboard schema. Every statement is idempotent, so `npm run db:migrate` can be rerun.
-- Every tenant-owned row carries org_id, and every tenant-owned query filters on it.

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));

-- authz_version is bumped in the same transaction as any membership, role,
-- project-access or flag change. It keys the permission cache.
CREATE TABLE IF NOT EXISTS orgs (
  id            TEXT PRIMARY KEY CHECK (id ~ '^org_[a-z0-9]{3,32}$'),
  name          TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'starter' CHECK (plan IN ('starter', 'pro')),
  branding      JSONB NOT NULL DEFAULT '{"accent": "indigo", "initials": "??"}',
  authz_version BIGINT NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  -- Restricted projects are visible to admins and to explicit project members only.
  restricted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, id)
);
CREATE INDEX IF NOT EXISTS projects_org ON projects (org_id);

CREATE TABLE IF NOT EXISTS org_memberships (
  org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX IF NOT EXISTS org_memberships_user ON org_memberships (user_id);

CREATE TABLE IF NOT EXISTS project_memberships (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS invitations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('admin', 'editor', 'viewer')),
  token_hash  TEXT NOT NULL UNIQUE,
  invited_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  accepted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invitations_org_pending ON invitations (org_id) WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS feature_flags (
  key             TEXT PRIMARY KEY,
  description     TEXT NOT NULL,
  default_enabled BOOLEAN NOT NULL DEFAULT false
);

-- One rule per (flag, org). An empty roles array means every role.
CREATE TABLE IF NOT EXISTS feature_flag_rules (
  flag_key   TEXT NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
  org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  enabled    BOOLEAN NOT NULL,
  roles      TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (flag_key, org_id)
);

-- Resources: each has an owner and belongs to a project in the org.
-- The composite FK (org_id, project_id) makes a cross-org project reference impossible.
CREATE TABLE IF NOT EXISTS agents (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id   UUID NOT NULL,
  owner_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  model        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'paused')),
  instructions TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS agents_org_project ON agents (org_id, project_id);

CREATE TABLE IF NOT EXISTS knowledge_docs (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id     TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id UUID NOT NULL,
  owner_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  title      TEXT NOT NULL,
  source     TEXT NOT NULL CHECK (source IN ('upload', 'url', 'helpdesk')),
  chunks     INT NOT NULL DEFAULT 0,
  status     TEXT NOT NULL DEFAULT 'indexed' CHECK (status IN ('indexing', 'indexed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS knowledge_docs_org_project ON knowledge_docs (org_id, project_id);

CREATE TABLE IF NOT EXISTS conversations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id    UUID NOT NULL,
  agent_id      UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  channel       TEXT NOT NULL CHECK (channel IN ('chat', 'email', 'voice')),
  status        TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'escalated')),
  customer_name TEXT NOT NULL,
  subject       TEXT NOT NULL,
  message_count INT NOT NULL DEFAULT 0,
  csat          SMALLINT CHECK (csat BETWEEN 1 AND 5),
  cost_cents    INT NOT NULL DEFAULT 0,
  started_at    TIMESTAMPTZ NOT NULL,
  ended_at      TIMESTAMPTZ,
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id) ON DELETE CASCADE
);
-- Keyset pagination: newest first, id as the tie-breaker.
CREATE INDEX IF NOT EXISTS conversations_org_started ON conversations (org_id, started_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS conversations_org_status_started ON conversations (org_id, status, started_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id              BIGSERIAL PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  org_id          TEXT NOT NULL,
  author          TEXT NOT NULL CHECK (author IN ('customer', 'agent', 'human')),
  body            TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS conversation_messages_conversation ON conversation_messages (conversation_id, created_at);

-- Prompt library (the prompt-sharing variant). shared_roles empty = private to the owner.
CREATE TABLE IF NOT EXISTS prompts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  project_id   UUID NOT NULL,
  owner_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  shared_roles TEXT[] NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id, project_id) REFERENCES projects(org_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS prompts_org ON prompts (org_id, updated_at DESC);

-- Bearer links to a resource. Only the token's hash is stored; revocation is a timestamp, never a delete,
-- so the audit trail and "this link was revoked" both keep working.
CREATE TABLE IF NOT EXISTS share_links (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('prompt')),
  resource_id   UUID NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  token_hint    TEXT NOT NULL,
  permission    TEXT NOT NULL DEFAULT 'view' CHECK (permission IN ('view')),
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at    TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  revoked_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  last_used_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS share_links_org ON share_links (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS share_links_creator_active ON share_links (org_id, created_by) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS audit_events (
  id          BIGSERIAL PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_name  TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT,
  target_name TEXT,
  before      JSONB,
  after       JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_events_org ON audit_events (org_id, id DESC);

CREATE TABLE IF NOT EXISTS export_jobs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_by          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL CHECK (kind IN ('conversations')),
  query               JSONB NOT NULL,
  idempotency_key     TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  total_rows          INT,
  processed_rows      INT NOT NULL DEFAULT 0,
  file_path           TEXT,
  file_bytes          BIGINT,
  error_code          TEXT,
  error_message       TEXT,
  attempts            INT NOT NULL DEFAULT 0,
  worker_id           TEXT,
  leased_until        TIMESTAMPTZ,
  cancel_requested_at TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at          TIMESTAMPTZ,
  finished_at         TIMESTAMPTZ,
  UNIQUE (org_id, created_by, idempotency_key)
);
CREATE INDEX IF NOT EXISTS export_jobs_claimable ON export_jobs (created_at) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS export_jobs_org_user ON export_jobs (org_id, created_by, created_at DESC);
