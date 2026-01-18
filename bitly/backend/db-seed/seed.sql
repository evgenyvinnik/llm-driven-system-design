-- Seed script for Bitly URL Shortener
-- Creates sample users, URLs, and click analytics data

-- Create alice user (password: password123)
-- Password hash generated with bcrypt, 10 rounds
INSERT INTO users (email, password_hash, role)
VALUES ('alice@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'user')
ON CONFLICT (email) DO NOTHING;

-- Create bob user (password: password123)
INSERT INTO users (email, password_hash, role)
VALUES ('bob@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'user')
ON CONFLICT (email) DO NOTHING;

-- Get alice's user ID
DO $$
DECLARE
    alice_id UUID;
    bob_id UUID;
BEGIN
    SELECT id INTO alice_id FROM users WHERE email = 'alice@example.com';
    SELECT id INTO bob_id FROM users WHERE email = 'bob@example.com';

    -- Alice's URLs with varied usage
    INSERT INTO urls (short_code, long_url, user_id, created_at, click_count, is_custom)
    VALUES
        ('github1', 'https://github.com/anthropics/claude-code', alice_id, NOW() - INTERVAL '30 days', 245, true),
        ('docs123', 'https://docs.anthropic.com/en/docs/intro-to-claude', alice_id, NOW() - INTERVAL '15 days', 89, true),
        ('ai-news', 'https://www.technologyreview.com/topic/artificial-intelligence/', alice_id, NOW() - INTERVAL '7 days', 156, true),
        ('abc123x', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', alice_id, NOW() - INTERVAL '5 days', 42, false),
        ('blog42z', 'https://www.example.com/blog/how-to-build-scalable-systems', alice_id, NOW() - INTERVAL '3 days', 78, false),
        ('promo99', 'https://store.example.com/sale?discount=50&category=electronics', alice_id, NOW() - INTERVAL '2 days', 312, true),
        ('news789', 'https://www.nytimes.com/section/technology', alice_id, NOW() - INTERVAL '1 day', 23, false)
    ON CONFLICT (short_code) DO NOTHING;

    -- Bob's URLs
    INSERT INTO urls (short_code, long_url, user_id, created_at, click_count, is_custom)
    VALUES
        ('mysite1', 'https://bobsportfolio.example.com', bob_id, NOW() - INTERVAL '20 days', 67, true),
        ('xyz456p', 'https://www.reddit.com/r/programming', bob_id, NOW() - INTERVAL '10 days', 134, false)
    ON CONFLICT (short_code) DO NOTHING;

    -- Generate realistic click events for alice's URLs over the past 30 days
    -- Most popular URL: promo99 (312 clicks)
    INSERT INTO click_events (short_code, clicked_at, referrer, device_type)
    SELECT
        'promo99',
        NOW() - (random() * INTERVAL '2 days'),
        CASE (random() * 4)::int
            WHEN 0 THEN 'https://twitter.com'
            WHEN 1 THEN 'https://facebook.com'
            WHEN 2 THEN 'https://linkedin.com'
            WHEN 3 THEN 'direct'
            ELSE 'https://google.com'
        END,
        CASE (random() * 3)::int
            WHEN 0 THEN 'mobile'
            WHEN 1 THEN 'desktop'
            ELSE 'tablet'
        END
    FROM generate_series(1, 312);

    -- github1 (245 clicks over 30 days)
    INSERT INTO click_events (short_code, clicked_at, referrer, device_type)
    SELECT
        'github1',
        NOW() - (random() * INTERVAL '30 days'),
        CASE (random() * 5)::int
            WHEN 0 THEN 'https://twitter.com'
            WHEN 1 THEN 'https://news.ycombinator.com'
            WHEN 2 THEN 'https://reddit.com/r/programming'
            WHEN 3 THEN 'direct'
            ELSE 'https://google.com'
        END,
        CASE (random() * 2)::int
            WHEN 0 THEN 'mobile'
            ELSE 'desktop'
        END
    FROM generate_series(1, 245);

    -- ai-news (156 clicks over 7 days)
    INSERT INTO click_events (short_code, clicked_at, referrer, device_type)
    SELECT
        'ai-news',
        NOW() - (random() * INTERVAL '7 days'),
        CASE (random() * 4)::int
            WHEN 0 THEN 'https://twitter.com'
            WHEN 1 THEN 'https://linkedin.com'
            WHEN 2 THEN 'direct'
            ELSE 'https://google.com'
        END,
        CASE (random() * 3)::int
            WHEN 0 THEN 'mobile'
            WHEN 1 THEN 'desktop'
            ELSE 'tablet'
        END
    FROM generate_series(1, 156);

    -- docs123 (89 clicks over 15 days)
    INSERT INTO click_events (short_code, clicked_at, referrer, device_type)
    SELECT
        'docs123',
        NOW() - (random() * INTERVAL '15 days'),
        CASE (random() * 3)::int
            WHEN 0 THEN 'https://github.com'
            WHEN 1 THEN 'direct'
            ELSE 'https://google.com'
        END,
        'desktop'
    FROM generate_series(1, 89);

    -- blog42z (78 clicks over 3 days)
    INSERT INTO click_events (short_code, clicked_at, referrer, device_type)
    SELECT
        'blog42z',
        NOW() - (random() * INTERVAL '3 days'),
        CASE (random() * 3)::int
            WHEN 0 THEN 'https://twitter.com'
            WHEN 1 THEN 'direct'
            ELSE 'https://google.com'
        END,
        CASE (random() * 2)::int
            WHEN 0 THEN 'mobile'
            ELSE 'desktop'
        END
    FROM generate_series(1, 78);

    -- abc123x (42 clicks over 5 days)
    INSERT INTO click_events (short_code, clicked_at, referrer, device_type)
    SELECT
        'abc123x',
        NOW() - (random() * INTERVAL '5 days'),
        'direct',
        CASE (random() * 3)::int
            WHEN 0 THEN 'mobile'
            WHEN 1 THEN 'desktop'
            ELSE 'tablet'
        END
    FROM generate_series(1, 42);

    -- news789 (23 clicks over 1 day)
    INSERT INTO click_events (short_code, clicked_at, referrer, device_type)
    SELECT
        'news789',
        NOW() - (random() * INTERVAL '1 day'),
        CASE (random() * 2)::int
            WHEN 0 THEN 'https://twitter.com'
            ELSE 'direct'
        END,
        'mobile'
    FROM generate_series(1, 23);

    -- Bob's URLs clicks
    INSERT INTO click_events (short_code, clicked_at, referrer, device_type)
    SELECT
        'mysite1',
        NOW() - (random() * INTERVAL '20 days'),
        'direct',
        'desktop'
    FROM generate_series(1, 67);

    INSERT INTO click_events (short_code, clicked_at, referrer, device_type)
    SELECT
        'xyz456p',
        NOW() - (random() * INTERVAL '10 days'),
        'https://news.ycombinator.com',
        'desktop'
    FROM generate_series(1, 134);
END $$;
