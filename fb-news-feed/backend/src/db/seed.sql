-- Seed data for development/testing
-- Facebook News Feed sample data

-- Insert sample users (all passwords are 'password123')
INSERT INTO users (id, username, email, password_hash, display_name, bio, is_celebrity, follower_count)
VALUES
    ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'john_doe', 'john@example.com', '$2b$10$rQZ6vXP0a5TbGSKLMRzv8.ZZq5kzv1sN5A7MsMkbz8IlCOq7j9C6a', 'John Doe', 'Software developer and coffee enthusiast', FALSE, 150),
    ('b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'jane_smith', 'jane@example.com', '$2b$10$rQZ6vXP0a5TbGSKLMRzv8.ZZq5kzv1sN5A7MsMkbz8IlCOq7j9C6a', 'Jane Smith', 'Designer and photographer', FALSE, 320),
    ('c2eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'tech_guru', 'tech@example.com', '$2b$10$rQZ6vXP0a5TbGSKLMRzv8.ZZq5kzv1sN5A7MsMkbz8IlCOq7j9C6a', 'Tech Guru', 'Tech influencer | 1M followers', TRUE, 1000000),
    ('d3eebc99-9c0b-4ef8-bb6d-6bb9bd380a44', 'admin', 'admin@example.com', '$2b$10$rQZ6vXP0a5TbGSKLMRzv8.ZZq5kzv1sN5A7MsMkbz8IlCOq7j9C6a', 'Admin User', 'System administrator', FALSE, 0);

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
