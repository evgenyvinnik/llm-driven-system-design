-- Seed data for development/testing
-- Figma demo data

-- Insert a default demo user
INSERT INTO users (id, email, name, password_hash, role) VALUES
  ('00000000-0000-0000-0000-000000000001', 'demo@figma.local', 'Demo User', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'admin');

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
  ('00000000-0000-0000-0000-000000000004', 'Mobile App — Login Screen', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
  '{"objects": [
    {"id": "obj-frame", "type": "rectangle", "x": 320, "y": 80, "width": 360, "height": 640, "fill": "#0F172A", "stroke": "#334155", "strokeWidth": 2, "rotation": 0, "name": "Phone Frame"},
    {"id": "obj-logo", "type": "ellipse", "x": 460, "y": 160, "width": 80, "height": 80, "fill": "#6366F1", "stroke": "#4F46E5", "strokeWidth": 0, "rotation": 0, "name": "Logo"},
    {"id": "obj-title", "type": "text", "x": 400, "y": 280, "width": 200, "height": 40, "fill": "#F8FAFC", "text": "Welcome back", "fontSize": 28, "textAlign": "center", "rotation": 0, "name": "Title"},
    {"id": "obj-sub", "type": "text", "x": 400, "y": 324, "width": 200, "height": 24, "fill": "#94A3B8", "text": "Sign in to continue", "fontSize": 15, "textAlign": "center", "rotation": 0, "name": "Subtitle"},
    {"id": "obj-input1", "type": "rectangle", "x": 360, "y": 380, "width": 280, "height": 48, "fill": "#1E293B", "stroke": "#475569", "strokeWidth": 1, "rotation": 0, "name": "Email Field"},
    {"id": "obj-input2", "type": "rectangle", "x": 360, "y": 444, "width": 280, "height": 48, "fill": "#1E293B", "stroke": "#475569", "strokeWidth": 1, "rotation": 0, "name": "Password Field"},
    {"id": "obj-btn", "type": "rectangle", "x": 360, "y": 520, "width": 280, "height": 52, "fill": "#6366F1", "stroke": "#4F46E5", "strokeWidth": 0, "rotation": 0, "name": "Sign In Button"},
    {"id": "obj-btntext", "type": "text", "x": 440, "y": 536, "width": 120, "height": 24, "fill": "#FFFFFF", "text": "Sign In", "fontSize": 16, "textAlign": "center", "rotation": 0, "name": "Button Label"}
  ], "pages": [{"id": "page-1", "name": "Page 1"}]}'),
  ('00000000-0000-0000-0000-000000000005', 'Dashboard Wireframe', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
  '{"objects": [
    {"id": "d-sidebar", "type": "rectangle", "x": 80, "y": 80, "width": 180, "height": 560, "fill": "#1E293B", "stroke": "#334155", "strokeWidth": 1, "rotation": 0, "name": "Sidebar"},
    {"id": "d-header", "type": "rectangle", "x": 280, "y": 80, "width": 700, "height": 72, "fill": "#F1F5F9", "stroke": "#CBD5E1", "strokeWidth": 1, "rotation": 0, "name": "Header"},
    {"id": "d-card1", "type": "rectangle", "x": 280, "y": 176, "width": 220, "height": 140, "fill": "#DBEAFE", "stroke": "#93C5FD", "strokeWidth": 1, "rotation": 0, "name": "Stat Card 1"},
    {"id": "d-card2", "type": "rectangle", "x": 520, "y": 176, "width": 220, "height": 140, "fill": "#DCFCE7", "stroke": "#86EFAC", "strokeWidth": 1, "rotation": 0, "name": "Stat Card 2"},
    {"id": "d-card3", "type": "rectangle", "x": 760, "y": 176, "width": 220, "height": 140, "fill": "#FEF3C7", "stroke": "#FCD34D", "strokeWidth": 1, "rotation": 0, "name": "Stat Card 3"},
    {"id": "d-chart", "type": "rectangle", "x": 280, "y": 340, "width": 460, "height": 300, "fill": "#FFFFFF", "stroke": "#CBD5E1", "strokeWidth": 1, "rotation": 0, "name": "Chart Panel"},
    {"id": "d-list", "type": "rectangle", "x": 760, "y": 340, "width": 220, "height": 300, "fill": "#FFFFFF", "stroke": "#CBD5E1", "strokeWidth": 1, "rotation": 0, "name": "Activity List"},
    {"id": "d-title", "type": "text", "x": 300, "y": 100, "width": 200, "height": 32, "fill": "#0F172A", "text": "Analytics Dashboard", "fontSize": 22, "textAlign": "left", "rotation": 0, "name": "Header Title"}
  ], "pages": [{"id": "page-1", "name": "Page 1"}]}'),
  ('00000000-0000-0000-0000-000000000006', 'Brand Color Palette', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002',
  '{"objects": [
    {"id": "p-1", "type": "rectangle", "x": 120, "y": 200, "width": 120, "height": 200, "fill": "#EF4444", "stroke": "#000000", "strokeWidth": 0, "rotation": 0, "name": "Red"},
    {"id": "p-2", "type": "rectangle", "x": 250, "y": 200, "width": 120, "height": 200, "fill": "#F97316", "stroke": "#000000", "strokeWidth": 0, "rotation": 0, "name": "Orange"},
    {"id": "p-3", "type": "rectangle", "x": 380, "y": 200, "width": 120, "height": 200, "fill": "#EAB308", "stroke": "#000000", "strokeWidth": 0, "rotation": 0, "name": "Yellow"},
    {"id": "p-4", "type": "rectangle", "x": 510, "y": 200, "width": 120, "height": 200, "fill": "#22C55E", "stroke": "#000000", "strokeWidth": 0, "rotation": 0, "name": "Green"},
    {"id": "p-5", "type": "rectangle", "x": 640, "y": 200, "width": 120, "height": 200, "fill": "#3B82F6", "stroke": "#000000", "strokeWidth": 0, "rotation": 0, "name": "Blue"},
    {"id": "p-6", "type": "rectangle", "x": 770, "y": 200, "width": 120, "height": 200, "fill": "#8B5CF6", "stroke": "#000000", "strokeWidth": 0, "rotation": 0, "name": "Purple"},
    {"id": "p-title", "type": "text", "x": 120, "y": 140, "width": 400, "height": 40, "fill": "#0F172A", "text": "Brand Palette 2026", "fontSize": 30, "textAlign": "left", "rotation": 0, "name": "Title"}
  ], "pages": [{"id": "page-1", "name": "Page 1"}]}');
