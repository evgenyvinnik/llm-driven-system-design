-- Seed data for development/testing
-- Run after init.sql

-- Create default admin user (password: admin123)
INSERT INTO admin_users (id, username, password_hash, role)
VALUES (
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  'admin',
  '$2b$10$rQZ6VvI6N6C6JYqE3X3Y0eP.XYX.XYX.XYX.XYX.XYX.XYX.XYX',
  'admin'
) ON CONFLICT (username) DO NOTHING;
