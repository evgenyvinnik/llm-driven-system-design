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
  ('la-inbox', 'a1111111-1111-1111-1111-111111111111', 'INBOX', '#1A73E8', true),
  ('la-sent', 'a1111111-1111-1111-1111-111111111111', 'SENT', '#1A73E8', true),
  ('la-drafts', 'a1111111-1111-1111-1111-111111111111', 'DRAFTS', '#1A73E8', true),
  ('la-trash', 'a1111111-1111-1111-1111-111111111111', 'TRASH', '#666666', true),
  ('la-spam', 'a1111111-1111-1111-1111-111111111111', 'SPAM', '#D93025', true),
  ('la-starred', 'a1111111-1111-1111-1111-111111111111', 'STARRED', '#F4B400', true),
  ('la-allmail', 'a1111111-1111-1111-1111-111111111111', 'ALL_MAIL', '#666666', true),
  ('la-important', 'a1111111-1111-1111-1111-111111111111', 'IMPORTANT', '#F4B400', true)
ON CONFLICT DO NOTHING;

-- System labels for Bob
INSERT INTO labels (id, user_id, name, color, is_system) VALUES
  ('lb-inbox', 'b2222222-2222-2222-2222-222222222222', 'INBOX', '#1A73E8', true),
  ('lb-sent', 'b2222222-2222-2222-2222-222222222222', 'SENT', '#1A73E8', true),
  ('lb-drafts', 'b2222222-2222-2222-2222-222222222222', 'DRAFTS', '#1A73E8', true),
  ('lb-trash', 'b2222222-2222-2222-2222-222222222222', 'TRASH', '#666666', true),
  ('lb-spam', 'b2222222-2222-2222-2222-222222222222', 'SPAM', '#D93025', true),
  ('lb-starred', 'b2222222-2222-2222-2222-222222222222', 'STARRED', '#F4B400', true),
  ('lb-allmail', 'b2222222-2222-2222-2222-222222222222', 'ALL_MAIL', '#666666', true),
  ('lb-important', 'b2222222-2222-2222-2222-222222222222', 'IMPORTANT', '#F4B400', true)
ON CONFLICT DO NOTHING;

-- System labels for Charlie
INSERT INTO labels (id, user_id, name, color, is_system) VALUES
  ('lc-inbox', 'c3333333-3333-3333-3333-333333333333', 'INBOX', '#1A73E8', true),
  ('lc-sent', 'c3333333-3333-3333-3333-333333333333', 'SENT', '#1A73E8', true),
  ('lc-drafts', 'c3333333-3333-3333-3333-333333333333', 'DRAFTS', '#1A73E8', true),
  ('lc-trash', 'c3333333-3333-3333-3333-333333333333', 'TRASH', '#666666', true),
  ('lc-spam', 'c3333333-3333-3333-3333-333333333333', 'SPAM', '#D93025', true),
  ('lc-starred', 'c3333333-3333-3333-3333-333333333333', 'STARRED', '#F4B400', true),
  ('lc-allmail', 'c3333333-3333-3333-3333-333333333333', 'ALL_MAIL', '#666666', true),
  ('lc-important', 'c3333333-3333-3333-3333-333333333333', 'IMPORTANT', '#F4B400', true)
ON CONFLICT DO NOTHING;

-- Custom label for Alice
INSERT INTO labels (id, user_id, name, color, is_system) VALUES
  ('la-work', 'a1111111-1111-1111-1111-111111111111', 'Work', '#4285F4', false),
  ('la-personal', 'a1111111-1111-1111-1111-111111111111', 'Personal', '#34A853', false)
ON CONFLICT DO NOTHING;

-- Thread 1: Bob -> Alice (project update)
INSERT INTO threads (id, subject, snippet, message_count, last_message_at, created_at) VALUES
  ('t1111111-1111-1111-1111-111111111111', 'Project Update - Q4 Report', 'Hey Alice, I just finished the Q4 report. Can you review it when you get a chance?', 2, NOW() - INTERVAL '1 hour', NOW() - INTERVAL '3 hours')
ON CONFLICT DO NOTHING;

INSERT INTO messages (id, thread_id, sender_id, body_text, body_html, created_at) VALUES
  ('m1111111-1111-1111-1111-111111111111', 't1111111-1111-1111-1111-111111111111', 'b2222222-2222-2222-2222-222222222222',
   'Hey Alice, I just finished the Q4 report. Can you review it when you get a chance? I think we have some great numbers this quarter.',
   '<p>Hey Alice,</p><p>I just finished the Q4 report. Can you review it when you get a chance? I think we have some great numbers this quarter.</p>',
   NOW() - INTERVAL '3 hours'),
  ('m1111111-1111-1111-1111-222222222222', 't1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111',
   'Thanks Bob! I will take a look at it this afternoon. The preliminary numbers looked promising.',
   '<p>Thanks Bob! I will take a look at it this afternoon. The preliminary numbers looked promising.</p>',
   NOW() - INTERVAL '1 hour')
ON CONFLICT DO NOTHING;

INSERT INTO message_recipients (message_id, user_id, recipient_type) VALUES
  ('m1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'to'),
  ('m1111111-1111-1111-1111-222222222222', 'b2222222-2222-2222-2222-222222222222', 'to')
ON CONFLICT DO NOTHING;

-- Thread 2: Charlie -> Alice, Bob (team lunch)
INSERT INTO threads (id, subject, snippet, message_count, last_message_at, created_at) VALUES
  ('t2222222-2222-2222-2222-222222222222', 'Team Lunch Tomorrow', 'Hey everyone, want to grab lunch tomorrow at noon? I was thinking of trying that new Italian place.', 3, NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '5 hours')
ON CONFLICT DO NOTHING;

INSERT INTO messages (id, thread_id, sender_id, body_text, body_html, created_at) VALUES
  ('m2222222-2222-2222-2222-111111111111', 't2222222-2222-2222-2222-222222222222', 'c3333333-3333-3333-3333-333333333333',
   'Hey everyone, want to grab lunch tomorrow at noon? I was thinking of trying that new Italian place on Main Street.',
   '<p>Hey everyone,</p><p>Want to grab lunch tomorrow at noon? I was thinking of trying that new Italian place on Main Street.</p>',
   NOW() - INTERVAL '5 hours'),
  ('m2222222-2222-2222-2222-222222222222', 't2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-111111111111',
   'Sounds great! I have been wanting to try that place. Count me in!',
   '<p>Sounds great! I have been wanting to try that place. Count me in!</p>',
   NOW() - INTERVAL '2 hours'),
  ('m2222222-2222-2222-2222-333333333333', 't2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222222',
   'I am in too! Let us meet at the lobby at 11:45.',
   '<p>I am in too! Let us meet at the lobby at 11:45.</p>',
   NOW() - INTERVAL '30 minutes')
ON CONFLICT DO NOTHING;

INSERT INTO message_recipients (message_id, user_id, recipient_type) VALUES
  ('m2222222-2222-2222-2222-111111111111', 'a1111111-1111-1111-1111-111111111111', 'to'),
  ('m2222222-2222-2222-2222-111111111111', 'b2222222-2222-2222-2222-222222222222', 'to'),
  ('m2222222-2222-2222-2222-222222222222', 'c3333333-3333-3333-3333-333333333333', 'to'),
  ('m2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222222', 'cc'),
  ('m2222222-2222-2222-2222-333333333333', 'c3333333-3333-3333-3333-333333333333', 'to'),
  ('m2222222-2222-2222-2222-333333333333', 'a1111111-1111-1111-1111-111111111111', 'cc')
ON CONFLICT DO NOTHING;

-- Thread 3: Alice -> Charlie (code review)
INSERT INTO threads (id, subject, snippet, message_count, last_message_at, created_at) VALUES
  ('t3333333-3333-3333-3333-333333333333', 'Code Review: Authentication Module', 'Hi Charlie, can you review my PR for the auth module? Link: github.com/project/pull/42', 1, NOW() - INTERVAL '6 hours', NOW() - INTERVAL '6 hours')
ON CONFLICT DO NOTHING;

INSERT INTO messages (id, thread_id, sender_id, body_text, body_html, created_at) VALUES
  ('m3333333-3333-3333-3333-111111111111', 't3333333-3333-3333-3333-333333333333', 'a1111111-1111-1111-1111-111111111111',
   'Hi Charlie, can you review my PR for the auth module? Link: github.com/project/pull/42. I added session-based auth with Redis store and rate limiting on login attempts.',
   '<p>Hi Charlie,</p><p>Can you review my PR for the auth module? <a href="github.com/project/pull/42">Link</a>.</p><p>I added session-based auth with Redis store and rate limiting on login attempts.</p>',
   NOW() - INTERVAL '6 hours')
ON CONFLICT DO NOTHING;

INSERT INTO message_recipients (message_id, user_id, recipient_type) VALUES
  ('m3333333-3333-3333-3333-111111111111', 'c3333333-3333-3333-3333-333333333333', 'to')
ON CONFLICT DO NOTHING;

-- Thread 4: Bob -> Alice (meeting notes)
INSERT INTO threads (id, subject, snippet, message_count, last_message_at, created_at) VALUES
  ('t4444444-4444-4444-4444-444444444444', 'Meeting Notes - Sprint Planning', 'Here are the notes from today sprint planning session. Key decisions: 1. Move to microservices', 1, NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day')
ON CONFLICT DO NOTHING;

INSERT INTO messages (id, thread_id, sender_id, body_text, body_html, created_at) VALUES
  ('m4444444-4444-4444-4444-111111111111', 't4444444-4444-4444-4444-444444444444', 'b2222222-2222-2222-2222-222222222222',
   'Here are the notes from today sprint planning session. Key decisions: 1. Move to microservices architecture. 2. Prioritize search feature. 3. Launch date set for March 15.',
   '<p>Here are the notes from today sprint planning session.</p><ul><li>Move to microservices architecture</li><li>Prioritize search feature</li><li>Launch date set for March 15</li></ul>',
   NOW() - INTERVAL '1 day')
ON CONFLICT DO NOTHING;

INSERT INTO message_recipients (message_id, user_id, recipient_type) VALUES
  ('m4444444-4444-4444-4444-111111111111', 'a1111111-1111-1111-1111-111111111111', 'to'),
  ('m4444444-4444-4444-4444-111111111111', 'c3333333-3333-3333-3333-333333333333', 'cc')
ON CONFLICT DO NOTHING;

-- Thread 5: Charlie -> Bob (deployment)
INSERT INTO threads (id, subject, snippet, message_count, last_message_at, created_at) VALUES
  ('t5555555-5555-5555-5555-555555555555', 'Re: Deployment Schedule', 'The staging deployment is complete. All tests passed. Ready for production push tomorrow morning.', 2, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '8 hours')
ON CONFLICT DO NOTHING;

INSERT INTO messages (id, thread_id, sender_id, body_text, body_html, created_at) VALUES
  ('m5555555-5555-5555-5555-111111111111', 't5555555-5555-5555-5555-555555555555', 'b2222222-2222-2222-2222-222222222222',
   'Charlie, when are we deploying the new release to production? I want to make sure monitoring is set up.',
   '<p>Charlie, when are we deploying the new release to production? I want to make sure monitoring is set up.</p>',
   NOW() - INTERVAL '8 hours'),
  ('m5555555-5555-5555-5555-222222222222', 't5555555-5555-5555-5555-555555555555', 'c3333333-3333-3333-3333-333333333333',
   'The staging deployment is complete. All tests passed. Ready for production push tomorrow morning at 9 AM.',
   '<p>The staging deployment is complete. All tests passed. Ready for production push tomorrow morning at 9 AM.</p>',
   NOW() - INTERVAL '2 hours')
ON CONFLICT DO NOTHING;

INSERT INTO message_recipients (message_id, user_id, recipient_type) VALUES
  ('m5555555-5555-5555-5555-111111111111', 'c3333333-3333-3333-3333-333333333333', 'to'),
  ('m5555555-5555-5555-5555-222222222222', 'b2222222-2222-2222-2222-222222222222', 'to')
ON CONFLICT DO NOTHING;

-- Thread user states
INSERT INTO thread_user_state (thread_id, user_id, is_read, is_starred) VALUES
  -- Thread 1
  ('t1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', true, false),
  ('t1111111-1111-1111-1111-111111111111', 'b2222222-2222-2222-2222-222222222222', true, false),
  -- Thread 2
  ('t2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-111111111111', false, true),
  ('t2222222-2222-2222-2222-222222222222', 'b2222222-2222-2222-2222-222222222222', false, false),
  ('t2222222-2222-2222-2222-222222222222', 'c3333333-3333-3333-3333-333333333333', true, false),
  -- Thread 3
  ('t3333333-3333-3333-3333-333333333333', 'a1111111-1111-1111-1111-111111111111', true, false),
  ('t3333333-3333-3333-3333-333333333333', 'c3333333-3333-3333-3333-333333333333', false, false),
  -- Thread 4
  ('t4444444-4444-4444-4444-444444444444', 'a1111111-1111-1111-1111-111111111111', false, false),
  ('t4444444-4444-4444-4444-444444444444', 'b2222222-2222-2222-2222-222222222222', true, false),
  ('t4444444-4444-4444-4444-444444444444', 'c3333333-3333-3333-3333-333333333333', false, false),
  -- Thread 5
  ('t5555555-5555-5555-5555-555555555555', 'b2222222-2222-2222-2222-222222222222', false, true),
  ('t5555555-5555-5555-5555-555555555555', 'c3333333-3333-3333-3333-333333333333', true, false)
ON CONFLICT DO NOTHING;

-- Thread labels (INBOX for recipients, SENT for senders)
INSERT INTO thread_labels (thread_id, label_id, user_id) VALUES
  -- Thread 1: Bob sent to Alice
  ('t1111111-1111-1111-1111-111111111111', 'la-inbox', 'a1111111-1111-1111-1111-111111111111'),
  ('t1111111-1111-1111-1111-111111111111', 'lb-sent', 'b2222222-2222-2222-2222-222222222222'),
  ('t1111111-1111-1111-1111-111111111111', 'la-sent', 'a1111111-1111-1111-1111-111111111111'),
  ('t1111111-1111-1111-1111-111111111111', 'lb-inbox', 'b2222222-2222-2222-2222-222222222222'),
  -- Thread 2: Charlie sent to Alice and Bob
  ('t2222222-2222-2222-2222-222222222222', 'la-inbox', 'a1111111-1111-1111-1111-111111111111'),
  ('t2222222-2222-2222-2222-222222222222', 'lb-inbox', 'b2222222-2222-2222-2222-222222222222'),
  ('t2222222-2222-2222-2222-222222222222', 'lc-sent', 'c3333333-3333-3333-3333-333333333333'),
  ('t2222222-2222-2222-2222-222222222222', 'lc-inbox', 'c3333333-3333-3333-3333-333333333333'),
  -- Thread 3: Alice sent to Charlie
  ('t3333333-3333-3333-3333-333333333333', 'la-sent', 'a1111111-1111-1111-1111-111111111111'),
  ('t3333333-3333-3333-3333-333333333333', 'lc-inbox', 'c3333333-3333-3333-3333-333333333333'),
  -- Thread 4: Bob sent to Alice (cc Charlie)
  ('t4444444-4444-4444-4444-444444444444', 'la-inbox', 'a1111111-1111-1111-1111-111111111111'),
  ('t4444444-4444-4444-4444-444444444444', 'lb-sent', 'b2222222-2222-2222-2222-222222222222'),
  ('t4444444-4444-4444-4444-444444444444', 'lc-inbox', 'c3333333-3333-3333-3333-333333333333'),
  -- Thread 5: Bob -> Charlie
  ('t5555555-5555-5555-5555-555555555555', 'lb-sent', 'b2222222-2222-2222-2222-222222222222'),
  ('t5555555-5555-5555-5555-555555555555', 'lc-inbox', 'c3333333-3333-3333-3333-333333333333'),
  ('t5555555-5555-5555-5555-555555555555', 'lb-inbox', 'b2222222-2222-2222-2222-222222222222'),
  ('t5555555-5555-5555-5555-555555555555', 'lc-sent', 'c3333333-3333-3333-3333-333333333333'),
  -- Work label for Alice on thread 1 and 3
  ('t1111111-1111-1111-1111-111111111111', 'la-work', 'a1111111-1111-1111-1111-111111111111'),
  ('t3333333-3333-3333-3333-333333333333', 'la-work', 'a1111111-1111-1111-1111-111111111111')
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
