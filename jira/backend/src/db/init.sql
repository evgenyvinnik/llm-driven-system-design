-- Jira Issue Tracking System Schema

-- Users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(200) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100),
  avatar_url VARCHAR(500),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Project Roles
CREATE TABLE IF NOT EXISTS project_roles (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  description TEXT
);

-- Permission Schemes
CREATE TABLE IF NOT EXISTS permission_schemes (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_default BOOLEAN DEFAULT FALSE
);

-- Permission Grants
CREATE TABLE IF NOT EXISTS permission_grants (
  id SERIAL PRIMARY KEY,
  scheme_id INTEGER REFERENCES permission_schemes(id) ON DELETE CASCADE,
  permission VARCHAR(100) NOT NULL,
  grantee_type VARCHAR(50) NOT NULL, -- 'anyone', 'user', 'role', 'group'
  grantee_id VARCHAR(100)
);

-- Workflows
CREATE TABLE IF NOT EXISTS workflows (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_default BOOLEAN DEFAULT FALSE
);

-- Statuses
CREATE TABLE IF NOT EXISTS statuses (
  id SERIAL PRIMARY KEY,
  workflow_id INTEGER REFERENCES workflows(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  category VARCHAR(50) DEFAULT 'todo', -- 'todo', 'in_progress', 'done'
  color VARCHAR(20) DEFAULT '#6B7280',
  position INTEGER DEFAULT 0,
  UNIQUE(workflow_id, name)
);

-- Transitions
CREATE TABLE IF NOT EXISTS transitions (
  id SERIAL PRIMARY KEY,
  workflow_id INTEGER REFERENCES workflows(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  from_status_id INTEGER REFERENCES statuses(id),
  to_status_id INTEGER REFERENCES statuses(id) NOT NULL,
  conditions JSONB DEFAULT '[]',
  validators JSONB DEFAULT '[]',
  post_functions JSONB DEFAULT '[]'
);

-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(10) UNIQUE NOT NULL,
  name VARCHAR(200) NOT NULL,
  description TEXT,
  lead_id UUID REFERENCES users(id),
  workflow_id INTEGER REFERENCES workflows(id),
  permission_scheme_id INTEGER REFERENCES permission_schemes(id),
  issue_counter INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Project Members
CREATE TABLE IF NOT EXISTS project_members (
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER REFERENCES project_roles(id),
  PRIMARY KEY (project_id, user_id)
);

-- Sprints
CREATE TABLE IF NOT EXISTS sprints (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  goal TEXT,
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'planning', -- 'planning', 'active', 'closed'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Issues
CREATE TABLE IF NOT EXISTS issues (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  key VARCHAR(50) UNIQUE NOT NULL,
  summary VARCHAR(500) NOT NULL,
  description TEXT,
  issue_type VARCHAR(50) DEFAULT 'task', -- 'task', 'story', 'bug', 'epic', 'subtask'
  status_id INTEGER REFERENCES statuses(id),
  priority VARCHAR(20) DEFAULT 'medium', -- 'highest', 'high', 'medium', 'low', 'lowest'
  assignee_id UUID REFERENCES users(id),
  reporter_id UUID REFERENCES users(id),
  parent_id INTEGER REFERENCES issues(id),
  epic_id INTEGER REFERENCES issues(id),
  sprint_id INTEGER REFERENCES sprints(id),
  story_points INTEGER,
  labels TEXT[] DEFAULT '{}',
  components TEXT[] DEFAULT '{}',
  custom_fields JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
CREATE INDEX IF NOT EXISTS idx_issues_assignee ON issues(assignee_id);
CREATE INDEX IF NOT EXISTS idx_issues_sprint ON issues(sprint_id);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status_id);
-- GIN indexes support the `labels IN (...)` / `component = ...` JQL clauses,
-- which translate to array-containment predicates on the PostgreSQL side.
CREATE INDEX IF NOT EXISTS idx_issues_labels ON issues USING GIN(labels);
CREATE INDEX IF NOT EXISTS idx_issues_components ON issues USING GIN(components);

-- Issue History (audit trail)
CREATE TABLE IF NOT EXISTS issue_history (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  field VARCHAR(100) NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_issue_history_issue ON issue_history(issue_id, created_at DESC);

-- Comments
CREATE TABLE IF NOT EXISTS comments (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  author_id UUID REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id);

-- Boards
CREATE TABLE IF NOT EXISTS boards (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  type VARCHAR(20) DEFAULT 'kanban', -- 'kanban', 'scrum'
  filter_jql TEXT,
  column_config JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Labels
CREATE TABLE IF NOT EXISTS labels (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  color VARCHAR(20) DEFAULT '#6B7280',
  UNIQUE(project_id, name)
);

-- Components
CREATE TABLE IF NOT EXISTS components (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  lead_id UUID REFERENCES users(id)
);

-- Idempotency Keys
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key VARCHAR(64) PRIMARY KEY,
  user_id UUID NOT NULL,
  request_path VARCHAR(200) NOT NULL,
  response_status INTEGER,
  response_body JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);

-- ============================================================
-- Concurrency, ordering and authorization support.
-- Every statement below is safe to run again on an existing database.
-- ============================================================

-- Optimistic concurrency: any change to an issue's fields or status bumps
-- version. Clients send the version they edited in If-Match and get
-- 412 Precondition Failed when someone else changed the issue first.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

-- Board and backlog order. Rank keys are base-36 strings compared byte-wise
-- (COLLATE "C"), so ORDER BY rank and JavaScript string comparison agree.
-- See src/services/rank.ts for the key scheme.
ALTER TABLE issues ADD COLUMN IF NOT EXISTS rank TEXT COLLATE "C";

-- Returns a rank strictly greater than prev: the first six characters are
-- read as a base-36 integer and advanced by 36^2, which leaves 1,296 slots for
-- later inserts between neighbours. Mirrors rankAfter() in src/services/rank.ts.
CREATE OR REPLACE FUNCTION jira_rank_after(prev TEXT) RETURNS TEXT AS $$
DECLARE
  digits CONSTANT TEXT := '0123456789abcdefghijklmnopqrstuvwxyz';
  head TEXT;
  val BIGINT := 0;
  result TEXT := '';
  prefix TEXT := '';
  rest TEXT;
  d INT;
BEGIN
  IF prev IS NULL THEN
    RETURN 'i00000i';
  END IF;
  head := rpad(left(prev, 6), 6, '0');
  FOR i IN 1..6 LOOP
    val := val * 36 + (strpos(digits, substr(head, i, 1)) - 1);
  END LOOP;
  val := val + 1296;
  IF val <= 2176782335 THEN
    FOR i IN 1..6 LOOP
      result := substr(digits, (val % 36)::INT + 1, 1) || result;
      val := val / 36;
    END LOOP;
    RETURN result || 'i';
  END IF;
  -- Integer space exhausted: grow the key (midpoint between prev and +infinity).
  rest := prev;
  LOOP
    IF rest = '' THEN d := 0; ELSE d := strpos(digits, substr(rest, 1, 1)) - 1; END IF;
    IF d < 35 THEN
      RETURN prefix || substr(digits, round((d + 36) / 2.0)::INT + 1, 1);
    END IF;
    prefix := prefix || 'z';
    rest := substr(rest, 2);
  END LOOP;
END
$$ LANGUAGE plpgsql IMMUTABLE;

-- New issues land at the bottom of their project's order, whichever code
-- path inserts them (API, seed.sql, seed.ts).
CREATE OR REPLACE FUNCTION jira_issues_default_rank() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.rank IS NULL THEN
    SELECT jira_rank_after(max(rank)) INTO NEW.rank
    FROM issues WHERE project_id = NEW.project_id;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS issues_default_rank ON issues;
CREATE TRIGGER issues_default_rank
  BEFORE INSERT ON issues
  FOR EACH ROW EXECUTE FUNCTION jira_issues_default_rank();

-- Backfill rows created before the rank column existed, oldest first.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN SELECT id, project_id FROM issues WHERE rank IS NULL ORDER BY project_id, created_at, id LOOP
    UPDATE issues
    SET rank = jira_rank_after((SELECT max(rank) FROM issues WHERE project_id = r.project_id))
    WHERE id = r.id;
  END LOOP;
END
$$;

ALTER TABLE issues ALTER COLUMN rank SET NOT NULL;

-- One issue per rank key within a project: two concurrent moves into the
-- same gap compute the same key, and the loser retries instead of producing
-- an ambiguous order.
CREATE UNIQUE INDEX IF NOT EXISTS idx_issues_project_rank ON issues(project_id, rank);

-- Permission checks read a scheme's grants and a user's memberships on every
-- request (behind a short Redis cache).
CREATE INDEX IF NOT EXISTS idx_permission_grants_scheme ON permission_grants(scheme_id, permission);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

-- Idempotency records: a hash of method, path and body, so a key reused with
-- a different request is rejected (422) instead of replaying the wrong response.
ALTER TABLE idempotency_keys ADD COLUMN IF NOT EXISTS request_fingerprint VARCHAR(64);
