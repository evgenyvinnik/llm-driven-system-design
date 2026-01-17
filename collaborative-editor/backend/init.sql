-- Create extension for UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(100) NOT NULL UNIQUE,
  display_name VARCHAR(200) NOT NULL,
  email VARCHAR(255),
  color VARCHAR(7) DEFAULT '#3B82F6',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Documents table
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title VARCHAR(500) NOT NULL DEFAULT 'Untitled Document',
  owner_id UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Document snapshots (periodic checkpoints)
CREATE TABLE IF NOT EXISTS document_snapshots (
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (document_id, version)
);

-- Operations log
CREATE TABLE IF NOT EXISTS operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  client_id VARCHAR(100),
  user_id UUID REFERENCES users(id),
  operation JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (document_id, version)
);

CREATE INDEX IF NOT EXISTS idx_operations_doc_version ON operations(document_id, version);

-- Document access
CREATE TABLE IF NOT EXISTS document_access (
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  permission VARCHAR(20) NOT NULL DEFAULT 'edit', -- view, edit, admin
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (document_id, user_id)
);

-- Insert a default user for testing
INSERT INTO users (id, username, display_name, color) VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice', 'Alice Johnson', '#3B82F6'),
  ('22222222-2222-2222-2222-222222222222', 'bob', 'Bob Smith', '#10B981'),
  ('33333333-3333-3333-3333-333333333333', 'charlie', 'Charlie Brown', '#F59E0B')
ON CONFLICT (id) DO NOTHING;

-- Insert a default document for testing
INSERT INTO documents (id, title, owner_id) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Welcome Document', '11111111-1111-1111-1111-111111111111')
ON CONFLICT (id) DO NOTHING;

-- Insert initial snapshot for the document
INSERT INTO document_snapshots (document_id, version, content) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 0, 'Welcome to the Collaborative Editor!\n\nStart typing to collaborate in real-time.')
ON CONFLICT (document_id, version) DO NOTHING;
