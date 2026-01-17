-- Notion Clone Database Schema

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    name VARCHAR(200) NOT NULL,
    avatar_url VARCHAR(500),
    role VARCHAR(20) DEFAULT 'user' CHECK (role IN ('user', 'admin')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Workspaces table
CREATE TABLE IF NOT EXISTS workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    icon VARCHAR(100),
    owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
    settings JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Workspace members
CREATE TABLE IF NOT EXISTS workspace_members (
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(20) DEFAULT 'member' CHECK (role IN ('admin', 'member', 'guest')),
    joined_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (workspace_id, user_id)
);

-- Pages table (recursive hierarchy)
CREATE TABLE IF NOT EXISTS pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES pages(id) ON DELETE CASCADE,
    title VARCHAR(500) DEFAULT 'Untitled',
    icon VARCHAR(100),
    cover_image VARCHAR(500),
    is_database BOOLEAN DEFAULT FALSE,
    properties_schema JSONB DEFAULT '[]',
    position VARCHAR(100) DEFAULT 'a',
    is_archived BOOLEAN DEFAULT FALSE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Blocks table
CREATE TABLE IF NOT EXISTS blocks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id UUID REFERENCES pages(id) ON DELETE CASCADE,
    parent_block_id UUID REFERENCES blocks(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL DEFAULT 'text',
    properties JSONB DEFAULT '{}',
    content JSONB DEFAULT '[]',
    position VARCHAR(100) DEFAULT 'a',
    version INTEGER DEFAULT 0,
    is_collapsed BOOLEAN DEFAULT FALSE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Database views
CREATE TABLE IF NOT EXISTS database_views (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id UUID REFERENCES pages(id) ON DELETE CASCADE,
    name VARCHAR(200) DEFAULT 'Default View',
    type VARCHAR(20) DEFAULT 'table' CHECK (type IN ('table', 'board', 'list', 'calendar', 'gallery')),
    filter JSONB DEFAULT '[]',
    sort JSONB DEFAULT '[]',
    group_by VARCHAR(100),
    properties_visibility JSONB DEFAULT '[]',
    position VARCHAR(100) DEFAULT 'a',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Database rows (pages that are database entries)
CREATE TABLE IF NOT EXISTS database_rows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    database_id UUID REFERENCES pages(id) ON DELETE CASCADE,
    properties JSONB DEFAULT '{}',
    position VARCHAR(100) DEFAULT 'a',
    is_archived BOOLEAN DEFAULT FALSE,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Page permissions (override workspace-level)
CREATE TABLE IF NOT EXISTS page_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id UUID REFERENCES pages(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    permission VARCHAR(20) DEFAULT 'view' CHECK (permission IN ('view', 'edit', 'full_access')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(page_id, user_id)
);

-- Sessions table for auth
CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(500) UNIQUE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Operations log for CRDT sync
CREATE TABLE IF NOT EXISTS operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    page_id UUID REFERENCES pages(id) ON DELETE CASCADE,
    block_id UUID,
    type VARCHAR(20) NOT NULL CHECK (type IN ('insert', 'update', 'delete', 'move')),
    data JSONB NOT NULL,
    timestamp BIGINT NOT NULL,
    author_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Audit log table for security events
CREATE TABLE IF NOT EXISTS audit_log (
    id BIGSERIAL PRIMARY KEY,
    timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    user_id UUID NOT NULL,
    resource_type VARCHAR(50) NOT NULL,
    resource_id UUID NOT NULL,
    action VARCHAR(50) NOT NULL,
    metadata JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_pages_workspace ON pages(workspace_id);
CREATE INDEX IF NOT EXISTS idx_pages_parent ON pages(parent_id);
CREATE INDEX IF NOT EXISTS idx_blocks_page ON blocks(page_id);
CREATE INDEX IF NOT EXISTS idx_blocks_parent ON blocks(parent_block_id);
CREATE INDEX IF NOT EXISTS idx_blocks_position ON blocks(page_id, position);
CREATE INDEX IF NOT EXISTS idx_database_rows_database ON database_rows(database_id);
CREATE INDEX IF NOT EXISTS idx_operations_page ON operations(page_id);
CREATE INDEX IF NOT EXISTS idx_operations_timestamp ON operations(page_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_resource ON audit_log(resource_type, resource_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_timestamp ON audit_log(timestamp DESC);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_workspaces_updated_at BEFORE UPDATE ON workspaces
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_pages_updated_at BEFORE UPDATE ON pages
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_blocks_updated_at BEFORE UPDATE ON blocks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_database_views_updated_at BEFORE UPDATE ON database_views
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_database_rows_updated_at BEFORE UPDATE ON database_rows
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert default admin user (password: admin123)
INSERT INTO users (id, email, password_hash, name, role) VALUES
    ('00000000-0000-0000-0000-000000000001', 'admin@notion.local', '$2b$10$8K1p/a0dR6OQS6qL5uF4.uBXLH5Y5IQ0NQDCzWQKXpHzJMF7QJQXG', 'Admin User', 'admin')
ON CONFLICT (email) DO NOTHING;

-- Insert default workspace
INSERT INTO workspaces (id, name, icon, owner_id) VALUES
    ('00000000-0000-0000-0000-000000000001', 'My Workspace', '📚', '00000000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- Add admin to workspace
INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
    ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'admin')
ON CONFLICT DO NOTHING;

-- Insert sample pages
INSERT INTO pages (id, workspace_id, title, icon, created_by) VALUES
    ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'Getting Started', '🚀', '00000000-0000-0000-0000-000000000001'),
    ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'Tasks', '✅', '00000000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- Make Tasks a database
UPDATE pages SET is_database = true, properties_schema = '[
    {"id": "title", "name": "Task", "type": "title"},
    {"id": "status", "name": "Status", "type": "select", "options": [
        {"id": "todo", "name": "To Do", "color": "gray"},
        {"id": "in_progress", "name": "In Progress", "color": "blue"},
        {"id": "done", "name": "Done", "color": "green"}
    ]},
    {"id": "priority", "name": "Priority", "type": "select", "options": [
        {"id": "low", "name": "Low", "color": "gray"},
        {"id": "medium", "name": "Medium", "color": "yellow"},
        {"id": "high", "name": "High", "color": "red"}
    ]},
    {"id": "due_date", "name": "Due Date", "type": "date"}
]'::jsonb WHERE id = '00000000-0000-0000-0000-000000000003';

-- Insert default database view for Tasks
INSERT INTO database_views (id, page_id, name, type) VALUES
    ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003', 'All Tasks', 'table'),
    ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003', 'Kanban', 'board')
ON CONFLICT DO NOTHING;

-- Update Kanban view to group by status
UPDATE database_views SET group_by = 'status' WHERE id = '00000000-0000-0000-0000-000000000002';

-- Insert sample blocks for Getting Started page
INSERT INTO blocks (id, page_id, type, content, position) VALUES
    ('00000000-0000-0000-0000-000000000010', '00000000-0000-0000-0000-000000000002', 'heading_1', '[{"text": "Welcome to Notion Clone!"}]'::jsonb, 'a'),
    ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000002', 'text', '[{"text": "This is a block-based collaborative workspace. You can create pages, add different types of blocks, and collaborate in real-time."}]'::jsonb, 'b'),
    ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000002', 'heading_2', '[{"text": "Features"}]'::jsonb, 'c'),
    ('00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000002', 'bulleted_list', '[{"text": "Block-based editing with multiple block types"}]'::jsonb, 'd'),
    ('00000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000002', 'bulleted_list', '[{"text": "Real-time collaboration"}]'::jsonb, 'e'),
    ('00000000-0000-0000-0000-000000000015', '00000000-0000-0000-0000-000000000002', 'bulleted_list', '[{"text": "Nested pages and hierarchy"}]'::jsonb, 'f'),
    ('00000000-0000-0000-0000-000000000016', '00000000-0000-0000-0000-000000000002', 'bulleted_list', '[{"text": "Databases with views (table, board, list)"}]'::jsonb, 'g'),
    ('00000000-0000-0000-0000-000000000017', '00000000-0000-0000-0000-000000000002', 'heading_2', '[{"text": "Try it out!"}]'::jsonb, 'h'),
    ('00000000-0000-0000-0000-000000000018', '00000000-0000-0000-0000-000000000002', 'text', '[{"text": "Start editing this page or create a new one from the sidebar."}]'::jsonb, 'i'),
    ('00000000-0000-0000-0000-000000000019', '00000000-0000-0000-0000-000000000002', 'code', '[{"text": "// Example code block\\nconsole.log(\"Hello, Notion!\");"}]'::jsonb, 'j')
ON CONFLICT DO NOTHING;

-- Insert sample database rows for Tasks
INSERT INTO database_rows (id, database_id, properties, position, created_by) VALUES
    ('00000000-0000-0000-0000-000000000020', '00000000-0000-0000-0000-000000000003',
     '{"title": "Set up project", "status": "done", "priority": "high", "due_date": "2025-01-15"}'::jsonb,
     'a', '00000000-0000-0000-0000-000000000001'),
    ('00000000-0000-0000-0000-000000000021', '00000000-0000-0000-0000-000000000003',
     '{"title": "Implement block editor", "status": "in_progress", "priority": "high", "due_date": "2025-01-20"}'::jsonb,
     'b', '00000000-0000-0000-0000-000000000001'),
    ('00000000-0000-0000-0000-000000000022', '00000000-0000-0000-0000-000000000003',
     '{"title": "Add real-time sync", "status": "todo", "priority": "medium", "due_date": "2025-01-25"}'::jsonb,
     'c', '00000000-0000-0000-0000-000000000001'),
    ('00000000-0000-0000-0000-000000000023', '00000000-0000-0000-0000-000000000003',
     '{"title": "Design database views", "status": "todo", "priority": "medium", "due_date": "2025-01-28"}'::jsonb,
     'd', '00000000-0000-0000-0000-000000000001'),
    ('00000000-0000-0000-0000-000000000024', '00000000-0000-0000-0000-000000000003',
     '{"title": "Write documentation", "status": "todo", "priority": "low", "due_date": "2025-02-01"}'::jsonb,
     'e', '00000000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;
