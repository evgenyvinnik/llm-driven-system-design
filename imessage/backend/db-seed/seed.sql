-- =============================================================================
-- iMessage Seed Data
-- =============================================================================
-- Populates the database with realistic sample data for local development.
-- All passwords are 'password123' (bcrypt hash below).
-- All inserts use ON CONFLICT DO NOTHING for idempotent re-runs.
-- =============================================================================

-- =============================================================================
-- USERS
-- =============================================================================

INSERT INTO users (id, username, email, password_hash, display_name, avatar_url, status, role)
VALUES
  ('a0000000-0000-0000-0000-000000000001', 'alice', 'alice@example.com',
   '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom',
   'Alice Johnson', NULL, 'online', 'user'),

  ('a0000000-0000-0000-0000-000000000002', 'bob', 'bob@example.com',
   '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom',
   'Bob Smith', NULL, 'online', 'user'),

  ('a0000000-0000-0000-0000-000000000003', 'charlie', 'charlie@example.com',
   '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom',
   'Charlie Davis', NULL, 'offline', 'user'),

  ('a0000000-0000-0000-0000-000000000004', 'admin', 'admin@example.com',
   '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom',
   'System Admin', NULL, 'offline', 'system_admin')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- DEVICES (multi-device per user)
-- =============================================================================

INSERT INTO devices (id, user_id, device_name, device_type, push_token, is_active)
VALUES
  -- Alice: iPhone + MacBook
  ('d0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
   'Alice''s iPhone', 'iphone', 'apns-token-alice-iphone', true),
  ('d0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001',
   'Alice''s MacBook', 'mac', 'apns-token-alice-mac', true),

  -- Bob: iPhone + iPad
  ('d0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000002',
   'Bob''s iPhone', 'iphone', 'apns-token-bob-iphone', true),
  ('d0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000002',
   'Bob''s iPad', 'ipad', 'apns-token-bob-ipad', true),

  -- Charlie: iPhone only
  ('d0000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000003',
   'Charlie''s iPhone', 'iphone', 'apns-token-charlie-iphone', true),

  -- Admin: Web
  ('d0000000-0000-0000-0000-000000000006', 'a0000000-0000-0000-0000-000000000004',
   'Admin Web', 'web', NULL, true)
ON CONFLICT DO NOTHING;

-- =============================================================================
-- DEVICE KEYS (E2E encryption keys)
-- =============================================================================

INSERT INTO device_keys (device_id, identity_public_key, signing_public_key)
VALUES
  ('d0000000-0000-0000-0000-000000000001',
   'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-alice-iphone-identity-key-placeholder',
   'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-alice-iphone-signing-key-placeholder'),
  ('d0000000-0000-0000-0000-000000000002',
   'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-alice-mac-identity-key-placeholder',
   'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-alice-mac-signing-key-placeholder'),
  ('d0000000-0000-0000-0000-000000000003',
   'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-bob-iphone-identity-key-placeholder',
   'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-bob-iphone-signing-key-placeholder'),
  ('d0000000-0000-0000-0000-000000000004',
   'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-bob-ipad-identity-key-placeholder',
   'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-bob-ipad-signing-key-placeholder'),
  ('d0000000-0000-0000-0000-000000000005',
   'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-charlie-iphone-identity-key-placeholder',
   'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE-charlie-iphone-signing-key-placeholder')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- PREKEYS (one-time keys for forward secrecy)
-- =============================================================================

INSERT INTO prekeys (device_id, prekey_id, public_key, used)
VALUES
  -- Alice's iPhone: 5 prekeys
  ('d0000000-0000-0000-0000-000000000001', 1, 'prekey-alice-iphone-001', false),
  ('d0000000-0000-0000-0000-000000000001', 2, 'prekey-alice-iphone-002', false),
  ('d0000000-0000-0000-0000-000000000001', 3, 'prekey-alice-iphone-003', false),
  ('d0000000-0000-0000-0000-000000000001', 4, 'prekey-alice-iphone-004', true),
  ('d0000000-0000-0000-0000-000000000001', 5, 'prekey-alice-iphone-005', true),

  -- Alice's MacBook: 3 prekeys
  ('d0000000-0000-0000-0000-000000000002', 1, 'prekey-alice-mac-001', false),
  ('d0000000-0000-0000-0000-000000000002', 2, 'prekey-alice-mac-002', false),
  ('d0000000-0000-0000-0000-000000000002', 3, 'prekey-alice-mac-003', false),

  -- Bob's iPhone: 3 prekeys
  ('d0000000-0000-0000-0000-000000000003', 1, 'prekey-bob-iphone-001', false),
  ('d0000000-0000-0000-0000-000000000003', 2, 'prekey-bob-iphone-002', false),
  ('d0000000-0000-0000-0000-000000000003', 3, 'prekey-bob-iphone-003', false),

  -- Bob's iPad: 3 prekeys
  ('d0000000-0000-0000-0000-000000000004', 1, 'prekey-bob-ipad-001', false),
  ('d0000000-0000-0000-0000-000000000004', 2, 'prekey-bob-ipad-002', false),
  ('d0000000-0000-0000-0000-000000000004', 3, 'prekey-bob-ipad-003', false),

  -- Charlie's iPhone: 3 prekeys
  ('d0000000-0000-0000-0000-000000000005', 1, 'prekey-charlie-iphone-001', false),
  ('d0000000-0000-0000-0000-000000000005', 2, 'prekey-charlie-iphone-002', false),
  ('d0000000-0000-0000-0000-000000000005', 3, 'prekey-charlie-iphone-003', false)
ON CONFLICT DO NOTHING;

-- =============================================================================
-- CONVERSATIONS
-- =============================================================================

-- Direct message: Alice <-> Bob
INSERT INTO conversations (id, type, name, created_by)
VALUES
  ('c0000000-0000-0000-0000-000000000001', 'direct', NULL,
   'a0000000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- Direct message: Alice <-> Charlie
INSERT INTO conversations (id, type, name, created_by)
VALUES
  ('c0000000-0000-0000-0000-000000000002', 'direct', NULL,
   'a0000000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- Group chat: Alice, Bob, Charlie
INSERT INTO conversations (id, type, name, created_by)
VALUES
  ('c0000000-0000-0000-0000-000000000003', 'group', 'Weekend Plans',
   'a0000000-0000-0000-0000-000000000001')
ON CONFLICT DO NOTHING;

-- Another group: Bob, Charlie
INSERT INTO conversations (id, type, name, created_by)
VALUES
  ('c0000000-0000-0000-0000-000000000004', 'group', 'Project Alpha',
   'a0000000-0000-0000-0000-000000000002')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- CONVERSATION PARTICIPANTS
-- =============================================================================

INSERT INTO conversation_participants (conversation_id, user_id, role)
VALUES
  -- Alice <-> Bob (direct)
  ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'member'),
  ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002', 'member'),

  -- Alice <-> Charlie (direct)
  ('c0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'member'),
  ('c0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000003', 'member'),

  -- Weekend Plans group (Alice admin, Bob + Charlie members)
  ('c0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'admin'),
  ('c0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000002', 'member'),
  ('c0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000003', 'member'),

  -- Project Alpha group (Bob admin, Charlie member)
  ('c0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000002', 'admin'),
  ('c0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000003', 'member')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- MESSAGES
-- =============================================================================

-- Conversation 1: Alice <-> Bob (direct messages)
INSERT INTO messages (id, conversation_id, sender_id, content, content_type, created_at)
VALUES
  ('60000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
   'Hey Bob! How are you?', 'text', NOW() - INTERVAL '2 hours'),

  ('60000000-0000-0000-0000-000000000002',
   'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002',
   'Hi Alice! I''m doing great, thanks for asking. What''s up?', 'text', NOW() - INTERVAL '1 hour 55 minutes'),

  ('60000000-0000-0000-0000-000000000003',
   'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
   'Just wanted to check if you''re free this weekend for the hiking trip.', 'text', NOW() - INTERVAL '1 hour 50 minutes'),

  ('60000000-0000-0000-0000-000000000004',
   'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002',
   'Absolutely! I''ve been looking forward to it. What time should we meet?', 'text', NOW() - INTERVAL '1 hour 45 minutes'),

  ('60000000-0000-0000-0000-000000000005',
   'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001',
   'Let''s do 8 AM at the trailhead. I''ll send the coordinates later.', 'text', NOW() - INTERVAL '1 hour 40 minutes')
ON CONFLICT DO NOTHING;

-- Conversation 2: Alice <-> Charlie (direct messages)
INSERT INTO messages (id, conversation_id, sender_id, content, content_type, created_at)
VALUES
  ('60000000-0000-0000-0000-000000000006',
   'c0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000003',
   'Alice, did you see the new design mockups?', 'text', NOW() - INTERVAL '3 hours'),

  ('60000000-0000-0000-0000-000000000007',
   'c0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001',
   'Yes! They look amazing. I especially love the new color scheme.', 'text', NOW() - INTERVAL '2 hours 50 minutes'),

  ('60000000-0000-0000-0000-000000000008',
   'c0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000003',
   'Great, I''ll finalize them and share with the team tomorrow.', 'text', NOW() - INTERVAL '2 hours 45 minutes')
ON CONFLICT DO NOTHING;

-- Conversation 3: Weekend Plans group
INSERT INTO messages (id, conversation_id, sender_id, content, content_type, created_at)
VALUES
  ('60000000-0000-0000-0000-000000000009',
   'c0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001',
   'Hey everyone! Planning a weekend hike. Who''s in?', 'text', NOW() - INTERVAL '5 hours'),

  ('60000000-0000-0000-0000-000000000010',
   'c0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000002',
   'Count me in! Where are we going?', 'text', NOW() - INTERVAL '4 hours 50 minutes'),

  ('60000000-0000-0000-0000-000000000011',
   'c0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000003',
   'I''m interested! Let me check my schedule.', 'text', NOW() - INTERVAL '4 hours 30 minutes'),

  ('60000000-0000-0000-0000-000000000012',
   'c0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001',
   'Thinking about Eagle Peak trail. It''s about 8 miles round trip.', 'text', NOW() - INTERVAL '4 hours'),

  ('60000000-0000-0000-0000-000000000013',
   'c0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000002',
   'Perfect difficulty level. What should we bring?', 'text', NOW() - INTERVAL '3 hours 45 minutes'),

  ('60000000-0000-0000-0000-000000000014',
   'c0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000003',
   'I confirmed, I''m free Saturday! I''ll bring snacks and water.', 'text', NOW() - INTERVAL '3 hours 30 minutes'),

  ('60000000-0000-0000-0000-000000000015',
   'c0000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001',
   'Awesome! Bring sunscreen and comfortable shoes. Meet at 8 AM.', 'text', NOW() - INTERVAL '3 hours')
ON CONFLICT DO NOTHING;

-- Conversation 4: Project Alpha group
INSERT INTO messages (id, conversation_id, sender_id, content, content_type, created_at)
VALUES
  ('60000000-0000-0000-0000-000000000016',
   'c0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000002',
   'Charlie, we need to finalize the API spec by Friday.', 'text', NOW() - INTERVAL '6 hours'),

  ('60000000-0000-0000-0000-000000000017',
   'c0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000003',
   'Got it. I''ll have a draft ready by Wednesday for review.', 'text', NOW() - INTERVAL '5 hours 45 minutes'),

  ('60000000-0000-0000-0000-000000000018',
   'c0000000-0000-0000-0000-000000000004', 'a0000000-0000-0000-0000-000000000002',
   'Sounds good. Let''s sync up Thursday to go over any changes.', 'text', NOW() - INTERVAL '5 hours 30 minutes')
ON CONFLICT DO NOTHING;

-- A reply message (thread support)
INSERT INTO messages (id, conversation_id, sender_id, content, content_type, reply_to_id, created_at)
VALUES
  ('60000000-0000-0000-0000-000000000019',
   'c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002',
   'Sounds perfect! I''ll set my alarm.', 'text',
   '60000000-0000-0000-0000-000000000005', NOW() - INTERVAL '1 hour 30 minutes')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- REACTIONS (tapbacks)
-- =============================================================================

INSERT INTO reactions (id, message_id, user_id, reaction, created_at)
VALUES
  ('b0000000-0000-0000-0000-000000000001',
   '60000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002',
   'love', NOW() - INTERVAL '1 hour 54 minutes'),

  ('b0000000-0000-0000-0000-000000000002',
   '60000000-0000-0000-0000-000000000005', 'a0000000-0000-0000-0000-000000000002',
   'thumbs_up', NOW() - INTERVAL '1 hour 39 minutes'),

  ('b0000000-0000-0000-0000-000000000003',
   '60000000-0000-0000-0000-000000000009', 'a0000000-0000-0000-0000-000000000002',
   'love', NOW() - INTERVAL '4 hours 49 minutes'),

  ('b0000000-0000-0000-0000-000000000004',
   '60000000-0000-0000-0000-000000000009', 'a0000000-0000-0000-0000-000000000003',
   'thumbs_up', NOW() - INTERVAL '4 hours 29 minutes'),

  ('b0000000-0000-0000-0000-000000000005',
   '60000000-0000-0000-0000-000000000014', 'a0000000-0000-0000-0000-000000000001',
   'ha_ha', NOW() - INTERVAL '3 hours 29 minutes'),

  ('b0000000-0000-0000-0000-000000000006',
   '60000000-0000-0000-0000-000000000015', 'a0000000-0000-0000-0000-000000000003',
   'love', NOW() - INTERVAL '2 hours 59 minutes')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- READ RECEIPTS
-- =============================================================================

-- Alice's iPhone has read all messages in conversation with Bob
INSERT INTO read_receipts (user_id, device_id, conversation_id, last_read_message_id, last_read_at)
VALUES
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000019',
   NOW() - INTERVAL '1 hour 25 minutes'),

  -- Alice's MacBook has read up to message 4 in the Bob conversation
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000002',
   'c0000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000004',
   NOW() - INTERVAL '1 hour 44 minutes'),

  -- Bob's iPhone has read all messages in conversation with Alice
  ('a0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000003',
   'c0000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000019',
   NOW() - INTERVAL '1 hour 29 minutes'),

  -- Alice has read all messages in the Charlie DM
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000008',
   NOW() - INTERVAL '2 hours 40 minutes'),

  -- Alice has read all group messages in Weekend Plans
  ('a0000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-000000000003', '60000000-0000-0000-0000-000000000015',
   NOW() - INTERVAL '2 hours 55 minutes'),

  -- Bob has read all group messages in Weekend Plans
  ('a0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000003',
   'c0000000-0000-0000-0000-000000000003', '60000000-0000-0000-0000-000000000015',
   NOW() - INTERVAL '2 hours 58 minutes')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- DELIVERY RECEIPTS
-- =============================================================================

-- All devices have received the latest messages
INSERT INTO delivery_receipts (message_id, device_id, delivered_at)
VALUES
  -- Message 1 delivered to Bob's devices
  ('60000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000003',
   NOW() - INTERVAL '1 hour 59 minutes'),
  ('60000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000004',
   NOW() - INTERVAL '1 hour 58 minutes'),

  -- Message 2 delivered to Alice's devices
  ('60000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001',
   NOW() - INTERVAL '1 hour 54 minutes'),
  ('60000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000002',
   NOW() - INTERVAL '1 hour 53 minutes'),

  -- Group message 9 delivered to Bob's and Charlie's devices
  ('60000000-0000-0000-0000-000000000009', 'd0000000-0000-0000-0000-000000000003',
   NOW() - INTERVAL '4 hours 59 minutes'),
  ('60000000-0000-0000-0000-000000000009', 'd0000000-0000-0000-0000-000000000005',
   NOW() - INTERVAL '4 hours 58 minutes')
ON CONFLICT DO NOTHING;

-- =============================================================================
-- SYNC CURSORS (device sync progress)
-- =============================================================================

INSERT INTO sync_cursors (device_id, conversation_id, last_synced_message_id, last_synced_at)
VALUES
  -- Alice's iPhone is fully synced on all conversations
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001',
   '60000000-0000-0000-0000-000000000019', NOW() - INTERVAL '1 hour'),
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000002',
   '60000000-0000-0000-0000-000000000008', NOW() - INTERVAL '2 hours'),
  ('d0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000003',
   '60000000-0000-0000-0000-000000000015', NOW() - INTERVAL '2 hours 50 minutes'),

  -- Alice's MacBook is behind on conversation 1 (hasn't synced reply)
  ('d0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001',
   '60000000-0000-0000-0000-000000000004', NOW() - INTERVAL '1 hour 45 minutes'),

  -- Bob's iPhone is fully synced
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000001',
   '60000000-0000-0000-0000-000000000019', NOW() - INTERVAL '1 hour'),
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000003',
   '60000000-0000-0000-0000-000000000015', NOW() - INTERVAL '2 hours 50 minutes'),
  ('d0000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000004',
   '60000000-0000-0000-0000-000000000018', NOW() - INTERVAL '5 hours'),

  -- Charlie's iPhone
  ('d0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000002',
   '60000000-0000-0000-0000-000000000008', NOW() - INTERVAL '2 hours 40 minutes'),
  ('d0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000003',
   '60000000-0000-0000-0000-000000000015', NOW() - INTERVAL '2 hours 55 minutes'),
  ('d0000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000004',
   '60000000-0000-0000-0000-000000000018', NOW() - INTERVAL '5 hours 25 minutes')
ON CONFLICT DO NOTHING;
