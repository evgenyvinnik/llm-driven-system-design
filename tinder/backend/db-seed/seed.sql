-- Tinder Seed Data
-- Password hash for 'password123': $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Sample users (daters)
INSERT INTO users (id, email, password_hash, name, birthdate, gender, bio, job_title, company, school, latitude, longitude, last_active, is_admin)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Alice', '1995-03-15', 'female', 'Coffee lover, dog mom, hiking enthusiast. Looking for someone to explore the city with!', 'Software Engineer', 'Google', 'Stanford University', 37.7749, -122.4194, NOW(), false),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Bob', '1993-07-22', 'male', 'Musician by night, accountant by day. Lets grab a drink and talk about life', 'Senior Accountant', 'Deloitte', 'UC Berkeley', 37.7850, -122.4094, NOW() - INTERVAL '2 hours', false),
  ('33333333-3333-3333-3333-333333333333', 'charlie@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Charlie', '1992-11-08', 'male', 'Foodie, traveler, amateur photographer. Always planning my next adventure', 'Product Manager', 'Airbnb', 'MIT', 37.7600, -122.4350, NOW() - INTERVAL '1 day', false),
  ('44444444-4444-4444-4444-444444444444', 'diana@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Diana', '1996-01-30', 'female', 'Yoga instructor and wellness advocate. Seeking someone with good vibes only', 'Yoga Instructor', 'CorePower Yoga', 'UCLA', 37.7550, -122.4450, NOW() - INTERVAL '30 minutes', false),
  ('55555555-5555-5555-5555-555555555555', 'emma@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Emma', '1994-09-12', 'female', 'Bookworm who loves brunch, indie films, and lazy Sundays. Cats > Dogs', 'Marketing Manager', 'Salesforce', 'Columbia University', 37.7900, -122.3900, NOW() - INTERVAL '3 hours', false),
  ('66666666-6666-6666-6666-666666666666', 'frank@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Frank', '1991-05-25', 'male', 'Startup founder, marathon runner, coffee snob. Looking for my co-pilot in life', 'CEO', 'TechStartup Inc', 'Harvard Business School', 37.7700, -122.4100, NOW() - INTERVAL '5 hours', false),
  ('77777777-7777-7777-7777-777777777777', 'grace@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Grace', '1997-12-03', 'female', 'Art gallery curator by day, salsa dancer by night. Let me show you the city', 'Art Curator', 'SF MOMA', 'Parsons School of Design', 37.7850, -122.4250, NOW() - INTERVAL '1 hour', false),
  ('88888888-8888-8888-8888-888888888888', 'henry@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Henry', '1990-08-18', 'male', 'Chef who loves cooking for two. Fluent in French and sarcasm', 'Head Chef', 'Michelin Star Restaurant', 'Culinary Institute of America', 37.7650, -122.4300, NOW() - INTERVAL '12 hours', false),
  ('99999999-9999-9999-9999-999999999999', 'admin@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Admin', '1985-01-01', 'male', 'Platform administrator', 'Admin', 'Tinder', 'N/A', 37.7749, -122.4194, NOW(), true)
ON CONFLICT (email) DO NOTHING;

-- User preferences
INSERT INTO user_preferences (user_id, interested_in, age_min, age_max, distance_km, show_me)
VALUES
  ('11111111-1111-1111-1111-111111111111', ARRAY['male'], 25, 38, 25, true),
  ('22222222-2222-2222-2222-222222222222', ARRAY['female'], 23, 35, 30, true),
  ('33333333-3333-3333-3333-333333333333', ARRAY['female'], 24, 36, 40, true),
  ('44444444-4444-4444-4444-444444444444', ARRAY['male'], 25, 40, 20, true),
  ('55555555-5555-5555-5555-555555555555', ARRAY['male'], 26, 38, 35, true),
  ('66666666-6666-6666-6666-666666666666', ARRAY['female'], 24, 35, 50, true),
  ('77777777-7777-7777-7777-777777777777', ARRAY['male'], 25, 40, 25, true),
  ('88888888-8888-8888-8888-888888888888', ARRAY['female'], 24, 38, 30, true)
ON CONFLICT (user_id) DO NOTHING;

-- Profile photos
INSERT INTO photos (id, user_id, url, position, is_primary)
VALUES
  -- Alice's photos
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=600', 0, true),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa1', '11111111-1111-1111-1111-111111111111', 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=600', 1, false),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaa2', '11111111-1111-1111-1111-111111111111', 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=600', 2, false),

  -- Bob's photos
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=600', 0, true),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1', '22222222-2222-2222-2222-222222222222', 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=600', 1, false),

  -- Charlie's photos
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '33333333-3333-3333-3333-333333333333', 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=600', 0, true),
  ('cccccccc-cccc-cccc-cccc-ccccccccccc1', '33333333-3333-3333-3333-333333333333', 'https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=600', 1, false),
  ('cccccccc-cccc-cccc-cccc-ccccccccccc2', '33333333-3333-3333-3333-333333333333', 'https://images.unsplash.com/photo-1463453091185-61582044d556?w=600', 2, false),

  -- Diana's photos
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', '44444444-4444-4444-4444-444444444444', 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=600', 0, true),
  ('dddddddd-dddd-dddd-dddd-ddddddddddd1', '44444444-4444-4444-4444-444444444444', 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=600', 1, false),

  -- Emma's photos
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '55555555-5555-5555-5555-555555555555', 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=600', 0, true),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeee1', '55555555-5555-5555-5555-555555555555', 'https://images.unsplash.com/photo-1531746020798-e6953c6e8e04?w=600', 1, false),

  -- Frank's photos
  ('ffffffff-ffff-ffff-ffff-ffffffffffff', '66666666-6666-6666-6666-666666666666', 'https://images.unsplash.com/photo-1492562080023-ab3db95bfbce?w=600', 0, true),

  -- Grace's photos
  ('gggggggg-gggg-gggg-gggg-gggggggggggg', '77777777-7777-7777-7777-777777777777', 'https://images.unsplash.com/photo-1529626455594-4ff0802cfb7e?w=600', 0, true),
  ('gggggggg-gggg-gggg-gggg-ggggggggggg1', '77777777-7777-7777-7777-777777777777', 'https://images.unsplash.com/photo-1488426862026-3ee34a7d66df?w=600', 1, false),
  ('gggggggg-gggg-gggg-gggg-ggggggggggg2', '77777777-7777-7777-7777-777777777777', 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=600', 2, false),

  -- Henry's photos
  ('hhhhhhhh-hhhh-hhhh-hhhh-hhhhhhhhhhhh', '88888888-8888-8888-8888-888888888888', 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=600', 0, true),
  ('hhhhhhhh-hhhh-hhhh-hhhh-hhhhhhhhhhh1', '88888888-8888-8888-8888-888888888888', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=600', 1, false)
ON CONFLICT DO NOTHING;

-- Sample swipes (some mutual likes to create matches)
INSERT INTO swipes (id, swiper_id, swiped_id, direction)
VALUES
  -- Alice's swipes
  ('11111111-aaaa-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'like'),
  ('11111111-aaaa-2222-1111-111111111111', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'like'),
  ('11111111-aaaa-3333-1111-111111111111', '11111111-1111-1111-1111-111111111111', '66666666-6666-6666-6666-666666666666', 'pass'),
  ('11111111-aaaa-4444-1111-111111111111', '11111111-1111-1111-1111-111111111111', '88888888-8888-8888-8888-888888888888', 'like'),

  -- Bob's swipes
  ('22222222-aaaa-1111-2222-222222222222', '22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'like'),
  ('22222222-aaaa-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', 'like'),
  ('22222222-aaaa-3333-2222-222222222222', '22222222-2222-2222-2222-222222222222', '77777777-7777-7777-7777-777777777777', 'like'),

  -- Charlie's swipes
  ('33333333-aaaa-1111-3333-333333333333', '33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'like'),
  ('33333333-aaaa-2222-3333-333333333333', '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444', 'like'),
  ('33333333-aaaa-3333-3333-333333333333', '33333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', 'pass'),

  -- Diana's swipes
  ('44444444-aaaa-1111-4444-444444444444', '44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', 'like'),
  ('44444444-aaaa-2222-4444-444444444444', '44444444-4444-4444-4444-444444444444', '66666666-6666-6666-6666-666666666666', 'like'),
  ('44444444-aaaa-3333-4444-444444444444', '44444444-4444-4444-4444-444444444444', '88888888-8888-8888-8888-888888888888', 'like'),

  -- Henry's swipes
  ('88888888-aaaa-1111-8888-888888888888', '88888888-8888-8888-8888-888888888888', '11111111-1111-1111-1111-111111111111', 'like'),
  ('88888888-aaaa-2222-8888-888888888888', '88888888-8888-8888-8888-888888888888', '44444444-4444-4444-4444-444444444444', 'like'),
  ('88888888-aaaa-3333-8888-888888888888', '88888888-8888-8888-8888-888888888888', '55555555-5555-5555-5555-555555555555', 'like')
ON CONFLICT DO NOTHING;

-- Matches (created from mutual likes)
-- Note: user1_id < user2_id to maintain ordering constraint
INSERT INTO matches (id, user1_id, user2_id, matched_at, last_message_at)
VALUES
  ('match-1111-2222-0000-000000000000', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', NOW() - INTERVAL '5 days', NOW() - INTERVAL '1 hour'),
  ('match-1111-3333-0000-000000000000', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', NOW() - INTERVAL '3 days', NOW() - INTERVAL '2 days'),
  ('match-1111-8888-0000-000000000000', '11111111-1111-1111-1111-111111111111', '88888888-8888-8888-8888-888888888888', NOW() - INTERVAL '1 day', NOW() - INTERVAL '30 minutes'),
  ('match-2222-4444-0000-000000000000', '22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', NOW() - INTERVAL '4 days', NOW() - INTERVAL '6 hours'),
  ('match-4444-8888-0000-000000000000', '44444444-4444-4444-4444-444444444444', '88888888-8888-8888-8888-888888888888', NOW() - INTERVAL '2 days', NULL)
ON CONFLICT DO NOTHING;

-- Sample messages
INSERT INTO messages (id, match_id, sender_id, content, sent_at, read_at)
VALUES
  -- Alice & Bob conversation
  ('msg-0001-0000-0000-000000000000', 'match-1111-2222-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'Hey Alice! Love your hiking pics. Which trails do you recommend?', NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days'),
  ('msg-0002-0000-0000-000000000000', 'match-1111-2222-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'Hi Bob! Thanks! I love Lands End and the Dipsea Trail. Have you been?', NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days'),
  ('msg-0003-0000-0000-000000000000', 'match-1111-2222-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'Ive done Lands End but not Dipsea. Would you want to go together sometime?', NOW() - INTERVAL '4 days', NOW() - INTERVAL '4 days'),
  ('msg-0004-0000-0000-000000000000', 'match-1111-2222-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'That sounds fun! How about this weekend?', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days'),
  ('msg-0005-0000-0000-000000000000', 'match-1111-2222-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'Perfect! Saturday morning works for me. Ill bring coffee', NOW() - INTERVAL '1 hour', NOW()),

  -- Alice & Henry conversation
  ('msg-0006-0000-0000-000000000000', 'match-1111-8888-0000-000000000000', '88888888-8888-8888-8888-888888888888', 'Bonjour! I noticed you like good food. Any favorite spots in the city?', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day'),
  ('msg-0007-0000-0000-000000000000', 'match-1111-8888-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'Hey! I love State Bird Provisions and Flour + Water. You must know all the best places being a chef!', NOW() - INTERVAL '23 hours', NOW() - INTERVAL '23 hours'),
  ('msg-0008-0000-0000-000000000000', 'match-1111-8888-0000-000000000000', '88888888-8888-8888-8888-888888888888', 'Great taste! I could take you to a few hidden gems if youd like', NOW() - INTERVAL '30 minutes', NULL),

  -- Bob & Diana conversation
  ('msg-0009-0000-0000-000000000000', 'match-2222-4444-0000-000000000000', '44444444-4444-4444-4444-444444444444', 'Hey! Your bio made me laugh. What kind of music do you play?', NOW() - INTERVAL '4 days', NOW() - INTERVAL '4 days'),
  ('msg-0010-0000-0000-000000000000', 'match-2222-4444-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'Thanks! I play guitar and a bit of piano. Mostly indie and folk. Do you have a favorite genre?', NOW() - INTERVAL '4 days', NOW() - INTERVAL '3 days'),
  ('msg-0011-0000-0000-000000000000', 'match-2222-4444-0000-000000000000', '44444444-4444-4444-4444-444444444444', 'I love anything I can flow to during yoga! Would love to hear you play sometime', NOW() - INTERVAL '6 hours', NOW())
ON CONFLICT DO NOTHING;
