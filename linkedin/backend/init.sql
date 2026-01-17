-- LinkedIn Database Schema
-- Consolidated from init.sql and migrations

-- ============================================================================
-- CORE ENTITIES
-- ============================================================================

-- Companies table
-- Represents organizations where users work or have worked
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  industry VARCHAR(100),
  size VARCHAR(50),                    -- e.g., '1-10', '11-50', '51-200', '201-500', '501-1000', '1001-5000', '5001-10000', '10001+'
  location VARCHAR(100),
  website VARCHAR(255),
  logo_url VARCHAR(500),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Users table
-- Core user profile information
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  first_name VARCHAR(100) NOT NULL,
  last_name VARCHAR(100) NOT NULL,
  headline VARCHAR(200),               -- Professional tagline shown under name
  summary TEXT,                        -- About section / bio
  location VARCHAR(100),
  industry VARCHAR(100),
  profile_image_url VARCHAR(500),
  banner_image_url VARCHAR(500),
  connection_count INTEGER DEFAULT 0,  -- Denormalized for performance (1st-degree only)
  role VARCHAR(20) DEFAULT 'user',     -- 'user', 'recruiter', 'admin'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- SKILLS (Normalized)
-- ============================================================================

-- Skills table (normalized)
-- Master list of skills for standardization and searchability
CREATE TABLE IF NOT EXISTS skills (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT NOW()
);

-- User Skills junction table
-- Many-to-many relationship between users and skills with endorsement tracking
CREATE TABLE IF NOT EXISTS user_skills (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  skill_id INTEGER REFERENCES skills(id) ON DELETE CASCADE,
  endorsement_count INTEGER DEFAULT 0,
  PRIMARY KEY (user_id, skill_id)
);

-- ============================================================================
-- PROFESSIONAL HISTORY
-- ============================================================================

-- Experience (work history)
-- Tracks current and past employment
CREATE TABLE IF NOT EXISTS experiences (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
  company_name VARCHAR(255) NOT NULL,  -- Denormalized for display when company not in system
  title VARCHAR(200) NOT NULL,
  location VARCHAR(100),
  start_date DATE NOT NULL,
  end_date DATE,                       -- NULL for current positions
  description TEXT,
  is_current BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Education
-- Academic history of users
CREATE TABLE IF NOT EXISTS education (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  school_name VARCHAR(255) NOT NULL,
  degree VARCHAR(100),                 -- e.g., 'Bachelor of Science', 'Master of Arts'
  field_of_study VARCHAR(100),         -- e.g., 'Computer Science', 'Business Administration'
  start_year INTEGER,
  end_year INTEGER,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- CONNECTIONS (Social Graph)
-- ============================================================================

-- Connections (bidirectional - stored once per pair)
-- Uses constraint to ensure consistent ordering: user_id < connected_to
-- This halves storage and prevents duplicate connection records
CREATE TABLE IF NOT EXISTS connections (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  connected_to INTEGER REFERENCES users(id) ON DELETE CASCADE,
  connected_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, connected_to),
  CONSTRAINT connection_order CHECK (user_id < connected_to)
);

-- Connection Requests
-- Pending connection invitations
CREATE TABLE IF NOT EXISTS connection_requests (
  id SERIAL PRIMARY KEY,
  from_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  to_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  message TEXT,                        -- Optional personalized invitation message
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'accepted', 'declined', 'withdrawn'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(from_user_id, to_user_id)
);

-- ============================================================================
-- FEED AND CONTENT
-- ============================================================================

-- Posts (Feed)
-- User-generated content for the feed
CREATE TABLE IF NOT EXISTS posts (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  image_url VARCHAR(500),
  like_count INTEGER DEFAULT 0,        -- Denormalized for performance
  comment_count INTEGER DEFAULT 0,     -- Denormalized for performance
  share_count INTEGER DEFAULT 0,       -- Denormalized for performance
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Post Likes
-- Tracks which users liked which posts
CREATE TABLE IF NOT EXISTS post_likes (
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (user_id, post_id)
);

-- Post Comments
-- Comments on posts
CREATE TABLE IF NOT EXISTS post_comments (
  id SERIAL PRIMARY KEY,
  post_id INTEGER REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- JOBS AND APPLICATIONS
-- ============================================================================

-- Jobs
-- Job postings by companies
CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  posted_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title VARCHAR(200) NOT NULL,
  description TEXT NOT NULL,
  location VARCHAR(100),
  is_remote BOOLEAN DEFAULT FALSE,
  employment_type VARCHAR(50),         -- 'full-time', 'part-time', 'contract', 'internship'
  experience_level VARCHAR(50),        -- 'entry', 'associate', 'mid-senior', 'director', 'executive'
  years_required INTEGER,
  salary_min INTEGER,
  salary_max INTEGER,
  status VARCHAR(20) DEFAULT 'active', -- 'active', 'closed', 'filled', 'draft'
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Job Skills (required skills for a job)
-- Many-to-many relationship between jobs and skills
CREATE TABLE IF NOT EXISTS job_skills (
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  skill_id INTEGER REFERENCES skills(id) ON DELETE CASCADE,
  is_required BOOLEAN DEFAULT TRUE,    -- TRUE = required, FALSE = nice-to-have
  PRIMARY KEY (job_id, skill_id)
);

-- Job Applications
-- User applications to job postings
CREATE TABLE IF NOT EXISTS job_applications (
  id SERIAL PRIMARY KEY,
  job_id INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  resume_url VARCHAR(500),
  cover_letter TEXT,
  status VARCHAR(20) DEFAULT 'pending', -- 'pending', 'reviewed', 'interviewing', 'offered', 'rejected', 'withdrawn'
  match_score INTEGER,                  -- AI-computed job-candidate fit score (0-100)
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(job_id, user_id)               -- One application per user per job
);

-- ============================================================================
-- AUDIT AND SECURITY
-- ============================================================================

-- Audit logs table for tracking security-sensitive operations
-- Supports compliance requirements, account recovery, and security investigations
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(100) NOT NULL,    -- Event category (e.g., 'auth.login.success', 'profile.updated')
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- User who performed the action
  actor_ip INET,                       -- IP address of the actor
  target_type VARCHAR(50),             -- Type of entity: 'user', 'profile', 'connection', 'post', 'comment', 'job', 'session'
  target_id INTEGER,                   -- ID of the entity being acted upon
  action VARCHAR(50) NOT NULL,         -- Short action description
  details JSONB DEFAULT '{}',          -- Additional event-specific data (JSON)
  created_at TIMESTAMP DEFAULT NOW()
);

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

-- User indexes
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

-- Experience indexes
CREATE INDEX IF NOT EXISTS idx_experiences_user_id ON experiences(user_id);
CREATE INDEX IF NOT EXISTS idx_experiences_company_id ON experiences(company_id);

-- Education indexes
CREATE INDEX IF NOT EXISTS idx_education_user_id ON education(user_id);

-- Post indexes
CREATE INDEX IF NOT EXISTS idx_posts_user_id ON posts(user_id);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);

-- Job indexes
CREATE INDEX IF NOT EXISTS idx_jobs_company_id ON jobs(company_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

-- Job application indexes
CREATE INDEX IF NOT EXISTS idx_job_applications_user_id ON job_applications(user_id);
CREATE INDEX IF NOT EXISTS idx_job_applications_job_id ON job_applications(job_id);

-- Connection request indexes
CREATE INDEX IF NOT EXISTS idx_connection_requests_to_user ON connection_requests(to_user_id, status);

-- Audit log indexes (for efficient querying)
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target ON audit_logs(target_type, target_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event ON audit_logs(event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at);

-- Partial index for admin actions (common compliance query)
CREATE INDEX IF NOT EXISTS idx_audit_logs_admin ON audit_logs(created_at)
  WHERE event_type LIKE 'admin.%';

-- ============================================================================
-- TABLE AND COLUMN COMMENTS
-- ============================================================================

COMMENT ON TABLE audit_logs IS 'Audit trail for security-sensitive operations';
COMMENT ON COLUMN audit_logs.event_type IS 'Event category (e.g., auth.login.success, profile.updated)';
COMMENT ON COLUMN audit_logs.actor_id IS 'User who performed the action';
COMMENT ON COLUMN audit_logs.actor_ip IS 'IP address of the actor';
COMMENT ON COLUMN audit_logs.target_type IS 'Type of entity being acted upon';
COMMENT ON COLUMN audit_logs.target_id IS 'ID of the entity being acted upon';
COMMENT ON COLUMN audit_logs.action IS 'Short action description';
COMMENT ON COLUMN audit_logs.details IS 'Additional event-specific data (JSON)';
