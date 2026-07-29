-- Seed data for development/testing
-- Loom - async video messaging platform
--
-- Login credentials for every seeded user: password123
-- (bcrypt hash below is $2b$10$BdLsE... == "password123")
--
-- Usage: psql -U loom -d loom -f backend/db-seed/seed.sql
-- Safe to re-run: every INSERT is ON CONFLICT DO NOTHING with fixed UUIDs.

-- ============ Users ============
INSERT INTO users (id, username, email, password_hash, display_name, avatar_url, role) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'alice', 'alice@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Alice Chen', 'https://i.pravatar.cc/150?u=alice', 'user'),
    ('a2222222-2222-2222-2222-222222222222', 'bob', 'bob@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Bob Martinez', 'https://i.pravatar.cc/150?u=bob', 'user'),
    ('a3333333-3333-3333-3333-333333333333', 'carol', 'carol@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Carol Nguyen', 'https://i.pravatar.cc/150?u=carol', 'user'),
    ('a4444444-4444-4444-4444-444444444444', 'admin', 'admin@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Platform Admin', 'https://i.pravatar.cc/150?u=admin', 'admin')
ON CONFLICT (id) DO NOTHING;

-- ============ Folders ============
INSERT INTO folders (id, user_id, name, parent_id) VALUES
    ('f1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'Product Demos', NULL),
    ('f2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-111111111111', 'Standups', NULL),
    ('f3333333-3333-3333-3333-333333333333', 'a1111111-1111-1111-1111-111111111111', 'Q3 Launch', 'f1111111-1111-1111-1111-111111111111'),
    ('f4444444-4444-4444-4444-444444444444', 'a2222222-2222-2222-2222-222222222222', 'Bug Reports', NULL)
ON CONFLICT (id) DO NOTHING;

-- ============ Videos ============
-- alice owns most of them (she is the screenshot login), spanning every status.
INSERT INTO videos (id, user_id, title, description, duration_seconds, status, storage_path, thumbnail_path, file_size_bytes, view_count, created_at, updated_at) VALUES
    ('11111111-aaaa-4aaa-8aaa-111111111111', 'a1111111-1111-1111-1111-111111111111',
     'Checkout flow walkthrough', 'Screen recording of the new 3-step checkout, including the coupon edge case we discussed.',
     312, 'ready', 'videos/11111111-aaaa-4aaa-8aaa-111111111111.webm', 'thumbnails/11111111-aaaa-4aaa-8aaa-111111111111.jpg',
     48210496, 128, NOW() - INTERVAL '2 hours', NOW() - INTERVAL '2 hours'),

    ('22222222-aaaa-4aaa-8aaa-222222222222', 'a1111111-1111-1111-1111-111111111111',
     'Sprint 24 standup', 'Async standup: shipped the search reindex, blocked on the CDN cache purge.',
     94, 'ready', 'videos/22222222-aaaa-4aaa-8aaa-222222222222.webm', 'thumbnails/22222222-aaaa-4aaa-8aaa-222222222222.jpg',
     14680064, 42, NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day'),

    ('33333333-aaaa-4aaa-8aaa-333333333333', 'a1111111-1111-1111-1111-111111111111',
     'Design review: dashboard v2', 'Walking through the three dashboard layouts. Timestamped comments welcome.',
     725, 'ready', 'videos/33333333-aaaa-4aaa-8aaa-333333333333.webm', 'thumbnails/33333333-aaaa-4aaa-8aaa-333333333333.jpg',
     112590848, 317, NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days'),

    ('44444444-aaaa-4aaa-8aaa-444444444444', 'a1111111-1111-1111-1111-111111111111',
     'Onboarding for new engineers', 'Repo tour, local setup, and how to run the test suite.',
     1483, 'ready', 'videos/44444444-aaaa-4aaa-8aaa-444444444444.webm', 'thumbnails/44444444-aaaa-4aaa-8aaa-444444444444.jpg',
     241172480, 903, NOW() - INTERVAL '9 days', NOW() - INTERVAL '9 days'),

    ('55555555-aaaa-4aaa-8aaa-555555555555', 'a1111111-1111-1111-1111-111111111111',
     'Hotfix postmortem (raw)', 'Just uploaded - still encoding.',
     NULL, 'processing', NULL, NULL, NULL, 0, NOW() - INTERVAL '3 minutes', NOW() - INTERVAL '3 minutes'),

    ('66666666-aaaa-4aaa-8aaa-666666666666', 'a1111111-1111-1111-1111-111111111111',
     'Mobile nav prototype', 'Upload interrupted mid-transcode - kept to exercise the failed state.',
     NULL, 'failed', NULL, NULL, 9437184, 0, NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days'),

    ('77777777-aaaa-4aaa-8aaa-777777777777', 'a2222222-2222-2222-2222-222222222222',
     'Repro: cart total off by one cent', 'Bob reproducing the rounding bug on staging.',
     201, 'ready', 'videos/77777777-aaaa-4aaa-8aaa-777777777777.webm', 'thumbnails/77777777-aaaa-4aaa-8aaa-777777777777.jpg',
     31457280, 57, NOW() - INTERVAL '6 hours', NOW() - INTERVAL '6 hours'),

    ('88888888-aaaa-4aaa-8aaa-888888888888', 'a3333333-3333-3333-3333-333333333333',
     'Customer call highlights', 'Carol: the 4 minutes of the Acme call that matter.',
     248, 'ready', 'videos/88888888-aaaa-4aaa-8aaa-888888888888.webm', 'thumbnails/88888888-aaaa-4aaa-8aaa-888888888888.jpg',
     38797312, 74, NOW() - INTERVAL '2 days', NOW() - INTERVAL '2 days')
ON CONFLICT (id) DO NOTHING;

-- ============ Video <-> Folder ============
INSERT INTO video_folders (video_id, folder_id) VALUES
    ('11111111-aaaa-4aaa-8aaa-111111111111', 'f1111111-1111-1111-1111-111111111111'),
    ('33333333-aaaa-4aaa-8aaa-333333333333', 'f1111111-1111-1111-1111-111111111111'),
    ('44444444-aaaa-4aaa-8aaa-444444444444', 'f3333333-3333-3333-3333-333333333333'),
    ('22222222-aaaa-4aaa-8aaa-222222222222', 'f2222222-2222-2222-2222-222222222222'),
    ('77777777-aaaa-4aaa-8aaa-777777777777', 'f4444444-4444-4444-4444-444444444444')
ON CONFLICT DO NOTHING;

-- ============ Comments ============
-- Mix of general comments (timestamp_seconds NULL) and time-anchored ones,
-- plus one threaded reply so the reply UI has something to render.
INSERT INTO comments (id, video_id, user_id, content, timestamp_seconds, parent_id, created_at) VALUES
    ('c1111111-1111-4111-8111-111111111111', '11111111-aaaa-4aaa-8aaa-111111111111', 'a2222222-2222-2222-2222-222222222222',
     'The coupon field losing focus at 1:12 is the bug I filed last week.', 72, NULL, NOW() - INTERVAL '90 minutes'),
    ('c2222222-2222-4222-8222-222222222222', '11111111-aaaa-4aaa-8aaa-111111111111', 'a1111111-1111-1111-1111-111111111111',
     'Good catch - patch is up, will re-record once it lands.', 72, 'c1111111-1111-4111-8111-111111111111', NOW() - INTERVAL '80 minutes'),
    ('c3333333-3333-4333-8333-333333333333', '11111111-aaaa-4aaa-8aaa-111111111111', 'a3333333-3333-3333-3333-333333333333',
     'Nice walkthrough, this answered my question without a meeting.', NULL, NULL, NOW() - INTERVAL '1 hour'),
    ('c4444444-4444-4444-8444-444444444444', '33333333-aaaa-4aaa-8aaa-333333333333', 'a3333333-3333-3333-3333-333333333333',
     'Layout B at 4:20 reads much better on a 13-inch screen.', 260, NULL, NOW() - INTERVAL '2 days'),
    ('c5555555-5555-4555-8555-555555555555', '33333333-aaaa-4aaa-8aaa-333333333333', 'a2222222-2222-2222-2222-222222222222',
     'Agreed on B. The sidebar in A eats too much width.', NULL, NULL, NOW() - INTERVAL '2 days'),
    ('c6666666-6666-4666-8666-666666666666', '44444444-aaaa-4aaa-8aaa-444444444444', 'a2222222-2222-2222-2222-222222222222',
     'The docker-compose step at 8:05 is out of date now.', 485, NULL, NOW() - INTERVAL '4 days')
ON CONFLICT (id) DO NOTHING;

-- ============ Share links ============
-- share_public: no password, no expiry. share_locked: password-protected (password123).
INSERT INTO shares (id, video_id, token, password_hash, expires_at, allow_download, created_at) VALUES
    ('50000001-0000-4000-8000-000000000001', '11111111-aaaa-4aaa-8aaa-111111111111',
     'demo-checkout-walkthrough-2f8a91', NULL, NULL, TRUE, NOW() - INTERVAL '2 hours'),
    ('50000002-0000-4000-8000-000000000002', '33333333-aaaa-4aaa-8aaa-333333333333',
     'demo-dashboard-review-7c3e44', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi',
     NOW() + INTERVAL '14 days', FALSE, NOW() - INTERVAL '3 days'),
    ('50000003-0000-4000-8000-000000000003', '44444444-aaaa-4aaa-8aaa-444444444444',
     'demo-eng-onboarding-b19d05', NULL, NOW() + INTERVAL '90 days', TRUE, NOW() - INTERVAL '9 days')
ON CONFLICT (id) DO NOTHING;

-- ============ View events ============
-- Spread across the last 6 days so the analytics panel has a non-flat
-- views-by-day series, a real unique-viewer count, and a partial completion rate.
INSERT INTO view_events (video_id, viewer_id, session_id, watch_duration_seconds, completed, ip_address, user_agent, created_at)
SELECT
    '11111111-aaaa-4aaa-8aaa-111111111111',
    CASE (i % 4)
        WHEN 0 THEN 'a2222222-2222-2222-2222-222222222222'::uuid
        WHEN 1 THEN 'a3333333-3333-3333-3333-333333333333'::uuid
        WHEN 2 THEN 'a4444444-4444-4444-4444-444444444444'::uuid
        ELSE NULL
    END,
    'sess-checkout-' || i,
    -- completed viewers watch the full 312s, the rest bail partway through
    CASE WHEN i % 3 = 0 THEN 312 ELSE 40 + (i * 17) % 240 END,
    (i % 3 = 0),
    '203.0.113.' || (i % 250 + 1),
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36',
    NOW() - (INTERVAL '1 hour' * (i * 2))
FROM generate_series(1, 36) AS i
WHERE NOT EXISTS (SELECT 1 FROM view_events WHERE video_id = '11111111-aaaa-4aaa-8aaa-111111111111');

INSERT INTO view_events (video_id, viewer_id, session_id, watch_duration_seconds, completed, ip_address, user_agent, created_at)
SELECT
    '33333333-aaaa-4aaa-8aaa-333333333333',
    CASE WHEN i % 2 = 0 THEN 'a3333333-3333-3333-3333-333333333333'::uuid ELSE NULL END,
    'sess-design-' || i,
    CASE WHEN i % 4 = 0 THEN 725 ELSE 120 + (i * 31) % 500 END,
    (i % 4 = 0),
    '198.51.100.' || (i % 250 + 1),
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0 Safari/537.36',
    NOW() - (INTERVAL '3 hours' * i)
FROM generate_series(1, 24) AS i
WHERE NOT EXISTS (SELECT 1 FROM view_events WHERE video_id = '33333333-aaaa-4aaa-8aaa-333333333333');

INSERT INTO view_events (video_id, viewer_id, session_id, watch_duration_seconds, completed, ip_address, user_agent, created_at)
SELECT
    '44444444-aaaa-4aaa-8aaa-444444444444',
    CASE WHEN i % 5 = 0 THEN 'a2222222-2222-2222-2222-222222222222'::uuid ELSE NULL END,
    'sess-onboarding-' || i,
    CASE WHEN i % 2 = 0 THEN 1483 ELSE 200 + (i * 53) % 1100 END,
    (i % 2 = 0),
    '192.0.2.' || (i % 250 + 1),
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36',
    NOW() - (INTERVAL '5 hours' * i)
FROM generate_series(1, 18) AS i
WHERE NOT EXISTS (SELECT 1 FROM view_events WHERE video_id = '44444444-aaaa-4aaa-8aaa-444444444444');
