-- Notion Clone Seed Data
-- Password hash is for 'password123': $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Additional sample users
INSERT INTO users (id, email, password_hash, name, avatar_url, role) VALUES
    ('00000000-0000-0000-0000-000000000002', 'alice@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Alice Johnson', 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150', 'user'),
    ('00000000-0000-0000-0000-000000000003', 'bob@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Bob Smith', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150', 'user'),
    ('00000000-0000-0000-0000-000000000004', 'carol@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Carol Williams', 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150', 'user')
ON CONFLICT (email) DO NOTHING;

-- Add Alice and Bob to the default workspace
INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
    ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', 'member'),
    ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000003', 'member')
ON CONFLICT DO NOTHING;

-- Create a second workspace for collaboration demo
INSERT INTO workspaces (id, name, icon, owner_id) VALUES
    ('00000000-0000-0000-0000-000000000002', 'Team Alpha', '🚀', '00000000-0000-0000-0000-000000000002')
ON CONFLICT DO NOTHING;

INSERT INTO workspace_members (workspace_id, user_id, role) VALUES
    ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'admin'),
    ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003', 'member'),
    ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000004', 'member')
ON CONFLICT DO NOTHING;

-- Additional pages in Team Alpha workspace
INSERT INTO pages (id, workspace_id, title, icon, cover_image, created_by) VALUES
    ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000002', 'Product Roadmap', '🗺️', 'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=1200', '00000000-0000-0000-0000-000000000002'),
    ('00000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000002', 'Meeting Notes', '📝', NULL, '00000000-0000-0000-0000-000000000002'),
    ('00000000-0000-0000-0000-000000000006', '00000000-0000-0000-0000-000000000002', 'Team Wiki', '📚', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=1200', '00000000-0000-0000-0000-000000000003')
ON CONFLICT DO NOTHING;

-- Nested page under Meeting Notes
INSERT INTO pages (id, workspace_id, parent_id, title, icon, created_by) VALUES
    ('00000000-0000-0000-0000-000000000007', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000005', 'Sprint Planning 2025-01-13', '📅', '00000000-0000-0000-0000-000000000002'),
    ('00000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000005', 'Sprint Retro 2025-01-10', '🔄', '00000000-0000-0000-0000-000000000003')
ON CONFLICT DO NOTHING;

-- Blocks for Product Roadmap page
INSERT INTO blocks (id, page_id, type, content, position) VALUES
    ('00000000-0000-0000-0000-000000000030', '00000000-0000-0000-0000-000000000004', 'heading_1', '[{"text": "Q1 2025 Product Roadmap"}]'::jsonb, 'a'),
    ('00000000-0000-0000-0000-000000000031', '00000000-0000-0000-0000-000000000004', 'text', '[{"text": "This document outlines our key initiatives for Q1 2025."}]'::jsonb, 'b'),
    ('00000000-0000-0000-0000-000000000032', '00000000-0000-0000-0000-000000000004', 'heading_2', '[{"text": "Key Milestones"}]'::jsonb, 'c'),
    ('00000000-0000-0000-0000-000000000033', '00000000-0000-0000-0000-000000000004', 'numbered_list', '[{"text": "Launch mobile app beta - Jan 31"}]'::jsonb, 'd'),
    ('00000000-0000-0000-0000-000000000034', '00000000-0000-0000-0000-000000000004', 'numbered_list', '[{"text": "Complete API v2 migration - Feb 15"}]'::jsonb, 'e'),
    ('00000000-0000-0000-0000-000000000035', '00000000-0000-0000-0000-000000000004', 'numbered_list', '[{"text": "Enterprise features release - Mar 1"}]'::jsonb, 'f'),
    ('00000000-0000-0000-0000-000000000036', '00000000-0000-0000-0000-000000000004', 'callout', '[{"text": "Priority shift: Focus on performance optimization before new features"}]'::jsonb, 'g'),
    ('00000000-0000-0000-0000-000000000037', '00000000-0000-0000-0000-000000000004', 'divider', '[]'::jsonb, 'h'),
    ('00000000-0000-0000-0000-000000000038', '00000000-0000-0000-0000-000000000004', 'quote', '[{"text": "Ship fast, but never compromise on quality."}]'::jsonb, 'i')
ON CONFLICT DO NOTHING;

-- Blocks for Meeting Notes page
INSERT INTO blocks (id, page_id, type, content, position) VALUES
    ('00000000-0000-0000-0000-000000000040', '00000000-0000-0000-0000-000000000005', 'text', '[{"text": "This page contains all team meeting notes. Click on a subpage to view specific meetings."}]'::jsonb, 'a')
ON CONFLICT DO NOTHING;

-- Blocks for Sprint Planning page
INSERT INTO blocks (id, page_id, type, content, position) VALUES
    ('00000000-0000-0000-0000-000000000050', '00000000-0000-0000-0000-000000000007', 'heading_1', '[{"text": "Sprint Planning - January 13, 2025"}]'::jsonb, 'a'),
    ('00000000-0000-0000-0000-000000000051', '00000000-0000-0000-0000-000000000007', 'text', '[{"text": "Attendees: Alice, Bob, Carol"}]'::jsonb, 'b'),
    ('00000000-0000-0000-0000-000000000052', '00000000-0000-0000-0000-000000000007', 'heading_2', '[{"text": "Sprint Goals"}]'::jsonb, 'c'),
    ('00000000-0000-0000-0000-000000000053', '00000000-0000-0000-0000-000000000007', 'bulleted_list', '[{"text": "Implement user authentication flow"}]'::jsonb, 'd'),
    ('00000000-0000-0000-0000-000000000054', '00000000-0000-0000-0000-000000000007', 'bulleted_list', '[{"text": "Set up CI/CD pipeline"}]'::jsonb, 'e'),
    ('00000000-0000-0000-0000-000000000055', '00000000-0000-0000-0000-000000000007', 'bulleted_list', '[{"text": "Complete database schema design"}]'::jsonb, 'f'),
    ('00000000-0000-0000-0000-000000000056', '00000000-0000-0000-0000-000000000007', 'heading_2', '[{"text": "Action Items"}]'::jsonb, 'g'),
    ('00000000-0000-0000-0000-000000000057', '00000000-0000-0000-0000-000000000007', 'to_do', '[{"text": "Alice: Create wireframes for dashboard"}]'::jsonb, 'h'),
    ('00000000-0000-0000-0000-000000000058', '00000000-0000-0000-0000-000000000007', 'to_do', '[{"text": "Bob: Set up development environment docs"}]'::jsonb, 'i'),
    ('00000000-0000-0000-0000-000000000059', '00000000-0000-0000-0000-000000000007', 'to_do', '[{"text": "Carol: Review security requirements"}]'::jsonb, 'j')
ON CONFLICT DO NOTHING;

-- Create a Bug Tracker database in Team Alpha
INSERT INTO pages (id, workspace_id, title, icon, is_database, properties_schema, created_by) VALUES
    ('00000000-0000-0000-0000-000000000009', '00000000-0000-0000-0000-000000000002', 'Bug Tracker', '🐛', true, '[
        {"id": "title", "name": "Bug", "type": "title"},
        {"id": "severity", "name": "Severity", "type": "select", "options": [
            {"id": "critical", "name": "Critical", "color": "red"},
            {"id": "high", "name": "High", "color": "orange"},
            {"id": "medium", "name": "Medium", "color": "yellow"},
            {"id": "low", "name": "Low", "color": "gray"}
        ]},
        {"id": "status", "name": "Status", "type": "select", "options": [
            {"id": "open", "name": "Open", "color": "red"},
            {"id": "in_progress", "name": "In Progress", "color": "blue"},
            {"id": "resolved", "name": "Resolved", "color": "green"},
            {"id": "closed", "name": "Closed", "color": "gray"}
        ]},
        {"id": "assignee", "name": "Assignee", "type": "text"},
        {"id": "created", "name": "Created", "type": "date"}
    ]'::jsonb, '00000000-0000-0000-0000-000000000002')
ON CONFLICT DO NOTHING;

-- Database views for Bug Tracker
INSERT INTO database_views (id, page_id, name, type, group_by) VALUES
    ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000009', 'All Bugs', 'table', NULL),
    ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000009', 'By Status', 'board', 'status'),
    ('00000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000009', 'By Severity', 'board', 'severity')
ON CONFLICT DO NOTHING;

-- Sample bugs in the Bug Tracker database
INSERT INTO database_rows (id, database_id, properties, position, created_by) VALUES
    ('00000000-0000-0000-0000-000000000025', '00000000-0000-0000-0000-000000000009',
     '{"title": "Login page crashes on mobile Safari", "severity": "critical", "status": "in_progress", "assignee": "Alice", "created": "2025-01-10"}'::jsonb,
     'a', '00000000-0000-0000-0000-000000000003'),
    ('00000000-0000-0000-0000-000000000026', '00000000-0000-0000-0000-000000000009',
     '{"title": "Dark mode toggle not persisting", "severity": "medium", "status": "open", "assignee": "Bob", "created": "2025-01-12"}'::jsonb,
     'b', '00000000-0000-0000-0000-000000000002'),
    ('00000000-0000-0000-0000-000000000027', '00000000-0000-0000-0000-000000000009',
     '{"title": "Notification email formatting broken", "severity": "high", "status": "open", "assignee": "Carol", "created": "2025-01-14"}'::jsonb,
     'c', '00000000-0000-0000-0000-000000000004'),
    ('00000000-0000-0000-0000-000000000028', '00000000-0000-0000-0000-000000000009',
     '{"title": "Typo in footer copyright year", "severity": "low", "status": "resolved", "assignee": "Bob", "created": "2025-01-08"}'::jsonb,
     'd', '00000000-0000-0000-0000-000000000003'),
    ('00000000-0000-0000-0000-000000000029', '00000000-0000-0000-0000-000000000009',
     '{"title": "API rate limiting not working", "severity": "high", "status": "in_progress", "assignee": "Alice", "created": "2025-01-11"}'::jsonb,
     'e', '00000000-0000-0000-0000-000000000002')
ON CONFLICT DO NOTHING;

-- Page permissions example
INSERT INTO page_permissions (page_id, user_id, permission) VALUES
    ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000003', 'edit'),
    ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000004', 'view')
ON CONFLICT DO NOTHING;
