-- Reddit Clone Seed Data
-- Password hash is for 'password123': $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Sample users
INSERT INTO users (id, username, email, password_hash, karma_post, karma_comment, role) VALUES
    (1, 'alice', 'alice@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 1250, 3420, 'user'),
    (2, 'bob', 'bob@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 580, 1205, 'user'),
    (3, 'carol', 'carol@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 2100, 890, 'user'),
    (4, 'dave', 'dave@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 340, 2560, 'user'),
    (5, 'admin', 'admin@reddit.local', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 0, 0, 'admin')
ON CONFLICT (username) DO NOTHING;

-- Sample subreddits
INSERT INTO subreddits (id, name, title, description, created_by, subscriber_count, is_private) VALUES
    (1, 'programming', 'Programming', 'Computer programming news, discussion, and Q&A', 1, 5250000, false),
    (2, 'webdev', 'Web Development', 'A community for web developers and designers', 2, 1850000, false),
    (3, 'typescript', 'TypeScript', 'TypeScript is a typed superset of JavaScript that compiles to plain JavaScript', 1, 425000, false),
    (4, 'sysadmin', 'System Administration', 'A community for sysadmins to discuss tools, tips, and best practices', 3, 780000, false),
    (5, 'devops', 'DevOps', 'A place for DevOps professionals to share knowledge', 3, 620000, false),
    (6, 'askprogramming', 'Ask Programming', 'Ask questions about programming', 4, 350000, false),
    (7, 'privateteam', 'Private Team', 'A private subreddit for team discussions', 1, 25, true)
ON CONFLICT (name) DO NOTHING;

-- Subscriptions
INSERT INTO subscriptions (user_id, subreddit_id) VALUES
    (1, 1), (1, 2), (1, 3), (1, 4), (1, 7),
    (2, 1), (2, 2), (2, 6),
    (3, 1), (3, 4), (3, 5),
    (4, 1), (4, 2), (4, 3), (4, 5), (4, 6)
ON CONFLICT DO NOTHING;

-- Sample posts
INSERT INTO posts (id, subreddit_id, author_id, title, content, url, score, upvotes, downvotes, comment_count, hot_score) VALUES
    (1, 1, 1, 'Why I switched from JavaScript to TypeScript',
     'After 5 years of JavaScript, I finally made the switch to TypeScript. Here are my thoughts on the transition and why I think every JavaScript developer should consider it...',
     NULL, 2847, 3012, 165, 342, 8.45),

    (2, 1, 3, 'The future of WebAssembly in 2025',
     'WebAssembly has come a long way. Let''s discuss where it''s heading and what opportunities it opens up for developers.',
     'https://webassembly.org/roadmap', 1523, 1680, 157, 189, 7.92),

    (3, 2, 2, 'Modern CSS is amazing - here''s what you''re missing',
     'CSS has evolved significantly. Container queries, cascade layers, :has() selector... Let me show you some techniques that might blow your mind.',
     NULL, 3421, 3650, 229, 256, 8.89),

    (4, 3, 1, 'TypeScript 5.4 Released - New Features Overview',
     'TypeScript 5.4 just dropped with some exciting features including improved narrowing and the new NoInfer utility type.',
     'https://devblogs.microsoft.com/typescript/announcing-typescript-5-4/', 1892, 2010, 118, 145, 8.12),

    (5, 4, 3, 'My home lab setup for learning Kubernetes',
     'I finally set up a proper home lab for learning K8s. Three Raspberry Pi 5s, one mini PC as the master node. Here''s my complete setup guide.',
     NULL, 987, 1050, 63, 178, 7.45),

    (6, 5, 3, 'GitOps best practices I learned the hard way',
     'After implementing GitOps at three different companies, here are the patterns that worked and the mistakes to avoid.',
     NULL, 1654, 1780, 126, 203, 8.01),

    (7, 2, 4, 'Is React still the best choice in 2025?',
     'With so many alternatives now available (Svelte, Solid, Qwik), is React still the go-to choice for new projects? Let''s discuss.',
     NULL, 567, 890, 323, 412, 6.89),

    (8, 6, 4, '[Question] How do you handle API rate limiting in production?',
     'Working on a service that needs to call external APIs with strict rate limits. What strategies have worked for you?',
     NULL, 234, 256, 22, 89, 5.67),

    (9, 1, 2, 'I built a code review tool with AI - lessons learned',
     'Spent 6 months building an AI-powered code review assistant. Here''s what I learned about LLMs, prompting, and developer tools.',
     NULL, 4521, 4780, 259, 567, 9.12),

    (10, 3, 4, 'Zod vs Yup vs TypeBox - Schema validation comparison',
     'Comprehensive comparison of the three most popular TypeScript schema validation libraries with benchmarks.',
     NULL, 876, 920, 44, 98, 6.78)
ON CONFLICT DO NOTHING;

-- Sample comments with threading (materialized path)
INSERT INTO comments (id, post_id, author_id, parent_id, path, depth, content, score, upvotes, downvotes) VALUES
    -- Comments on post 1 (TypeScript switch)
    (1, 1, 2, NULL, '1', 0, 'Great points! I made the same switch last year and haven''t looked back.', 156, 162, 6),
    (2, 1, 3, NULL, '2', 0, 'What about the learning curve? I''m worried about team adoption.', 89, 95, 6),
    (3, 1, 1, 2, '2.3', 1, 'The learning curve is real but worth it. We ran TypeScript workshops for 2 weeks before fully adopting.', 124, 128, 4),
    (4, 1, 4, 2, '2.4', 1, 'Start with strict: false and gradually enable stricter rules. That worked for our team.', 78, 82, 4),
    (5, 1, 2, 3, '2.3.5', 2, 'That''s a great approach! Did you create any internal documentation?', 34, 36, 2),

    -- Comments on post 3 (Modern CSS)
    (6, 3, 1, NULL, '6', 0, 'Container queries changed everything for me. Component-based responsive design is finally here!', 234, 245, 11),
    (7, 3, 4, NULL, '7', 0, 'Can you share some real-world examples of :has() usage?', 67, 72, 5),
    (8, 3, 2, 7, '7.8', 1, 'Sure! I use it for form validation styling: form:has(input:invalid) { border-color: red; }', 89, 92, 3),
    (9, 3, 1, 7, '7.9', 1, 'Another one: styling parent based on checkbox state. .card:has(input:checked) { background: blue; }', 76, 79, 3),

    -- Comments on post 7 (React discussion)
    (10, 7, 1, NULL, '10', 0, 'React is still dominant but I''m excited about Solid''s approach to reactivity.', 45, 58, 13),
    (11, 7, 3, NULL, '11', 0, 'For enterprise, React''s ecosystem is unmatched. The hiring pool is also much larger.', 123, 134, 11),
    (12, 7, 2, 11, '11.12', 1, 'This. Finding Svelte developers is really hard compared to React developers.', 67, 71, 4),
    (13, 7, 4, 10, '10.13', 1, 'Solid is great but the smaller ecosystem is a real concern for production apps.', 38, 42, 4),

    -- Comments on post 9 (AI code review)
    (14, 9, 3, NULL, '14', 0, 'How do you handle the hallucination problem? AI often suggests non-existent APIs.', 189, 198, 9),
    (15, 9, 2, 14, '14.15', 1, 'Good question! I use a combination of AST parsing and the AI suggestions. Only suggest changes that compile.', 256, 262, 6),
    (16, 9, 1, 14, '14.16', 1, 'We had the same issue. Ground the AI with actual codebase context using RAG.', 145, 150, 5),
    (17, 9, 4, NULL, '17', 0, 'What''s the latency like? Code review needs to be fast to be useful.', 78, 84, 6),
    (18, 9, 2, 17, '17.18', 1, 'Under 5 seconds for most reviews. We stream results and use a smaller model for initial pass.', 92, 96, 4)
ON CONFLICT DO NOTHING;

-- Votes on posts
INSERT INTO votes (user_id, post_id, comment_id, direction) VALUES
    (2, 1, NULL, 1), (3, 1, NULL, 1), (4, 1, NULL, 1),
    (1, 2, NULL, 1), (4, 2, NULL, 1),
    (1, 3, NULL, 1), (3, 3, NULL, 1), (4, 3, NULL, 1),
    (2, 4, NULL, 1), (3, 4, NULL, 1),
    (1, 5, NULL, 1), (2, 5, NULL, 1), (4, 5, NULL, 1),
    (1, 6, NULL, 1), (2, 6, NULL, 1),
    (1, 7, NULL, -1), (3, 7, NULL, 1),
    (1, 8, NULL, 1), (2, 8, NULL, 1), (3, 8, NULL, 1),
    (1, 9, NULL, 1), (3, 9, NULL, 1), (4, 9, NULL, 1),
    (1, 10, NULL, 1), (2, 10, NULL, 1)
ON CONFLICT DO NOTHING;

-- Votes on comments
INSERT INTO votes (user_id, post_id, comment_id, direction) VALUES
    (1, NULL, 1, 1), (3, NULL, 1, 1), (4, NULL, 1, 1),
    (1, NULL, 2, 1), (4, NULL, 2, 1),
    (2, NULL, 3, 1), (4, NULL, 3, 1),
    (1, NULL, 6, 1), (3, NULL, 6, 1), (4, NULL, 6, 1),
    (1, NULL, 8, 1), (3, NULL, 8, 1),
    (2, NULL, 11, 1), (4, NULL, 11, 1),
    (1, NULL, 14, 1), (2, NULL, 14, 1), (4, NULL, 14, 1),
    (1, NULL, 15, 1), (3, NULL, 15, 1), (4, NULL, 15, 1)
ON CONFLICT DO NOTHING;

-- Sample audit logs
INSERT INTO audit_logs (actor_id, actor_ip, action, target_type, target_id, details, subreddit_id) VALUES
    (5, '192.168.1.100', 'post_remove', 'post', 100, '{"reason": "spam", "removed_by": "admin"}'::jsonb, 1),
    (1, '10.0.0.50', 'subreddit_settings_update', 'subreddit', 7, '{"field": "is_private", "old": false, "new": true}'::jsonb, 7),
    (3, '172.16.0.25', 'user_ban', 'user', 100, '{"duration_days": 7, "reason": "rule violation"}'::jsonb, 4)
ON CONFLICT DO NOTHING;

-- Update sequences to avoid conflicts with future inserts
SELECT setval('users_id_seq', (SELECT MAX(id) FROM users));
SELECT setval('subreddits_id_seq', (SELECT MAX(id) FROM subreddits));
SELECT setval('posts_id_seq', (SELECT MAX(id) FROM posts));
SELECT setval('comments_id_seq', (SELECT MAX(id) FROM comments));
SELECT setval('votes_id_seq', (SELECT MAX(id) FROM votes));
SELECT setval('audit_logs_id_seq', (SELECT MAX(id) FROM audit_logs));
