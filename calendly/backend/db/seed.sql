-- Seed Data for Calendly (Meeting Scheduling)
-- Run after init.sql: psql -d calendly -f seed.sql
-- Uses ON CONFLICT DO NOTHING for idempotency

-- Note: init.sql already contains basic demo user, admin, meeting types, and availability
-- This file adds additional users, more bookings, and sample data for testing

-- ============================================================================
-- ADDITIONAL USERS
-- ============================================================================

-- Password: password123
-- Hash: $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

INSERT INTO users (id, email, password_hash, name, time_zone, role) VALUES
    ('d1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'alice@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Alice Johnson', 'America/Los_Angeles', 'user'),
    ('d2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'bob@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Bob Smith', 'America/Chicago', 'user'),
    ('d3eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'charlie@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Charlie Brown', 'Europe/London', 'user'),
    ('d4eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'diana@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Diana Ross', 'Asia/Tokyo', 'user')
ON CONFLICT (email) DO NOTHING;

-- ============================================================================
-- MEETING TYPES FOR NEW USERS
-- ============================================================================

-- Alice's meeting types
INSERT INTO meeting_types (id, user_id, name, slug, description, duration_minutes, buffer_before_minutes, buffer_after_minutes, color, max_bookings_per_day) VALUES
    ('mt11eebc-9c0b-4ef8-bb6d-6bb9bd380a11', 'd1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Quick Call', 'quick-call', 'A brief 15-minute check-in', 15, 0, 5, '#10B981', 10),
    ('mt12eebc-9c0b-4ef8-bb6d-6bb9bd380a11', 'd1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Strategy Session', 'strategy-session', '1-hour deep dive into your project strategy', 60, 10, 15, '#8B5CF6', 3),
    ('mt13eebc-9c0b-4ef8-bb6d-6bb9bd380a11', 'd1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Team Sync', 'team-sync', 'Regular team synchronization meeting', 30, 5, 5, '#3B82F6', 5)
ON CONFLICT (user_id, slug) DO NOTHING;

-- Bob's meeting types
INSERT INTO meeting_types (id, user_id, name, slug, description, duration_minutes, buffer_before_minutes, buffer_after_minutes, color) VALUES
    ('mt21eebc-9c0b-4ef8-bb6d-6bb9bd380a11', 'd2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Coffee Chat', 'coffee-chat', 'Casual virtual coffee and conversation', 20, 0, 5, '#F59E0B'),
    ('mt22eebc-9c0b-4ef8-bb6d-6bb9bd380a11', 'd2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Interview', 'interview', 'Technical interview session', 45, 10, 10, '#EF4444'),
    ('mt23eebc-9c0b-4ef8-bb6d-6bb9bd380a11', 'd2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Mentorship', 'mentorship', 'One-on-one mentorship session', 60, 5, 10, '#06B6D4')
ON CONFLICT (user_id, slug) DO NOTHING;

-- Charlie's meeting types
INSERT INTO meeting_types (id, user_id, name, slug, description, duration_minutes, buffer_before_minutes, buffer_after_minutes, color) VALUES
    ('mt31eebc-9c0b-4ef8-bb6d-6bb9bd380a11', 'd3eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Consultation', 'consultation', 'Initial consultation for new clients', 45, 10, 10, '#EC4899'),
    ('mt32eebc-9c0b-4ef8-bb6d-6bb9bd380a11', 'd3eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Project Review', 'project-review', 'Review ongoing project progress', 30, 5, 5, '#14B8A6')
ON CONFLICT (user_id, slug) DO NOTHING;

-- ============================================================================
-- AVAILABILITY RULES FOR NEW USERS
-- ============================================================================

-- Alice: Mon-Fri 8 AM - 4 PM (Pacific)
INSERT INTO availability_rules (user_id, day_of_week, start_time, end_time, is_active)
SELECT 'd1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', day, '08:00', '16:00', true
FROM generate_series(1, 5) AS day
ON CONFLICT DO NOTHING;

-- Bob: Mon-Thu 10 AM - 6 PM, Fri 10 AM - 2 PM (Central)
INSERT INTO availability_rules (user_id, day_of_week, start_time, end_time, is_active) VALUES
    ('d2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 1, '10:00', '18:00', true),
    ('d2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 2, '10:00', '18:00', true),
    ('d2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 3, '10:00', '18:00', true),
    ('d2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 4, '10:00', '18:00', true),
    ('d2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 5, '10:00', '14:00', true)
ON CONFLICT DO NOTHING;

-- Charlie: Mon-Fri 9 AM - 5 PM (London)
INSERT INTO availability_rules (user_id, day_of_week, start_time, end_time, is_active)
SELECT 'd3eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', day, '09:00', '17:00', true
FROM generate_series(1, 5) AS day
ON CONFLICT DO NOTHING;

-- Diana: Mon-Fri 10 AM - 7 PM (Tokyo)
INSERT INTO availability_rules (user_id, day_of_week, start_time, end_time, is_active)
SELECT 'd4eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', day, '10:00', '19:00', true
FROM generate_series(1, 5) AS day
ON CONFLICT DO NOTHING;

-- ============================================================================
-- SAMPLE BOOKINGS
-- ============================================================================

-- Upcoming bookings for Demo User (from init.sql: a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11)
INSERT INTO bookings (id, meeting_type_id, host_user_id, invitee_name, invitee_email, start_time, end_time, invitee_timezone, status, notes, idempotency_key) VALUES
    -- Tomorrow's meetings
    ('bk111111-1111-1111-1111-111111111111',
     'b2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', -- 30-minute meeting type
     'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
     'John Davis', 'john.davis@company.com',
     (CURRENT_DATE + INTERVAL '1 day' + TIME '10:00')::timestamp with time zone,
     (CURRENT_DATE + INTERVAL '1 day' + TIME '10:30')::timestamp with time zone,
     'America/New_York', 'confirmed', 'Discuss Q4 planning',
     'idem-111111'),

    ('bk222222-2222-2222-2222-222222222222',
     'b2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
     'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
     'Sarah Miller', 'sarah.miller@startup.io',
     (CURRENT_DATE + INTERVAL '1 day' + TIME '14:00')::timestamp with time zone,
     (CURRENT_DATE + INTERVAL '1 day' + TIME '14:30')::timestamp with time zone,
     'America/Los_Angeles', 'confirmed', 'Product demo walkthrough',
     'idem-222222'),

    ('bk333333-3333-3333-3333-333333333333',
     'b3eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', -- 60-minute meeting type
     'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
     'Mike Thompson', 'mike.t@enterprise.com',
     (CURRENT_DATE + INTERVAL '2 days' + TIME '11:00')::timestamp with time zone,
     (CURRENT_DATE + INTERVAL '2 days' + TIME '12:00')::timestamp with time zone,
     'Europe/London', 'confirmed', 'Strategic partnership discussion',
     'idem-333333'),

    -- Next week meetings
    ('bk444444-4444-4444-4444-444444444444',
     'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', -- 15-minute meeting type
     'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
     'Emily Chen', 'emily.chen@tech.co',
     (CURRENT_DATE + INTERVAL '7 days' + TIME '09:00')::timestamp with time zone,
     (CURRENT_DATE + INTERVAL '7 days' + TIME '09:15')::timestamp with time zone,
     'Asia/Tokyo', 'confirmed', 'Quick status update',
     'idem-444444')
ON CONFLICT (id) DO NOTHING;

-- Bookings for Alice
INSERT INTO bookings (id, meeting_type_id, host_user_id, invitee_name, invitee_email, start_time, end_time, invitee_timezone, status, notes, idempotency_key) VALUES
    ('bk511111-1111-1111-1111-111111111111',
     'mt11eebc-9c0b-4ef8-bb6d-6bb9bd380a11', -- Quick Call
     'd1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
     'Tom Wilson', 'tom.wilson@corp.com',
     (CURRENT_DATE + INTERVAL '1 day' + TIME '09:00')::timestamp with time zone,
     (CURRENT_DATE + INTERVAL '1 day' + TIME '09:15')::timestamp with time zone,
     'America/New_York', 'confirmed', NULL,
     'idem-511111'),

    ('bk522222-2222-2222-2222-222222222222',
     'mt12eebc-9c0b-4ef8-bb6d-6bb9bd380a11', -- Strategy Session
     'd1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
     'Lisa Park', 'lisa.park@agency.io',
     (CURRENT_DATE + INTERVAL '3 days' + TIME '13:00')::timestamp with time zone,
     (CURRENT_DATE + INTERVAL '3 days' + TIME '14:00')::timestamp with time zone,
     'America/Chicago', 'confirmed', 'Q1 2025 roadmap planning',
     'idem-522222')
ON CONFLICT (id) DO NOTHING;

-- Past bookings (for history)
INSERT INTO bookings (id, meeting_type_id, host_user_id, invitee_name, invitee_email, start_time, end_time, invitee_timezone, status, notes, idempotency_key) VALUES
    ('bk611111-1111-1111-1111-111111111111',
     'b2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
     'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
     'Robert Brown', 'robert.b@old-client.com',
     (CURRENT_DATE - INTERVAL '7 days' + TIME '10:00')::timestamp with time zone,
     (CURRENT_DATE - INTERVAL '7 days' + TIME '10:30')::timestamp with time zone,
     'America/New_York', 'confirmed', 'Follow-up on proposal',
     'idem-611111'),

    ('bk622222-2222-2222-2222-222222222222',
     'b3eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
     'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
     'Amanda Lee', 'amanda.lee@cancelled.co',
     (CURRENT_DATE - INTERVAL '5 days' + TIME '15:00')::timestamp with time zone,
     (CURRENT_DATE - INTERVAL '5 days' + TIME '16:00')::timestamp with time zone,
     'Europe/Paris', 'cancelled', NULL,
     'idem-622222')
ON CONFLICT (id) DO NOTHING;

-- Update cancelled booking with cancellation reason
UPDATE bookings
SET cancellation_reason = 'Client requested to reschedule'
WHERE id = 'bk622222-2222-2222-2222-222222222222';

-- ============================================================================
-- EMAIL NOTIFICATIONS
-- ============================================================================

INSERT INTO email_notifications (booking_id, recipient_email, notification_type, subject, body, status) VALUES
    ('bk111111-1111-1111-1111-111111111111', 'john.davis@company.com', 'confirmation',
     'Meeting Confirmed: 30 Minute Meeting with Demo User',
     'Your meeting has been confirmed for tomorrow at 10:00 AM EST. Meeting notes: Discuss Q4 planning',
     'sent'),
    ('bk111111-1111-1111-1111-111111111111', 'demo@example.com', 'confirmation',
     'New Booking: 30 Minute Meeting with John Davis',
     'You have a new booking for tomorrow at 10:00 AM EST. Invitee: John Davis (john.davis@company.com)',
     'sent'),
    ('bk222222-2222-2222-2222-222222222222', 'sarah.miller@startup.io', 'confirmation',
     'Meeting Confirmed: 30 Minute Meeting with Demo User',
     'Your meeting has been confirmed for tomorrow at 2:00 PM PST.',
     'sent'),
    ('bk622222-2222-2222-2222-222222222222', 'amanda.lee@cancelled.co', 'cancellation',
     'Meeting Cancelled: 60 Minute Meeting with Demo User',
     'Your meeting scheduled for the listed time has been cancelled. Reason: Client requested to reschedule',
     'sent');

-- ============================================================================
-- ARCHIVED BOOKINGS (for historical data)
-- ============================================================================

INSERT INTO bookings_archive (id, meeting_type_id, host_user_id, invitee_name, invitee_email, start_time, end_time, invitee_timezone, status, notes, created_at, archived_at) VALUES
    ('ar111111-1111-1111-1111-111111111111',
     'b2eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
     'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
     'Old Client One', 'old.client1@archive.com',
     (CURRENT_DATE - INTERVAL '120 days' + TIME '10:00')::timestamp with time zone,
     (CURRENT_DATE - INTERVAL '120 days' + TIME '10:30')::timestamp with time zone,
     'America/New_York', 'confirmed', 'Historical meeting 1',
     NOW() - INTERVAL '120 days', NOW() - INTERVAL '30 days'),

    ('ar222222-2222-2222-2222-222222222222',
     'b3eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
     'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
     'Old Client Two', 'old.client2@archive.com',
     (CURRENT_DATE - INTERVAL '100 days' + TIME '14:00')::timestamp with time zone,
     (CURRENT_DATE - INTERVAL '100 days' + TIME '15:00')::timestamp with time zone,
     'Europe/London', 'confirmed', 'Historical meeting 2',
     NOW() - INTERVAL '100 days', NOW() - INTERVAL '10 days')
ON CONFLICT (id) DO NOTHING;
