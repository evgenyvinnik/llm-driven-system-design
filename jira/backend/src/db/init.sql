-- Jira Issue Tracking System Schema

-- Users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(200) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(100),
  avatar_url VARCHAR(500),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
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
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
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
  start_date TIMESTAMP,
  end_date TIMESTAMP,
  status VARCHAR(20) DEFAULT 'planning', -- 'planning', 'active', 'closed'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
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
  custom_fields JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
CREATE INDEX IF NOT EXISTS idx_issues_assignee ON issues(assignee_id);
CREATE INDEX IF NOT EXISTS idx_issues_sprint ON issues(sprint_id);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status_id);

-- Issue History (audit trail)
CREATE TABLE IF NOT EXISTS issue_history (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  field VARCHAR(100) NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_issue_history_issue ON issue_history(issue_id, created_at DESC);

-- Comments
CREATE TABLE IF NOT EXISTS comments (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  author_id UUID REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
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
  created_at TIMESTAMP DEFAULT NOW()
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
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys(expires_at);
