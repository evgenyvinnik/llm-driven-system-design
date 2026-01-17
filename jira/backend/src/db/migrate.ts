import { pool } from '../config/database.js';

const schema = `
-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name VARCHAR(255) NOT NULL,
  avatar_url TEXT,
  role VARCHAR(50) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Workflows table
CREATE TABLE IF NOT EXISTS workflows (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_default BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Statuses table
CREATE TABLE IF NOT EXISTS statuses (
  id SERIAL PRIMARY KEY,
  workflow_id INTEGER REFERENCES workflows(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  category VARCHAR(50) NOT NULL, -- 'todo', 'in_progress', 'done'
  color VARCHAR(7) DEFAULT '#6B7280',
  position INTEGER DEFAULT 0,
  UNIQUE(workflow_id, name)
);

-- Transitions table
CREATE TABLE IF NOT EXISTS transitions (
  id SERIAL PRIMARY KEY,
  workflow_id INTEGER REFERENCES workflows(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  from_status_id INTEGER REFERENCES statuses(id) ON DELETE CASCADE, -- NULL means 'from any'
  to_status_id INTEGER REFERENCES statuses(id) ON DELETE CASCADE NOT NULL,
  conditions JSONB DEFAULT '[]',
  validators JSONB DEFAULT '[]',
  post_functions JSONB DEFAULT '[]'
);

-- Permission schemes table
CREATE TABLE IF NOT EXISTS permission_schemes (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_default BOOLEAN DEFAULT FALSE
);

-- Permission grants table
CREATE TABLE IF NOT EXISTS permission_grants (
  scheme_id INTEGER REFERENCES permission_schemes(id) ON DELETE CASCADE,
  permission VARCHAR(100) NOT NULL,
  grantee_type VARCHAR(50) NOT NULL, -- 'role', 'user', 'group', 'anyone'
  grantee_id VARCHAR(100),
  PRIMARY KEY (scheme_id, permission, grantee_type, COALESCE(grantee_id, ''))
);

-- Project roles table
CREATE TABLE IF NOT EXISTS project_roles (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description TEXT
);

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
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

-- Project members table
CREATE TABLE IF NOT EXISTS project_members (
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role_id INTEGER REFERENCES project_roles(id),
  PRIMARY KEY (project_id, user_id)
);

-- Sprints table
CREATE TABLE IF NOT EXISTS sprints (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  goal TEXT,
  start_date TIMESTAMP,
  end_date TIMESTAMP,
  status VARCHAR(50) DEFAULT 'future', -- 'future', 'active', 'closed'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Components table
CREATE TABLE IF NOT EXISTS components (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  lead_id UUID REFERENCES users(id),
  UNIQUE(project_id, name)
);

-- Labels table
CREATE TABLE IF NOT EXISTS labels (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  color VARCHAR(7) DEFAULT '#6B7280',
  UNIQUE(project_id, name)
);

-- Custom field definitions table
CREATE TABLE IF NOT EXISTS custom_field_definitions (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,
  type VARCHAR(50) NOT NULL, -- 'text', 'number', 'select', 'multiselect', 'date', 'user', 'checkbox'
  config JSONB DEFAULT '{}',
  required BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(project_id, name)
);

-- Issues table
CREATE TABLE IF NOT EXISTS issues (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  key VARCHAR(50) UNIQUE NOT NULL,
  summary VARCHAR(500) NOT NULL,
  description TEXT,
  issue_type VARCHAR(50) NOT NULL, -- 'bug', 'story', 'task', 'epic', 'subtask'
  status_id INTEGER REFERENCES statuses(id),
  priority VARCHAR(50) DEFAULT 'medium', -- 'highest', 'high', 'medium', 'low', 'lowest'
  assignee_id UUID REFERENCES users(id),
  reporter_id UUID REFERENCES users(id) NOT NULL,
  parent_id INTEGER REFERENCES issues(id),
  epic_id INTEGER REFERENCES issues(id),
  sprint_id INTEGER REFERENCES sprints(id),
  story_points INTEGER,
  labels TEXT[] DEFAULT '{}',
  components INTEGER[] DEFAULT '{}',
  custom_fields JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Issue history table
CREATE TABLE IF NOT EXISTS issue_history (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id),
  field VARCHAR(100) NOT NULL,
  old_value TEXT,
  new_value TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Comments table
CREATE TABLE IF NOT EXISTS comments (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  author_id UUID REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Watchers table
CREATE TABLE IF NOT EXISTS watchers (
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, user_id)
);

-- Issue links table
CREATE TABLE IF NOT EXISTS issue_links (
  id SERIAL PRIMARY KEY,
  source_issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  target_issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  link_type VARCHAR(50) NOT NULL, -- 'blocks', 'is_blocked_by', 'relates_to', 'duplicates', 'is_duplicated_by'
  created_at TIMESTAMP DEFAULT NOW()
);

-- Boards table
CREATE TABLE IF NOT EXISTS boards (
  id SERIAL PRIMARY KEY,
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(200) NOT NULL,
  type VARCHAR(50) DEFAULT 'kanban', -- 'kanban', 'scrum'
  filter_jql TEXT,
  column_config JSONB DEFAULT '[]',
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_issues_project ON issues(project_id);
CREATE INDEX IF NOT EXISTS idx_issues_status ON issues(status_id);
CREATE INDEX IF NOT EXISTS idx_issues_assignee ON issues(assignee_id);
CREATE INDEX IF NOT EXISTS idx_issues_reporter ON issues(reporter_id);
CREATE INDEX IF NOT EXISTS idx_issues_sprint ON issues(sprint_id);
CREATE INDEX IF NOT EXISTS idx_issues_epic ON issues(epic_id);
CREATE INDEX IF NOT EXISTS idx_issues_type ON issues(issue_type);
CREATE INDEX IF NOT EXISTS idx_issues_priority ON issues(priority);
CREATE INDEX IF NOT EXISTS idx_issues_created ON issues(created_at);
CREATE INDEX IF NOT EXISTS idx_issues_updated ON issues(updated_at);
CREATE INDEX IF NOT EXISTS idx_issues_custom_fields ON issues USING GIN(custom_fields);
CREATE INDEX IF NOT EXISTS idx_issue_history_issue ON issue_history(issue_id);
CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id);
CREATE INDEX IF NOT EXISTS idx_sprints_project ON sprints(project_id);
CREATE INDEX IF NOT EXISTS idx_sprints_status ON sprints(status);
`;

async function migrate() {
  console.log('Running migrations...');

  try {
    await pool.query(schema);
    console.log('Migrations completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

migrate().catch(console.error);
