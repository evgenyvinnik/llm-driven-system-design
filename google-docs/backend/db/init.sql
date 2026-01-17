-- Google Docs Database Schema
-- UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table
CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    avatar_color VARCHAR(7) DEFAULT '#3B82F6',
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Sessions table for Redis-backed auth
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Documents table
CREATE TABLE documents (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title VARCHAR(500) NOT NULL DEFAULT 'Untitled Document',
    owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    current_version BIGINT DEFAULT 0,
    content JSONB DEFAULT '{"type":"doc","content":[{"type":"paragraph","content":[]}]}',
    is_deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Document permissions
CREATE TABLE document_permissions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    email VARCHAR(255),
    permission_level VARCHAR(20) NOT NULL CHECK (permission_level IN ('view', 'comment', 'edit')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(document_id, user_id),
    UNIQUE(document_id, email)
);

-- Document versions (snapshots)
CREATE TABLE document_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_number BIGINT NOT NULL,
    content JSONB NOT NULL,
    created_by UUID REFERENCES users(id),
    is_named BOOLEAN DEFAULT FALSE,
    name VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(document_id, version_number)
);

-- Operations log for OT
CREATE TABLE operations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_number BIGINT NOT NULL,
    operation JSONB NOT NULL,
    user_id UUID REFERENCES users(id),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(document_id, version_number)
);

-- Comments
CREATE TABLE comments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES comments(id) ON DELETE CASCADE,
    anchor_start INTEGER,
    anchor_end INTEGER,
    anchor_version BIGINT,
    content TEXT NOT NULL,
    author_id UUID NOT NULL REFERENCES users(id),
    resolved BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Suggestions (tracked changes)
CREATE TABLE suggestions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    suggestion_type VARCHAR(20) NOT NULL CHECK (suggestion_type IN ('insert', 'delete', 'replace')),
    anchor_start INTEGER NOT NULL,
    anchor_end INTEGER NOT NULL,
    anchor_version BIGINT NOT NULL,
    original_text TEXT,
    suggested_text TEXT,
    author_id UUID NOT NULL REFERENCES users(id),
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_documents_owner ON documents(owner_id);
CREATE INDEX idx_documents_updated ON documents(updated_at DESC);
CREATE INDEX idx_document_permissions_user ON document_permissions(user_id);
CREATE INDEX idx_document_versions_doc ON document_versions(document_id, version_number DESC);
CREATE INDEX idx_operations_doc ON operations(document_id, version_number);
CREATE INDEX idx_comments_doc ON comments(document_id);
CREATE INDEX idx_suggestions_doc ON suggestions(document_id);
CREATE INDEX idx_sessions_token ON sessions(token);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- Seed data for testing
INSERT INTO users (id, email, name, password_hash, avatar_color, role) VALUES
('11111111-1111-1111-1111-111111111111', 'alice@example.com', 'Alice Johnson', '$2b$10$rQZ6LM5dv.e/O.G9yLW3ZOqDJCcNX.G9HwD7nHD5Z3yKr8X9aQx8O', '#EF4444', 'user'),
('22222222-2222-2222-2222-222222222222', 'bob@example.com', 'Bob Smith', '$2b$10$rQZ6LM5dv.e/O.G9yLW3ZOqDJCcNX.G9HwD7nHD5Z3yKr8X9aQx8O', '#22C55E', 'user'),
('33333333-3333-3333-3333-333333333333', 'admin@example.com', 'Admin User', '$2b$10$rQZ6LM5dv.e/O.G9yLW3ZOqDJCcNX.G9HwD7nHD5Z3yKr8X9aQx8O', '#8B5CF6', 'admin');

-- Sample documents
INSERT INTO documents (id, title, owner_id, content) VALUES
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Welcome to Google Docs Clone', '11111111-1111-1111-1111-111111111111',
'{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Welcome to Google Docs Clone!"}]},{"type":"paragraph","content":[{"type":"text","text":"This is a collaborative document editor built with:"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"}],"text":"Real-time collaboration"},{"type":"text","text":" using Operational Transformation"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"}],"text":"Rich text editing"},{"type":"text","text":" with formatting support"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"}],"text":"Comments and suggestions"},{"type":"text","text":" for feedback"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"}],"text":"Version history"},{"type":"text","text":" to track changes"}]}]}]}]}'),
('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Project Planning Document', '22222222-2222-2222-2222-222222222222',
'{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Project Planning"}]},{"type":"paragraph","content":[{"type":"text","text":"Start planning your project here..."}]}]}');

-- Share first document with Bob
INSERT INTO document_permissions (document_id, user_id, permission_level) VALUES
('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'edit');
