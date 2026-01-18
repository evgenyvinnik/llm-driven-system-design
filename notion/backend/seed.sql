-- Seed data for development/testing
-- Notion Clone Sample Data

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
