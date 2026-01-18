-- YouTube Clone Seed Data
-- Password for all users: password123
-- bcrypt hash: $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- ============================================================================
-- USERS / CHANNELS
-- ============================================================================
INSERT INTO users (id, username, email, password_hash, channel_name, channel_description, avatar_url, subscriber_count, role) VALUES
    ('11111111-1111-1111-1111-111111111111', 'alice', 'alice@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Alice Tech', 'Tech tutorials and coding tips for developers of all levels', 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=200', 15420, 'creator'),
    ('22222222-2222-2222-2222-222222222222', 'bob', 'bob@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Bob Cooks', 'Delicious recipes and cooking tutorials for home chefs', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200', 8750, 'creator'),
    ('33333333-3333-3333-3333-333333333333', 'charlie', 'charlie@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Charlie Gaming', 'Gaming walkthroughs, reviews, and live streams', 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=200', 45200, 'creator'),
    ('44444444-4444-4444-4444-444444444444', 'diana', 'diana@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Diana Fitness', 'Workout routines and fitness motivation for everyone', 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=200', 32100, 'creator'),
    ('55555555-5555-5555-5555-555555555555', 'eve', 'eve@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', NULL, NULL, 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=200', 0, 'user'),
    ('66666666-6666-6666-6666-666666666666', 'frank', 'frank@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Frank Music', 'Original music, covers, and music production tutorials', 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=200', 12800, 'creator'),
    ('77777777-7777-7777-7777-777777777777', 'admin', 'admin@youtube.local', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Admin Channel', 'Platform administration and announcements', NULL, 0, 'admin')
ON CONFLICT (username) DO NOTHING;

-- ============================================================================
-- VIDEOS
-- ============================================================================
INSERT INTO videos (id, channel_id, title, description, duration_seconds, status, visibility, view_count, like_count, dislike_count, comment_count, categories, tags, thumbnail_url, published_at, created_at) VALUES
    -- Alice Tech videos
    ('abc123xyz01', '11111111-1111-1111-1111-111111111111', 'Learn React in 30 Minutes', 'A comprehensive beginner tutorial covering React fundamentals including components, state, and hooks.', 1847, 'ready', 'public', 125000, 8500, 120, 342, ARRAY['Education', 'Technology'], ARRAY['react', 'javascript', 'tutorial', 'web development', 'frontend'], 'https://images.unsplash.com/photo-1633356122544-f134324a6cee?w=800', NOW() - INTERVAL '30 days', NOW() - INTERVAL '30 days'),
    ('def456uvw02', '11111111-1111-1111-1111-111111111111', 'TypeScript for Beginners', 'Everything you need to know to get started with TypeScript in your JavaScript projects.', 2456, 'ready', 'public', 89000, 6200, 85, 215, ARRAY['Education', 'Technology'], ARRAY['typescript', 'javascript', 'tutorial', 'programming'], 'https://images.unsplash.com/photo-1516116216624-53e697fedbea?w=800', NOW() - INTERVAL '20 days', NOW() - INTERVAL '20 days'),
    ('ghi789rst03', '11111111-1111-1111-1111-111111111111', 'Building a REST API with Node.js', 'Step by step guide to creating a production-ready REST API with Express and PostgreSQL.', 3120, 'ready', 'public', 67000, 4800, 62, 178, ARRAY['Education', 'Technology'], ARRAY['nodejs', 'api', 'backend', 'express', 'postgresql'], 'https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=800', NOW() - INTERVAL '10 days', NOW() - INTERVAL '10 days'),

    -- Bob Cooks videos
    ('jkl012opq04', '22222222-2222-2222-2222-222222222222', 'Perfect Homemade Pizza', 'Learn the secrets to making restaurant-quality pizza at home with simple ingredients.', 1234, 'ready', 'public', 234000, 18500, 230, 567, ARRAY['Entertainment', 'Howto'], ARRAY['pizza', 'cooking', 'recipe', 'italian', 'homemade'], 'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=800', NOW() - INTERVAL '25 days', NOW() - INTERVAL '25 days'),
    ('mno345lmn05', '22222222-2222-2222-2222-222222222222', '5-Minute Breakfast Ideas', 'Quick and healthy breakfast recipes for busy mornings that will keep you energized.', 542, 'ready', 'public', 178000, 14200, 180, 423, ARRAY['Entertainment', 'Howto'], ARRAY['breakfast', 'quick recipes', 'healthy', 'cooking', 'meal prep'], 'https://images.unsplash.com/photo-1533089860892-a7c6f0a88666?w=800', NOW() - INTERVAL '15 days', NOW() - INTERVAL '15 days'),

    -- Charlie Gaming videos
    ('pqr678ijk06', '33333333-3333-3333-3333-333333333333', 'Complete Game Walkthrough Part 1', 'Full walkthrough of the latest adventure game with all secrets and collectibles revealed.', 4567, 'ready', 'public', 456000, 32000, 450, 1234, ARRAY['Gaming', 'Entertainment'], ARRAY['gaming', 'walkthrough', 'tips', 'gameplay', 'adventure'], 'https://images.unsplash.com/photo-1538481199705-c710c4e965fc?w=800', NOW() - INTERVAL '18 days', NOW() - INTERVAL '18 days'),
    ('stu901ghi07', '33333333-3333-3333-3333-333333333333', 'Top 10 Games of 2024', 'My picks for the best games released this year across all platforms.', 1823, 'ready', 'public', 289000, 21500, 890, 876, ARRAY['Gaming', 'Entertainment'], ARRAY['gaming', 'top 10', 'review', 'best games', '2024'], 'https://images.unsplash.com/photo-1493711662062-fa541f7f3d24?w=800', NOW() - INTERVAL '8 days', NOW() - INTERVAL '8 days'),
    ('vwx234def08', '33333333-3333-3333-3333-333333333333', 'Speedrun World Record Attempt', 'Attempting to break the world record speedrun. Watch me try to beat it live!', 2134, 'ready', 'public', 567000, 45000, 320, 2100, ARRAY['Gaming', 'Entertainment'], ARRAY['speedrun', 'world record', 'gaming', 'live', 'challenge'], 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=800', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days'),

    -- Diana Fitness videos
    ('yza567abc09', '44444444-4444-4444-4444-444444444444', '30-Day Fitness Challenge', 'Transform your body with this comprehensive 30-day workout program for all fitness levels.', 2789, 'ready', 'public', 345000, 28000, 290, 1456, ARRAY['Sports', 'Howto'], ARRAY['fitness', 'workout', 'challenge', 'exercise', 'health'], 'https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=800', NOW() - INTERVAL '22 days', NOW() - INTERVAL '22 days'),
    ('bcd890xyz10', '44444444-4444-4444-4444-444444444444', '10-Minute Morning Yoga', 'Start your day right with this energizing yoga routine that requires no equipment.', 645, 'ready', 'public', 198000, 16500, 120, 678, ARRAY['Sports', 'Howto'], ARRAY['yoga', 'morning routine', 'stretching', 'wellness', 'mindfulness'], 'https://images.unsplash.com/photo-1544367567-0f2fcb009e67?w=800', NOW() - INTERVAL '12 days', NOW() - INTERVAL '12 days'),

    -- Frank Music videos
    ('efg123rst11', '66666666-6666-6666-6666-666666666666', 'Guitar Tutorial: Classic Rock Riffs', 'Learn 10 iconic rock guitar riffs step by step with tab included.', 1567, 'ready', 'public', 156000, 12800, 95, 456, ARRAY['Music', 'Education'], ARRAY['guitar', 'rock', 'tutorial', 'music', 'riffs'], 'https://images.unsplash.com/photo-1510915361894-db8b60106cb1?w=800', NOW() - INTERVAL '14 days', NOW() - INTERVAL '14 days'),
    ('hij456uvw12', '66666666-6666-6666-6666-666666666666', 'Original Song: Midnight Dreams', 'My latest original composition. Hope you enjoy this mellow acoustic track!', 245, 'ready', 'public', 45000, 4200, 25, 234, ARRAY['Music', 'Entertainment'], ARRAY['original music', 'acoustic', 'singer songwriter', 'indie'], 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=800', NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days'),

    -- Unlisted video
    ('klm789opq13', '11111111-1111-1111-1111-111111111111', 'Behind the Scenes: My Setup', 'A tour of my home office and recording setup. Unlisted for patrons only.', 890, 'ready', 'unlisted', 1200, 180, 2, 45, ARRAY['Technology'], ARRAY['setup tour', 'home office', 'behind the scenes'], 'https://images.unsplash.com/photo-1593062096033-9a26b09da705?w=800', NOW() - INTERVAL '7 days', NOW() - INTERVAL '7 days'),

    -- Processing video
    ('nop012lmn14', '22222222-2222-2222-2222-222222222222', 'Coming Soon: Holiday Special', 'Holiday cooking special coming soon!', NULL, 'processing', 'private', 0, 0, 0, 0, ARRAY['Entertainment'], ARRAY['holiday', 'cooking', 'special'], NULL, NULL, NOW() - INTERVAL '1 hour')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- VIDEO RESOLUTIONS
-- ============================================================================
INSERT INTO video_resolutions (video_id, resolution, manifest_url, video_url, bitrate, width, height) VALUES
    -- Alice Tech - React tutorial
    ('abc123xyz01', '1080p', '/videos/abc123xyz01/1080p/playlist.m3u8', '/videos/abc123xyz01/1080p/video.mp4', 5000, 1920, 1080),
    ('abc123xyz01', '720p', '/videos/abc123xyz01/720p/playlist.m3u8', '/videos/abc123xyz01/720p/video.mp4', 2500, 1280, 720),
    ('abc123xyz01', '480p', '/videos/abc123xyz01/480p/playlist.m3u8', '/videos/abc123xyz01/480p/video.mp4', 1000, 854, 480),
    ('abc123xyz01', '360p', '/videos/abc123xyz01/360p/playlist.m3u8', '/videos/abc123xyz01/360p/video.mp4', 500, 640, 360),
    -- Other videos - just 720p for brevity
    ('def456uvw02', '720p', '/videos/def456uvw02/720p/playlist.m3u8', '/videos/def456uvw02/720p/video.mp4', 2500, 1280, 720),
    ('ghi789rst03', '720p', '/videos/ghi789rst03/720p/playlist.m3u8', '/videos/ghi789rst03/720p/video.mp4', 2500, 1280, 720),
    ('jkl012opq04', '720p', '/videos/jkl012opq04/720p/playlist.m3u8', '/videos/jkl012opq04/720p/video.mp4', 2500, 1280, 720),
    ('mno345lmn05', '720p', '/videos/mno345lmn05/720p/playlist.m3u8', '/videos/mno345lmn05/720p/video.mp4', 2500, 1280, 720),
    ('pqr678ijk06', '720p', '/videos/pqr678ijk06/720p/playlist.m3u8', '/videos/pqr678ijk06/720p/video.mp4', 2500, 1280, 720),
    ('stu901ghi07', '720p', '/videos/stu901ghi07/720p/playlist.m3u8', '/videos/stu901ghi07/720p/video.mp4', 2500, 1280, 720),
    ('vwx234def08', '720p', '/videos/vwx234def08/720p/playlist.m3u8', '/videos/vwx234def08/720p/video.mp4', 2500, 1280, 720),
    ('yza567abc09', '720p', '/videos/yza567abc09/720p/playlist.m3u8', '/videos/yza567abc09/720p/video.mp4', 2500, 1280, 720),
    ('bcd890xyz10', '720p', '/videos/bcd890xyz10/720p/playlist.m3u8', '/videos/bcd890xyz10/720p/video.mp4', 2500, 1280, 720),
    ('efg123rst11', '720p', '/videos/efg123rst11/720p/playlist.m3u8', '/videos/efg123rst11/720p/video.mp4', 2500, 1280, 720),
    ('hij456uvw12', '720p', '/videos/hij456uvw12/720p/playlist.m3u8', '/videos/hij456uvw12/720p/video.mp4', 2500, 1280, 720),
    ('klm789opq13', '720p', '/videos/klm789opq13/720p/playlist.m3u8', '/videos/klm789opq13/720p/video.mp4', 2500, 1280, 720)
ON CONFLICT (video_id, resolution) DO NOTHING;

-- ============================================================================
-- SUBSCRIPTIONS
-- ============================================================================
INSERT INTO subscriptions (subscriber_id, channel_id, notifications_enabled) VALUES
    -- Eve subscribes to multiple channels
    ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', TRUE),
    ('55555555-5555-5555-5555-555555555555', '22222222-2222-2222-2222-222222222222', TRUE),
    ('55555555-5555-5555-5555-555555555555', '33333333-3333-3333-3333-333333333333', TRUE),
    ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444', FALSE),
    -- Creators subscribe to each other
    ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', TRUE),
    ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', FALSE),
    ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', TRUE),
    ('22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', TRUE),
    ('33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444', TRUE),
    ('33333333-3333-3333-3333-333333333333', '66666666-6666-6666-6666-666666666666', TRUE),
    ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', TRUE),
    ('66666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', TRUE)
ON CONFLICT (subscriber_id, channel_id) DO NOTHING;

-- ============================================================================
-- COMMENTS
-- ============================================================================
INSERT INTO comments (id, video_id, user_id, parent_id, text, like_count, created_at) VALUES
    -- Comments on React tutorial
    ('c1111111-1111-1111-1111-111111111111', 'abc123xyz01', '55555555-5555-5555-5555-555555555555', NULL, 'This is exactly what I needed! Finally understand hooks now. Thank you Alice!', 45, NOW() - INTERVAL '28 days'),
    ('c1111111-1111-1111-1111-111111111112', 'abc123xyz01', '22222222-2222-2222-2222-222222222222', NULL, 'Great explanation! Could you make a video on Redux next?', 23, NOW() - INTERVAL '25 days'),
    ('c1111111-1111-1111-1111-111111111113', 'abc123xyz01', '11111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111112', 'Redux video is already in the works! Stay tuned!', 18, NOW() - INTERVAL '24 days'),
    ('c1111111-1111-1111-1111-111111111114', 'abc123xyz01', '33333333-3333-3333-3333-333333333333', NULL, 'Timestamp 15:23 saved my project. useEffect finally makes sense!', 67, NOW() - INTERVAL '20 days'),

    -- Comments on Pizza video
    ('c2222222-2222-2222-2222-222222222221', 'jkl012opq04', '11111111-1111-1111-1111-111111111111', NULL, 'Made this last weekend and my family loved it! The dough recipe is perfect.', 89, NOW() - INTERVAL '23 days'),
    ('c2222222-2222-2222-2222-222222222222', 'jkl012opq04', '44444444-4444-4444-4444-444444444444', NULL, 'Pro tip: let the dough rest overnight for even better flavor!', 56, NOW() - INTERVAL '22 days'),
    ('c2222222-2222-2222-2222-222222222223', 'jkl012opq04', '22222222-2222-2222-2222-222222222222', 'c2222222-2222-2222-2222-222222222222', 'Great tip Diana! I mentioned that in my advanced pizza video too.', 34, NOW() - INTERVAL '21 days'),
    ('c2222222-2222-2222-2222-222222222224', 'jkl012opq04', '55555555-5555-5555-5555-555555555555', NULL, 'The cheese pull at 8:45 is amazing! I need to try this.', 42, NOW() - INTERVAL '18 days'),

    -- Comments on Gaming walkthrough
    ('c3333333-3333-3333-3333-333333333331', 'pqr678ijk06', '55555555-5555-5555-5555-555555555555', NULL, 'Your walkthroughs are always so thorough. Found all the hidden items thanks to you!', 120, NOW() - INTERVAL '16 days'),
    ('c3333333-3333-3333-3333-333333333332', 'pqr678ijk06', '66666666-6666-6666-6666-666666666666', NULL, 'The secret boss fight at 45:00 was insane! How many attempts did that take?', 78, NOW() - INTERVAL '14 days'),
    ('c3333333-3333-3333-3333-333333333333', 'pqr678ijk06', '33333333-3333-3333-3333-333333333333', 'c3333333-3333-3333-3333-333333333332', 'That took me about 20 tries haha. Worth it for the legendary loot!', 95, NOW() - INTERVAL '13 days'),

    -- Comments on Fitness challenge
    ('c4444444-4444-4444-4444-444444444441', 'yza567abc09', '55555555-5555-5555-5555-555555555555', NULL, 'Day 15 and already seeing results! This program is amazing.', 156, NOW() - INTERVAL '7 days'),
    ('c4444444-4444-4444-4444-444444444442', 'yza567abc09', '22222222-2222-2222-2222-222222222222', NULL, 'The modifications for beginners are so helpful. Finally a workout I can keep up with!', 89, NOW() - INTERVAL '10 days'),
    ('c4444444-4444-4444-4444-444444444443', 'yza567abc09', '44444444-4444-4444-4444-444444444444', 'c4444444-4444-4444-4444-444444444441', 'So proud of you! Keep going, the results get even better in the last week!', 67, NOW() - INTERVAL '6 days'),

    -- Comments on speedrun
    ('c5555555-5555-5555-5555-555555555551', 'vwx234def08', '66666666-6666-6666-6666-666666666666', NULL, 'That skip at 12:34 was absolutely insane! New tech?', 234, NOW() - INTERVAL '2 days'),
    ('c5555555-5555-5555-5555-555555555552', 'vwx234def08', '11111111-1111-1111-1111-111111111111', NULL, 'So close to the record! You will get it next time for sure.', 167, NOW() - INTERVAL '2 days'),
    ('c5555555-5555-5555-5555-555555555553', 'vwx234def08', '33333333-3333-3333-3333-333333333333', 'c5555555-5555-5555-5555-555555555551', 'Yes! Discovered it last week. Will make a tutorial soon.', 189, NOW() - INTERVAL '1 day')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- VIDEO REACTIONS
-- ============================================================================
INSERT INTO video_reactions (user_id, video_id, reaction_type) VALUES
    -- Eve likes many videos
    ('55555555-5555-5555-5555-555555555555', 'abc123xyz01', 'like'),
    ('55555555-5555-5555-5555-555555555555', 'jkl012opq04', 'like'),
    ('55555555-5555-5555-5555-555555555555', 'pqr678ijk06', 'like'),
    ('55555555-5555-5555-5555-555555555555', 'yza567abc09', 'like'),
    ('55555555-5555-5555-5555-555555555555', 'vwx234def08', 'like'),
    -- Creators support each other
    ('11111111-1111-1111-1111-111111111111', 'jkl012opq04', 'like'),
    ('11111111-1111-1111-1111-111111111111', 'yza567abc09', 'like'),
    ('22222222-2222-2222-2222-222222222222', 'abc123xyz01', 'like'),
    ('22222222-2222-2222-2222-222222222222', 'pqr678ijk06', 'like'),
    ('33333333-3333-3333-3333-333333333333', 'efg123rst11', 'like'),
    ('33333333-3333-3333-3333-333333333333', 'yza567abc09', 'like'),
    ('44444444-4444-4444-4444-444444444444', 'jkl012opq04', 'like'),
    ('44444444-4444-4444-4444-444444444444', 'abc123xyz01', 'like'),
    ('66666666-6666-6666-6666-666666666666', 'pqr678ijk06', 'like'),
    ('66666666-6666-6666-6666-666666666666', 'vwx234def08', 'like')
ON CONFLICT (user_id, video_id) DO NOTHING;

-- ============================================================================
-- COMMENT LIKES
-- ============================================================================
INSERT INTO comment_likes (user_id, comment_id) VALUES
    ('11111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111111'),
    ('22222222-2222-2222-2222-222222222222', 'c1111111-1111-1111-1111-111111111111'),
    ('33333333-3333-3333-3333-333333333333', 'c1111111-1111-1111-1111-111111111114'),
    ('44444444-4444-4444-4444-444444444444', 'c2222222-2222-2222-2222-222222222221'),
    ('55555555-5555-5555-5555-555555555555', 'c3333333-3333-3333-3333-333333333331'),
    ('66666666-6666-6666-6666-666666666666', 'c5555555-5555-5555-5555-555555555551'),
    ('11111111-1111-1111-1111-111111111111', 'c4444444-4444-4444-4444-444444444441'),
    ('22222222-2222-2222-2222-222222222222', 'c4444444-4444-4444-4444-444444444442')
ON CONFLICT (user_id, comment_id) DO NOTHING;

-- ============================================================================
-- WATCH HISTORY
-- ============================================================================
INSERT INTO watch_history (user_id, video_id, watch_duration_seconds, watch_percentage, last_position_seconds, watched_at) VALUES
    -- Eve's watch history
    ('55555555-5555-5555-5555-555555555555', 'abc123xyz01', 1847, 100.00, 1847, NOW() - INTERVAL '5 days'),
    ('55555555-5555-5555-5555-555555555555', 'abc123xyz01', 900, 48.73, 900, NOW() - INTERVAL '28 days'),
    ('55555555-5555-5555-5555-555555555555', 'jkl012opq04', 1234, 100.00, 1234, NOW() - INTERVAL '3 days'),
    ('55555555-5555-5555-5555-555555555555', 'pqr678ijk06', 2500, 54.73, 2500, NOW() - INTERVAL '2 days'),
    ('55555555-5555-5555-5555-555555555555', 'vwx234def08', 2134, 100.00, 2134, NOW() - INTERVAL '1 day'),
    ('55555555-5555-5555-5555-555555555555', 'yza567abc09', 1500, 53.78, 1500, NOW() - INTERVAL '4 days'),
    -- Other users watch history
    ('11111111-1111-1111-1111-111111111111', 'jkl012opq04', 1234, 100.00, 1234, NOW() - INTERVAL '20 days'),
    ('11111111-1111-1111-1111-111111111111', 'yza567abc09', 2789, 100.00, 2789, NOW() - INTERVAL '15 days'),
    ('22222222-2222-2222-2222-222222222222', 'abc123xyz01', 1847, 100.00, 1847, NOW() - INTERVAL '25 days'),
    ('22222222-2222-2222-2222-222222222222', 'pqr678ijk06', 3000, 65.68, 3000, NOW() - INTERVAL '10 days'),
    ('33333333-3333-3333-3333-333333333333', 'efg123rst11', 1567, 100.00, 1567, NOW() - INTERVAL '12 days'),
    ('33333333-3333-3333-3333-333333333333', 'yza567abc09', 2000, 71.71, 2000, NOW() - INTERVAL '8 days'),
    ('44444444-4444-4444-4444-444444444444', 'jkl012opq04', 1234, 100.00, 1234, NOW() - INTERVAL '22 days'),
    ('44444444-4444-4444-4444-444444444444', 'abc123xyz01', 1200, 64.97, 1200, NOW() - INTERVAL '18 days'),
    ('66666666-6666-6666-6666-666666666666', 'pqr678ijk06', 4567, 100.00, 4567, NOW() - INTERVAL '16 days'),
    ('66666666-6666-6666-6666-666666666666', 'vwx234def08', 2134, 100.00, 2134, NOW() - INTERVAL '2 days')
ON CONFLICT DO NOTHING;
