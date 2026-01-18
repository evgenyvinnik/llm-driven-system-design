-- Seed data for development/testing
-- Run after init.sql

-- Insert demo merchant
INSERT INTO merchants (id, name, category_code, merchant_id, status)
VALUES (
  'a1b2c3d4-e5f6-4a5b-8c9d-0e1f2a3b4c5d',
  'Demo Coffee Shop',
  '5814',
  'DEMO_MERCHANT_001',
  'active'
) ON CONFLICT DO NOTHING;

-- Insert demo user (password: demo123)
INSERT INTO users (id, email, password_hash, name, role)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'demo@example.com',
  '$2b$10$K7L1OJ45/4Y2nIvhRVpCe.FSmhDdWoXehVzJptJ/op0lSsvqNuMq6',
  'Demo User',
  'user'
) ON CONFLICT DO NOTHING;

-- Insert demo device
INSERT INTO devices (id, user_id, device_name, device_type, secure_element_id, status)
VALUES (
  '22222222-2222-2222-2222-222222222222',
  '11111111-1111-1111-1111-111111111111',
  'Demo iPhone 15 Pro',
  'iphone',
  'SE_DEMO_001',
  'active'
) ON CONFLICT DO NOTHING;
