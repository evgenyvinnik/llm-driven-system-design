-- Seed data for development/testing

-- Insert default users for testing
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
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 0, 'Welcome to the Collaborative Editor!

Start typing to collaborate in real-time.')
ON CONFLICT (document_id, version) DO NOTHING;
