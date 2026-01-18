-- Strava Seed Data
-- Password hash for 'password123': $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Sample users (athletes)
INSERT INTO users (id, username, email, password_hash, profile_photo, weight_kg, bio, location, role)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice_runner', 'alice@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=200', 58.5, 'Marathon runner and trail enthusiast. Boston 2024 qualifier!', 'San Francisco, CA', 'user'),
  ('22222222-2222-2222-2222-222222222222', 'bob_cyclist', 'bob@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=200', 75.0, 'Weekend warrior on two wheels. Love climbing hills!', 'Oakland, CA', 'user'),
  ('33333333-3333-3333-3333-333333333333', 'charlie_tri', 'charlie@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=200', 72.0, 'Ironman finisher, always training for the next one', 'Berkeley, CA', 'user'),
  ('44444444-4444-4444-4444-444444444444', 'diana_hiker', 'diana@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=200', 62.0, 'Hiking and nature lover. 50 peaks challenge in progress!', 'Marin County, CA', 'user'),
  ('55555555-5555-5555-5555-555555555555', 'admin', 'admin@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=200', 70.0, 'Platform administrator', 'San Francisco, CA', 'admin')
ON CONFLICT (username) DO NOTHING;

-- Follow relationships (athletes following each other)
INSERT INTO follows (follower_id, following_id)
VALUES
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333'),
  ('11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444'),
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333'),
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111'),
  ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444'),
  ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111'),
  ('44444444-4444-4444-4444-444444444444', '33333333-3333-3333-3333-333333333333')
ON CONFLICT DO NOTHING;

-- Sample activities
INSERT INTO activities (id, user_id, type, name, description, start_time, elapsed_time, moving_time, distance, elevation_gain, calories, avg_heart_rate, max_heart_rate, avg_speed, max_speed, privacy, polyline, start_lat, start_lng, end_lat, end_lng, kudos_count, comment_count)
VALUES
  -- Alice's runs
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'run', 'Morning Run in Golden Gate Park', 'Beautiful foggy morning run through the park', NOW() - INTERVAL '2 days', 3600, 3420, 10500.00, 125.50, 650, 152, 175, 2.92, 4.10, 'public', 'c_~rFnechVm@s@o@q@', 37.7694, -122.4862, 37.7750, -122.4650, 5, 2),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '11111111-1111-1111-1111-111111111111', 'run', 'Tempo Run on Embarcadero', 'Fast tempo session along the waterfront', NOW() - INTERVAL '5 days', 2700, 2650, 8000.00, 45.00, 520, 165, 182, 3.02, 4.50, 'public', 'd_~rFnechVq@s@', 37.8024, -122.4058, 37.7900, -122.3950, 8, 1),

  -- Bob's rides
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '22222222-2222-2222-2222-222222222222', 'ride', 'Sunday Century Ride', 'Epic 100-mile ride through Marin', NOW() - INTERVAL '3 days', 18000, 17200, 160000.00, 1850.00, 4200, 142, 168, 8.89, 15.20, 'public', 'e_~rFnechVs@u@', 37.8700, -122.5100, 38.0500, -122.8000, 12, 4),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', '22222222-2222-2222-2222-222222222222', 'ride', 'Hawk Hill Repeats', 'Training ride with 5x Hawk Hill', NOW() - INTERVAL '7 days', 7200, 6800, 45000.00, 920.00, 1800, 155, 178, 6.25, 12.50, 'public', 'f_~rFnechVu@w@', 37.8270, -122.4993, 37.8350, -122.4800, 6, 2),

  -- Charlie's tri training
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '33333333-3333-3333-3333-333333333333', 'swim', 'Open Water Swim at Aquatic Park', 'Cold but refreshing morning swim', NOW() - INTERVAL '1 day', 2400, 2300, 2000.00, 0.00, 400, 125, 145, 0.83, 1.10, 'public', NULL, 37.8070, -122.4217, 37.8070, -122.4217, 3, 1),
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', '33333333-3333-3333-3333-333333333333', 'run', 'Brick Workout - Run off the Bike', 'Transition training for upcoming race', NOW() - INTERVAL '4 days', 4800, 4500, 12000.00, 180.00, 800, 158, 175, 2.50, 3.80, 'followers', 'g_~rFnechVw@y@', 37.7749, -122.4194, 37.7850, -122.4100, 4, 0),

  -- Diana's hikes
  ('11112222-3333-4444-5555-666677778888', '44444444-4444-4444-4444-444444444444', 'hike', 'Mount Tam Summit via Matt Davis Trail', 'Stunning views from the top!', NOW() - INTERVAL '6 days', 14400, 12000, 18000.00, 850.00, 1200, 115, 145, 1.25, 2.00, 'public', 'h_~rFnechVy@{@', 37.9035, -122.5960, 37.9285, -122.5800, 9, 3),
  ('22223333-4444-5555-6666-777788889999', '44444444-4444-4444-4444-444444444444', 'hike', 'Muir Woods Loop', 'Peaceful walk among the redwoods', NOW() - INTERVAL '10 days', 7200, 6600, 9500.00, 320.00, 600, 105, 130, 1.32, 1.80, 'public', 'i_~rFnechV{@}@', 37.8970, -122.5811, 37.8970, -122.5811, 7, 2)
ON CONFLICT DO NOTHING;

-- Sample segments
INSERT INTO segments (id, creator_id, name, activity_type, distance, elevation_gain, polyline, start_lat, start_lng, end_lat, end_lng, min_lat, min_lng, max_lat, max_lng, effort_count, athlete_count)
VALUES
  ('aaaabbbb-cccc-dddd-eeee-ffffggggaaaa', '11111111-1111-1111-1111-111111111111', 'Golden Gate Park Loop', 'run', 5000.00, 50.00, 'j_~rFnechV}@_A', 37.7694, -122.4862, 37.7750, -122.4750, 37.7650, -122.4900, 37.7800, -122.4700, 45, 23),
  ('bbbbcccc-dddd-eeee-ffff-gggghhhhbbbb', '22222222-2222-2222-2222-222222222222', 'Hawk Hill Climb', 'ride', 2500.00, 180.00, 'k_~rFnechV_AA_B', 37.8270, -122.4993, 37.8350, -122.4850, 37.8250, -122.5000, 37.8400, -122.4800, 156, 89),
  ('ccccdddd-eeee-ffff-gggg-hhhhiiiiccc', '44444444-4444-4444-4444-444444444444', 'Dipsea Trail Segment', 'hike', 3500.00, 280.00, 'l_~rFnechVaAbAcA', 37.8970, -122.5300, 37.9100, -122.5200, 37.8950, -122.5350, 37.9150, -122.5150, 78, 42)
ON CONFLICT DO NOTHING;

-- Sample segment efforts
INSERT INTO segment_efforts (id, segment_id, activity_id, user_id, elapsed_time, moving_time, avg_speed, max_speed, pr_rank)
VALUES
  ('11112222-aaaa-bbbb-cccc-ddddeeeeffff', 'aaaabbbb-cccc-dddd-eeee-ffffggggaaaa', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 1200, 1180, 4.17, 5.50, 1),
  ('22223333-aaaa-bbbb-cccc-ddddeeeeffff', 'bbbbcccc-dddd-eeee-ffff-gggghhhhbbbb', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '22222222-2222-2222-2222-222222222222', 480, 475, 5.21, 8.50, 2),
  ('33334444-aaaa-bbbb-cccc-ddddeeeeffff', 'ccccdddd-eeee-ffff-gggg-hhhhiiiiccc', '11112222-3333-4444-5555-666677778888', '44444444-4444-4444-4444-444444444444', 2100, 2000, 1.67, 2.50, 1)
ON CONFLICT DO NOTHING;

-- Sample kudos
INSERT INTO kudos (activity_id, user_id)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '44444444-4444-4444-4444-444444444444'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '33333333-3333-3333-3333-333333333333'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '44444444-4444-4444-4444-444444444444'),
  ('11112222-3333-4444-5555-666677778888', '11111111-1111-1111-1111-111111111111'),
  ('11112222-3333-4444-5555-666677778888', '22222222-2222-2222-2222-222222222222'),
  ('11112222-3333-4444-5555-666677778888', '33333333-3333-3333-3333-333333333333')
ON CONFLICT DO NOTHING;

-- Sample comments
INSERT INTO comments (id, activity_id, user_id, content)
VALUES
  ('11111111-aaaa-bbbb-cccc-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '22222222-2222-2222-2222-222222222222', 'Great pace! Looking strong for Boston!'),
  ('22222222-aaaa-bbbb-cccc-222222222222', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'Love that route through GGP!'),
  ('33333333-aaaa-bbbb-cccc-333333333333', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111', 'Epic century! Those hills are no joke.'),
  ('44444444-aaaa-bbbb-cccc-444444444444', '11112222-3333-4444-5555-666677778888', '22222222-2222-2222-2222-222222222222', 'Mount Tam is on my bucket list!'),
  ('55555555-aaaa-bbbb-cccc-555555555555', '11112222-3333-4444-5555-666677778888', '33333333-3333-3333-3333-333333333333', 'The views from the summit are incredible!')
ON CONFLICT DO NOTHING;

-- Sample privacy zones
INSERT INTO privacy_zones (id, user_id, name, center_lat, center_lng, radius_meters)
VALUES
  ('11111111-pppp-qqqq-rrrr-111111111111', '11111111-1111-1111-1111-111111111111', 'Home', 37.7749, -122.4194, 500),
  ('22222222-pppp-qqqq-rrrr-222222222222', '22222222-2222-2222-2222-222222222222', 'Home', 37.8044, -122.2712, 500),
  ('33333333-pppp-qqqq-rrrr-333333333333', '33333333-3333-3333-3333-333333333333', 'Home', 37.8716, -122.2727, 500),
  ('44444444-pppp-qqqq-rrrr-444444444444', '44444444-4444-4444-4444-444444444444', 'Home', 37.8716, -122.5200, 500)
ON CONFLICT DO NOTHING;
