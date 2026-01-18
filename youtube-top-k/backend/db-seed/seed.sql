-- YouTube Top K Videos Seed Data
-- Sample videos and view events for trending analytics

-- ============================================================================
-- VIDEOS
-- ============================================================================
INSERT INTO videos (id, title, description, thumbnail_url, channel_name, category, duration_seconds, total_views, created_at) VALUES
    -- Technology videos
    ('11111111-1111-1111-1111-111111111111', 'Learn React in 30 Minutes', 'A comprehensive beginner tutorial covering React fundamentals including components, state, and hooks.', 'https://images.unsplash.com/photo-1633356122544-f134324a6cee?w=800', 'Alice Tech', 'Technology', 1847, 125000, NOW() - INTERVAL '30 days'),
    ('11111111-1111-1111-1111-111111111112', 'TypeScript for Beginners', 'Everything you need to know to get started with TypeScript in your JavaScript projects.', 'https://images.unsplash.com/photo-1516116216624-53e697fedbea?w=800', 'Alice Tech', 'Technology', 2456, 89000, NOW() - INTERVAL '20 days'),
    ('11111111-1111-1111-1111-111111111113', 'Building a REST API with Node.js', 'Step by step guide to creating a production-ready REST API with Express and PostgreSQL.', 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=800', 'CodeMaster', 'Technology', 3120, 67000, NOW() - INTERVAL '10 days'),
    ('11111111-1111-1111-1111-111111111114', 'Python Machine Learning Tutorial', 'Introduction to machine learning with scikit-learn and pandas.', 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=800', 'DataScience Pro', 'Technology', 4520, 234000, NOW() - INTERVAL '15 days'),

    -- Entertainment videos
    ('22222222-2222-2222-2222-222222222221', 'Top 10 Movies of 2024', 'My picks for the best movies released this year across all genres.', 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?w=800', 'MovieReviewer', 'Entertainment', 1823, 456000, NOW() - INTERVAL '5 days'),
    ('22222222-2222-2222-2222-222222222222', 'Comedy Sketch: Office Life', 'Hilarious take on everyday office situations that everyone can relate to.', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=800', 'FunnyBunch', 'Entertainment', 542, 789000, NOW() - INTERVAL '3 days'),
    ('22222222-2222-2222-2222-222222222223', 'Viral Dance Challenge', 'Join the latest dance trend sweeping the internet!', 'https://images.unsplash.com/photo-1545959570-a94084071b5d?w=800', 'DanceVibes', 'Entertainment', 180, 1250000, NOW() - INTERVAL '1 day'),

    -- Gaming videos
    ('33333333-3333-3333-3333-333333333331', 'Complete Game Walkthrough Part 1', 'Full walkthrough of the latest adventure game with all secrets revealed.', 'https://images.unsplash.com/photo-1538481199705-c710c4e965fc?w=800', 'Charlie Gaming', 'Gaming', 4567, 567000, NOW() - INTERVAL '18 days'),
    ('33333333-3333-3333-3333-333333333332', 'Speedrun World Record Attempt', 'Attempting to break the world record speedrun live!', 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=800', 'SpeedRunner', 'Gaming', 2134, 890000, NOW() - INTERVAL '2 days'),
    ('33333333-3333-3333-3333-333333333333', 'New Game Review: Honest Opinion', 'Unbiased review of the most anticipated game of the year.', 'https://images.unsplash.com/photo-1493711662062-fa541f7f3d24?w=800', 'GameCritic', 'Gaming', 1567, 345000, NOW() - INTERVAL '7 days'),

    -- Music videos
    ('44444444-4444-4444-4444-444444444441', 'Guitar Tutorial: Classic Rock Riffs', 'Learn 10 iconic rock guitar riffs step by step with tab included.', 'https://images.unsplash.com/photo-1510915361894-db8b60106cb1?w=800', 'Frank Music', 'Music', 1567, 156000, NOW() - INTERVAL '14 days'),
    ('44444444-4444-4444-4444-444444444442', 'Original Song: Midnight Dreams', 'My latest original composition. Hope you enjoy this mellow acoustic track!', 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=800', 'IndieSinger', 'Music', 245, 45000, NOW() - INTERVAL '5 days'),
    ('44444444-4444-4444-4444-444444444443', 'Piano Cover: Popular Hits Medley', 'Beautiful piano arrangements of this years biggest hits.', 'https://images.unsplash.com/photo-1520523839897-bd0b52f945a0?w=800', 'PianoMaster', 'Music', 890, 234000, NOW() - INTERVAL '8 days'),

    -- Sports videos
    ('55555555-5555-5555-5555-555555555551', '30-Day Fitness Challenge', 'Transform your body with this comprehensive workout program.', 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=800', 'Diana Fitness', 'Sports', 2789, 345000, NOW() - INTERVAL '22 days'),
    ('55555555-5555-5555-5555-555555555552', '10-Minute Morning Yoga', 'Start your day right with this energizing yoga routine.', 'https://images.unsplash.com/photo-1544367567-0f2fcb009e67?w=800', 'YogaLife', 'Sports', 645, 198000, NOW() - INTERVAL '12 days'),
    ('55555555-5555-5555-5555-555555555553', 'Basketball Training: Pro Tips', 'Professional basketball training techniques for all skill levels.', 'https://images.unsplash.com/photo-1546519638-68e109498ffc?w=800', 'CourtKing', 'Sports', 1234, 123000, NOW() - INTERVAL '9 days'),

    -- News videos
    ('66666666-6666-6666-6666-666666666661', 'Breaking: Tech Industry Update', 'Latest developments in the technology sector and market analysis.', 'https://images.unsplash.com/photo-1504711434969-e33886168f5c?w=800', 'TechNews Daily', 'News', 456, 567000, NOW() - INTERVAL '6 hours'),
    ('66666666-6666-6666-6666-666666666662', 'Weekly News Roundup', 'Summary of the most important news stories from this week.', 'https://images.unsplash.com/photo-1495020689067-958852a7765e?w=800', 'NewsChannel', 'News', 1890, 234000, NOW() - INTERVAL '1 day'),

    -- Education videos
    ('77777777-7777-7777-7777-777777777771', 'How the Universe Works', 'Fascinating journey through the cosmos and the laws of physics.', 'https://images.unsplash.com/photo-1462331940025-496dfbfc7564?w=800', 'ScienceExplained', 'Education', 2456, 890000, NOW() - INTERVAL '25 days'),
    ('77777777-7777-7777-7777-777777777772', 'History of Ancient Rome', 'Comprehensive documentary about the rise and fall of the Roman Empire.', 'https://images.unsplash.com/photo-1552832230-c0197dd311b5?w=800', 'HistoryChannel', 'Education', 5678, 456000, NOW() - INTERVAL '20 days')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- VIEW EVENTS
-- ============================================================================
-- Generate realistic view events for the past 24 hours to populate trending data
-- Using different time buckets to simulate natural viewing patterns

-- Viral Dance Challenge - highest views (trending #1)
INSERT INTO view_events (video_id, viewed_at, session_id, idempotency_key)
SELECT
    '22222222-2222-2222-2222-222222222223',
    NOW() - (random() * INTERVAL '24 hours'),
    'session_' || generate_series,
    '22222222-2222-2222-2222-222222222223:session_' || generate_series || ':' || (EXTRACT(EPOCH FROM NOW())::bigint / 60)
FROM generate_series(1, 500)
ON CONFLICT DO NOTHING;

-- Speedrun World Record - very high views (trending #2)
INSERT INTO view_events (video_id, viewed_at, session_id, idempotency_key)
SELECT
    '33333333-3333-3333-3333-333333333332',
    NOW() - (random() * INTERVAL '24 hours'),
    'session_' || (1000 + generate_series),
    '33333333-3333-3333-3333-333333333332:session_' || (1000 + generate_series) || ':' || (EXTRACT(EPOCH FROM NOW())::bigint / 60)
FROM generate_series(1, 400)
ON CONFLICT DO NOTHING;

-- Comedy Sketch - high views
INSERT INTO view_events (video_id, viewed_at, session_id, idempotency_key)
SELECT
    '22222222-2222-2222-2222-222222222222',
    NOW() - (random() * INTERVAL '24 hours'),
    'session_' || (2000 + generate_series),
    '22222222-2222-2222-2222-222222222222:session_' || (2000 + generate_series) || ':' || (EXTRACT(EPOCH FROM NOW())::bigint / 60)
FROM generate_series(1, 350)
ON CONFLICT DO NOTHING;

-- Breaking Tech News - recent surge
INSERT INTO view_events (video_id, viewed_at, session_id, idempotency_key)
SELECT
    '66666666-6666-6666-6666-666666666661',
    NOW() - (random() * INTERVAL '6 hours'),
    'session_' || (3000 + generate_series),
    '66666666-6666-6666-6666-666666666661:session_' || (3000 + generate_series) || ':' || (EXTRACT(EPOCH FROM NOW())::bigint / 60)
FROM generate_series(1, 300)
ON CONFLICT DO NOTHING;

-- Universe Documentary - steady views
INSERT INTO view_events (video_id, viewed_at, session_id, idempotency_key)
SELECT
    '77777777-7777-7777-7777-777777777771',
    NOW() - (random() * INTERVAL '24 hours'),
    'session_' || (4000 + generate_series),
    '77777777-7777-7777-7777-777777777771:session_' || (4000 + generate_series) || ':' || (EXTRACT(EPOCH FROM NOW())::bigint / 60)
FROM generate_series(1, 250)
ON CONFLICT DO NOTHING;

-- Top 10 Movies - moderate views
INSERT INTO view_events (video_id, viewed_at, session_id, idempotency_key)
SELECT
    '22222222-2222-2222-2222-222222222221',
    NOW() - (random() * INTERVAL '24 hours'),
    'session_' || (5000 + generate_series),
    '22222222-2222-2222-2222-222222222221:session_' || (5000 + generate_series) || ':' || (EXTRACT(EPOCH FROM NOW())::bigint / 60)
FROM generate_series(1, 200)
ON CONFLICT DO NOTHING;

-- Game Walkthrough - moderate views
INSERT INTO view_events (video_id, viewed_at, session_id, idempotency_key)
SELECT
    '33333333-3333-3333-3333-333333333331',
    NOW() - (random() * INTERVAL '24 hours'),
    'session_' || (6000 + generate_series),
    '33333333-3333-3333-3333-333333333331:session_' || (6000 + generate_series) || ':' || (EXTRACT(EPOCH FROM NOW())::bigint / 60)
FROM generate_series(1, 180)
ON CONFLICT DO NOTHING;

-- Fitness Challenge - steady views
INSERT INTO view_events (video_id, viewed_at, session_id, idempotency_key)
SELECT
    '55555555-5555-5555-5555-555555555551',
    NOW() - (random() * INTERVAL '24 hours'),
    'session_' || (7000 + generate_series),
    '55555555-5555-5555-5555-555555555551:session_' || (7000 + generate_series) || ':' || (EXTRACT(EPOCH FROM NOW())::bigint / 60)
FROM generate_series(1, 150)
ON CONFLICT DO NOTHING;

-- ML Tutorial - tech audience views
INSERT INTO view_events (video_id, viewed_at, session_id, idempotency_key)
SELECT
    '11111111-1111-1111-1111-111111111114',
    NOW() - (random() * INTERVAL '24 hours'),
    'session_' || (8000 + generate_series),
    '11111111-1111-1111-1111-111111111114:session_' || (8000 + generate_series) || ':' || (EXTRACT(EPOCH FROM NOW())::bigint / 60)
FROM generate_series(1, 120)
ON CONFLICT DO NOTHING;

-- React Tutorial - educational views
INSERT INTO view_events (video_id, viewed_at, session_id, idempotency_key)
SELECT
    '11111111-1111-1111-1111-111111111111',
    NOW() - (random() * INTERVAL '24 hours'),
    'session_' || (9000 + generate_series),
    '11111111-1111-1111-1111-111111111111:session_' || (9000 + generate_series) || ':' || (EXTRACT(EPOCH FROM NOW())::bigint / 60)
FROM generate_series(1, 100)
ON CONFLICT DO NOTHING;

-- Piano Cover - music views
INSERT INTO view_events (video_id, viewed_at, session_id, idempotency_key)
SELECT
    '44444444-4444-4444-4444-444444444443',
    NOW() - (random() * INTERVAL '24 hours'),
    'session_' || (10000 + generate_series),
    '44444444-4444-4444-4444-444444444443:session_' || (10000 + generate_series) || ':' || (EXTRACT(EPOCH FROM NOW())::bigint / 60)
FROM generate_series(1, 90)
ON CONFLICT DO NOTHING;

-- Other videos with fewer views
INSERT INTO view_events (video_id, viewed_at, session_id, idempotency_key)
SELECT
    '11111111-1111-1111-1111-111111111112',
    NOW() - (random() * INTERVAL '24 hours'),
    'session_' || (11000 + generate_series),
    '11111111-1111-1111-1111-111111111112:session_' || (11000 + generate_series) || ':' || (EXTRACT(EPOCH FROM NOW())::bigint / 60)
FROM generate_series(1, 50)
ON CONFLICT DO NOTHING;

INSERT INTO view_events (video_id, viewed_at, session_id, idempotency_key)
SELECT
    '55555555-5555-5555-5555-555555555552',
    NOW() - (random() * INTERVAL '24 hours'),
    'session_' || (12000 + generate_series),
    '55555555-5555-5555-5555-555555555552:session_' || (12000 + generate_series) || ':' || (EXTRACT(EPOCH FROM NOW())::bigint / 60)
FROM generate_series(1, 45)
ON CONFLICT DO NOTHING;

INSERT INTO view_events (video_id, viewed_at, session_id, idempotency_key)
SELECT
    '33333333-3333-3333-3333-333333333333',
    NOW() - (random() * INTERVAL '24 hours'),
    'session_' || (13000 + generate_series),
    '33333333-3333-3333-3333-333333333333:session_' || (13000 + generate_series) || ':' || (EXTRACT(EPOCH FROM NOW())::bigint / 60)
FROM generate_series(1, 40)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- TRENDING SNAPSHOTS
-- ============================================================================
-- Sample snapshots to show historical trending data
INSERT INTO trending_snapshots (window_type, category, video_rankings, snapshot_at) VALUES
    -- Hourly snapshot - all categories
    ('hourly', NULL, '[
        {"videoId": "22222222-2222-2222-2222-222222222223", "title": "Viral Dance Challenge", "score": 520, "rank": 1},
        {"videoId": "33333333-3333-3333-3333-333333333332", "title": "Speedrun World Record Attempt", "score": 415, "rank": 2},
        {"videoId": "22222222-2222-2222-2222-222222222222", "title": "Comedy Sketch: Office Life", "score": 365, "rank": 3},
        {"videoId": "66666666-6666-6666-6666-666666666661", "title": "Breaking: Tech Industry Update", "score": 310, "rank": 4},
        {"videoId": "77777777-7777-7777-7777-777777777771", "title": "How the Universe Works", "score": 260, "rank": 5}
    ]'::jsonb, NOW() - INTERVAL '1 hour'),

    -- Hourly snapshot - Gaming category
    ('hourly', 'Gaming', '[
        {"videoId": "33333333-3333-3333-3333-333333333332", "title": "Speedrun World Record Attempt", "score": 415, "rank": 1},
        {"videoId": "33333333-3333-3333-3333-333333333331", "title": "Complete Game Walkthrough Part 1", "score": 190, "rank": 2},
        {"videoId": "33333333-3333-3333-3333-333333333333", "title": "New Game Review: Honest Opinion", "score": 45, "rank": 3}
    ]'::jsonb, NOW() - INTERVAL '1 hour'),

    -- Daily snapshot - all categories
    ('daily', NULL, '[
        {"videoId": "22222222-2222-2222-2222-222222222223", "title": "Viral Dance Challenge", "score": 4500, "rank": 1},
        {"videoId": "33333333-3333-3333-3333-333333333332", "title": "Speedrun World Record Attempt", "score": 3200, "rank": 2},
        {"videoId": "22222222-2222-2222-2222-222222222222", "title": "Comedy Sketch: Office Life", "score": 2800, "rank": 3},
        {"videoId": "77777777-7777-7777-7777-777777777771", "title": "How the Universe Works", "score": 2100, "rank": 4},
        {"videoId": "22222222-2222-2222-2222-222222222221", "title": "Top 10 Movies of 2024", "score": 1800, "rank": 5}
    ]'::jsonb, NOW() - INTERVAL '12 hours'),

    -- Previous day snapshot
    ('daily', NULL, '[
        {"videoId": "77777777-7777-7777-7777-777777777771", "title": "How the Universe Works", "score": 3800, "rank": 1},
        {"videoId": "33333333-3333-3333-3333-333333333331", "title": "Complete Game Walkthrough Part 1", "score": 2900, "rank": 2},
        {"videoId": "55555555-5555-5555-5555-555555555551", "title": "30-Day Fitness Challenge", "score": 2200, "rank": 3},
        {"videoId": "11111111-1111-1111-1111-111111111114", "title": "Python Machine Learning Tutorial", "score": 1900, "rank": 4},
        {"videoId": "44444444-4444-4444-4444-444444444443", "title": "Piano Cover: Popular Hits Medley", "score": 1500, "rank": 5}
    ]'::jsonb, NOW() - INTERVAL '1 day')
ON CONFLICT DO NOTHING;
