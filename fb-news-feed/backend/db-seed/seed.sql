-- Facebook News Feed Seed Data
-- Password for all users: password123
-- Hash: $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Users (mix of regular users and celebrities)
INSERT INTO users (id, username, email, password_hash, display_name, bio, avatar_url, role, follower_count, following_count, is_celebrity) VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice', 'alice@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Alice Johnson', 'Software engineer passionate about building great products. Coffee lover.', 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150', 'user', 245, 180, false),
  ('22222222-2222-2222-2222-222222222222', 'bob', 'bob@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Bob Smith', 'Designer & photographer. Capturing moments one photo at a time.', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150', 'user', 532, 245, false),
  ('33333333-3333-3333-3333-333333333333', 'carol', 'carol@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Carol Williams', 'Foodie | Travel enthusiast | Book worm', 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150', 'user', 189, 312, false),
  ('44444444-4444-4444-4444-444444444444', 'david', 'david@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'David Chen', 'Startup founder | Angel investor | Tech enthusiast', 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150', 'user', 8756, 423, false),
  ('55555555-5555-5555-5555-555555555555', 'tech_influencer', 'tech@celebrity.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'TechGuru Official', 'Your daily dose of tech news and reviews. 2M+ followers across platforms.', 'https://images.unsplash.com/photo-1531427186611-ecfd6d936c79?w=150', 'user', 2500000, 150, true),
  ('66666666-6666-6666-6666-666666666666', 'fitness_star', 'fitness@celebrity.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'FitLife Sarah', 'Certified Personal Trainer | Nutrition Coach | Transform your life', 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150', 'user', 1500000, 89, true),
  ('77777777-7777-7777-7777-777777777777', 'admin', 'admin@facebook.local', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Admin User', 'System administrator', NULL, 'admin', 0, 0, false)
ON CONFLICT (email) DO NOTHING;

-- Friendships (bidirectional for friends, one-way for celebrity followers)
INSERT INTO friendships (follower_id, following_id, status) VALUES
  -- Alice and Bob are mutual friends
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'active'),
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'active'),
  -- Alice and Carol are mutual friends
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'active'),
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'active'),
  -- Bob and David are mutual friends
  ('22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', 'active'),
  ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', 'active'),
  -- Everyone follows celebrities
  ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555', 'active'),
  ('22222222-2222-2222-2222-222222222222', '55555555-5555-5555-5555-555555555555', 'active'),
  ('33333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', 'active'),
  ('44444444-4444-4444-4444-444444444444', '55555555-5555-5555-5555-555555555555', 'active'),
  ('11111111-1111-1111-1111-111111111111', '66666666-6666-6666-6666-666666666666', 'active'),
  ('33333333-3333-3333-3333-333333333333', '66666666-6666-6666-6666-666666666666', 'active'),
  -- Pending friend request
  ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'pending')
ON CONFLICT (follower_id, following_id) DO NOTHING;

-- Posts from various users
INSERT INTO posts (id, author_id, content, image_url, post_type, privacy, like_count, comment_count, share_count, created_at) VALUES
  -- Alice's posts
  ('aaaa1111-0001-0001-0001-000000000001', '11111111-1111-1111-1111-111111111111', 'Just deployed my first microservices architecture to production! Feels amazing when months of work finally pays off. #coding #developer #achievement', NULL, 'text', 'public', 45, 12, 3, NOW() - INTERVAL '2 hours'),
  ('aaaa1111-0001-0001-0001-000000000002', '11111111-1111-1111-1111-111111111111', 'Perfect morning coffee setup. Ready to tackle the day!', 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=800', 'image', 'friends', 28, 5, 0, NOW() - INTERVAL '1 day'),
  ('aaaa1111-0001-0001-0001-000000000003', '11111111-1111-1111-1111-111111111111', 'Great article about system design patterns. Highly recommend for anyone building distributed systems!', NULL, 'link', 'public', 15, 2, 8, NOW() - INTERVAL '3 days'),

  -- Bob's posts
  ('bbbb2222-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222222', 'Captured this amazing sunset at the Golden Gate Bridge. Sometimes you just need to stop and appreciate the beauty around you.', 'https://images.unsplash.com/photo-1501594907352-04cda38ebc29?w=800', 'image', 'public', 156, 23, 12, NOW() - INTERVAL '4 hours'),
  ('bbbb2222-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222222', 'New camera gear arrived! Canon R5 is a beast. Time to take my photography to the next level.', 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?w=800', 'image', 'friends', 89, 15, 2, NOW() - INTERVAL '2 days'),

  -- Carol's posts
  ('cccc3333-0001-0001-0001-000000000001', '33333333-3333-3333-3333-333333333333', 'Finally tried that new ramen place downtown. The tonkotsu was incredible - rich, creamy, and perfectly balanced. 10/10 would recommend!', 'https://images.unsplash.com/photo-1557872943-16a5ac26437e?w=800', 'image', 'public', 67, 18, 4, NOW() - INTERVAL '6 hours'),
  ('cccc3333-0001-0001-0001-000000000002', '33333333-3333-3333-3333-333333333333', 'Just finished "Atomic Habits" by James Clear. Life-changing book! What are you reading right now?', NULL, 'text', 'public', 34, 28, 6, NOW() - INTERVAL '1 day'),

  -- David's posts
  ('dddd4444-0001-0001-0001-000000000001', '44444444-4444-4444-4444-444444444444', 'Excited to announce our Series A funding! $10M to revolutionize the way teams collaborate. Thank you to all our investors and early users who believed in us.', NULL, 'text', 'public', 523, 89, 156, NOW() - INTERVAL '12 hours'),
  ('dddd4444-0001-0001-0001-000000000002', '44444444-4444-4444-4444-444444444444', 'Hiring! Looking for senior engineers who want to solve hard problems. DM me if interested.', NULL, 'text', 'public', 234, 45, 78, NOW() - INTERVAL '3 days'),

  -- TechGuru posts (celebrity)
  ('eeee5555-0001-0001-0001-000000000001', '55555555-5555-5555-5555-555555555555', 'BREAKING: Apple announces new M4 chips with unprecedented AI capabilities. Thread below with all the details you need to know.', 'https://images.unsplash.com/photo-1517336714731-489689fd1ca8?w=800', 'image', 'public', 15234, 2341, 5678, NOW() - INTERVAL '3 hours'),
  ('eeee5555-0001-0001-0001-000000000002', '55555555-5555-5555-5555-555555555555', 'Just got early access to the new VR headset. Full review coming this weekend. What questions do you want me to answer?', NULL, 'text', 'public', 8923, 1567, 234, NOW() - INTERVAL '1 day'),

  -- FitLife Sarah posts (celebrity)
  ('ffff6666-0001-0001-0001-000000000001', '66666666-6666-6666-6666-666666666666', 'Morning workout complete! Remember: consistency beats intensity. Show up every day, even when you dont feel like it.', 'https://images.unsplash.com/photo-1517836357463-d25dfeac3438?w=800', 'image', 'public', 23456, 3421, 1234, NOW() - INTERVAL '5 hours'),
  ('ffff6666-0001-0001-0001-000000000002', '66666666-6666-6666-6666-666666666666', 'New meal prep video is live! 5 easy high-protein recipes you can make in under 30 minutes. Link in bio!', NULL, 'text', 'public', 12345, 2156, 890, NOW() - INTERVAL '2 days')
ON CONFLICT DO NOTHING;

-- Likes
INSERT INTO likes (user_id, post_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 'bbbb2222-0001-0001-0001-000000000001'),
  ('11111111-1111-1111-1111-111111111111', 'cccc3333-0001-0001-0001-000000000001'),
  ('11111111-1111-1111-1111-111111111111', 'eeee5555-0001-0001-0001-000000000001'),
  ('22222222-2222-2222-2222-222222222222', 'aaaa1111-0001-0001-0001-000000000001'),
  ('22222222-2222-2222-2222-222222222222', 'dddd4444-0001-0001-0001-000000000001'),
  ('33333333-3333-3333-3333-333333333333', 'aaaa1111-0001-0001-0001-000000000001'),
  ('33333333-3333-3333-3333-333333333333', 'bbbb2222-0001-0001-0001-000000000001'),
  ('33333333-3333-3333-3333-333333333333', 'ffff6666-0001-0001-0001-000000000001'),
  ('44444444-4444-4444-4444-444444444444', 'aaaa1111-0001-0001-0001-000000000001'),
  ('44444444-4444-4444-4444-444444444444', 'bbbb2222-0001-0001-0001-000000000001')
ON CONFLICT (user_id, post_id) DO NOTHING;

-- Comments
INSERT INTO comments (id, user_id, post_id, content, like_count) VALUES
  ('cmt11111-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222222', 'aaaa1111-0001-0001-0001-000000000001', 'Congrats Alice! Microservices are no joke. What stack did you use?', 5),
  ('cmt11111-0001-0001-0001-000000000002', '33333333-3333-3333-3333-333333333333', 'aaaa1111-0001-0001-0001-000000000001', 'Amazing work! Would love to hear more about your architecture decisions.', 3),
  ('cmt11111-0001-0001-0001-000000000003', '11111111-1111-1111-1111-111111111111', 'bbbb2222-0001-0001-0001-000000000001', 'Stunning shot Bob! The colors are incredible.', 8),
  ('cmt11111-0001-0001-0001-000000000004', '44444444-4444-4444-4444-444444444444', 'bbbb2222-0001-0001-0001-000000000001', 'This should be on a postcard! Beautiful work.', 4),
  ('cmt11111-0001-0001-0001-000000000005', '11111111-1111-1111-1111-111111111111', 'cccc3333-0001-0001-0001-000000000001', 'What is the name of the place? I need to try it!', 2),
  ('cmt11111-0001-0001-0001-000000000006', '22222222-2222-2222-2222-222222222222', 'dddd4444-0001-0001-0001-000000000001', 'Huge congratulations David! Well deserved.', 12)
ON CONFLICT DO NOTHING;

-- Feed items (pre-computed for Alice's feed)
INSERT INTO feed_items (user_id, post_id, score, created_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 'bbbb2222-0001-0001-0001-000000000001', 95.5, NOW() - INTERVAL '4 hours'),
  ('11111111-1111-1111-1111-111111111111', 'cccc3333-0001-0001-0001-000000000001', 88.2, NOW() - INTERVAL '6 hours'),
  ('11111111-1111-1111-1111-111111111111', 'dddd4444-0001-0001-0001-000000000001', 78.9, NOW() - INTERVAL '12 hours'),
  ('11111111-1111-1111-1111-111111111111', 'eeee5555-0001-0001-0001-000000000001', 92.1, NOW() - INTERVAL '3 hours'),
  ('11111111-1111-1111-1111-111111111111', 'ffff6666-0001-0001-0001-000000000001', 85.7, NOW() - INTERVAL '5 hours')
ON CONFLICT (user_id, post_id) DO NOTHING;

-- Affinity scores (for ranking)
INSERT INTO affinity_scores (user_id, target_user_id, score, last_interaction_at) VALUES
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 0.85, NOW() - INTERVAL '1 day'),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 0.72, NOW() - INTERVAL '2 days'),
  ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555', 0.45, NOW() - INTERVAL '3 hours'),
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 0.88, NOW() - INTERVAL '12 hours'),
  ('22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', 0.65, NOW() - INTERVAL '3 days')
ON CONFLICT (user_id, target_user_id) DO NOTHING;

-- Notifications
INSERT INTO notifications (user_id, actor_id, type, entity_type, entity_id, is_read) VALUES
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'like', 'post', 'aaaa1111-0001-0001-0001-000000000001', false),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'comment', 'post', 'aaaa1111-0001-0001-0001-000000000001', false),
  ('11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444', 'friend_request', 'user', '44444444-4444-4444-4444-444444444444', true),
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'like', 'post', 'bbbb2222-0001-0001-0001-000000000001', false),
  ('22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'like', 'post', 'bbbb2222-0001-0001-0001-000000000001', true)
ON CONFLICT DO NOTHING;
