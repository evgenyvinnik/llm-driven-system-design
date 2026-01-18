-- Facebook Post Search Seed Data
-- Password for all users: password123
-- Hash: $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Users
INSERT INTO users (id, username, email, display_name, password_hash, avatar_url, role) VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice', 'alice@example.com', 'Alice Johnson', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150', 'user'),
  ('22222222-2222-2222-2222-222222222222', 'bob', 'bob@example.com', 'Bob Smith', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150', 'user'),
  ('33333333-3333-3333-3333-333333333333', 'carol', 'carol@example.com', 'Carol Williams', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150', 'user'),
  ('44444444-4444-4444-4444-444444444444', 'david', 'david@example.com', 'David Chen', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150', 'user'),
  ('55555555-5555-5555-5555-555555555555', 'emma', 'emma@example.com', 'Emma Garcia', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=150', 'user'),
  ('66666666-6666-6666-6666-666666666666', 'admin', 'admin@facebook.local', 'Admin User', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', NULL, 'admin')
ON CONFLICT (email) DO NOTHING;

-- Friendships (bidirectional)
INSERT INTO friendships (user_id, friend_id, status) VALUES
  -- Alice's friends
  ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'accepted'),
  ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'accepted'),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', 'accepted'),
  ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'accepted'),
  -- Bob's additional friends
  ('22222222-2222-2222-2222-222222222222', '44444444-4444-4444-4444-444444444444', 'accepted'),
  ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', 'accepted'),
  ('22222222-2222-2222-2222-222222222222', '55555555-5555-5555-5555-555555555555', 'accepted'),
  ('55555555-5555-5555-5555-555555555555', '22222222-2222-2222-2222-222222222222', 'accepted'),
  -- Carol's additional friends
  ('33333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', 'accepted'),
  ('55555555-5555-5555-5555-555555555555', '33333333-3333-3333-3333-333333333333', 'accepted'),
  -- Pending requests
  ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'pending')
ON CONFLICT (user_id, friend_id) DO NOTHING;

-- Posts with various visibility levels (for search testing)
INSERT INTO posts (id, author_id, content, visibility, post_type, media_url, like_count, comment_count, share_count, created_at) VALUES
  -- Alice's posts (searchable by friends)
  ('aaaa1111-0001-0001-0001-000000000001', '11111111-1111-1111-1111-111111111111',
   'Just finished reading "Clean Code" by Robert Martin. Every developer should read this book! The principles of writing readable and maintainable code are timeless. #programming #cleancode #developer',
   'public', 'text', NULL, 45, 12, 8, NOW() - INTERVAL '2 hours'),

  ('aaaa1111-0001-0001-0001-000000000002', '11111111-1111-1111-1111-111111111111',
   'Beautiful sunset hike at Mount Tamalpais today. Nature is the best way to recharge after a busy week of coding.',
   'friends', 'photo', 'https://images.unsplash.com/photo-1469474968028-56623f02e42e?w=800', 32, 8, 2, NOW() - INTERVAL '1 day'),

  ('aaaa1111-0001-0001-0001-000000000003', '11111111-1111-1111-1111-111111111111',
   'Learning about microservices architecture. The trade-offs between monolith and microservices are fascinating. Anyone have recommendations for good resources?',
   'public', 'text', NULL, 28, 15, 5, NOW() - INTERVAL '3 days'),

  -- Bob's posts
  ('bbbb2222-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222222',
   'Street photography in San Francisco today. Love how the fog creates such a moody atmosphere. Check out this shot from the Golden Gate!',
   'public', 'photo', 'https://images.unsplash.com/photo-1449034446853-66c86144b0ad?w=800', 156, 34, 23, NOW() - INTERVAL '4 hours'),

  ('bbbb2222-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222222',
   'New camera gear review: The Sony A7IV is absolutely incredible for both photo and video. Best hybrid camera I have ever used.',
   'public', 'text', NULL, 89, 22, 15, NOW() - INTERVAL '2 days'),

  ('bbbb2222-0001-0001-0001-000000000003', '22222222-2222-2222-2222-222222222222',
   'Family dinner at grandmas house. Some moments are too precious to share with everyone.',
   'private', 'photo', 'https://images.unsplash.com/photo-1529566652340-2c41a1eb6d93?w=800', 12, 3, 0, NOW() - INTERVAL '5 days'),

  -- Carol's posts
  ('cccc3333-0001-0001-0001-000000000001', '33333333-3333-3333-3333-333333333333',
   'Recipe alert! Made the most amazing sourdough bread today. The secret is patience and a good starter. Sharing the recipe in the comments!',
   'public', 'photo', 'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=800', 234, 67, 45, NOW() - INTERVAL '6 hours'),

  ('cccc3333-0001-0001-0001-000000000002', '33333333-3333-3333-3333-333333333333',
   'Travel planning for Japan in spring. Cherry blossom season is calling! Any recommendations for off-the-beaten-path spots in Kyoto?',
   'friends', 'text', NULL, 56, 28, 4, NOW() - INTERVAL '1 day'),

  ('cccc3333-0001-0001-0001-000000000003', '33333333-3333-3333-3333-333333333333',
   'Book club meeting tonight! We are discussing "Project Hail Mary" by Andy Weir. Such a great sci-fi adventure!',
   'friends_of_friends', 'text', NULL, 23, 11, 2, NOW() - INTERVAL '3 days'),

  -- David's posts
  ('dddd4444-0001-0001-0001-000000000001', '44444444-4444-4444-4444-444444444444',
   'Excited to announce that our startup just closed Series A funding! $15M to build the future of developer tools. Thanks to everyone who believed in us!',
   'public', 'text', NULL, 567, 123, 89, NOW() - INTERVAL '8 hours'),

  ('dddd4444-0001-0001-0001-000000000002', '44444444-4444-4444-4444-444444444444',
   'Hiring senior engineers! We are building something amazing at TechStartup. Looking for people who love solving hard problems with distributed systems.',
   'public', 'text', NULL, 234, 45, 67, NOW() - INTERVAL '2 days'),

  ('dddd4444-0001-0001-0001-000000000003', '44444444-4444-4444-4444-444444444444',
   'Weekend hackathon project: Built a real-time collaborative code editor. Using CRDTs for conflict resolution. Pretty happy with how it turned out!',
   'public', 'link', NULL, 189, 56, 34, NOW() - INTERVAL '4 days'),

  -- Emma's posts
  ('eeee5555-0001-0001-0001-000000000001', '55555555-5555-5555-5555-555555555555',
   'Morning yoga routine complete! Starting the day with mindfulness makes such a difference. Here is my favorite sequence for energy and focus.',
   'public', 'photo', 'https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=800', 145, 32, 18, NOW() - INTERVAL '5 hours'),

  ('eeee5555-0001-0001-0001-000000000002', '55555555-5555-5555-5555-555555555555',
   'Just finished a 30-day meditation challenge. The mental clarity and reduced stress are real! Highly recommend starting with just 5 minutes a day.',
   'public', 'text', NULL, 178, 45, 23, NOW() - INTERVAL '1 day'),

  ('eeee5555-0001-0001-0001-000000000003', '55555555-5555-5555-5555-555555555555',
   'Plant-based cooking experiment: Thai green curry with homemade paste. Turned out amazing! Recipe coming soon to my blog.',
   'friends', 'photo', 'https://images.unsplash.com/photo-1455619452474-d2be8b1e70cd?w=800', 67, 19, 5, NOW() - INTERVAL '3 days')
ON CONFLICT DO NOTHING;

-- Search history
INSERT INTO search_history (user_id, query, filters, results_count, created_at) VALUES
  ('11111111-1111-1111-1111-111111111111', 'photography tips', '{"post_type": "text"}', 23, NOW() - INTERVAL '1 hour'),
  ('11111111-1111-1111-1111-111111111111', 'sourdough recipe', NULL, 15, NOW() - INTERVAL '1 day'),
  ('11111111-1111-1111-1111-111111111111', 'microservices', '{"date_from": "2024-01-01"}', 42, NOW() - INTERVAL '2 days'),
  ('22222222-2222-2222-2222-222222222222', 'camera review', NULL, 18, NOW() - INTERVAL '3 hours'),
  ('22222222-2222-2222-2222-222222222222', 'San Francisco', '{"post_type": "photo"}', 56, NOW() - INTERVAL '5 hours'),
  ('33333333-3333-3333-3333-333333333333', 'Japan travel', NULL, 34, NOW() - INTERVAL '2 hours'),
  ('33333333-3333-3333-3333-333333333333', 'book recommendations', NULL, 67, NOW() - INTERVAL '1 day'),
  ('44444444-4444-4444-4444-444444444444', 'startup funding', NULL, 89, NOW() - INTERVAL '6 hours'),
  ('55555555-5555-5555-5555-555555555555', 'yoga routine', NULL, 45, NOW() - INTERVAL '4 hours'),
  ('55555555-5555-5555-5555-555555555555', 'meditation', NULL, 78, NOW() - INTERVAL '2 days')
ON CONFLICT DO NOTHING;
