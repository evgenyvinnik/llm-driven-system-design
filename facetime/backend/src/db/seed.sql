-- Seed data for development/testing

-- Insert sample users for testing
INSERT INTO users (id, username, email, display_name, role) VALUES
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'alice', 'alice@example.com', 'Alice Smith', 'user'),
  ('b2c3d4e5-f6a7-8901-bcde-f12345678901', 'bob', 'bob@example.com', 'Bob Johnson', 'user'),
  ('c3d4e5f6-a7b8-9012-cdef-123456789012', 'charlie', 'charlie@example.com', 'Charlie Brown', 'user'),
  ('d4e5f6a7-b8c9-0123-defa-234567890123', 'admin', 'admin@example.com', 'Admin User', 'admin')
ON CONFLICT (username) DO NOTHING;

-- Insert sample devices
INSERT INTO user_devices (user_id, device_name, device_type, is_active) VALUES
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Alice MacBook', 'desktop', true),
  ('a1b2c3d4-e5f6-7890-abcd-ef1234567890', 'Alice iPhone', 'mobile', true),
  ('b2c3d4e5-f6a7-8901-bcde-f12345678901', 'Bob Desktop', 'desktop', true),
  ('c3d4e5f6-a7b8-9012-cdef-123456789012', 'Charlie iPad', 'tablet', true)
ON CONFLICT DO NOTHING;
