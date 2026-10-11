-- LeetCode Database Schema
-- Re-runnable: safe to apply to a fresh database or to an existing development volume.

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Problems table
CREATE TABLE IF NOT EXISTS problems (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(255) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  description TEXT NOT NULL,
  examples TEXT,
  constraints TEXT,
  difficulty VARCHAR(20) NOT NULL CHECK (difficulty IN ('easy', 'medium', 'hard')),
  time_limit_ms INTEGER DEFAULT 2000,
  memory_limit_mb INTEGER DEFAULT 256,
  -- How outputs are compared: 'exact' (token by token) or 'unordered' (any order of the
  -- top-level array, for problems that say "return the answer in any order")
  checker VARCHAR(20) NOT NULL DEFAULT 'exact',
  starter_code_python TEXT,
  starter_code_javascript TEXT,
  starter_code_cpp TEXT,
  starter_code_java TEXT,
  -- Reference solutions: used to validate test data, never returned by the public API
  solution_python TEXT,
  solution_javascript TEXT,
  solution_cpp TEXT,
  solution_java TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Test cases table
CREATE TABLE IF NOT EXISTS test_cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  problem_id UUID REFERENCES problems(id) ON DELETE CASCADE,
  input TEXT NOT NULL,
  expected_output TEXT NOT NULL,
  is_sample BOOLEAN DEFAULT FALSE,
  order_index INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Submissions table. Each row is also a job in the judge queue: workers claim 'pending' rows
-- with FOR UPDATE SKIP LOCKED, hold a lease while judging, and write the verdict back.
CREATE TABLE IF NOT EXISTS submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  problem_id UUID REFERENCES problems(id) ON DELETE CASCADE,
  language VARCHAR(20) NOT NULL,
  code TEXT NOT NULL,
  status VARCHAR(30) DEFAULT 'pending' CHECK (status IN (
    'pending', 'running', 'accepted', 'wrong_answer',
    'time_limit_exceeded', 'memory_limit_exceeded', 'output_limit_exceeded',
    'runtime_error', 'compile_error', 'system_error'
  )),
  runtime_ms INTEGER,
  memory_kb INTEGER,
  test_cases_passed INTEGER DEFAULT 0,
  test_cases_total INTEGER DEFAULT 0,
  error_message TEXT,
  -- Idempotency: client-supplied key, hash of the exact request body, hash of normalized code
  idempotency_key VARCHAR(255),
  request_hash CHAR(64),
  code_hash CHAR(64),
  -- Judge queue: earliest retry time, lease holder, lease expiry, fencing token, attempts
  run_after TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lease_owner VARCHAR(100),
  lease_expires_at TIMESTAMPTZ,
  lease_token INTEGER NOT NULL DEFAULT 0,
  judge_attempts INTEGER NOT NULL DEFAULT 0,
  judged_at TIMESTAMPTZ,
  created_at TIMESTAMP DEFAULT NOW()
);

-- User problem status (progress tracking)
CREATE TABLE IF NOT EXISTS user_problem_status (
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  problem_id UUID REFERENCES problems(id) ON DELETE CASCADE,
  status VARCHAR(20) DEFAULT 'unsolved' CHECK (status IN ('solved', 'attempted', 'unsolved')),
  best_runtime_ms INTEGER,
  best_memory_kb INTEGER,
  attempts INTEGER DEFAULT 0,
  solved_at TIMESTAMP,
  PRIMARY KEY (user_id, problem_id)
);

-- Upgrade databases created before the judge queue and checker columns existed
ALTER TABLE problems ADD COLUMN IF NOT EXISTS checker VARCHAR(20) NOT NULL DEFAULT 'exact';
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255);
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS request_hash CHAR(64);
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS code_hash CHAR(64);
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS run_after TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS lease_owner VARCHAR(100);
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS lease_token INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS judge_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submissions ADD COLUMN IF NOT EXISTS judged_at TIMESTAMPTZ;

-- Guarded constraints (re-created so older volumes pick up new allowed values)
ALTER TABLE submissions DROP CONSTRAINT IF EXISTS submissions_status_check;
ALTER TABLE submissions ADD CONSTRAINT submissions_status_check CHECK (status IN (
  'pending', 'running', 'accepted', 'wrong_answer',
  'time_limit_exceeded', 'memory_limit_exceeded', 'output_limit_exceeded',
  'runtime_error', 'compile_error', 'system_error'
));
ALTER TABLE problems DROP CONSTRAINT IF EXISTS problems_checker_check;
ALTER TABLE problems ADD CONSTRAINT problems_checker_check CHECK (checker IN ('exact', 'unordered'));

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_submissions_user_id ON submissions(user_id);
CREATE INDEX IF NOT EXISTS idx_submissions_problem_id ON submissions(problem_id);
CREATE INDEX IF NOT EXISTS idx_submissions_created_at ON submissions(created_at);
CREATE INDEX IF NOT EXISTS idx_submissions_user_problem ON submissions(user_id, problem_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_test_cases_problem_id ON test_cases(problem_id);
CREATE INDEX IF NOT EXISTS idx_problems_slug ON problems(slug);
CREATE INDEX IF NOT EXISTS idx_problems_difficulty ON problems(difficulty);

-- Idempotency: one submission per (user, Idempotency-Key)
CREATE UNIQUE INDEX IF NOT EXISTS uq_submissions_idempotency_key
  ON submissions (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- At most one identical submission (same user, problem, language, normalized code) in flight
CREATE UNIQUE INDEX IF NOT EXISTS uq_submissions_in_flight
  ON submissions (user_id, problem_id, language, code_hash)
  WHERE status IN ('pending', 'running') AND code_hash IS NOT NULL;

-- Judge queue: the next pending job, and running jobs whose lease may have expired
CREATE INDEX IF NOT EXISTS idx_submissions_queue
  ON submissions (run_after, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_submissions_leases
  ON submissions (lease_expires_at)
  WHERE status = 'running';
