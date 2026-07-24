-- Seed data for development/testing
-- Facebook Live Comments sample data
-- Password hash is for 'password123': $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

INSERT INTO users (id, username, display_name, avatar_url, role, is_verified) VALUES
    ('11111111-1111-1111-1111-111111111111', 'streamer1', 'Live Streamer', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150', 'user', true),
    ('22222222-2222-2222-2222-222222222222', 'viewer1', 'Happy Viewer', 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150', 'user', false),
    ('33333333-3333-3333-3333-333333333333', 'viewer2', 'Excited Viewer', 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150', 'user', false),
    ('44444444-4444-4444-4444-444444444444', 'moderator1', 'Mod Team', 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=150', 'moderator', true),
    ('55555555-5555-5555-5555-555555555555', 'admin', 'Admin User', 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150', 'admin', true)
ON CONFLICT (username) DO NOTHING;

INSERT INTO streams (id, title, description, creator_id, status, video_url) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Live Coding Session', 'Building a real-time comment system', '11111111-1111-1111-1111-111111111111', 'live', 'https://www.w3schools.com/html/mov_bbb.mp4'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Gaming Stream', 'Playing some cool games', '11111111-1111-1111-1111-111111111111', 'live', 'https://www.w3schools.com/html/movie.mp4')
ON CONFLICT DO NOTHING;

-- ============================================================
-- Live chat comments for "Live Coding Session" so the comment
-- stream shows real conversation on load. BIGINT ids are chosen
-- to sort chronologically (the app orders by id, Snowflake-style).
-- One comment is pinned and one highlighted to show those states.
-- ============================================================
INSERT INTO comments (id, stream_id, user_id, content, is_pinned, is_highlighted, created_at) VALUES
  (7300000000000000001, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Welcome everyone! Today we are building a real-time comment system 🚀', true, false, NOW() - INTERVAL '9 minutes'),
  (7300000000000000002, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'So excited for this one!', false, false, NOW() - INTERVAL '8 minutes'),
  (7300000000000000003, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'How do you handle fan-out to millions of viewers?', false, false, NOW() - INTERVAL '7 minutes'),
  (7300000000000000004, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Great question — we batch comments every 100ms and aggregate reactions. Coming up next!', false, true, NOW() - INTERVAL '6 minutes'),
  (7300000000000000005, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44444444-4444-4444-4444-444444444444', 'Reminder: keep it respectful in chat 🙂', false, false, NOW() - INTERVAL '5 minutes'),
  (7300000000000000006, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'Snowflake IDs are such a clean trick for ordering', false, false, NOW() - INTERVAL '4 minutes'),
  (7300000000000000007, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'Wait, why not just use a database auto-increment?', false, false, NOW() - INTERVAL '3 minutes'),
  (7300000000000000008, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'Because you would need a DB round-trip before broadcasting. Snowflake lets us assign the id locally 👍', false, false, NOW() - INTERVAL '2 minutes'),
  (7300000000000000009, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '55555555-5555-5555-5555-555555555555', 'This architecture is really elegant', false, false, NOW() - INTERVAL '1 minute'),
  (7300000000000000010, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'Loving this stream ❤️', false, false, NOW() - INTERVAL '20 seconds')
ON CONFLICT DO NOTHING;
