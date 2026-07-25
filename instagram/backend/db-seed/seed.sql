-- Seed script for Instagram Clone
-- Creates sample users, posts, stories, comments, likes, and follows
-- Password for all users: password123

-- Create users (password hash for 'password123' with bcrypt)
INSERT INTO users (id, username, email, password_hash, display_name, bio, profile_picture_url, is_private, role)
VALUES
    ('11111111-1111-1111-1111-111111111111', 'alice', 'alice@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Alice Johnson', 'Photographer | Travel enthusiast | Coffee addict', 'https://i.pravatar.cc/150?u=alice', false, 'user'),
    ('22222222-2222-2222-2222-222222222222', 'bob', 'bob@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Bob Smith', 'Foodie | Chef in training | Living the good life', 'https://i.pravatar.cc/150?u=bob', false, 'user'),
    ('33333333-3333-3333-3333-333333333333', 'carol', 'carol@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Carol Davis', 'Artist | Nature lover | Dog mom', 'https://i.pravatar.cc/150?u=carol', false, 'user'),
    ('44444444-4444-4444-4444-444444444444', 'david', 'david@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'David Wilson', 'Tech geek | Gamer | Coffee lover', 'https://i.pravatar.cc/150?u=david', false, 'user'),
    ('55555555-5555-5555-5555-555555555555', 'emma', 'emma@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Emma Thompson', 'Fitness | Yoga | Healthy living', 'https://i.pravatar.cc/150?u=emma', false, 'user'),
    ('66666666-6666-6666-6666-666666666666', 'admin', 'admin@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Admin User', 'Platform Administrator', 'https://i.pravatar.cc/150?u=admin', false, 'admin')
ON CONFLICT (email) DO NOTHING;

-- Create posts with images
INSERT INTO posts (id, user_id, caption, location, created_at)
VALUES
    -- Alice's posts (photographer)
    ('ab111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'Golden hour in the mountains. These moments make all the hiking worth it.', 'Rocky Mountains, Colorado', NOW() - INTERVAL '2 days'),
    ('ab222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'City lights and late night vibes. NYC never sleeps and neither do I.', 'New York City', NOW() - INTERVAL '5 days'),
    ('ab333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'Morning coffee ritual. The best part of waking up.', 'Home Studio', NOW() - INTERVAL '7 days'),
    -- Bob's posts (foodie)
    ('ab444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222', 'Homemade pasta from scratch. Four hours of work but so worth it!', 'My Kitchen', NOW() - INTERVAL '1 day'),
    ('ab555555-5555-5555-5555-555555555555', '22222222-2222-2222-2222-222222222222', 'Sunday brunch goals achieved. Eggs benedict with a twist.', 'The Breakfast Club', NOW() - INTERVAL '3 days'),
    -- Carol's posts (artist)
    ('ab666666-6666-6666-6666-666666666666', '33333333-3333-3333-3333-333333333333', 'New watercolor piece finished today. Inspired by the fall colors.', 'Art Studio', NOW() - INTERVAL '4 days'),
    ('ab777777-7777-7777-7777-777777777777', '33333333-3333-3333-3333-333333333333', 'Max enjoying his favorite spot in the park.', 'Central Park', NOW() - INTERVAL '6 days'),
    -- David's posts (tech/gaming)
    ('ab888888-8888-8888-8888-888888888888', '44444444-4444-4444-4444-444444444444', 'Finally got my setup complete. Ready for some serious gaming!', 'Gaming Den', NOW() - INTERVAL '2 days'),
    -- Emma's posts (fitness)
    ('ab999999-9999-9999-9999-999999999999', '55555555-5555-5555-5555-555555555555', 'Morning yoga flow. Start your day with intention.', 'Sunset Beach', NOW() - INTERVAL '1 day'),
    ('abaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '55555555-5555-5555-5555-555555555555', '10K personal best today! Hard work pays off.', 'City Marathon', NOW() - INTERVAL '8 days')
ON CONFLICT DO NOTHING;

-- Add media for posts
INSERT INTO post_media (id, post_id, media_type, media_url, width, height, order_index)
VALUES
    -- Alice's mountain photo
    ('ad111111-1111-1111-1111-111111111111', 'ab111111-1111-1111-1111-111111111111', 'image', 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800', 800, 600, 0),
    -- Alice's NYC photo
    ('ad222222-2222-2222-2222-222222222222', 'ab222222-2222-2222-2222-222222222222', 'image', 'https://images.unsplash.com/photo-1534430480872-3498386e7856?w=800', 800, 1000, 0),
    -- Alice's coffee photo
    ('ad333333-3333-3333-3333-333333333333', 'ab333333-3333-3333-3333-333333333333', 'image', 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=800', 800, 800, 0),
    -- Bob's pasta
    ('ad444444-4444-4444-4444-444444444444', 'ab444444-4444-4444-4444-444444444444', 'image', 'https://images.unsplash.com/photo-1473093295043-cdd812d0e601?w=800', 800, 600, 0),
    -- Bob's brunch
    ('ad555555-5555-5555-5555-555555555555', 'ab555555-5555-5555-5555-555555555555', 'image', 'https://images.unsplash.com/photo-1525351484163-7529414344d8?w=800', 800, 800, 0),
    -- Carol's watercolor
    ('ad666666-6666-6666-6666-666666666666', 'ab666666-6666-6666-6666-666666666666', 'image', 'https://images.unsplash.com/photo-1579783902614-a3fb3927b6a5?w=800', 800, 1000, 0),
    -- Carol's dog
    ('ad777777-7777-7777-7777-777777777777', 'ab777777-7777-7777-7777-777777777777', 'image', 'https://images.unsplash.com/photo-1587300003388-59208cc962cb?w=800', 800, 800, 0),
    -- David's gaming setup
    ('ad888888-8888-8888-8888-888888888888', 'ab888888-8888-8888-8888-888888888888', 'image', 'https://images.unsplash.com/photo-1593305841991-05c297ba4575?w=800', 800, 600, 0),
    -- Emma's yoga
    ('ad999999-9999-9999-9999-999999999999', 'ab999999-9999-9999-9999-999999999999', 'image', 'https://images.unsplash.com/photo-1544367567-0f2fcb009e0b?w=800', 800, 1000, 0),
    -- Emma's running
    ('adaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'abaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'image', 'https://images.unsplash.com/photo-1571008887538-b36bb32f4571?w=800', 800, 600, 0)
ON CONFLICT DO NOTHING;

-- Create follows (social graph)
INSERT INTO follows (follower_id, following_id)
VALUES
    -- Alice follows everyone
    ('11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'),
    ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333'),
    ('11111111-1111-1111-1111-111111111111', '44444444-4444-4444-4444-444444444444'),
    ('11111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555'),
    -- Bob follows Alice and Carol
    ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111'),
    ('22222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333'),
    -- Carol follows Alice and Emma
    ('33333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111'),
    ('33333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555'),
    -- David follows Alice and Bob
    ('44444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111'),
    ('44444444-4444-4444-4444-444444444444', '22222222-2222-2222-2222-222222222222'),
    -- Emma follows everyone
    ('55555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111'),
    ('55555555-5555-5555-5555-555555555555', '22222222-2222-2222-2222-222222222222'),
    ('55555555-5555-5555-5555-555555555555', '33333333-3333-3333-3333-333333333333'),
    ('55555555-5555-5555-5555-555555555555', '44444444-4444-4444-4444-444444444444')
ON CONFLICT DO NOTHING;

-- Create likes
INSERT INTO likes (user_id, post_id)
VALUES
    -- Likes on Alice's mountain photo
    ('22222222-2222-2222-2222-222222222222', 'ab111111-1111-1111-1111-111111111111'),
    ('33333333-3333-3333-3333-333333333333', 'ab111111-1111-1111-1111-111111111111'),
    ('44444444-4444-4444-4444-444444444444', 'ab111111-1111-1111-1111-111111111111'),
    ('55555555-5555-5555-5555-555555555555', 'ab111111-1111-1111-1111-111111111111'),
    -- Likes on Alice's NYC photo
    ('22222222-2222-2222-2222-222222222222', 'ab222222-2222-2222-2222-222222222222'),
    ('55555555-5555-5555-5555-555555555555', 'ab222222-2222-2222-2222-222222222222'),
    -- Likes on Bob's pasta
    ('11111111-1111-1111-1111-111111111111', 'ab444444-4444-4444-4444-444444444444'),
    ('33333333-3333-3333-3333-333333333333', 'ab444444-4444-4444-4444-444444444444'),
    ('55555555-5555-5555-5555-555555555555', 'ab444444-4444-4444-4444-444444444444'),
    -- Likes on Carol's dog
    ('11111111-1111-1111-1111-111111111111', 'ab777777-7777-7777-7777-777777777777'),
    ('22222222-2222-2222-2222-222222222222', 'ab777777-7777-7777-7777-777777777777'),
    ('44444444-4444-4444-4444-444444444444', 'ab777777-7777-7777-7777-777777777777'),
    ('55555555-5555-5555-5555-555555555555', 'ab777777-7777-7777-7777-777777777777'),
    -- Likes on Emma's yoga
    ('11111111-1111-1111-1111-111111111111', 'ab999999-9999-9999-9999-999999999999'),
    ('22222222-2222-2222-2222-222222222222', 'ab999999-9999-9999-9999-999999999999'),
    ('33333333-3333-3333-3333-333333333333', 'ab999999-9999-9999-9999-999999999999')
ON CONFLICT DO NOTHING;

-- Create comments
INSERT INTO comments (id, user_id, post_id, content, created_at)
VALUES
    -- Comments on Alice's mountain photo
    ('c0111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', 'ab111111-1111-1111-1111-111111111111', 'Absolutely stunning! Where is this exactly?', NOW() - INTERVAL '1 day'),
    ('c0222222-2222-2222-2222-222222222222', '33333333-3333-3333-3333-333333333333', 'ab111111-1111-1111-1111-111111111111', 'The colors are incredible!', NOW() - INTERVAL '1 day'),
    ('c0333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', 'ab111111-1111-1111-1111-111111111111', 'Goals! I need to plan a trip there.', NOW() - INTERVAL '1 day'),
    -- Reply to first comment
    ('c0444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'ab111111-1111-1111-1111-111111111111', 'This is near Aspen, about 3 hours from Denver!', NOW() - INTERVAL '20 hours'),
    -- Comments on Bob's pasta
    ('c0555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', 'ab444444-4444-4444-4444-444444444444', 'This looks amazing! Recipe please!', NOW() - INTERVAL '12 hours'),
    ('c0666666-6666-6666-6666-666666666666', '55555555-5555-5555-5555-555555555555', 'ab444444-4444-4444-4444-444444444444', 'My mouth is watering just looking at this!', NOW() - INTERVAL '10 hours'),
    -- Comments on Carol's dog
    ('c0777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111', 'ab777777-7777-7777-7777-777777777777', 'Max is the cutest! Give him pets from me!', NOW() - INTERVAL '5 days'),
    ('c0888888-8888-8888-8888-888888888888', '55555555-5555-5555-5555-555555555555', 'ab777777-7777-7777-7777-777777777777', 'What breed is he? So adorable!', NOW() - INTERVAL '5 days'),
    -- Comments on Emma's yoga
    ('c0999999-9999-9999-9999-999999999999', '11111111-1111-1111-1111-111111111111', 'ab999999-9999-9999-9999-999999999999', 'Perfect form! So inspiring.', NOW() - INTERVAL '18 hours'),
    ('c0aaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '33333333-3333-3333-3333-333333333333', 'ab999999-9999-9999-9999-999999999999', 'That sunset is breathtaking! Where is this beach?', NOW() - INTERVAL '16 hours')
ON CONFLICT DO NOTHING;

-- Set parent comment for the reply
UPDATE comments SET parent_comment_id = 'c0111111-1111-1111-1111-111111111111' WHERE id = 'c0444444-4444-4444-4444-444444444444';

-- Create active stories (will expire in 24 hours from creation)
INSERT INTO stories (id, user_id, media_url, media_type, created_at, expires_at)
VALUES
    -- Alice's stories
    ('b0111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'https://images.unsplash.com/photo-1682687220742-aba13b6e50ba?w=600', 'image', NOW() - INTERVAL '2 hours', NOW() + INTERVAL '22 hours'),
    ('b0222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'https://images.unsplash.com/photo-1682686580391-615b1f28e5ee?w=600', 'image', NOW() - INTERVAL '1 hour', NOW() + INTERVAL '23 hours'),
    -- Bob's story
    ('b0333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=600', 'image', NOW() - INTERVAL '3 hours', NOW() + INTERVAL '21 hours'),
    -- Emma's story
    ('b0444444-4444-4444-4444-444444444444', '55555555-5555-5555-5555-555555555555', 'https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=600', 'image', NOW() - INTERVAL '30 minutes', NOW() + INTERVAL '23 hours')
ON CONFLICT DO NOTHING;

-- Add some story views
INSERT INTO story_views (story_id, viewer_id, viewed_at)
VALUES
    ('b0111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222', NOW() - INTERVAL '1 hour'),
    ('b0111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333', NOW() - INTERVAL '90 minutes'),
    ('b0111111-1111-1111-1111-111111111111', '55555555-5555-5555-5555-555555555555', NOW() - INTERVAL '30 minutes'),
    ('b0222222-2222-2222-2222-222222222222', '22222222-2222-2222-2222-222222222222', NOW() - INTERVAL '45 minutes'),
    ('b0333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', NOW() - INTERVAL '2 hours'),
    ('b0333333-3333-3333-3333-333333333333', '55555555-5555-5555-5555-555555555555', NOW() - INTERVAL '1 hour'),
    ('b0444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', NOW() - INTERVAL '15 minutes')
ON CONFLICT DO NOTHING;

-- Create saved posts
INSERT INTO saved_posts (user_id, post_id)
VALUES
    ('11111111-1111-1111-1111-111111111111', 'ab444444-4444-4444-4444-444444444444'),
    ('11111111-1111-1111-1111-111111111111', 'ab999999-9999-9999-9999-999999999999'),
    ('22222222-2222-2222-2222-222222222222', 'ab111111-1111-1111-1111-111111111111'),
    ('55555555-5555-5555-5555-555555555555', 'ab111111-1111-1111-1111-111111111111'),
    ('55555555-5555-5555-5555-555555555555', 'ab777777-7777-7777-7777-777777777777')
ON CONFLICT DO NOTHING;

-- ============================================================
-- Publish the seeded posts.
--
-- posts.status defaults to 'processing' because real uploads are finished
-- asynchronously by the image worker (resize → post_media → status='published'
-- → feed fan-out). Seeded rows never pass through that worker, so without this
-- they stay 'processing' forever: the Explore grid (which filters on
-- status='published') renders empty and the feed shows almost nothing.
-- The seed already provides post_media rows, so publishing here is accurate.
-- ============================================================
UPDATE posts SET status = 'published' WHERE status = 'processing';

-- ============================================================
-- DISCOVERABLE ACCOUNTS (nobody follows these)
--
-- The Explore query deliberately excludes accounts the viewer already follows
-- (`p.user_id NOT IN (SELECT following_id FROM follows ...)`) — that's the point
-- of Explore: surface accounts you *don't* follow. With only the six original
-- seed users, all followed by alice, Explore rendered permanently empty.
-- These extra creators are followed by nobody, so the grid always has content.
-- ============================================================
INSERT INTO users (id, username, email, password_hash, display_name, bio, profile_picture_url, is_private, role)
VALUES
    ('77777777-7777-7777-7777-777777777777', 'frankie', 'frankie@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Frankie Lee', 'Street photography | Tokyo', 'https://i.pravatar.cc/150?u=frankie', false, 'user'),
    ('88888888-8888-8888-8888-888888888888', 'grace', 'grace@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Grace Kim', 'Architecture & minimalism', 'https://i.pravatar.cc/150?u=grace', false, 'user'),
    ('99999999-9999-9999-9999-999999999999', 'hugo', 'hugo@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Hugo Martin', 'Mountains, mostly', 'https://i.pravatar.cc/150?u=hugo', false, 'user'),
    ('aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'iris', 'iris@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Iris Chen', 'Food styling & recipes', 'https://i.pravatar.cc/150?u=iris', false, 'user')
ON CONFLICT (email) DO NOTHING;

INSERT INTO posts (id, user_id, caption, location, status, like_count, comment_count, created_at)
VALUES
    ('ba111111-1111-4111-8111-111111111111', '77777777-7777-7777-7777-777777777777', 'Neon nights in Shinjuku.', 'Tokyo, Japan', 'published', 482, 0, NOW() - INTERVAL '2 hours'),
    ('ba222222-2222-4222-8222-222222222222', '77777777-7777-7777-7777-777777777777', 'Rainy crossing.', 'Shibuya', 'published', 271, 0, NOW() - INTERVAL '9 hours'),
    ('ba333333-3333-4333-8333-333333333333', '88888888-8888-8888-8888-888888888888', 'Concrete and light.', 'Rotterdam', 'published', 654, 0, NOW() - INTERVAL '5 hours'),
    ('ba444444-4444-4444-8444-444444444444', '88888888-8888-8888-8888-888888888888', 'Stairwell study.', NULL, 'published', 388, 0, NOW() - INTERVAL '1 day'),
    ('ba555555-5555-4555-8555-555555555555', '99999999-9999-9999-9999-999999999999', 'Above the clouds at 4am.', 'Dolomites', 'published', 921, 0, NOW() - INTERVAL '7 hours'),
    ('ba666666-6666-4666-8666-666666666666', '99999999-9999-9999-9999-999999999999', 'Alpine lake, no filter needed.', NULL, 'published', 733, 0, NOW() - INTERVAL '2 days'),
    ('ba777777-7777-4777-8777-777777777777', 'aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Sunday brunch spread.', NULL, 'published', 512, 0, NOW() - INTERVAL '11 hours'),
    ('ba888888-8888-4888-8888-888888888888', 'aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Fresh pasta, slow morning.', NULL, 'published', 445, 0, NOW() - INTERVAL '3 days')
ON CONFLICT (id) DO NOTHING;

INSERT INTO post_media (id, post_id, media_type, media_url, width, height, order_index)
VALUES
    ('bd111111-1111-4111-8111-111111111111', 'ba111111-1111-4111-8111-111111111111', 'image', 'https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?w=800', 800, 800, 0),
    ('bd222222-2222-4222-8222-222222222222', 'ba222222-2222-4222-8222-222222222222', 'image', 'https://images.unsplash.com/photo-1503899036084-c55cdd92da26?w=800', 800, 800, 0),
    ('bd333333-3333-4333-8333-333333333333', 'ba333333-3333-4333-8333-333333333333', 'image', 'https://images.unsplash.com/photo-1487958449943-2429e8be8625?w=800', 800, 800, 0),
    ('bd444444-4444-4444-8444-444444444444', 'ba444444-4444-4444-8444-444444444444', 'image', 'https://images.unsplash.com/photo-1449157291145-7efd050a4d0e?w=800', 800, 800, 0),
    ('bd555555-5555-4555-8555-555555555555', 'ba555555-5555-4555-8555-555555555555', 'image', 'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=800', 800, 800, 0),
    ('bd666666-6666-4666-8666-666666666666', 'ba666666-6666-4666-8666-666666666666', 'image', 'https://images.unsplash.com/photo-1439066615861-d1af74d74000?w=800', 800, 800, 0),
    ('bd777777-7777-4777-8777-777777777777', 'ba777777-7777-4777-8777-777777777777', 'image', 'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=800', 800, 800, 0),
    ('bd888888-8888-4888-8888-888888888888', 'ba888888-8888-4888-8888-888888888888', 'image', 'https://images.unsplash.com/photo-1473093295043-cdd812d0e601?w=800', 800, 800, 0)
ON CONFLICT (id) DO NOTHING;
