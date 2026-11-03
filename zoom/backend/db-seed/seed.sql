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
ON CONFLICT (meeting_code) DO UPDATE SET
  -- Re-seeding resets the demo meeting: joining it starts it and the last one out ends it.
  status = 'scheduled', actual_start = NULL, actual_end = NULL,
  scheduled_start = EXCLUDED.scheduled_start, scheduled_end = EXCLUDED.scheduled_end;

-- Upcoming meeting with a waiting room (hosted by bob): others wait until bob admits them
INSERT INTO meetings (id, meeting_code, title, host_id, scheduled_start, scheduled_end, status, settings) VALUES
  ('b0000000-0000-0000-0000-000000000003', 'bob-wait-rom', 'Office Hours with Bob', 'a0000000-0000-0000-0000-000000000002',
   NOW() + INTERVAL '2 hours', NOW() + INTERVAL '3 hours', 'scheduled',
   '{"waitingRoom": true, "muteOnEntry": false, "allowScreenShare": false, "maxParticipants": 10}')
ON CONFLICT (meeting_code) DO UPDATE SET
  status = 'scheduled', actual_start = NULL, actual_end = NULL,
  scheduled_start = EXCLUDED.scheduled_start, scheduled_end = EXCLUDED.scheduled_end;

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

-- Chat messages from the past meeting. The last one is a direct message from
-- charlie to bob: it shows in bob's and charlie's history, never in alice's.
INSERT INTO meeting_chat_messages (id, meeting_id, sender_id, recipient_id, content, created_at) VALUES
  ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', NULL, 'Welcome everyone to the project review!', NOW() - INTERVAL '2 days' + INTERVAL '1 minute'),
  ('c0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', NULL, 'Thanks Bob! Ready to share my screen.', NOW() - INTERVAL '2 days' + INTERVAL '3 minutes'),
  ('c0000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000003', NULL, 'Looking forward to seeing the progress!', NOW() - INTERVAL '2 days' + INTERVAL '5 minutes'),
  ('c0000000-0000-0000-0000-000000000004', 'b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000002', NULL, 'Great presentation Alice. Any questions from the team?', NOW() - INTERVAL '2 days' + INTERVAL '30 minutes'),
  ('c0000000-0000-0000-0000-000000000005', 'b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000002', 'Bob, can you send me the slides after? (private)', NOW() - INTERVAL '2 days' + INTERVAL '31 minutes')
ON CONFLICT (id) DO NOTHING;
