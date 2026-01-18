-- Seed data for development/testing
-- Password hash for 'password123' generated with bcrypt

-- Insert demo users
INSERT INTO users (id, email, password_hash, name, time_zone, role)
VALUES
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'alice@example.com', '$2b$10$B1hDCi2ToucR.t09jNQOquQoPjjhdeBPWRn6opLYJZ5IVDklNj1Fy', 'Alice Johnson', 'America/New_York', 'user'),
  ('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'admin@example.com', '$2b$10$B1hDCi2ToucR.t09jNQOquQoPjjhdeBPWRn6opLYJZ5IVDklNj1Fy', 'Admin User', 'UTC', 'admin');

-- Insert demo meeting types for Alice
INSERT INTO meeting_types (id, user_id, name, slug, description, duration_minutes, buffer_before_minutes, buffer_after_minutes, color)
VALUES
  ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '15 Minute Meeting', '15-minute-meeting', 'Quick sync or introduction call', 15, 0, 5, '#10B981'),
  ('b2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '30 Minute Meeting', '30-minute-meeting', 'Standard meeting for discussions', 30, 5, 5, '#3B82F6'),
  ('b3eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '60 Minute Meeting', '60-minute-meeting', 'Extended meeting for deep dives', 60, 5, 10, '#8B5CF6');

-- Insert demo availability rules for Alice (Mon-Fri, 9 AM - 5 PM)
INSERT INTO availability_rules (user_id, day_of_week, start_time, end_time)
VALUES
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 1, '09:00', '17:00'), -- Monday
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 2, '09:00', '17:00'), -- Tuesday
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 3, '09:00', '17:00'), -- Wednesday
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 4, '09:00', '17:00'), -- Thursday
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 5, '09:00', '17:00'); -- Friday
