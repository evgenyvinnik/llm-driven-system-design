-- Seed data for development/testing
-- Figma demo data

-- Insert a default demo user
INSERT INTO users (id, email, name, password_hash, role) VALUES
  ('00000000-0000-0000-0000-000000000001', 'demo@figma.local', 'Demo User', '$2b$10$demo', 'admin');

-- Insert a default team
INSERT INTO teams (id, name, owner_id) VALUES
  ('00000000-0000-0000-0000-000000000002', 'Demo Team', '00000000-0000-0000-0000-000000000001');

-- Add demo user to team
INSERT INTO team_members (team_id, user_id, role) VALUES
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'owner');

-- Insert a default project
INSERT INTO projects (id, name, team_id, owner_id) VALUES
  ('00000000-0000-0000-0000-000000000003', 'Demo Project', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001');

-- Insert a sample file
INSERT INTO files (id, name, project_id, owner_id, team_id, canvas_data) VALUES
  ('00000000-0000-0000-0000-000000000004', 'Welcome Design', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
  '{"objects": [{"id": "obj-1", "type": "rectangle", "x": 100, "y": 100, "width": 200, "height": 150, "fill": "#3B82F6", "stroke": "#1E40AF", "strokeWidth": 2, "rotation": 0, "name": "Blue Rectangle"}], "pages": [{"id": "page-1", "name": "Page 1"}]}');
