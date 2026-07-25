-- Gmail seed data: 3 users, system labels, threads with messages
-- Users: alice/password123, bob/password123, charlie/password123
-- Password hash is bcrypt of 'password123'

-- Insert users
INSERT INTO users (id, username, email, password_hash, display_name) VALUES
  ('a1111111-1111-1111-1111-111111111111', 'alice', 'alice@gmail.local', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Alice Johnson'),
  ('b2222222-2222-2222-2222-222222222222', 'bob', 'bob@gmail.local', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Bob Smith'),
  ('c3333333-3333-3333-3333-333333333333', 'charlie', 'charlie@gmail.local', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Charlie Brown')
ON CONFLICT DO NOTHING;

-- System labels for Alice
INSERT INTO labels (id, user_id, name, color, is_system) VALUES
  ('6c4821fd-d428-48bc-85db-3e435c9a0af9', 'a1111111-1111-1111-1111-111111111111', 'INBOX', '#1A73E8', true),
  ('8c9b2064-80c2-4188-88c6-ef65e07585c3', 'a1111111-1111-1111-1111-111111111111', 'SENT', '#1A73E8', true),
  ('8f7f0563-3602-4177-82fe-670d96f98f32', 'a1111111-1111-1111-1111-111111111111', 'DRAFTS', '#1A73E8', true),
  ('7e9eaa98-13dc-49b9-849b-f605267dc863', 'a1111111-1111-1111-1111-111111111111', 'TRASH', '#666666', true),
  ('51761ef9-a80e-4899-8ec2-5126cae59e8e', 'a1111111-1111-1111-1111-111111111111', 'SPAM', '#D93025', true),
  ('4d6940cd-bc1e-4bfa-828c-7e5b8fbc257c', 'a1111111-1111-1111-1111-111111111111', 'STARRED', '#F4B400', true),
  ('653ecfb4-1d44-496f-825f-db977e63324c', 'a1111111-1111-1111-1111-111111111111', 'ALL_MAIL', '#666666', true),
  ('45fc2094-2b3e-4b85-823f-368585d772c3', 'a1111111-1111-1111-1111-111111111111', 'IMPORTANT', '#F4B400', true)
ON CONFLICT DO NOTHING;

-- System labels for Bob
INSERT INTO labels (id, user_id, name, color, is_system) VALUES
  ('64316f50-dac6-49be-8bfa-13069a9282c8', 'b2222222-2222-2222-2222-222222222222', 'INBOX', '#1A73E8', true),
  ('9e8a4fe2-998a-4dd8-8b77-26462330111e', 'b2222222-2222-2222-2222-222222222222', 'SENT', '#1A73E8', true),
  ('d537d216-0444-450f-8f9e-299e59600130', 'b2222222-2222-2222-2222-222222222222', 'DRAFTS', '#1A73E8', true),
  ('0f631952-88f7-451c-852e-60fcfe4cae76', 'b2222222-2222-2222-2222-222222222222', 'TRASH', '#666666', true),
  ('beb1b56f-e6ec-444c-8e6b-5035bb7b3a75', 'b2222222-2222-2222-2222-222222222222', 'SPAM', '#D93025', true),
  ('93ef0531-6cca-411b-8db9-21dc0722d613', 'b2222222-2222-2222-2222-222222222222', 'STARRED', '#F4B400', true),
  ('3f42a56f-2137-4e9a-845b-261e646fa268', 'b2222222-2222-2222-2222-222222222222', 'ALL_MAIL', '#666666', true),
  ('5c206c4e-485c-454c-81b7-4cbf7b0043fa', 'b2222222-2222-2222-2222-222222222222', 'IMPORTANT', '#F4B400', true)
ON CONFLICT DO NOTHING;

-- System labels for Charlie
INSERT INTO labels (id, user_id, name, color, is_system) VALUES
  ('60c94afa-ca95-4fd8-8155-b10ae3eb2243', 'c3333333-3333-3333-3333-333333333333', 'INBOX', '#1A73E8', true),
  ('14588cb2-43ca-4f4d-8de1-f95be6592634', 'c3333333-3333-3333-3333-333333333333', 'SENT', '#1A73E8', true),
  ('5ab355a0-5a39-4276-8ca1-9797aaaa1db6', 'c3333333-3333-3333-3333-333333333333', 'DRAFTS', '#1A73E8', true),
  ('10ddca61-0965-4726-8633-32b6bd9eaf23', 'c3333333-3333-3333-3333-333333333333', 'TRASH', '#666666', true),
  ('fb8b6fd0-2560-4f66-8df4-9d0d54a234f7', 'c3333333-3333-3333-3333-333333333333', 'SPAM', '#D93025', true),
  ('452fce02-19b9-4c45-8fee-e6ebdd4a73aa', 'c3333333-3333-3333-3333-333333333333', 'STARRED', '#F4B400', true),
  ('61ec9ebc-104b-4fbe-807d-69875da230da', 'c3333333-3333-3333-3333-333333333333', 'ALL_MAIL', '#666666', true),
  ('a9d86bb2-7656-47b8-8394-b2402c31593a', 'c3333333-3333-3333-3333-333333333333', 'IMPORTANT', '#F4B400', true)
ON CONFLICT DO NOTHING;

-- Custom label for Alice
INSERT INTO labels (id, user_id, name, color, is_system) VALUES
  ('3d65e891-9212-48e3-887b-b274a984a953', 'a1111111-1111-1111-1111-111111111111', 'Work', '#4285F4', false),
  ('594b8349-59cc-4403-8609-93f85066d9b3', 'a1111111-1111-1111-1111-111111111111', 'Personal', '#34A853', false)
ON CONFLICT DO NOTHING;

-- Thread 1: Bob -> Alice (project update)
INSERT INTO threads (id, subject, snippet, message_count, last_message_at, created_at) VALUES
  ('d1111111-1111-1111-1111-111111111111', 'Project Update - Q4 Report', 'Hey Alice, I just finished the Q4 report. Can you review it when you get a chance?', 2, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '3 hours')
ON CONFLICT DO NOTHING;

INSERT INTO messages (id, thread_id, sender_id, body_text, body_html, created_at) VALUES
  ('61111111-1111-1111-1111-111111111111', 'd1111111-1111-1111-1111-111111111111', 'b2222222-2222-2222-2222-222222222222',
   'Hey Alice, I just finished the Q4 report. Can you review it when you get a chance? I think we have some great numbers this quarter.',
   '<p>Hey Alice,</p><p>I just finished the Q4 report. Can you review it when you get a chance? I think we have some great numbers this quarter.</p>',
   NOW() - INTERVAL '3 hours'),
  ('61111111-1111-1111-1111-222222222222', 'd1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111',
   'Thanks Bob! I will take a look at it this afternoon. The preliminary numbers looked promising.',
   '<p>Thanks Bob! I will take a look at it this afternoon. The preliminary numbers looked promising.</p>',
   NOW() - INTERVAL '1 hour')
ON CONFLICT DO NOTHING;

INSERT INTO message_recipients (message_id, user_id, recipient_type) VALUES
  ('61111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'to'),
  ('61111111-1111-1111-1111-222222222222', 'b2222222-2222-2222-2222-222222222222', 'to')
ON CONFLICT DO NOTHING;

-- Thread 2: Charlie -> Alice, Bob (team lunch)
INSERT INTO threads (id, subject, snippet, message_count, last_message_at, created_at) VALUES
  ('d2222222-2222-2222-2222-222222222222', 'Team Lunch Tomorrow', 'Hey everyone, want to grab lunch tomorrow at noon? I was thinking of trying that new Italian place.', 3, NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '5 hours')
ON CONFLICT DO NOTHING;

INSERT INTO messages (id, thread_id, sender_id, body_text, body_html, created_at) VALUES
  ('62222222-2222-2222-2222-111111111111', 'd2222222-2222-2222-2222-222222222222', 'c3333333-3333-3333-3333-333333333333',
   'Hey everyone, want to grab lunch tomorrow at noon? I was thinking of trying that new Italian place on Main Street.',
   '<p>Hey everyone,</p><p>Want to grab lunch tomorrow at noon? I was thinking of trying that new Italian place on Main Street.</p>',
   NOW() - INTERVAL '5 hours'),
  ('62222222-2222-2222-2222-222222222222', 'd2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-111111111111',
   'Sounds great! I have been wanting to try that place. Count me in!',
   '<p>Sounds great! I have been wanting to try that place. Count me in!</p>',
   NOW() - INTERVAL '2 hours'),
  ('62222222-2222-2222-2222-333333333333', 'd2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222222',
   'I am in too! Let us meet at the lobby at 11:45.',
   '<p>I am in too! Let us meet at the lobby at 11:45.</p>',
   NOW() - INTERVAL '30 minutes')
ON CONFLICT DO NOTHING;

INSERT INTO message_recipients (message_id, user_id, recipient_type) VALUES
  ('62222222-2222-2222-2222-111111111111', 'a1111111-1111-1111-1111-111111111111', 'to'),
  ('62222222-2222-2222-2222-111111111111', 'b2222222-2222-2222-2222-222222222222', 'to'),
  ('62222222-2222-2222-2222-222222222222', 'c3333333-3333-3333-3333-333333333333', 'to'),
  ('62222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222222', 'cc'),
  ('62222222-2222-2222-2222-333333333333', 'c3333333-3333-3333-3333-333333333333', 'to'),
  ('62222222-2222-2222-2222-333333333333', 'a1111111-1111-1111-1111-111111111111', 'cc')
ON CONFLICT DO NOTHING;

-- Thread 3: Alice -> Charlie (code review)
INSERT INTO threads (id, subject, snippet, message_count, last_message_at, created_at) VALUES
  ('d3333333-3333-3333-3333-333333333333', 'Code Review: Authentication Module', 'Hi Charlie, can you review my PR for the auth module? Link: github.com/project/pull/42', 1, NOW() - INTERVAL '6 hours', NOW() - INTERVAL '6 hours')
ON CONFLICT DO NOTHING;

INSERT INTO messages (id, thread_id, sender_id, body_text, body_html, created_at) VALUES
  ('63333333-3333-3333-3333-111111111111', 'd3333333-3333-3333-3333-333333333333', 'a1111111-1111-1111-1111-111111111111',
   'Hi Charlie, can you review my PR for the auth module? Link: github.com/project/pull/42. I added session-based auth with Redis store and rate limiting on login attempts.',
   '<p>Hi Charlie,</p><p>Can you review my PR for the auth module? <a href="github.com/project/pull/42">Link</a>.</p><p>I added session-based auth with Redis store and rate limiting on login attempts.</p>',
   NOW() - INTERVAL '6 hours')
ON CONFLICT DO NOTHING;

INSERT INTO message_recipients (message_id, user_id, recipient_type) VALUES
  ('63333333-3333-3333-3333-111111111111', 'c3333333-3333-3333-3333-333333333333', 'to')
ON CONFLICT DO NOTHING;

-- Thread 4: Bob -> Alice (meeting notes)
INSERT INTO threads (id, subject, snippet, message_count, last_message_at, created_at) VALUES
  ('d4444444-4444-4444-4444-444444444444', 'Meeting Notes - Sprint Planning', 'Here are the notes from today sprint planning session. Key decisions: 1. Move to microservices', 1, NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day')
ON CONFLICT DO NOTHING;

INSERT INTO messages (id, thread_id, sender_id, body_text, body_html, created_at) VALUES
  ('64444444-4444-4444-4444-111111111111', 'd4444444-4444-4444-4444-444444444444', 'b2222222-2222-2222-2222-222222222222',
   'Here are the notes from today sprint planning session. Key decisions: 1. Move to microservices architecture. 2. Prioritize search feature. 3. Launch date set for March 15.',
   '<p>Here are the notes from today sprint planning session.</p><ul><li>Move to microservices architecture</li><li>Prioritize search feature</li><li>Launch date set for March 15</li></ul>',
   NOW() - INTERVAL '1 day')
ON CONFLICT DO NOTHING;

INSERT INTO message_recipients (message_id, user_id, recipient_type) VALUES
  ('64444444-4444-4444-4444-111111111111', 'a1111111-1111-1111-1111-111111111111', 'to'),
  ('64444444-4444-4444-4444-111111111111', 'c3333333-3333-3333-3333-333333333333', 'cc')
ON CONFLICT DO NOTHING;

-- Thread 5: Charlie -> Bob (deployment)
INSERT INTO threads (id, subject, snippet, message_count, last_message_at, created_at) VALUES
  ('d5555555-5555-5555-5555-555555555555', 'Re: Deployment Schedule', 'The staging deployment is complete. All tests passed. Ready for production push tomorrow morning.', 2, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '8 hours')
ON CONFLICT DO NOTHING;

INSERT INTO messages (id, thread_id, sender_id, body_text, body_html, created_at) VALUES
  ('65555555-5555-5555-5555-111111111111', 'd5555555-5555-5555-5555-555555555555', 'b2222222-2222-2222-2222-222222222222',
   'Charlie, when are we deploying the new release to production? I want to make sure monitoring is set up.',
   '<p>Charlie, when are we deploying the new release to production? I want to make sure monitoring is set up.</p>',
   NOW() - INTERVAL '8 hours'),
  ('65555555-5555-5555-5555-222222222222', 'd5555555-5555-5555-5555-555555555555', 'c3333333-3333-3333-3333-333333333333',
   'The staging deployment is complete. All tests passed. Ready for production push tomorrow morning at 9 AM.',
   '<p>The staging deployment is complete. All tests passed. Ready for production push tomorrow morning at 9 AM.</p>',
   NOW() - INTERVAL '2 hours')
ON CONFLICT DO NOTHING;

INSERT INTO message_recipients (message_id, user_id, recipient_type) VALUES
  ('65555555-5555-5555-5555-111111111111', 'c3333333-3333-3333-3333-333333333333', 'to'),
  ('65555555-5555-5555-5555-222222222222', 'b2222222-2222-2222-2222-222222222222', 'to')
ON CONFLICT DO NOTHING;

-- Thread user states
INSERT INTO thread_user_state (thread_id, user_id, is_read, is_starred) VALUES
  -- Thread 1
  ('d1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', true, false),
  ('d1111111-1111-1111-1111-111111111111', 'b2222222-2222-2222-2222-222222222222', true, false),
  -- Thread 2
  ('d2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-111111111111', false, true),
  ('d2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222222', false, false),
  ('d2222222-2222-2222-2222-222222222222', 'c3333333-3333-3333-3333-333333333333', true, false),
  -- Thread 3
  ('d3333333-3333-3333-3333-333333333333', 'a1111111-1111-1111-1111-111111111111', true, false),
  ('d3333333-3333-3333-3333-333333333333', 'c3333333-3333-3333-3333-333333333333', false, false),
  -- Thread 4
  ('d4444444-4444-4444-4444-444444444444', 'a1111111-1111-1111-1111-111111111111', false, false),
  ('d4444444-4444-4444-4444-444444444444', 'b2222222-2222-2222-2222-222222222222', true, false),
  ('d4444444-4444-4444-4444-444444444444', 'c3333333-3333-3333-3333-333333333333', false, false),
  -- Thread 5
  ('d5555555-5555-5555-5555-555555555555', 'b2222222-2222-2222-2222-222222222222', false, true),
  ('d5555555-5555-5555-5555-555555555555', 'c3333333-3333-3333-3333-333333333333', true, false)
ON CONFLICT DO NOTHING;

-- Thread labels (INBOX for recipients, SENT for senders)
INSERT INTO thread_labels (thread_id, label_id, user_id) VALUES
  -- Thread 1: Bob sent to Alice
  ('d1111111-1111-1111-1111-111111111111', '6c4821fd-d428-48bc-85db-3e435c9a0af9', 'a1111111-1111-1111-1111-111111111111'),
  ('d1111111-1111-1111-1111-111111111111', '9e8a4fe2-998a-4dd8-8b77-26462330111e', 'b2222222-2222-2222-2222-222222222222'),
  ('d1111111-1111-1111-1111-111111111111', '8c9b2064-80c2-4188-88c6-ef65e07585c3', 'a1111111-1111-1111-1111-111111111111'),
  ('d1111111-1111-1111-1111-111111111111', '64316f50-dac6-49be-8bfa-13069a9282c8', 'b2222222-2222-2222-2222-222222222222'),
  -- Thread 2: Charlie sent to Alice and Bob
  ('d2222222-2222-2222-2222-222222222222', '6c4821fd-d428-48bc-85db-3e435c9a0af9', 'a1111111-1111-1111-1111-111111111111'),
  ('d2222222-2222-2222-2222-222222222222', '64316f50-dac6-49be-8bfa-13069a9282c8', 'b2222222-2222-2222-2222-222222222222'),
  ('d2222222-2222-2222-2222-222222222222', '14588cb2-43ca-4f4d-8de1-f95be6592634', 'c3333333-3333-3333-3333-333333333333'),
  ('d2222222-2222-2222-2222-222222222222', '60c94afa-ca95-4fd8-8155-b10ae3eb2243', 'c3333333-3333-3333-3333-333333333333'),
  -- Thread 3: Alice sent to Charlie
  ('d3333333-3333-3333-3333-333333333333', '8c9b2064-80c2-4188-88c6-ef65e07585c3', 'a1111111-1111-1111-1111-111111111111'),
  ('d3333333-3333-3333-3333-333333333333', '60c94afa-ca95-4fd8-8155-b10ae3eb2243', 'c3333333-3333-3333-3333-333333333333'),
  -- Thread 4: Bob sent to Alice (cc Charlie)
  ('d4444444-4444-4444-4444-444444444444', '6c4821fd-d428-48bc-85db-3e435c9a0af9', 'a1111111-1111-1111-1111-111111111111'),
  ('d4444444-4444-4444-4444-444444444444', '9e8a4fe2-998a-4dd8-8b77-26462330111e', 'b2222222-2222-2222-2222-222222222222'),
  ('d4444444-4444-4444-4444-444444444444', '60c94afa-ca95-4fd8-8155-b10ae3eb2243', 'c3333333-3333-3333-3333-333333333333'),
  -- Thread 5: Bob -> Charlie
  ('d5555555-5555-5555-5555-555555555555', '9e8a4fe2-998a-4dd8-8b77-26462330111e', 'b2222222-2222-2222-2222-222222222222'),
  ('d5555555-5555-5555-5555-555555555555', '60c94afa-ca95-4fd8-8155-b10ae3eb2243', 'c3333333-3333-3333-3333-333333333333'),
  ('d5555555-5555-5555-5555-555555555555', '64316f50-dac6-49be-8bfa-13069a9282c8', 'b2222222-2222-2222-2222-222222222222'),
  ('d5555555-5555-5555-5555-555555555555', '14588cb2-43ca-4f4d-8de1-f95be6592634', 'c3333333-3333-3333-3333-333333333333'),
  -- Work label for Alice on thread 1 and 3
  ('d1111111-1111-1111-1111-111111111111', '3d65e891-9212-48e3-887b-b274a984a953', 'a1111111-1111-1111-1111-111111111111'),
  ('d3333333-3333-3333-3333-333333333333', '3d65e891-9212-48e3-887b-b274a984a953', 'a1111111-1111-1111-1111-111111111111')
ON CONFLICT DO NOTHING;

-- Contacts
INSERT INTO contacts (user_id, contact_email, contact_name, frequency, last_contacted_at) VALUES
  ('a1111111-1111-1111-1111-111111111111', 'bob@gmail.local', 'Bob Smith', 5, NOW() - INTERVAL '1 hour'),
  ('a1111111-1111-1111-1111-111111111111', 'charlie@gmail.local', 'Charlie Brown', 3, NOW() - INTERVAL '6 hours'),
  ('b2222222-2222-2222-2222-222222222222', 'alice@gmail.local', 'Alice Johnson', 5, NOW() - INTERVAL '1 hour'),
  ('b2222222-2222-2222-2222-222222222222', 'charlie@gmail.local', 'Charlie Brown', 2, NOW() - INTERVAL '8 hours'),
  ('c3333333-3333-3333-3333-333333333333', 'alice@gmail.local', 'Alice Johnson', 3, NOW() - INTERVAL '5 hours'),
  ('c3333333-3333-3333-3333-333333333333', 'bob@gmail.local', 'Bob Smith', 2, NOW() - INTERVAL '2 hours')
ON CONFLICT DO NOTHING;

-- A draft for Alice
INSERT INTO drafts (id, user_id, subject, body_text, to_recipients, version) VALUES
  ('d1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111',
   'Weekly Status Update',
   'Hi team, here is my weekly update...',
   '["bob@gmail.local", "charlie@gmail.local"]',
   1)
ON CONFLICT DO NOTHING;
