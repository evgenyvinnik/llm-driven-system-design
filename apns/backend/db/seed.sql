-- Seed Data for APNs (Apple Push Notification Service)
-- Run after init.sql: psql -d apns -f seed.sql
-- Uses ON CONFLICT DO NOTHING for idempotency

-- ============================================================================
-- ADMIN USERS
-- ============================================================================

-- Password: password123
-- Hash: $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

INSERT INTO admin_users (id, username, password_hash, role) VALUES
    ('a1eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'admin', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'admin'),
    ('a2eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'operator', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'admin'),
    ('a3eebc99-9c0b-4ef8-bb6d-6bb9bd380a13', 'developer', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'admin')
ON CONFLICT (username) DO NOTHING;

-- ============================================================================
-- DEVICE TOKENS (Sample iOS Devices)
-- ============================================================================

INSERT INTO device_tokens (device_id, token_hash, app_bundle_id, device_info, is_valid, last_seen) VALUES
    -- Demo App devices
    ('d1111111-1111-1111-1111-111111111111',
     'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
     'com.example.demoapp',
     '{"device_model": "iPhone 15 Pro", "os_version": "17.2", "app_version": "2.1.0", "locale": "en_US"}',
     true, NOW() - INTERVAL '10 minutes'),

    ('d2222222-2222-2222-2222-222222222222',
     'b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3',
     'com.example.demoapp',
     '{"device_model": "iPhone 14", "os_version": "17.1", "app_version": "2.0.5", "locale": "en_GB"}',
     true, NOW() - INTERVAL '1 hour'),

    ('d3333333-3333-3333-3333-333333333333',
     'c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
     'com.example.demoapp',
     '{"device_model": "iPad Pro", "os_version": "17.2", "app_version": "2.1.0", "locale": "de_DE"}',
     true, NOW() - INTERVAL '2 hours'),

    ('d4444444-4444-4444-4444-444444444444',
     'd4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5',
     'com.example.demoapp',
     '{"device_model": "iPhone 13 Mini", "os_version": "16.7", "app_version": "1.9.0", "locale": "ja_JP"}',
     true, NOW() - INTERVAL '6 hours'),

    -- Second app devices
    ('d5555555-5555-5555-5555-555555555555',
     'e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6',
     'com.example.chatapp',
     '{"device_model": "iPhone 15 Pro Max", "os_version": "17.2", "app_version": "3.0.0", "locale": "en_US"}',
     true, NOW() - INTERVAL '5 minutes'),

    ('d6666666-6666-6666-6666-666666666666',
     'f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1',
     'com.example.chatapp',
     '{"device_model": "iPhone 14 Pro", "os_version": "17.1", "app_version": "2.9.5", "locale": "fr_FR"}',
     true, NOW() - INTERVAL '30 minutes'),

    -- Invalid/expired tokens
    ('d7777777-7777-7777-7777-777777777777',
     'a7b7c7d7e7f7a7b7c7d7e7f7a7b7c7d7e7f7a7b7c7d7e7f7a7b7c7d7e7f7a7b7',
     'com.example.demoapp',
     '{"device_model": "iPhone 12", "os_version": "15.5", "app_version": "1.5.0", "locale": "en_US"}',
     false, NOW() - INTERVAL '30 days'),

    ('d8888888-8888-8888-8888-888888888888',
     'b8c8d8e8f8a8b8c8d8e8f8a8b8c8d8e8f8a8b8c8d8e8f8a8b8c8d8e8f8a8b8c8',
     'com.example.demoapp',
     '{"device_model": "iPhone 11", "os_version": "15.0", "app_version": "1.0.0", "locale": "es_ES"}',
     false, NOW() - INTERVAL '60 days')
ON CONFLICT (device_id) DO NOTHING;

-- Update invalidation info for invalid tokens
UPDATE device_tokens
SET invalidated_at = NOW() - INTERVAL '25 days',
    invalidation_reason = 'Unregistered'
WHERE device_id = 'd7777777-7777-7777-7777-777777777777';

UPDATE device_tokens
SET invalidated_at = NOW() - INTERVAL '55 days',
    invalidation_reason = 'AppUninstalled'
WHERE device_id = 'd8888888-8888-8888-8888-888888888888';

-- ============================================================================
-- TOPIC SUBSCRIPTIONS
-- ============================================================================

INSERT INTO topic_subscriptions (device_id, topic) VALUES
    -- News topics
    ('d1111111-1111-1111-1111-111111111111', 'news.breaking'),
    ('d1111111-1111-1111-1111-111111111111', 'news.technology'),
    ('d2222222-2222-2222-2222-222222222222', 'news.breaking'),
    ('d2222222-2222-2222-2222-222222222222', 'news.sports'),
    ('d3333333-3333-3333-3333-333333333333', 'news.breaking'),
    ('d3333333-3333-3333-3333-333333333333', 'news.business'),

    -- Marketing topics
    ('d1111111-1111-1111-1111-111111111111', 'marketing.promotions'),
    ('d4444444-4444-4444-4444-444444444444', 'marketing.promotions'),
    ('d4444444-4444-4444-4444-444444444444', 'marketing.new_features'),

    -- Chat app topics
    ('d5555555-5555-5555-5555-555555555555', 'chat.direct_messages'),
    ('d5555555-5555-5555-5555-555555555555', 'chat.group_mentions'),
    ('d6666666-6666-6666-6666-666666666666', 'chat.direct_messages'),
    ('d6666666-6666-6666-6666-666666666666', 'chat.all_messages')
ON CONFLICT (device_id, topic) DO NOTHING;

-- ============================================================================
-- SAMPLE NOTIFICATIONS
-- ============================================================================

INSERT INTO notifications (id, device_id, topic, payload, priority, expiration, collapse_id, status, created_at) VALUES
    -- Delivered notifications
    ('n1111111-1111-1111-1111-111111111111',
     'd1111111-1111-1111-1111-111111111111',
     NULL,
     '{"aps": {"alert": {"title": "Welcome!", "body": "Thanks for installing our app"}, "badge": 1, "sound": "default"}}',
     10, NOW() + INTERVAL '1 day', NULL, 'delivered', NOW() - INTERVAL '2 days'),

    ('n2222222-2222-2222-2222-222222222222',
     'd1111111-1111-1111-1111-111111111111',
     'news.breaking',
     '{"aps": {"alert": {"title": "Breaking News", "body": "Major tech announcement today"}, "badge": 2, "sound": "default"}}',
     10, NOW() + INTERVAL '4 hours', 'breaking-news-001', 'delivered', NOW() - INTERVAL '1 hour'),

    ('n3333333-3333-3333-3333-333333333333',
     'd2222222-2222-2222-2222-222222222222',
     'news.sports',
     '{"aps": {"alert": {"title": "Game Update", "body": "Your team scored!"}, "badge": 1, "sound": "cheer.wav"}}',
     5, NOW() + INTERVAL '1 hour', 'sports-game-123', 'delivered', NOW() - INTERVAL '30 minutes'),

    -- Pending notifications
    ('n4444444-4444-4444-4444-444444444444',
     'd4444444-4444-4444-4444-444444444444',
     'marketing.promotions',
     '{"aps": {"alert": {"title": "Flash Sale!", "body": "50% off for the next 24 hours"}, "badge": 1, "sound": "default"}, "data": {"promo_code": "FLASH50"}}',
     5, NOW() + INTERVAL '1 day', 'promo-flash-sale', 'pending', NOW() - INTERVAL '5 minutes'),

    ('n5555555-5555-5555-5555-555555555555',
     'd5555555-5555-5555-5555-555555555555',
     'chat.direct_messages',
     '{"aps": {"alert": {"title": "New Message", "body": "Alice: Hey, are you free tonight?"}, "badge": 3, "sound": "message.wav"}, "data": {"sender_id": "alice123", "thread_id": "thread-456"}}',
     10, NOW() + INTERVAL '1 day', NULL, 'delivered', NOW() - INTERVAL '2 minutes'),

    -- Silent push notification
    ('n6666666-6666-6666-6666-666666666666',
     'd3333333-3333-3333-3333-333333333333',
     NULL,
     '{"aps": {"content-available": 1}, "data": {"action": "sync_data", "version": "2.1.0"}}',
     1, NOW() + INTERVAL '12 hours', 'background-sync', 'delivered', NOW() - INTERVAL '15 minutes'),

    -- Failed notification
    ('n7777777-7777-7777-7777-777777777777',
     'd7777777-7777-7777-7777-777777777777',
     NULL,
     '{"aps": {"alert": {"title": "Test", "body": "This should fail"}, "sound": "default"}}',
     10, NOW() - INTERVAL '1 day', NULL, 'failed', NOW() - INTERVAL '25 days')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- DELIVERY LOG
-- ============================================================================

INSERT INTO delivery_log (notification_id, device_id, status, delivered_at, created_at) VALUES
    ('n1111111-1111-1111-1111-111111111111', 'd1111111-1111-1111-1111-111111111111', 'delivered', NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days'),
    ('n2222222-2222-2222-2222-222222222222', 'd1111111-1111-1111-1111-111111111111', 'delivered', NOW() - INTERVAL '59 minutes', NOW() - INTERVAL '1 hour'),
    ('n3333333-3333-3333-3333-333333333333', 'd2222222-2222-2222-2222-222222222222', 'delivered', NOW() - INTERVAL '29 minutes', NOW() - INTERVAL '30 minutes'),
    ('n5555555-5555-5555-5555-555555555555', 'd5555555-5555-5555-5555-555555555555', 'delivered', NOW() - INTERVAL '1 minute', NOW() - INTERVAL '2 minutes'),
    ('n6666666-6666-6666-6666-666666666666', 'd3333333-3333-3333-3333-333333333333', 'delivered', NOW() - INTERVAL '14 minutes', NOW() - INTERVAL '15 minutes'),
    ('n7777777-7777-7777-7777-777777777777', 'd7777777-7777-7777-7777-777777777777', 'failed', NULL, NOW() - INTERVAL '25 days')
ON CONFLICT (notification_id) DO NOTHING;

-- ============================================================================
-- PENDING NOTIFICATIONS (for offline devices)
-- ============================================================================

INSERT INTO pending_notifications (id, device_id, payload, priority, expiration, collapse_id) VALUES
    ('p1111111-1111-1111-1111-111111111111',
     'd4444444-4444-4444-4444-444444444444',
     '{"aps": {"alert": {"title": "Daily Digest", "body": "Check out today''s top stories"}, "badge": 5, "sound": "default"}}',
     5, NOW() + INTERVAL '12 hours', 'daily-digest'),

    ('p2222222-2222-2222-2222-222222222222',
     'd6666666-6666-6666-6666-666666666666',
     '{"aps": {"alert": {"title": "Missed Call", "body": "Bob tried to reach you"}, "badge": 1, "sound": "ringtone.wav"}}',
     10, NOW() + INTERVAL '1 hour', NULL)
ON CONFLICT (device_id, collapse_id) WHERE collapse_id IS NOT NULL DO NOTHING;

-- ============================================================================
-- FEEDBACK QUEUE (Token invalidation feedback)
-- ============================================================================

INSERT INTO feedback_queue (token_hash, app_bundle_id, reason, timestamp) VALUES
    ('a7b7c7d7e7f7a7b7c7d7e7f7a7b7c7d7e7f7a7b7c7d7e7f7a7b7c7d7e7f7a7b7', 'com.example.demoapp', 'Unregistered', NOW() - INTERVAL '25 days'),
    ('b8c8d8e8f8a8b8c8d8e8f8a8b8c8d8e8f8a8b8c8d8e8f8a8b8c8d8e8f8a8b8c8', 'com.example.demoapp', 'AppUninstalled', NOW() - INTERVAL '55 days');
