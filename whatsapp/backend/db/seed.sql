-- WhatsApp Clone Seed Data
-- Password for all users: password123
-- bcrypt hash: $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- ============================================================================
-- USERS
-- ============================================================================
INSERT INTO users (id, username, display_name, password_hash, profile_picture_url) VALUES
    ('11111111-1111-1111-1111-111111111111', 'alice', 'Alice Smith', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=200'),
    ('22222222-2222-2222-2222-222222222222', 'bob', 'Bob Johnson', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200'),
    ('33333333-3333-3333-3333-333333333333', 'charlie', 'Charlie Brown', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=200'),
    ('44444444-4444-4444-4444-444444444444', 'diana', 'Diana Ross', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=200'),
    ('55555555-5555-5555-5555-555555555555', 'eve', 'Eve Williams', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=200'),
    ('66666666-6666-6666-6666-666666666666', 'frank', 'Frank Miller', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=200')
ON CONFLICT (username) DO NOTHING;

-- ============================================================================
-- CONVERSATIONS
-- ============================================================================

-- 1:1 conversation between Alice and Bob
INSERT INTO conversations (id, name, is_group, created_by) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', NULL, FALSE, '11111111-1111-1111-1111-111111111111')
ON CONFLICT (id) DO NOTHING;

-- 1:1 conversation between Alice and Charlie
INSERT INTO conversations (id, name, is_group, created_by) VALUES
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NULL, FALSE, '11111111-1111-1111-1111-111111111111')
ON CONFLICT (id) DO NOTHING;

-- Group chat: Project Team
INSERT INTO conversations (id, name, is_group, created_by) VALUES
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Project Team', TRUE, '11111111-1111-1111-1111-111111111111')
ON CONFLICT (id) DO NOTHING;

-- Group chat: Weekend Plans
INSERT INTO conversations (id, name, is_group, created_by) VALUES
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Weekend Plans', TRUE, '22222222-2222-2222-2222-222222222222')
ON CONFLICT (id) DO NOTHING;

-- 1:1 conversation between Bob and Diana
INSERT INTO conversations (id, name, is_group, created_by) VALUES
    ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', NULL, FALSE, '22222222-2222-2222-2222-222222222222')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- CONVERSATION PARTICIPANTS
-- ============================================================================

-- Alice and Bob conversation
INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'member'),
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'member')
ON CONFLICT (conversation_id, user_id) DO NOTHING;

-- Alice and Charlie conversation
INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 'member'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '33333333-3333-3333-3333-333333333333', 'member')
ON CONFLICT (conversation_id, user_id) DO NOTHING;

-- Project Team group (Alice admin, Bob, Charlie, Diana members)
INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'admin'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', '22222222-2222-2222-2222-222222222222', 'member'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', '33333333-3333-3333-3333-333333333333', 'member'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', '44444444-4444-4444-4444-444444444444', 'member')
ON CONFLICT (conversation_id, user_id) DO NOTHING;

-- Weekend Plans group (Bob admin, Alice, Eve, Frank members)
INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', '22222222-2222-2222-2222-222222222222', 'admin'),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', '11111111-1111-1111-1111-111111111111', 'member'),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', '55555555-5555-5555-5555-555555555555', 'member'),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', '66666666-6666-6666-6666-666666666666', 'member')
ON CONFLICT (conversation_id, user_id) DO NOTHING;

-- Bob and Diana conversation
INSERT INTO conversation_participants (conversation_id, user_id, role) VALUES
    ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '22222222-2222-2222-2222-222222222222', 'member'),
    ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '44444444-4444-4444-4444-444444444444', 'member')
ON CONFLICT (conversation_id, user_id) DO NOTHING;

-- ============================================================================
-- MESSAGES
-- ============================================================================

-- Messages between Alice and Bob
INSERT INTO messages (id, conversation_id, sender_id, content, content_type, created_at) VALUES
    ('a0000001-0000-0000-0000-000000000001', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Hey Bob! How are you doing?', 'text', NOW() - INTERVAL '2 hours'),
    ('a0000001-0000-0000-0000-000000000002', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'Hi Alice! I am doing great, thanks for asking. How about you?', 'text', NOW() - INTERVAL '1 hour 55 minutes'),
    ('a0000001-0000-0000-0000-000000000003', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Pretty good! Just working on the project. Want to catch up later?', 'text', NOW() - INTERVAL '1 hour 50 minutes'),
    ('a0000001-0000-0000-0000-000000000004', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'Sure! Coffee at 3pm?', 'text', NOW() - INTERVAL '1 hour 45 minutes'),
    ('a0000001-0000-0000-0000-000000000005', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Perfect! See you then', 'text', NOW() - INTERVAL '1 hour 40 minutes')
ON CONFLICT (id) DO NOTHING;

-- Messages between Alice and Charlie
INSERT INTO messages (id, conversation_id, sender_id, content, content_type, created_at) VALUES
    ('b0000001-0000-0000-0000-000000000001', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '33333333-3333-3333-3333-333333333333', 'Alice, did you see the game last night?', 'text', NOW() - INTERVAL '1 day'),
    ('b0000001-0000-0000-0000-000000000002', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 'Yes! What an amazing finish!', 'text', NOW() - INTERVAL '23 hours'),
    ('b0000001-0000-0000-0000-000000000003', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '33333333-3333-3333-3333-333333333333', 'I know right! That last-minute goal was incredible', 'text', NOW() - INTERVAL '22 hours')
ON CONFLICT (id) DO NOTHING;

-- Messages in Project Team group
INSERT INTO messages (id, conversation_id, sender_id, content, content_type, created_at) VALUES
    ('c0000001-0000-0000-0000-000000000001', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'Hey team! Welcome to the project channel', 'text', NOW() - INTERVAL '3 days'),
    ('c0000001-0000-0000-0000-000000000002', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '22222222-2222-2222-2222-222222222222', 'Thanks Alice! Looking forward to working together', 'text', NOW() - INTERVAL '3 days' + INTERVAL '5 minutes'),
    ('c0000001-0000-0000-0000-000000000003', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '33333333-3333-3333-3333-333333333333', 'Same here! When is our first meeting?', 'text', NOW() - INTERVAL '3 days' + INTERVAL '10 minutes'),
    ('c0000001-0000-0000-0000-000000000004', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '44444444-4444-4444-4444-444444444444', 'Hi everyone!', 'text', NOW() - INTERVAL '3 days' + INTERVAL '15 minutes'),
    ('c0000001-0000-0000-0000-000000000005', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'Let us schedule a kickoff meeting for tomorrow at 10am', 'text', NOW() - INTERVAL '2 days'),
    ('c0000001-0000-0000-0000-000000000006', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '22222222-2222-2222-2222-222222222222', 'Works for me!', 'text', NOW() - INTERVAL '2 days' + INTERVAL '30 minutes'),
    ('c0000001-0000-0000-0000-000000000007', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '33333333-3333-3333-3333-333333333333', 'I will be there', 'text', NOW() - INTERVAL '2 days' + INTERVAL '45 minutes'),
    ('c0000001-0000-0000-0000-000000000008', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '44444444-4444-4444-4444-444444444444', 'Count me in!', 'text', NOW() - INTERVAL '2 days' + INTERVAL '1 hour')
ON CONFLICT (id) DO NOTHING;

-- Messages in Weekend Plans group
INSERT INTO messages (id, conversation_id, sender_id, content, content_type, created_at) VALUES
    ('d0000001-0000-0000-0000-000000000001', 'dddddddd-dddd-dddd-dddd-dddddddddddd', '22222222-2222-2222-2222-222222222222', 'Anyone up for hiking this weekend?', 'text', NOW() - INTERVAL '5 hours'),
    ('d0000001-0000-0000-0000-000000000002', 'dddddddd-dddd-dddd-dddd-dddddddddddd', '11111111-1111-1111-1111-111111111111', 'I am in! Which trail are you thinking?', 'text', NOW() - INTERVAL '4 hours 30 minutes'),
    ('d0000001-0000-0000-0000-000000000003', 'dddddddd-dddd-dddd-dddd-dddddddddddd', '55555555-5555-5555-5555-555555555555', 'Count me in too! How about the mountain trail?', 'text', NOW() - INTERVAL '4 hours'),
    ('d0000001-0000-0000-0000-000000000004', 'dddddddd-dddd-dddd-dddd-dddddddddddd', '66666666-6666-6666-6666-666666666666', 'That sounds great! What time should we meet?', 'text', NOW() - INTERVAL '3 hours 30 minutes'),
    ('d0000001-0000-0000-0000-000000000005', 'dddddddd-dddd-dddd-dddd-dddddddddddd', '22222222-2222-2222-2222-222222222222', 'How about 8am at the trailhead?', 'text', NOW() - INTERVAL '3 hours'),
    ('d0000001-0000-0000-0000-000000000006', 'dddddddd-dddd-dddd-dddd-dddddddddddd', '11111111-1111-1111-1111-111111111111', 'Perfect!', 'text', NOW() - INTERVAL '2 hours 30 minutes')
ON CONFLICT (id) DO NOTHING;

-- Messages between Bob and Diana
INSERT INTO messages (id, conversation_id, sender_id, content, content_type, created_at) VALUES
    ('e0000001-0000-0000-0000-000000000001', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '22222222-2222-2222-2222-222222222222', 'Diana, do you have the report ready?', 'text', NOW() - INTERVAL '6 hours'),
    ('e0000001-0000-0000-0000-000000000002', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '44444444-4444-4444-4444-444444444444', 'Almost done! I will send it by end of day', 'text', NOW() - INTERVAL '5 hours 45 minutes'),
    ('e0000001-0000-0000-0000-000000000003', 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '22222222-2222-2222-2222-222222222222', 'Great, thanks!', 'text', NOW() - INTERVAL '5 hours 30 minutes')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- MESSAGE STATUS
-- ============================================================================

-- Status for Alice-Bob conversation messages
INSERT INTO message_status (message_id, recipient_id, status, delivered_at, read_at) VALUES
    ('a0000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'read', NOW() - INTERVAL '1 hour 58 minutes', NOW() - INTERVAL '1 hour 56 minutes'),
    ('a0000001-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'read', NOW() - INTERVAL '1 hour 53 minutes', NOW() - INTERVAL '1 hour 51 minutes'),
    ('a0000001-0000-0000-0000-000000000003', '22222222-2222-2222-2222-222222222222', 'read', NOW() - INTERVAL '1 hour 48 minutes', NOW() - INTERVAL '1 hour 46 minutes'),
    ('a0000001-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'read', NOW() - INTERVAL '1 hour 43 minutes', NOW() - INTERVAL '1 hour 41 minutes'),
    ('a0000001-0000-0000-0000-000000000005', '22222222-2222-2222-2222-222222222222', 'read', NOW() - INTERVAL '1 hour 38 minutes', NOW() - INTERVAL '1 hour 35 minutes')
ON CONFLICT (message_id, recipient_id) DO NOTHING;

-- Status for Alice-Charlie conversation messages
INSERT INTO message_status (message_id, recipient_id, status, delivered_at, read_at) VALUES
    ('b0000001-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'read', NOW() - INTERVAL '23 hours 30 minutes', NOW() - INTERVAL '23 hours 15 minutes'),
    ('b0000001-0000-0000-0000-000000000002', '33333333-3333-3333-3333-333333333333', 'read', NOW() - INTERVAL '22 hours 30 minutes', NOW() - INTERVAL '22 hours 15 minutes'),
    ('b0000001-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'delivered', NOW() - INTERVAL '21 hours 45 minutes', NULL)
ON CONFLICT (message_id, recipient_id) DO NOTHING;

-- Status for group messages in Project Team (message to all participants except sender)
INSERT INTO message_status (message_id, recipient_id, status, delivered_at, read_at) VALUES
    -- First message from Alice to Bob, Charlie, Diana
    ('c0000001-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222', 'read', NOW() - INTERVAL '3 days' + INTERVAL '1 minute', NOW() - INTERVAL '3 days' + INTERVAL '3 minutes'),
    ('c0000001-0000-0000-0000-000000000001', '33333333-3333-3333-3333-333333333333', 'read', NOW() - INTERVAL '3 days' + INTERVAL '2 minutes', NOW() - INTERVAL '3 days' + INTERVAL '8 minutes'),
    ('c0000001-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444444', 'read', NOW() - INTERVAL '3 days' + INTERVAL '3 minutes', NOW() - INTERVAL '3 days' + INTERVAL '12 minutes')
ON CONFLICT (message_id, recipient_id) DO NOTHING;

-- Status for Weekend Plans latest messages
INSERT INTO message_status (message_id, recipient_id, status, delivered_at, read_at) VALUES
    ('d0000001-0000-0000-0000-000000000006', '22222222-2222-2222-2222-222222222222', 'read', NOW() - INTERVAL '2 hours 25 minutes', NOW() - INTERVAL '2 hours 20 minutes'),
    ('d0000001-0000-0000-0000-000000000006', '55555555-5555-5555-5555-555555555555', 'delivered', NOW() - INTERVAL '2 hours 25 minutes', NULL),
    ('d0000001-0000-0000-0000-000000000006', '66666666-6666-6666-6666-666666666666', 'delivered', NOW() - INTERVAL '2 hours 25 minutes', NULL)
ON CONFLICT (message_id, recipient_id) DO NOTHING;

-- Status for Bob-Diana conversation
INSERT INTO message_status (message_id, recipient_id, status, delivered_at, read_at) VALUES
    ('e0000001-0000-0000-0000-000000000001', '44444444-4444-4444-4444-444444444444', 'read', NOW() - INTERVAL '5 hours 55 minutes', NOW() - INTERVAL '5 hours 50 minutes'),
    ('e0000001-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222', 'read', NOW() - INTERVAL '5 hours 40 minutes', NOW() - INTERVAL '5 hours 35 minutes'),
    ('e0000001-0000-0000-0000-000000000003', '44444444-4444-4444-4444-444444444444', 'read', NOW() - INTERVAL '5 hours 25 minutes', NOW() - INTERVAL '5 hours 20 minutes')
ON CONFLICT (message_id, recipient_id) DO NOTHING;
