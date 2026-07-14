-- Seed data for Zoom project
-- Users: alice, bob, charlie (password: password123)
-- bcrypt hash for 'password123'

INSERT INTO users (id, username, email, password_hash, display_name) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'alice', 'alice@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Alice Johnson'),
  ('a0000000-0000-0000-0000-000000000002', 'bob', 'bob@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Bob Smith'),
  ('a0000000-0000-0000-0000-000000000003', 'charlie', 'charlie@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Charlie Davis')
ON CONFLICT (username) DO NOTHING;

-- Upcoming meeting (hosted by alice)
INSERT INTO meetings (id, meeting_code, title, host_id, scheduled_start, scheduled_end, status, settings) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'abc-defg-hij', 'Weekly Team Standup', 'a0000000-0000-0000-0000-000000000001',
   NOW() + INTERVAL '1 day', NOW() + INTERVAL '1 day 1 hour', 'scheduled',
   '{"waitingRoom": false, "muteOnEntry": true, "allowScreenShare": true, "maxParticipants": 100}')
ON CONFLICT (meeting_code) DO NOTHING;

-- Past meeting (hosted by bob)
INSERT INTO meetings (id, meeting_code, title, host_id, scheduled_start, scheduled_end, actual_start, actual_end, status, settings) VALUES
  ('b0000000-0000-0000-0000-000000000002', 'xyz-abcd-efg', 'Project Review', 'a0000000-0000-0000-0000-000000000002',
   NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days' + INTERVAL '45 minutes',
   NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days' + INTERVAL '42 minutes',
   'ended',
   '{"waitingRoom": false, "muteOnEntry": false, "allowScreenShare": true, "maxParticipants": 50}')
ON CONFLICT (meeting_code) DO NOTHING;

-- Participants for the past meeting
INSERT INTO meeting_participants (meeting_id, user_id, display_name, role, joined_at, left_at) VALUES
  ('b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', 'Bob Smith', 'host',
   NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days' + INTERVAL '42 minutes'),
  ('b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'Alice Johnson', 'participant',
   NOW() - INTERVAL '2 days' + INTERVAL '2 minutes', NOW() - INTERVAL '2 days' + INTERVAL '40 minutes'),
  ('b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000003', 'Charlie Davis', 'participant',
   NOW() - INTERVAL '2 days' + INTERVAL '5 minutes', NOW() - INTERVAL '2 days' + INTERVAL '42 minutes')
ON CONFLICT (meeting_id, user_id) DO NOTHING;

-- Chat messages from the past meeting
INSERT INTO meeting_chat_messages (meeting_id, sender_id, content, created_at) VALUES
  ('b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', 'Welcome everyone to the project review!', NOW() - INTERVAL '2 days' + INTERVAL '1 minute'),
  ('b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'Thanks Bob! Ready to share my screen.', NOW() - INTERVAL '2 days' + INTERVAL '3 minutes'),
  ('b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000003', 'Looking forward to seeing the progress!', NOW() - INTERVAL '2 days' + INTERVAL '5 minutes'),
  ('b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', 'Great presentation Alice. Any questions from the team?', NOW() - INTERVAL '2 days' + INTERVAL '30 minutes');
