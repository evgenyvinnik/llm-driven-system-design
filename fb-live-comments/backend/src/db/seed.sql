-- Seed data for development/testing
-- Facebook Live Comments sample data

INSERT INTO users (id, username, display_name, avatar_url, role, is_verified) VALUES
    ('11111111-1111-1111-1111-111111111111', 'streamer1', 'Live Streamer', '/avatars/streamer.png', 'user', true),
    ('22222222-2222-2222-2222-222222222222', 'viewer1', 'Happy Viewer', '/avatars/viewer1.png', 'user', false),
    ('33333333-3333-3333-3333-333333333333', 'viewer2', 'Excited Viewer', '/avatars/viewer2.png', 'user', false),
    ('44444444-4444-4444-4444-444444444444', 'moderator1', 'Mod Team', '/avatars/mod.png', 'moderator', true),
    ('55555555-5555-5555-5555-555555555555', 'admin', 'Admin User', '/avatars/admin.png', 'admin', true)
ON CONFLICT (username) DO NOTHING;

INSERT INTO streams (id, title, description, creator_id, status, video_url) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Live Coding Session', 'Building a real-time comment system', '11111111-1111-1111-1111-111111111111', 'live', 'https://www.w3schools.com/html/mov_bbb.mp4'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Gaming Stream', 'Playing some cool games', '11111111-1111-1111-1111-111111111111', 'live', 'https://www.w3schools.com/html/movie.mp4')
ON CONFLICT DO NOTHING;
