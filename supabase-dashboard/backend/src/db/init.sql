CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(30) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(100),
  role VARCHAR(20) DEFAULT 'user',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) NOT NULL,
  description TEXT,
  db_host VARCHAR(255) NOT NULL DEFAULT 'localhost',
  db_port INTEGER NOT NULL DEFAULT 5433,
  db_name VARCHAR(100) NOT NULL DEFAULT 'sample_db',
  db_user VARCHAR(100) NOT NULL DEFAULT 'sample',
  -- AES-256-GCM ciphertext ("enc:v1:..."), written by services/credentials.ts. TEXT
  -- because ciphertext is longer than the password it protects.
  db_password TEXT NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS project_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'editor', 'viewer')),
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, user_id)
);

CREATE TABLE IF NOT EXISTS saved_queries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  name VARCHAR(100) NOT NULL,
  query_text TEXT NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS auth_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  email VARCHAR(255) NOT NULL,
  encrypted_password VARCHAR(255),
  email_confirmed BOOLEAN DEFAULT false,
  role VARCHAR(50) DEFAULT 'authenticated',
  raw_user_metadata JSONB DEFAULT '{}',
  last_sign_in_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, email)
);

-- Upgrades for databases created before credentials were encrypted at rest.
ALTER TABLE projects ALTER COLUMN db_password TYPE TEXT;
ALTER TABLE projects ALTER COLUMN db_password DROP DEFAULT;

CREATE INDEX IF NOT EXISTS idx_project_members ON project_members(user_id);
CREATE INDEX IF NOT EXISTS idx_saved_queries_project ON saved_queries(project_id);
CREATE INDEX IF NOT EXISTS idx_auth_users_project ON auth_users(project_id);
CREATE INDEX IF NOT EXISTS idx_auth_users_email ON auth_users(project_id, email);
