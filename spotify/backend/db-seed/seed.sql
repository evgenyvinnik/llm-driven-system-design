-- Spotify Music Streaming Platform Seed Data
-- Password hash is for 'password123': $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Sample users
INSERT INTO users (id, email, password_hash, username, display_name, avatar_url, is_premium, role) VALUES
    ('u1111111-1111-1111-1111-111111111111', 'alice@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'alice_music', 'Alice', 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150', true, 'user'),
    ('u2222222-2222-2222-2222-222222222222', 'bob@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'bob_beats', 'Bob', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150', false, 'user'),
    ('u3333333-3333-3333-3333-333333333333', 'carol@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'carol_tunes', 'Carol', 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150', true, 'user'),
    ('u4444444-4444-4444-4444-444444444444', 'admin@spotify.local', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'admin', 'Admin', NULL, true, 'admin')
ON CONFLICT (email) DO NOTHING;

-- Sample artists
INSERT INTO artists (id, name, bio, image_url, verified, monthly_listeners) VALUES
    ('a1111111-1111-1111-1111-111111111111', 'The Midnight', 'Synthwave duo from Los Angeles known for their nostalgic 80s sound.', 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=400', true, 2500000),
    ('a2222222-2222-2222-2222-222222222222', 'Aurora', 'Norwegian singer-songwriter with ethereal pop soundscapes.', 'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?w=400', true, 8500000),
    ('a3333333-3333-3333-3333-333333333333', 'Khruangbin', 'Houston trio blending global sounds with psych-funk grooves.', 'https://images.unsplash.com/photo-1511671782779-c97d3d27a1d4?w=400', true, 5200000),
    ('a4444444-4444-4444-4444-444444444444', 'Bonobo', 'British musician and producer known for electronic and downtempo music.', 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?w=400', true, 4100000),
    ('a5555555-5555-5555-5555-555555555555', 'Glass Animals', 'British indie rock band with experimental pop influences.', 'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=400', true, 12000000),
    ('a6666666-6666-6666-6666-666666666666', 'Tycho', 'Ambient and electronic producer from San Francisco.', 'https://images.unsplash.com/photo-1514320291840-2e0a9bf2a9ae?w=400', true, 2800000)
ON CONFLICT DO NOTHING;

-- Sample albums
INSERT INTO albums (id, artist_id, title, release_date, cover_url, album_type, total_tracks) VALUES
    ('al111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', 'Endless Summer', '2016-07-15', 'https://images.unsplash.com/photo-1504898770365-14faca6a7320?w=400', 'album', 10),
    ('al222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-111111111111', 'Kids', '2018-09-28', 'https://images.unsplash.com/photo-1571330735066-03aaa9429d89?w=400', 'album', 12),
    ('al333333-3333-3333-3333-333333333333', 'a2222222-2222-2222-2222-222222222222', 'All My Demons Greeting Me as a Friend', '2016-03-11', 'https://images.unsplash.com/photo-1483412033650-1015ddeb83d1?w=400', 'album', 12),
    ('al444444-4444-4444-4444-444444444444', 'a3333333-3333-3333-3333-333333333333', 'Mordechai', '2020-06-26', 'https://images.unsplash.com/photo-1485579149621-3123dd979885?w=400', 'album', 10),
    ('al555555-5555-5555-5555-555555555555', 'a4444444-4444-4444-4444-444444444444', 'Migration', '2017-01-13', 'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?w=400', 'album', 12),
    ('al666666-6666-6666-6666-666666666666', 'a5555555-5555-5555-5555-555555555555', 'Dreamland', '2020-08-07', 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=400', 'album', 16),
    ('al777777-7777-7777-7777-777777777777', 'a6666666-6666-6666-6666-666666666666', 'Dive', '2011-11-08', 'https://images.unsplash.com/photo-1506157786151-b8491531f063?w=400', 'album', 8)
ON CONFLICT DO NOTHING;

-- Sample tracks
INSERT INTO tracks (id, album_id, title, duration_ms, track_number, explicit, audio_url, stream_count, audio_features) VALUES
    -- The Midnight - Endless Summer
    ('t1111111-1111-1111-1111-111111111111', 'al111111-1111-1111-1111-111111111111', 'Endless Summer', 256000, 1, false, '/audio/endless_summer.mp3', 45000000, '{"tempo": 118, "energy": 0.75, "danceability": 0.68}'::jsonb),
    ('t1111112-1111-1111-1111-111111111112', 'al111111-1111-1111-1111-111111111111', 'Sunset', 298000, 2, false, '/audio/sunset.mp3', 32000000, '{"tempo": 105, "energy": 0.65, "danceability": 0.72}'::jsonb),
    ('t1111113-1111-1111-1111-111111111113', 'al111111-1111-1111-1111-111111111111', 'Los Angeles', 245000, 3, false, '/audio/los_angeles.mp3', 28000000, '{"tempo": 122, "energy": 0.8, "danceability": 0.7}'::jsonb),

    -- The Midnight - Kids
    ('t2222221-2222-2222-2222-222222222221', 'al222222-2222-2222-2222-222222222222', 'Kids', 312000, 1, false, '/audio/kids.mp3', 65000000, '{"tempo": 110, "energy": 0.7, "danceability": 0.65}'::jsonb),
    ('t2222222-2222-2222-2222-222222222222', 'al222222-2222-2222-2222-222222222222', 'America Online', 285000, 2, false, '/audio/america_online.mp3', 38000000, '{"tempo": 115, "energy": 0.72, "danceability": 0.68}'::jsonb),

    -- Aurora - All My Demons
    ('t3333331-3333-3333-3333-333333333331', 'al333333-3333-3333-3333-333333333333', 'Runaway', 252000, 1, false, '/audio/runaway.mp3', 420000000, '{"tempo": 100, "energy": 0.6, "danceability": 0.55}'::jsonb),
    ('t3333332-3333-3333-3333-333333333332', 'al333333-3333-3333-3333-333333333333', 'Running with the Wolves', 218000, 2, false, '/audio/wolves.mp3', 280000000, '{"tempo": 138, "energy": 0.85, "danceability": 0.6}'::jsonb),
    ('t3333333-3333-3333-3333-333333333333', 'al333333-3333-3333-3333-333333333333', 'Warrior', 235000, 3, false, '/audio/warrior.mp3', 95000000, '{"tempo": 92, "energy": 0.55, "danceability": 0.45}'::jsonb),

    -- Khruangbin - Mordechai
    ('t4444441-4444-4444-4444-444444444441', 'al444444-4444-4444-4444-444444444444', 'Time (You and I)', 272000, 1, false, '/audio/time.mp3', 120000000, '{"tempo": 95, "energy": 0.55, "danceability": 0.7}'::jsonb),
    ('t4444442-4444-4444-4444-444444444442', 'al444444-4444-4444-4444-444444444444', 'So We Won''t Forget', 305000, 2, false, '/audio/so_we_wont_forget.mp3', 85000000, '{"tempo": 88, "energy": 0.5, "danceability": 0.65}'::jsonb),

    -- Bonobo - Migration
    ('t5555551-5555-5555-5555-555555555551', 'al555555-5555-5555-5555-555555555555', 'Migration', 242000, 1, false, '/audio/migration.mp3', 55000000, '{"tempo": 118, "energy": 0.65, "danceability": 0.6}'::jsonb),
    ('t5555552-5555-5555-5555-555555555552', 'al555555-5555-5555-5555-555555555555', 'Kerala', 365000, 2, false, '/audio/kerala.mp3', 125000000, '{"tempo": 120, "energy": 0.7, "danceability": 0.72}'::jsonb),

    -- Glass Animals - Dreamland
    ('t6666661-6666-6666-6666-666666666661', 'al666666-6666-6666-6666-666666666666', 'Heat Waves', 238000, 1, false, '/audio/heat_waves.mp3', 2100000000, '{"tempo": 80, "energy": 0.65, "danceability": 0.75}'::jsonb),
    ('t6666662-6666-6666-6666-666666666662', 'al666666-6666-6666-6666-666666666666', 'Dreamland', 185000, 2, false, '/audio/dreamland.mp3', 180000000, '{"tempo": 95, "energy": 0.55, "danceability": 0.68}'::jsonb),
    ('t6666663-6666-6666-6666-666666666663', 'al666666-6666-6666-6666-666666666666', 'Tangerine', 215000, 3, false, '/audio/tangerine.mp3', 420000000, '{"tempo": 100, "energy": 0.7, "danceability": 0.72}'::jsonb),

    -- Tycho - Dive
    ('t7777771-7777-7777-7777-777777777771', 'al777777-7777-7777-7777-777777777777', 'Dive', 315000, 1, false, '/audio/dive.mp3', 45000000, '{"tempo": 115, "energy": 0.6, "danceability": 0.55}'::jsonb),
    ('t7777772-7777-7777-7777-777777777772', 'al777777-7777-7777-7777-777777777777', 'A Walk', 368000, 2, false, '/audio/a_walk.mp3', 95000000, '{"tempo": 108, "energy": 0.65, "danceability": 0.5}'::jsonb)
ON CONFLICT DO NOTHING;

-- Track artists (primary and featured)
INSERT INTO track_artists (track_id, artist_id, is_primary) VALUES
    ('t1111111-1111-1111-1111-111111111111', 'a1111111-1111-1111-1111-111111111111', true),
    ('t1111112-1111-1111-1111-111111111112', 'a1111111-1111-1111-1111-111111111111', true),
    ('t1111113-1111-1111-1111-111111111113', 'a1111111-1111-1111-1111-111111111111', true),
    ('t2222221-2222-2222-2222-222222222221', 'a1111111-1111-1111-1111-111111111111', true),
    ('t2222222-2222-2222-2222-222222222222', 'a1111111-1111-1111-1111-111111111111', true),
    ('t3333331-3333-3333-3333-333333333331', 'a2222222-2222-2222-2222-222222222222', true),
    ('t3333332-3333-3333-3333-333333333332', 'a2222222-2222-2222-2222-222222222222', true),
    ('t3333333-3333-3333-3333-333333333333', 'a2222222-2222-2222-2222-222222222222', true),
    ('t4444441-4444-4444-4444-444444444441', 'a3333333-3333-3333-3333-333333333333', true),
    ('t4444442-4444-4444-4444-444444444442', 'a3333333-3333-3333-3333-333333333333', true),
    ('t5555551-5555-5555-5555-555555555551', 'a4444444-4444-4444-4444-444444444444', true),
    ('t5555552-5555-5555-5555-555555555552', 'a4444444-4444-4444-4444-444444444444', true),
    ('t6666661-6666-6666-6666-666666666661', 'a5555555-5555-5555-5555-555555555555', true),
    ('t6666662-6666-6666-6666-666666666662', 'a5555555-5555-5555-5555-555555555555', true),
    ('t6666663-6666-6666-6666-666666666663', 'a5555555-5555-5555-5555-555555555555', true),
    ('t7777771-7777-7777-7777-777777777771', 'a6666666-6666-6666-6666-666666666666', true),
    ('t7777772-7777-7777-7777-777777777772', 'a6666666-6666-6666-6666-666666666666', true)
ON CONFLICT DO NOTHING;

-- User playlists
INSERT INTO playlists (id, owner_id, name, description, cover_url, is_public, is_collaborative, follower_count) VALUES
    ('pl111111-1111-1111-1111-111111111111', 'u1111111-1111-1111-1111-111111111111', 'Synthwave Dreams', 'The best of synthwave and retro electronic music', 'https://images.unsplash.com/photo-1504898770365-14faca6a7320?w=400', true, false, 1250),
    ('pl222222-2222-2222-2222-222222222222', 'u1111111-1111-1111-1111-111111111111', 'Chill Vibes', 'Perfect for relaxing and unwinding', 'https://images.unsplash.com/photo-1483412033650-1015ddeb83d1?w=400', true, false, 890),
    ('pl333333-3333-3333-3333-333333333333', 'u2222222-2222-2222-2222-222222222222', 'Workout Energy', 'High energy tracks for the gym', 'https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?w=400', true, false, 2100),
    ('pl444444-4444-4444-4444-444444444444', 'u3333333-3333-3333-3333-333333333333', 'Indie Discoveries', 'Hidden gems from indie artists', 'https://images.unsplash.com/photo-1493225457124-a3eb161ffa5f?w=400', true, true, 560)
ON CONFLICT DO NOTHING;

-- Playlist tracks
INSERT INTO playlist_tracks (playlist_id, track_id, position, added_by) VALUES
    ('pl111111-1111-1111-1111-111111111111', 't1111111-1111-1111-1111-111111111111', 0, 'u1111111-1111-1111-1111-111111111111'),
    ('pl111111-1111-1111-1111-111111111111', 't1111112-1111-1111-1111-111111111112', 1, 'u1111111-1111-1111-1111-111111111111'),
    ('pl111111-1111-1111-1111-111111111111', 't2222221-2222-2222-2222-222222222221', 2, 'u1111111-1111-1111-1111-111111111111'),
    ('pl111111-1111-1111-1111-111111111111', 't7777771-7777-7777-7777-777777777771', 3, 'u1111111-1111-1111-1111-111111111111'),
    ('pl222222-2222-2222-2222-222222222222', 't4444441-4444-4444-4444-444444444441', 0, 'u1111111-1111-1111-1111-111111111111'),
    ('pl222222-2222-2222-2222-222222222222', 't4444442-4444-4444-4444-444444444442', 1, 'u1111111-1111-1111-1111-111111111111'),
    ('pl222222-2222-2222-2222-222222222222', 't5555551-5555-5555-5555-555555555551', 2, 'u1111111-1111-1111-1111-111111111111'),
    ('pl222222-2222-2222-2222-222222222222', 't5555552-5555-5555-5555-555555555552', 3, 'u1111111-1111-1111-1111-111111111111'),
    ('pl333333-3333-3333-3333-333333333333', 't3333332-3333-3333-3333-333333333332', 0, 'u2222222-2222-2222-2222-222222222222'),
    ('pl333333-3333-3333-3333-333333333333', 't6666661-6666-6666-6666-666666666661', 1, 'u2222222-2222-2222-2222-222222222222'),
    ('pl333333-3333-3333-3333-333333333333', 't6666663-6666-6666-6666-666666666663', 2, 'u2222222-2222-2222-2222-222222222222'),
    ('pl444444-4444-4444-4444-444444444444', 't3333331-3333-3333-3333-333333333331', 0, 'u3333333-3333-3333-3333-333333333333'),
    ('pl444444-4444-4444-4444-444444444444', 't6666662-6666-6666-6666-666666666662', 1, 'u3333333-3333-3333-3333-333333333333'),
    ('pl444444-4444-4444-4444-444444444444', 't7777772-7777-7777-7777-777777777772', 2, 'u3333333-3333-3333-3333-333333333333')
ON CONFLICT (playlist_id, track_id) DO NOTHING;

-- User library (liked songs)
INSERT INTO user_library (user_id, item_type, item_id) VALUES
    ('u1111111-1111-1111-1111-111111111111', 'track', 't1111111-1111-1111-1111-111111111111'),
    ('u1111111-1111-1111-1111-111111111111', 'track', 't3333331-3333-3333-3333-333333333331'),
    ('u1111111-1111-1111-1111-111111111111', 'track', 't6666661-6666-6666-6666-666666666661'),
    ('u1111111-1111-1111-1111-111111111111', 'album', 'al111111-1111-1111-1111-111111111111'),
    ('u1111111-1111-1111-1111-111111111111', 'artist', 'a1111111-1111-1111-1111-111111111111'),
    ('u2222222-2222-2222-2222-222222222222', 'track', 't6666661-6666-6666-6666-666666666661'),
    ('u2222222-2222-2222-2222-222222222222', 'track', 't3333332-3333-3333-3333-333333333332'),
    ('u2222222-2222-2222-2222-222222222222', 'artist', 'a5555555-5555-5555-5555-555555555555'),
    ('u3333333-3333-3333-3333-333333333333', 'track', 't5555552-5555-5555-5555-555555555552'),
    ('u3333333-3333-3333-3333-333333333333', 'album', 'al333333-3333-3333-3333-333333333333'),
    ('u3333333-3333-3333-3333-333333333333', 'playlist', 'pl111111-1111-1111-1111-111111111111')
ON CONFLICT (user_id, item_type, item_id) DO NOTHING;

-- Listening history
INSERT INTO listening_history (user_id, track_id, played_at, duration_played_ms, completed) VALUES
    ('u1111111-1111-1111-1111-111111111111', 't6666661-6666-6666-6666-666666666661', NOW() - INTERVAL '1 hour', 238000, true),
    ('u1111111-1111-1111-1111-111111111111', 't1111111-1111-1111-1111-111111111111', NOW() - INTERVAL '2 hours', 256000, true),
    ('u1111111-1111-1111-1111-111111111111', 't3333331-3333-3333-3333-333333333331', NOW() - INTERVAL '3 hours', 252000, true),
    ('u1111111-1111-1111-1111-111111111111', 't5555552-5555-5555-5555-555555555552', NOW() - INTERVAL '4 hours', 200000, false),
    ('u2222222-2222-2222-2222-222222222222', 't6666661-6666-6666-6666-666666666661', NOW() - INTERVAL '30 minutes', 238000, true),
    ('u2222222-2222-2222-2222-222222222222', 't6666663-6666-6666-6666-666666666663', NOW() - INTERVAL '1 hour', 215000, true),
    ('u2222222-2222-2222-2222-222222222222', 't3333332-3333-3333-3333-333333333332', NOW() - INTERVAL '2 hours', 218000, true),
    ('u3333333-3333-3333-3333-333333333333', 't4444441-4444-4444-4444-444444444441', NOW() - INTERVAL '45 minutes', 272000, true),
    ('u3333333-3333-3333-3333-333333333333', 't4444442-4444-4444-4444-444444444442', NOW() - INTERVAL '1 hour 30 minutes', 305000, true),
    ('u3333333-3333-3333-3333-333333333333', 't7777772-7777-7777-7777-777777777772', NOW() - INTERVAL '2 hours', 368000, true)
ON CONFLICT DO NOTHING;

-- Playback events (for analytics)
INSERT INTO playback_events (user_id, track_id, event_type, position_ms, device_type) VALUES
    ('u1111111-1111-1111-1111-111111111111', 't6666661-6666-6666-6666-666666666661', 'play', 0, 'desktop'),
    ('u1111111-1111-1111-1111-111111111111', 't6666661-6666-6666-6666-666666666661', 'stream_recorded', 30000, 'desktop'),
    ('u1111111-1111-1111-1111-111111111111', 't6666661-6666-6666-6666-666666666661', 'ended', 238000, 'desktop'),
    ('u2222222-2222-2222-2222-222222222222', 't6666661-6666-6666-6666-666666666661', 'play', 0, 'mobile'),
    ('u2222222-2222-2222-2222-222222222222', 't6666661-6666-6666-6666-666666666661', 'stream_recorded', 30000, 'mobile'),
    ('u2222222-2222-2222-2222-222222222222', 't6666661-6666-6666-6666-666666666661', 'ended', 238000, 'mobile'),
    ('u3333333-3333-3333-3333-333333333333', 't4444441-4444-4444-4444-444444444441', 'play', 0, 'web'),
    ('u3333333-3333-3333-3333-333333333333', 't4444441-4444-4444-4444-444444444441', 'stream_recorded', 30000, 'web')
ON CONFLICT DO NOTHING;
