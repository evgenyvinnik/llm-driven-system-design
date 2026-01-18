-- Seed Data for Apple TV+
-- Run after init.sql: psql -d apple_tv -f seed.sql
-- Uses ON CONFLICT DO NOTHING for idempotency

-- ============================================================================
-- USERS
-- ============================================================================

-- Password: password123
-- Hash: $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

INSERT INTO users (id, email, password_hash, name, role, subscription_tier, subscription_expires_at) VALUES
    ('u1111111-1111-1111-1111-111111111111', 'alice@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Alice Johnson', 'user', 'yearly', NOW() + INTERVAL '300 days'),
    ('u2222222-2222-2222-2222-222222222222', 'bob@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Bob Smith', 'user', 'monthly', NOW() + INTERVAL '25 days'),
    ('u3333333-3333-3333-3333-333333333333', 'charlie@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Charlie Brown', 'user', 'free', NULL),
    ('u4444444-4444-4444-4444-444444444444', 'admin@appletv.local', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Admin User', 'admin', 'yearly', NOW() + INTERVAL '365 days')
ON CONFLICT (email) DO NOTHING;

-- ============================================================================
-- USER PROFILES
-- ============================================================================

INSERT INTO user_profiles (id, user_id, name, avatar_url, is_kids) VALUES
    -- Alice's profiles
    ('p1111111-1111-1111-1111-111111111111', 'u1111111-1111-1111-1111-111111111111', 'Alice', 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150', false),
    ('p1222222-2222-2222-2222-222222222222', 'u1111111-1111-1111-1111-111111111111', 'Kids', 'https://images.unsplash.com/photo-1566004100631-35d015d6a491?w=150', true),

    -- Bob's profile
    ('p2111111-1111-1111-1111-111111111111', 'u2222222-2222-2222-2222-222222222222', 'Bob', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150', false),

    -- Charlie's profile
    ('p3111111-1111-1111-1111-111111111111', 'u3333333-3333-3333-3333-333333333333', 'Charlie', 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150', false)
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- USER DEVICES
-- ============================================================================

INSERT INTO user_devices (id, user_id, device_id, device_name, device_type, active, last_used_at) VALUES
    ('ud111111-1111-1111-1111-111111111111', 'u1111111-1111-1111-1111-111111111111', 'apple_tv_alice_001', 'Living Room Apple TV', 'apple_tv', true, NOW() - INTERVAL '2 hours'),
    ('ud112222-2222-2222-2222-222222222222', 'u1111111-1111-1111-1111-111111111111', 'iphone_alice_001', 'Alice''s iPhone', 'iphone', true, NOW() - INTERVAL '30 minutes'),
    ('ud113333-3333-3333-3333-333333333333', 'u1111111-1111-1111-1111-111111111111', 'ipad_alice_001', 'Alice''s iPad', 'ipad', true, NOW() - INTERVAL '1 day'),
    ('ud211111-1111-1111-1111-111111111111', 'u2222222-2222-2222-2222-222222222222', 'apple_tv_bob_001', 'Bedroom Apple TV', 'apple_tv', true, NOW() - INTERVAL '5 hours'),
    ('ud311111-1111-1111-1111-111111111111', 'u3333333-3333-3333-3333-333333333333', 'macbook_charlie_001', 'Charlie''s MacBook', 'mac', true, NOW() - INTERVAL '1 hour')
ON CONFLICT (user_id, device_id) DO NOTHING;

-- ============================================================================
-- CONTENT CATALOG
-- ============================================================================

-- Featured Movies
INSERT INTO content (id, title, description, duration, release_date, content_type, rating, genres, thumbnail_url, banner_url, master_resolution, hdr_format, status, featured, view_count) VALUES
    ('c1111111-1111-1111-1111-111111111111', 'The Last Horizon',
     'A visually stunning sci-fi epic about humanity''s journey to the edge of the galaxy. When Earth becomes uninhabitable, a crew of explorers must find a new home among the stars.',
     8400, '2024-06-15', 'movie', 'PG-13', ARRAY['Sci-Fi', 'Drama', 'Adventure'],
     'https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?w=400',
     'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=1920',
     '4K', 'Dolby Vision', 'ready', true, 2450000),

    ('c1222222-2222-2222-2222-222222222222', 'Midnight in Manhattan',
     'A heartwarming romantic comedy set in New York City. Two strangers meet on New Year''s Eve and discover that sometimes the best things happen when you least expect them.',
     6300, '2024-02-14', 'movie', 'PG', ARRAY['Romance', 'Comedy'],
     'https://images.unsplash.com/photo-1534430480872-3498386e7856?w=400',
     'https://images.unsplash.com/photo-1496588152823-86ff7695e68f?w=1920',
     '4K', 'HDR10', 'ready', true, 1890000),

    ('c1333333-3333-3333-3333-333333333333', 'The Silent Witness',
     'A gripping legal thriller about a defense attorney who takes on an impossible case. As she digs deeper, she uncovers a conspiracy that threatens everything she believes in.',
     7200, '2024-04-20', 'movie', 'R', ARRAY['Thriller', 'Drama', 'Crime'],
     'https://images.unsplash.com/photo-1589829545856-d10d557cf95f?w=400',
     'https://images.unsplash.com/photo-1505664194779-8beaceb93744?w=1920',
     '4K', 'Dolby Vision', 'ready', false, 1567000),

    ('c1444444-4444-4444-4444-444444444444', 'Ocean''s Secret',
     'A documentary exploring the mysteries of the deep ocean. Join marine biologists as they discover new species and uncover the secrets hidden in the darkest depths.',
     5400, '2024-03-22', 'movie', 'G', ARRAY['Documentary', 'Nature'],
     'https://images.unsplash.com/photo-1559827260-dc66d52bef19?w=400',
     'https://images.unsplash.com/photo-1518837695005-2083093ee35b?w=1920',
     '4K', 'HDR10', 'ready', false, 890000);

-- TV Series
INSERT INTO content (id, title, description, duration, release_date, content_type, rating, genres, thumbnail_url, banner_url, master_resolution, hdr_format, status, featured, view_count) VALUES
    ('c2111111-1111-1111-1111-111111111111', 'The Founders',
     'A drama series following the rise and fall of a tech startup in Silicon Valley. Friendships are tested and fortunes are made and lost in the cutthroat world of technology.',
     0, '2023-09-01', 'series', 'TV-MA', ARRAY['Drama', 'Tech'],
     'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?w=400',
     'https://images.unsplash.com/photo-1497366216548-37526070297c?w=1920',
     '4K', 'Dolby Vision', 'ready', true, 4560000),

    ('c2222222-2222-2222-2222-222222222222', 'Cosmic Tales',
     'An animated anthology series featuring stories from across the universe. Each episode tells a unique tale of adventure, mystery, and wonder.',
     0, '2024-01-15', 'series', 'TV-Y7', ARRAY['Animation', 'Sci-Fi', 'Kids'],
     'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=400',
     'https://images.unsplash.com/photo-1419242902214-272b3f66ee7a?w=1920',
     '4K', 'HDR10', 'ready', true, 2340000),

    ('c2333333-3333-3333-3333-333333333333', 'Kitchen Champions',
     'A cooking competition series where amateur chefs compete for a chance to work in a Michelin-starred restaurant. High stakes, delicious food, and fierce competition.',
     0, '2024-04-01', 'series', 'TV-PG', ARRAY['Reality', 'Food'],
     'https://images.unsplash.com/photo-1556909114-f6e7ad7d3136?w=400',
     'https://images.unsplash.com/photo-1466637574441-749b8f19452f?w=1920',
     '1080p', 'SDR', 'ready', false, 1230000);

-- Episodes for The Founders (Season 1)
INSERT INTO content (id, title, description, duration, release_date, content_type, series_id, season_number, episode_number, rating, genres, thumbnail_url, status, view_count) VALUES
    ('e2111101-1111-1111-1111-111111111111', 'Pilot', 'Three college friends drop out to start a revolutionary tech company.', 3600, '2023-09-01', 'episode', 'c2111111-1111-1111-1111-111111111111', 1, 1, 'TV-MA', ARRAY['Drama'], 'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?w=400', 'ready', 1890000),
    ('e2111102-2222-2222-2222-222222222222', 'The Pitch', 'The team prepares for their first investor presentation.', 3300, '2023-09-08', 'episode', 'c2111111-1111-1111-1111-111111111111', 1, 2, 'TV-MA', ARRAY['Drama'], 'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?w=400', 'ready', 1560000),
    ('e2111103-3333-3333-3333-333333333333', 'Growing Pains', 'Success brings new challenges as the company scales rapidly.', 3480, '2023-09-15', 'episode', 'c2111111-1111-1111-1111-111111111111', 1, 3, 'TV-MA', ARRAY['Drama'], 'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?w=400', 'ready', 1340000),
    ('e2111104-4444-4444-4444-444444444444', 'The Competition', 'A rival company threatens everything they''ve built.', 3540, '2023-09-22', 'episode', 'c2111111-1111-1111-1111-111111111111', 1, 4, 'TV-MA', ARRAY['Drama'], 'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?w=400', 'ready', 1120000),
    ('e2111105-5555-5555-5555-555555555555', 'Betrayal', 'Secrets are revealed and alliances are broken.', 3660, '2023-09-29', 'episode', 'c2111111-1111-1111-1111-111111111111', 1, 5, 'TV-MA', ARRAY['Drama'], 'https://images.unsplash.com/photo-1517245386807-bb43f82c33c4?w=400', 'ready', 980000);

-- Episodes for Cosmic Tales (Season 1)
INSERT INTO content (id, title, description, duration, release_date, content_type, series_id, season_number, episode_number, rating, genres, thumbnail_url, status, view_count) VALUES
    ('e2221101-1111-1111-1111-111111111111', 'The Star Keeper', 'A young alien discovers she has the power to create stars.', 1500, '2024-01-15', 'episode', 'c2222222-2222-2222-2222-222222222222', 1, 1, 'TV-Y7', ARRAY['Animation', 'Sci-Fi'], 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=400', 'ready', 890000),
    ('e2221102-2222-2222-2222-222222222222', 'Robot Friends', 'A lonely robot on a space station finds an unexpected companion.', 1380, '2024-01-22', 'episode', 'c2222222-2222-2222-2222-222222222222', 1, 2, 'TV-Y7', ARRAY['Animation', 'Sci-Fi'], 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=400', 'ready', 720000),
    ('e2221103-3333-3333-3333-333333333333', 'The Time Loop', 'A mischievous alien gets stuck repeating the same day.', 1440, '2024-01-29', 'episode', 'c2222222-2222-2222-2222-222222222222', 1, 3, 'TV-Y7', ARRAY['Animation', 'Sci-Fi'], 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=400', 'ready', 650000);

-- ============================================================================
-- ENCODED VARIANTS
-- ============================================================================

-- Add multiple quality variants for each movie
INSERT INTO encoded_variants (id, content_id, resolution, codec, hdr, bitrate, file_path, file_size) VALUES
    -- The Last Horizon variants
    ('v1111111-4k', 'c1111111-1111-1111-1111-111111111111', 2160, 'hevc', true, 25000, '/content/last-horizon/4k-dv.m3u8', 26250000000),
    ('v1111111-1080', 'c1111111-1111-1111-1111-111111111111', 1080, 'h264', false, 8000, '/content/last-horizon/1080p.m3u8', 8400000000),
    ('v1111111-720', 'c1111111-1111-1111-1111-111111111111', 720, 'h264', false, 4000, '/content/last-horizon/720p.m3u8', 4200000000),

    -- Midnight in Manhattan variants
    ('v1222222-4k', 'c1222222-2222-2222-2222-222222222222', 2160, 'hevc', true, 20000, '/content/midnight-manhattan/4k.m3u8', 15750000000),
    ('v1222222-1080', 'c1222222-2222-2222-2222-222222222222', 1080, 'h264', false, 6000, '/content/midnight-manhattan/1080p.m3u8', 4725000000),
    ('v1222222-720', 'c1222222-2222-2222-2222-222222222222', 720, 'h264', false, 3000, '/content/midnight-manhattan/720p.m3u8', 2362500000)
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- AUDIO TRACKS
-- ============================================================================

INSERT INTO audio_tracks (id, content_id, language, name, codec, channels, file_path) VALUES
    ('a1111111-en', 'c1111111-1111-1111-1111-111111111111', 'en', 'English (Dolby Atmos)', 'eac3', 8, '/content/last-horizon/audio-en-atmos.m4a'),
    ('a1111111-en-st', 'c1111111-1111-1111-1111-111111111111', 'en', 'English (Stereo)', 'aac', 2, '/content/last-horizon/audio-en-stereo.m4a'),
    ('a1111111-es', 'c1111111-1111-1111-1111-111111111111', 'es', 'Spanish', 'aac', 6, '/content/last-horizon/audio-es.m4a'),
    ('a1111111-fr', 'c1111111-1111-1111-1111-111111111111', 'fr', 'French', 'aac', 6, '/content/last-horizon/audio-fr.m4a'),
    ('a1222222-en', 'c1222222-2222-2222-2222-222222222222', 'en', 'English', 'aac', 6, '/content/midnight-manhattan/audio-en.m4a'),
    ('a1222222-es', 'c1222222-2222-2222-2222-222222222222', 'es', 'Spanish', 'aac', 6, '/content/midnight-manhattan/audio-es.m4a')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- SUBTITLES
-- ============================================================================

INSERT INTO subtitles (id, content_id, language, name, type, file_path) VALUES
    ('s1111111-en', 'c1111111-1111-1111-1111-111111111111', 'en', 'English', 'caption', '/content/last-horizon/subs-en.vtt'),
    ('s1111111-en-cc', 'c1111111-1111-1111-1111-111111111111', 'en', 'English (CC)', 'caption', '/content/last-horizon/subs-en-cc.vtt'),
    ('s1111111-es', 'c1111111-1111-1111-1111-111111111111', 'es', 'Spanish', 'subtitle', '/content/last-horizon/subs-es.vtt'),
    ('s1111111-fr', 'c1111111-1111-1111-1111-111111111111', 'fr', 'French', 'subtitle', '/content/last-horizon/subs-fr.vtt'),
    ('s1111111-de', 'c1111111-1111-1111-1111-111111111111', 'de', 'German', 'subtitle', '/content/last-horizon/subs-de.vtt'),
    ('s1222222-en', 'c1222222-2222-2222-2222-222222222222', 'en', 'English', 'caption', '/content/midnight-manhattan/subs-en.vtt'),
    ('s1222222-es', 'c1222222-2222-2222-2222-222222222222', 'es', 'Spanish', 'subtitle', '/content/midnight-manhattan/subs-es.vtt')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- WATCH PROGRESS
-- ============================================================================

INSERT INTO watch_progress (user_id, profile_id, content_id, position, duration, completed, client_timestamp) VALUES
    -- Alice watching The Last Horizon (halfway through)
    ('u1111111-1111-1111-1111-111111111111', 'p1111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111111', 4200, 8400, false, EXTRACT(EPOCH FROM NOW() - INTERVAL '2 hours')::BIGINT * 1000),

    -- Alice finished Midnight in Manhattan
    ('u1111111-1111-1111-1111-111111111111', 'p1111111-1111-1111-1111-111111111111', 'c1222222-2222-2222-2222-222222222222', 6300, 6300, true, EXTRACT(EPOCH FROM NOW() - INTERVAL '3 days')::BIGINT * 1000),

    -- Alice's Kids profile watching Cosmic Tales
    ('u1111111-1111-1111-1111-111111111111', 'p1222222-2222-2222-2222-222222222222', 'e2221101-1111-1111-1111-111111111111', 1500, 1500, true, EXTRACT(EPOCH FROM NOW() - INTERVAL '1 day')::BIGINT * 1000),
    ('u1111111-1111-1111-1111-111111111111', 'p1222222-2222-2222-2222-222222222222', 'e2221102-2222-2222-2222-222222222222', 750, 1380, false, EXTRACT(EPOCH FROM NOW() - INTERVAL '30 minutes')::BIGINT * 1000),

    -- Bob watching The Founders
    ('u2222222-2222-2222-2222-222222222222', 'p2111111-1111-1111-1111-111111111111', 'e2111101-1111-1111-1111-111111111111', 3600, 3600, true, EXTRACT(EPOCH FROM NOW() - INTERVAL '1 week')::BIGINT * 1000),
    ('u2222222-2222-2222-2222-222222222222', 'p2111111-1111-1111-1111-111111111111', 'e2111102-2222-2222-2222-222222222222', 3300, 3300, true, EXTRACT(EPOCH FROM NOW() - INTERVAL '6 days')::BIGINT * 1000),
    ('u2222222-2222-2222-2222-222222222222', 'p2111111-1111-1111-1111-111111111111', 'e2111103-3333-3333-3333-333333333333', 1800, 3480, false, EXTRACT(EPOCH FROM NOW() - INTERVAL '1 hour')::BIGINT * 1000)
ON CONFLICT (profile_id, content_id) DO NOTHING;

-- ============================================================================
-- WATCH HISTORY
-- ============================================================================

INSERT INTO watch_history (user_id, profile_id, content_id, watched_at) VALUES
    ('u1111111-1111-1111-1111-111111111111', 'p1111111-1111-1111-1111-111111111111', 'c1222222-2222-2222-2222-222222222222', NOW() - INTERVAL '3 days'),
    ('u1111111-1111-1111-1111-111111111111', 'p1222222-2222-2222-2222-222222222222', 'e2221101-1111-1111-1111-111111111111', NOW() - INTERVAL '1 day'),
    ('u2222222-2222-2222-2222-222222222222', 'p2111111-1111-1111-1111-111111111111', 'e2111101-1111-1111-1111-111111111111', NOW() - INTERVAL '1 week'),
    ('u2222222-2222-2222-2222-222222222222', 'p2111111-1111-1111-1111-111111111111', 'e2111102-2222-2222-2222-222222222222', NOW() - INTERVAL '6 days');

-- ============================================================================
-- WATCHLIST
-- ============================================================================

INSERT INTO watchlist (profile_id, content_id) VALUES
    ('p1111111-1111-1111-1111-111111111111', 'c1333333-3333-3333-3333-333333333333'),
    ('p1111111-1111-1111-1111-111111111111', 'c1444444-4444-4444-4444-444444444444'),
    ('p1111111-1111-1111-1111-111111111111', 'c2333333-3333-3333-3333-333333333333'),
    ('p2111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111111'),
    ('p2111111-1111-1111-1111-111111111111', 'c1333333-3333-3333-3333-333333333333')
ON CONFLICT (profile_id, content_id) DO NOTHING;

-- ============================================================================
-- CONTENT RATINGS
-- ============================================================================

INSERT INTO content_ratings (profile_id, content_id, rating, rated_at) VALUES
    ('p1111111-1111-1111-1111-111111111111', 'c1222222-2222-2222-2222-222222222222', 5, NOW() - INTERVAL '3 days'),
    ('p1111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111111', 4, NOW() - INTERVAL '2 hours'),
    ('p2111111-1111-1111-1111-111111111111', 'e2111101-1111-1111-1111-111111111111', 5, NOW() - INTERVAL '1 week'),
    ('p2111111-1111-1111-1111-111111111111', 'e2111102-2222-2222-2222-222222222222', 4, NOW() - INTERVAL '6 days')
ON CONFLICT (profile_id, content_id) DO NOTHING;

-- ============================================================================
-- DOWNLOADS
-- ============================================================================

INSERT INTO downloads (id, user_id, content_id, device_id, quality, status, license_expires, downloaded_at, last_played) VALUES
    ('dl111111-1111-1111-1111-111111111111', 'u1111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111111', 'ipad_alice_001', '1080p', 'completed', NOW() + INTERVAL '28 days', NOW() - INTERVAL '2 days', NOW() - INTERVAL '1 day'),
    ('dl222222-2222-2222-2222-222222222222', 'u1111111-1111-1111-1111-111111111111', 'e2221101-1111-1111-1111-111111111111', 'ipad_alice_001', '720p', 'completed', NOW() + INTERVAL '28 days', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day'),
    ('dl333333-3333-3333-3333-333333333333', 'u2222222-2222-2222-2222-222222222222', 'e2111103-3333-3333-3333-333333333333', 'apple_tv_bob_001', '1080p', 'pending', NOW() + INTERVAL '30 days', NULL, NULL)
ON CONFLICT (id) DO NOTHING;
