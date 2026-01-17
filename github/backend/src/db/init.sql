-- GitHub Clone Database Schema

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(100) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(255),
  bio TEXT,
  avatar_url VARCHAR(500),
  location VARCHAR(255),
  company VARCHAR(255),
  website VARCHAR(500),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Organizations table
CREATE TABLE IF NOT EXISTS organizations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  display_name VARCHAR(255),
  description TEXT,
  avatar_url VARCHAR(500),
  website VARCHAR(500),
  location VARCHAR(255),
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Organization members
CREATE TABLE IF NOT EXISTS organization_members (
  id SERIAL PRIMARY KEY,
  org_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  role VARCHAR(20) DEFAULT 'member',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(org_id, user_id)
);

-- Repositories table
CREATE TABLE IF NOT EXISTS repositories (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id),
  org_id INTEGER REFERENCES organizations(id),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  is_private BOOLEAN DEFAULT FALSE,
  default_branch VARCHAR(100) DEFAULT 'main',
  storage_path VARCHAR(500),
  language VARCHAR(50),
  stars_count INTEGER DEFAULT 0,
  forks_count INTEGER DEFAULT 0,
  watchers_count INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT unique_user_repo UNIQUE(owner_id, name),
  CONSTRAINT unique_org_repo UNIQUE(org_id, name),
  CONSTRAINT owner_or_org CHECK (
    (owner_id IS NOT NULL AND org_id IS NULL) OR
    (owner_id IS NULL AND org_id IS NOT NULL)
  )
);

-- Repository collaborators
CREATE TABLE IF NOT EXISTS collaborators (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  permission VARCHAR(20) DEFAULT 'read',
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(repo_id, user_id)
);

-- Stars
CREATE TABLE IF NOT EXISTS stars (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(user_id, repo_id)
);

-- Forks
CREATE TABLE IF NOT EXISTS forks (
  id SERIAL PRIMARY KEY,
  source_repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  forked_repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Issues table
CREATE TABLE IF NOT EXISTS issues (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title VARCHAR(500) NOT NULL,
  body TEXT,
  state VARCHAR(20) DEFAULT 'open',
  author_id INTEGER REFERENCES users(id),
  assignee_id INTEGER REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  closed_at TIMESTAMP,
  UNIQUE(repo_id, number)
);

-- Labels table
CREATE TABLE IF NOT EXISTS labels (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  name VARCHAR(50) NOT NULL,
  color VARCHAR(7) DEFAULT '#1a73e8',
  description TEXT,
  UNIQUE(repo_id, name)
);

-- Issue labels junction
CREATE TABLE IF NOT EXISTS issue_labels (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  label_id INTEGER REFERENCES labels(id) ON DELETE CASCADE,
  UNIQUE(issue_id, label_id)
);

-- Pull Requests table
CREATE TABLE IF NOT EXISTS pull_requests (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title VARCHAR(500) NOT NULL,
  body TEXT,
  state VARCHAR(20) DEFAULT 'open',
  head_branch VARCHAR(100) NOT NULL,
  head_sha VARCHAR(40),
  base_branch VARCHAR(100) NOT NULL,
  base_sha VARCHAR(40),
  author_id INTEGER REFERENCES users(id),
  merged_by INTEGER REFERENCES users(id),
  merged_at TIMESTAMP,
  additions INTEGER DEFAULT 0,
  deletions INTEGER DEFAULT 0,
  changed_files INTEGER DEFAULT 0,
  is_draft BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  closed_at TIMESTAMP,
  UNIQUE(repo_id, number)
);

-- PR labels junction
CREATE TABLE IF NOT EXISTS pr_labels (
  id SERIAL PRIMARY KEY,
  pr_id INTEGER REFERENCES pull_requests(id) ON DELETE CASCADE,
  label_id INTEGER REFERENCES labels(id) ON DELETE CASCADE,
  UNIQUE(pr_id, label_id)
);

-- PR Reviews
CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY,
  pr_id INTEGER REFERENCES pull_requests(id) ON DELETE CASCADE,
  reviewer_id INTEGER REFERENCES users(id),
  state VARCHAR(20),
  body TEXT,
  commit_sha VARCHAR(40),
  created_at TIMESTAMP DEFAULT NOW()
);

-- PR Review Comments (inline comments)
CREATE TABLE IF NOT EXISTS review_comments (
  id SERIAL PRIMARY KEY,
  review_id INTEGER REFERENCES reviews(id) ON DELETE CASCADE,
  pr_id INTEGER REFERENCES pull_requests(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  path VARCHAR(500),
  line INTEGER,
  side VARCHAR(10),
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Comments (for issues and PRs)
CREATE TABLE IF NOT EXISTS comments (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
  pr_id INTEGER REFERENCES pull_requests(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  CONSTRAINT issue_or_pr CHECK (
    (issue_id IS NOT NULL AND pr_id IS NULL) OR
    (issue_id IS NULL AND pr_id IS NOT NULL)
  )
);

-- Discussions
CREATE TABLE IF NOT EXISTS discussions (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  number INTEGER NOT NULL,
  title VARCHAR(500) NOT NULL,
  body TEXT,
  category VARCHAR(50),
  author_id INTEGER REFERENCES users(id),
  is_answered BOOLEAN DEFAULT FALSE,
  answer_comment_id INTEGER,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(repo_id, number)
);

-- Discussion comments
CREATE TABLE IF NOT EXISTS discussion_comments (
  id SERIAL PRIMARY KEY,
  discussion_id INTEGER REFERENCES discussions(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  parent_id INTEGER REFERENCES discussion_comments(id),
  body TEXT NOT NULL,
  upvotes INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Webhooks
CREATE TABLE IF NOT EXISTS webhooks (
  id SERIAL PRIMARY KEY,
  repo_id INTEGER REFERENCES repositories(id) ON DELETE CASCADE,
  url VARCHAR(500) NOT NULL,
  secret VARCHAR(100),
  events TEXT[],
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Webhook deliveries log
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id SERIAL PRIMARY KEY,
  webhook_id INTEGER REFERENCES webhooks(id) ON DELETE CASCADE,
  event VARCHAR(50),
  payload JSONB,
  response_status INTEGER,
  response_body TEXT,
  duration_ms INTEGER,
  attempt INTEGER DEFAULT 1,
  delivered_at TIMESTAMP DEFAULT NOW()
);

-- Sessions table for authentication
CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(255) UNIQUE NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  data JSONB,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50),
  title VARCHAR(255),
  message TEXT,
  url VARCHAR(500),
  is_read BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_repos_owner ON repositories(owner_id);
CREATE INDEX IF NOT EXISTS idx_repos_org ON repositories(org_id);
CREATE INDEX IF NOT EXISTS idx_issues_repo ON issues(repo_id);
CREATE INDEX IF NOT EXISTS idx_issues_author ON issues(author_id);
CREATE INDEX IF NOT EXISTS idx_prs_repo ON pull_requests(repo_id);
CREATE INDEX IF NOT EXISTS idx_prs_author ON pull_requests(author_id);
CREATE INDEX IF NOT EXISTS idx_comments_issue ON comments(issue_id);
CREATE INDEX IF NOT EXISTS idx_comments_pr ON comments(pr_id);
CREATE INDEX IF NOT EXISTS idx_reviews_pr ON reviews(pr_id);
CREATE INDEX IF NOT EXISTS idx_stars_user ON stars(user_id);
CREATE INDEX IF NOT EXISTS idx_stars_repo ON stars(repo_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

-- Audit log table for security-sensitive operations
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  timestamp TIMESTAMP DEFAULT NOW(),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id VARCHAR(100),
  ip_address INET,
  user_agent TEXT,
  request_id VARCHAR(64),
  details JSONB DEFAULT '{}',
  outcome VARCHAR(20) DEFAULT 'success'
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs(timestamp);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

-- Idempotency keys table for preventing duplicate operations
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key VARCHAR(64) PRIMARY KEY,
  operation_type VARCHAR(50) NOT NULL,
  resource_id INTEGER,
  response_body JSONB,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);
