-- Tinder Seed Data
-- Password hash for 'password123': $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Sample users (daters)
INSERT INTO users (id, email, password_hash, name, birthdate, gender, bio, job_title, company, school, latitude, longitude, last_active, is_admin)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Alice', '1995-03-15', 'female', 'Coffee lover, dog mom, hiking enthusiast. Looking for someone to explore the city with!', 'Software Engineer', 'Google', 'Stanford University', 37.7749, -122.4194, NOW(), false),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Bob', '1993-07-22', 'male', 'Musician by night, accountant by day. Lets grab a drink and talk about life', 'Senior Accountant', 'Deloitte', 'UC Berkeley', 37.7850, -122.4094, NOW() - INTERVAL '2 hours', false),
  ('33333333-3333-3333-3333-333333333333', 'charlie@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Charlie', '1992-11-08', 'male', 'Foodie, traveler, amateur photographer. Always planning my next adventure', 'Product Manager', 'Airbnb', 'MIT', 37.7600, -122.4350, NOW() - INTERVAL '1 day', false),
  ('44444444-4444-4444-4444-444444444444', 'diana@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Diana', '1996-01-30', 'female', 'Yoga instructor and wellness advocate. Seeking someone with good vibes only', 'Yoga Instructor', 'CorePower Yoga', 'UCLA', 37.7550, -122.4450, NOW() - INTERVAL '30 minutes', false),
  ('55555555-5555-5555-5555-555555555555', 'emma@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Emma', '1994-09-12', 'female', 'Bookworm who loves brunch, indie films, and lazy Sundays. Cats > Dogs', 'Marketing Manager', 'Salesforce', 'Columbia University', 37.7900, -122.3900, NOW() - INTERVAL '3 hours', false),
  ('66666666-6666-6666-6666-666666666666', 'frank@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Frank', '1991-05-25', 'male', 'Startup founder, marathon runner, coffee snob. Looking for my co-pilot in life', 'CEO', 'TechStartup Inc', 'Harvard Business School', 37.7700, -122.4100, NOW() - INTERVAL '5 hours', false),
  ('77777777-7777-7777-7777-777777777777', 'grace@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Grace', '1997-12-03', 'female', 'Art gallery curator by day, salsa dancer by night. Let me show you the city', 'Art Curator', 'SF MOMA', 'Parsons School of Design', 37.7850, -122.4250, NOW() - INTERVAL '1 hour', false),
  ('88888888-8888-8888-8888-888888888888', 'henry@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Henry', '1990-08-18', 'male', 'Chef who loves cooking for two. Fluent in French and sarcasm', 'Head Chef', 'Michelin Star Restaurant', 'Culinary Institute of America', 37.7650, -122.4300, NOW() - INTERVAL '12 hours', false),
  ('99999999-9999-9999-9999-999999999999', 'admin@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Admin', '1985-01-01', 'male', 'Platform administrator', 'Admin', 'Tinder', 'N/A', 37.7749, -122.4194, NOW(), true)
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
  ('99999990-9999-9999-9999-999999999990', '77777777-7777-7777-7777-777777777777', 'https://images.unsplash.com/photo-1529626455594-4ff0802cfb7e?w=600', 0, true),
  ('99999990-9999-9999-9999-999999999991', '77777777-7777-7777-7777-777777777777', 'https://images.unsplash.com/photo-1488426862026-3ee34a7d66df?w=600', 1, false),
  ('99999990-9999-9999-9999-999999999992', '77777777-7777-7777-7777-777777777777', 'https://images.unsplash.com/photo-1524504388940-b1c1722653e1?w=600', 2, false),

  -- Henry's photos
  ('00000000-0000-0000-0000-000000000088', '88888888-8888-8888-8888-888888888888', 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=600', 0, true),
  ('00000000-0000-0000-0000-000000000089', '88888888-8888-8888-8888-888888888888', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=600', 1, false)
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
  ('a0000001-1112-2220-0000-000000000000', '11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', NOW() - INTERVAL '5 days', NOW() - INTERVAL '1 hour'),
  ('a0000001-1113-3330-0000-000000000000', '11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', NOW() - INTERVAL '3 days', NOW() - INTERVAL '2 days'),
  ('a0000001-1118-8880-0000-000000000000', '11111111-1111-1111-1111-111111111111', '88888888-8888-8888-8888-888888888888', NOW() - INTERVAL '1 day', NOW() - INTERVAL '30 minutes'),
  ('a0000002-2224-4440-0000-000000000000', '22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', NOW() - INTERVAL '4 days', NOW() - INTERVAL '6 hours'),
  ('a0000004-4448-8880-0000-000000000000', '44444444-4444-4444-4444-444444444444', '88888888-8888-8888-8888-888888888888', NOW() - INTERVAL '2 days', NULL)
ON CONFLICT DO NOTHING;

-- Sample messages
INSERT INTO messages (id, match_id, sender_id, content, sent_at, read_at)
VALUES
  -- Alice & Bob conversation
  ('b0000001-0000-0000-0000-000000000001', 'a0000001-1112-2220-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'Hey Alice! Love your hiking pics. Which trails do you recommend?', NOW() - INTERVAL '5 days', NOW() - INTERVAL '5 days'),
  ('b0000001-0000-0000-0000-000000000002', 'a0000001-1112-2220-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'Hi Bob! Thanks! I love Lands End and the Dipsea Trail. Have you been?', NOW() - INTERVAL '4 days 22 hours', NOW() - INTERVAL '4 days 22 hours'),
  ('b0000001-0000-0000-0000-000000000003', 'a0000001-1112-2220-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'Ive done Lands End but not Dipsea. Would you want to go together sometime?', NOW() - INTERVAL '4 days', NOW() - INTERVAL '4 days'),
  ('b0000001-0000-0000-0000-000000000004', 'a0000001-1112-2220-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'That sounds fun! How about this weekend?', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days'),
  ('b0000001-0000-0000-0000-000000000005', 'a0000001-1112-2220-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'Perfect! Saturday morning works for me. Ill bring coffee', NOW() - INTERVAL '1 hour', NOW()),

  -- Alice & Henry conversation
  ('b0000001-0000-0000-0000-000000000006', 'a0000001-1118-8880-0000-000000000000', '88888888-8888-8888-8888-888888888888', 'Bonjour! I noticed you like good food. Any favorite spots in the city?', NOW() - INTERVAL '1 day', NOW() - INTERVAL '1 day'),
  ('b0000001-0000-0000-0000-000000000007', 'a0000001-1118-8880-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'Hey! I love State Bird Provisions and Flour + Water. You must know all the best places being a chef!', NOW() - INTERVAL '23 hours', NOW() - INTERVAL '23 hours'),
  ('b0000001-0000-0000-0000-000000000008', 'a0000001-1118-8880-0000-000000000000', '88888888-8888-8888-8888-888888888888', 'Great taste! I could take you to a few hidden gems if youd like', NOW() - INTERVAL '30 minutes', NULL),

  -- Bob & Diana conversation
  ('b0000001-0000-0000-0000-000000000009', 'a0000002-2224-4440-0000-000000000000', '44444444-4444-4444-4444-444444444444', 'Hey! Your bio made me laugh. What kind of music do you play?', NOW() - INTERVAL '4 days', NOW() - INTERVAL '4 days'),
  ('b0000001-0000-0000-0000-000000000010', 'a0000002-2224-4440-0000-000000000000', '22222222-2222-2222-2222-222222222222', 'Thanks! I play guitar and a bit of piano. Mostly indie and folk. Do you have a favorite genre?', NOW() - INTERVAL '3 days 20 hours', NOW() - INTERVAL '3 days'),
  ('b0000001-0000-0000-0000-000000000011', 'a0000002-2224-4440-0000-000000000000', '44444444-4444-4444-4444-444444444444', 'I love anything I can flow to during yoga! Would love to hear you play sometime', NOW() - INTERVAL '6 hours', NOW())
ON CONFLICT DO NOTHING;

-- ============================================================================
-- ADDITIONAL DISCOVERY CANDIDATES
-- ============================================================================
-- Alice (the demo login) had swiped every man the original seed created, so her
-- deck was empty on first launch — the swipe screen, which is the whole product,
-- showed "No more profiles". These profiles are unswiped by Alice and sit inside
-- her filters (male, 25-38, within 25km of 37.7749,-122.4194, active this week),
-- so the deck has cards. Two of them have already liked her, which exercises the
-- +200 reciprocity boost in ranking and turns a right-swipe into a real match.
INSERT INTO users (id, email, password_hash, name, birthdate, gender, bio, job_title, company, school, latitude, longitude, last_active, is_admin)
VALUES
  ('c0000001-0000-4000-8000-000000000001', 'ivan@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Ivan', '1994-06-11', 'male', 'Rock climber and weekend baker. I will absolutely talk your ear off about sourdough starters', 'Structural Engineer', 'Arup', 'Cal Poly', 37.7810, -122.4110, NOW() - INTERVAL '15 minutes', false),
  ('c0000002-0000-4000-8000-000000000002', 'jack@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Jack', '1997-02-19', 'male', 'Bike commuter, board game hoarder, terrible at karaoke but enthusiastic about it', 'Data Scientist', 'Stripe', 'Carnegie Mellon', 37.7690, -122.4290, NOW() - INTERVAL '4 hours', false),
  ('c0000003-0000-4000-8000-000000000003', 'kevin@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Kevin', '1991-10-05', 'male', 'Ex-bartender turned physical therapist. Ask me about the best dive bars in the Mission', 'Physical Therapist', 'UCSF Health', 'Boston University', 37.7930, -122.4020, NOW() - INTERVAL '45 minutes', false),
  ('c0000004-0000-4000-8000-000000000004', 'liam@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Liam', '1998-04-27', 'male', 'Surf at dawn, ship code by ten. Looking for someone who thinks 6am is a reasonable hour', 'iOS Developer', 'Notion', 'UC Santa Cruz', 37.7480, -122.4180, NOW() - INTERVAL '2 days', false),
  ('c0000005-0000-4000-8000-000000000005', 'marcus@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Marcus', '1989-12-14', 'male', 'Documentary nerd, mediocre chess player, very good dog uncle', 'Cinematographer', 'Freelance', 'NYU Tisch', 37.8010, -122.4350, NOW() - INTERVAL '6 hours', false),
  ('c0000006-0000-4000-8000-000000000006', 'nina@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Nina', '1995-08-09', 'female', 'Ceramicist with a caffeine problem. I will make you a mug and expect you to use it', 'Ceramic Artist', 'Studio Ninth', 'RISD', 37.7720, -122.4160, NOW() - INTERVAL '3 hours', false),
  ('c0000007-0000-4000-8000-000000000007', 'olivia@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Olivia', '1993-03-21', 'female', 'ER nurse, trail runner, aggressively competitive at trivia night', 'Registered Nurse', 'Zuckerberg SF General', 'Johns Hopkins', 37.7580, -122.4050, NOW() - INTERVAL '1 hour', false)
ON CONFLICT (email) DO NOTHING;

INSERT INTO user_preferences (user_id, interested_in, age_min, age_max, distance_km, show_me)
VALUES
  ('c0000001-0000-4000-8000-000000000001', ARRAY['female'], 26, 38, 30, true),
  ('c0000002-0000-4000-8000-000000000002', ARRAY['female'], 25, 34, 25, true),
  ('c0000003-0000-4000-8000-000000000003', ARRAY['female'], 27, 40, 40, true),
  ('c0000004-0000-4000-8000-000000000004', ARRAY['female'], 24, 33, 20, true),
  ('c0000005-0000-4000-8000-000000000005', ARRAY['female'], 28, 42, 35, true),
  ('c0000006-0000-4000-8000-000000000006', ARRAY['male'], 27, 40, 30, true),
  ('c0000007-0000-4000-8000-000000000007', ARRAY['male'], 28, 42, 25, true)
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO photos (id, user_id, url, position, is_primary)
VALUES
  ('d0000001-0000-4000-8000-000000000001', 'c0000001-0000-4000-8000-000000000001', 'https://images.unsplash.com/photo-1519085360753-af0119f7cbe7?w=600', 0, true),
  ('d0000002-0000-4000-8000-000000000002', 'c0000002-0000-4000-8000-000000000002', 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=600', 0, true),
  ('d0000003-0000-4000-8000-000000000003', 'c0000003-0000-4000-8000-000000000003', 'https://images.unsplash.com/photo-1521119989659-a83eee488004?w=600', 0, true),
  ('d0000004-0000-4000-8000-000000000004', 'c0000004-0000-4000-8000-000000000004', 'https://images.unsplash.com/photo-1547425260-76bcadfb4f2c?w=600', 0, true),
  ('d0000005-0000-4000-8000-000000000005', 'c0000005-0000-4000-8000-000000000005', 'https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=600', 0, true),
  ('d0000006-0000-4000-8000-000000000006', 'c0000006-0000-4000-8000-000000000006', 'https://images.unsplash.com/photo-1487412720507-e7ab37603c6f?w=600', 0, true),
  ('d0000007-0000-4000-8000-000000000007', 'c0000007-0000-4000-8000-000000000007', 'https://images.unsplash.com/photo-1502378735452-bc7d86632805?w=600', 0, true)
ON CONFLICT DO NOTHING;

-- Ivan and Kevin have already liked Alice. Neither appears in Alice's swipes, so
-- both stay in her deck and rank first via the reciprocity boost; a right-swipe
-- on either produces an immediate mutual match rather than a one-sided like.
INSERT INTO swipes (id, swiper_id, swiped_id, direction)
VALUES
  ('e0000001-0000-4000-8000-000000000001', 'c0000001-0000-4000-8000-000000000001', '11111111-1111-1111-1111-111111111111', 'like'),
  ('e0000002-0000-4000-8000-000000000002', 'c0000003-0000-4000-8000-000000000003', '11111111-1111-1111-1111-111111111111', 'like'),
  ('e0000003-0000-4000-8000-000000000003', 'c0000001-0000-4000-8000-000000000001', 'c0000006-0000-4000-8000-000000000006', 'like'),
  ('e0000004-0000-4000-8000-000000000004', 'c0000002-0000-4000-8000-000000000002', 'c0000006-0000-4000-8000-000000000006', 'like'),
  ('e0000005-0000-4000-8000-000000000005', 'c0000005-0000-4000-8000-000000000005', 'c0000007-0000-4000-8000-000000000007', 'like'),
  ('e0000006-0000-4000-8000-000000000006', 'c0000004-0000-4000-8000-000000000004', '55555555-5555-5555-5555-555555555555', 'pass')
ON CONFLICT DO NOTHING;
