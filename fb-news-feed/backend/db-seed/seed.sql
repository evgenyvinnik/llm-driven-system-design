-- Seed data for development/testing
-- Facebook News Feed sample data

-- Insert sample users (all passwords are 'password123')
INSERT INTO users (id, username, email, password_hash, display_name, bio, is_celebrity, follower_count)
VALUES
    ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'john_doe', 'john@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'John Doe', 'Software developer and coffee enthusiast', FALSE, 150),
    ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'jane_smith', 'jane@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Jane Smith', 'Designer and photographer', FALSE, 320),
    ('c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'tech_guru', 'tech@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Tech Guru', 'Tech influencer | 1M followers', TRUE, 1000000),
    ('d3eebc99-9c0b-4ef8-bb6d-6bb9bd380a44', 'admin', 'admin@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Admin User', 'System administrator', FALSE, 0);

-- Update admin role
UPDATE users SET role = 'admin' WHERE username = 'admin';

-- Insert sample friendships
INSERT INTO friendships (follower_id, following_id, status)
VALUES
    ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'active'),
    ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'active'),
    ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'active'),
    ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'active');

-- Insert sample posts
INSERT INTO posts (author_id, content, post_type, like_count, comment_count)
VALUES
    ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Just finished building an amazing new feature! Really proud of how it turned out.', 'text', 25, 5),
    ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'Captured this beautiful sunset today. Nature never fails to amaze me!', 'text', 45, 8),
    ('c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'New video dropping tomorrow! Stay tuned for my review of the latest tech gadgets.', 'text', 1500, 234),
    ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Coffee is the answer. What was the question again?', 'text', 12, 3),
    ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'Working on a new design project. Cant wait to share it with you all!', 'text', 30, 6);

-- ============================================================
-- More posts for a richer feed, with image posts and varied engagement.
-- ============================================================
INSERT INTO posts (author_id, content, image_url, post_type, privacy, like_count, comment_count, share_count, created_at)
VALUES
    ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'New photography portfolio is live! 3 months of work condensed into 20 shots. 📸', 'https://images.unsplash.com/photo-1452587925148-ce544e77e70d?w=800', 'image', 'public', 128, 24, 11, NOW() - INTERVAL '35 minutes'),
    ('c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'Hot take: the best framework is the one your team already knows. Fight me in the comments 🔥', NULL, 'text', 'public', 3200, 512, 340, NOW() - INTERVAL '1 hour'),
    ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Shipped a hybrid push/pull fan-out today. Celebrities pull, everyone else gets pushed. Feels good. 🚀', NULL, 'text', 'public', 88, 19, 7, NOW() - INTERVAL '2 hours'),
    ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'Golden hour at the coast. Sometimes you just have to stop and watch. 🌅', 'https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800', 'image', 'public', 210, 41, 18, NOW() - INTERVAL '3 hours'),
    ('c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'Just unboxed the new flagship phone. Full review dropping this weekend — what do you want me to test?', 'https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=800', 'image', 'public', 5400, 890, 620, NOW() - INTERVAL '5 hours'),
    ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Reminder to self: premature optimization is still the root of all evil. Ship first, profile later.', NULL, 'text', 'public', 64, 15, 9, NOW() - INTERVAL '8 hours');

-- ============================================================
-- Materialize John Doe's feed: every public, non-deleted post from the
-- people he follows (Jane, Tech Guru) plus his own, scored by recency.
-- Directly seeding feed_items because seeded posts don't run through the
-- fan-out path that would normally populate the feed on publish.
-- ============================================================
INSERT INTO feed_items (user_id, post_id, score, created_at)
SELECT 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', p.id,
       EXTRACT(EPOCH FROM p.created_at),
       p.created_at
FROM posts p
WHERE p.is_deleted = FALSE
  AND p.privacy = 'public'
  AND (
    p.author_id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'
    OR p.author_id IN (
      SELECT following_id FROM friendships
      WHERE follower_id = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11' AND status = 'active'
    )
  )
ON CONFLICT (user_id, post_id) DO NOTHING;
