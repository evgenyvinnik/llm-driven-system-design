-- Typeahead Seed Data
-- Sample phrases with popularity counts for autocomplete

-- Clear and insert phrase counts (search suggestions)
INSERT INTO phrase_counts (phrase, count, last_updated, is_filtered)
VALUES
  -- Tech searches
  ('javascript', 50000, NOW(), false),
  ('javascript tutorial', 35000, NOW(), false),
  ('javascript array methods', 28000, NOW(), false),
  ('javascript async await', 25000, NOW(), false),
  ('javascript map function', 22000, NOW(), false),
  ('java', 45000, NOW(), false),
  ('java vs javascript', 18000, NOW(), false),
  ('java spring boot', 15000, NOW(), false),
  ('python', 55000, NOW(), false),
  ('python tutorial', 40000, NOW(), false),
  ('python for beginners', 32000, NOW(), false),
  ('python machine learning', 28000, NOW(), false),
  ('python pandas', 25000, NOW(), false),
  ('python django', 22000, NOW(), false),
  ('react', 48000, NOW(), false),
  ('react tutorial', 38000, NOW(), false),
  ('react hooks', 35000, NOW(), false),
  ('react native', 30000, NOW(), false),
  ('react router', 25000, NOW(), false),
  ('react vs vue', 20000, NOW(), false),
  ('typescript', 42000, NOW(), false),
  ('typescript tutorial', 32000, NOW(), false),
  ('typescript vs javascript', 25000, NOW(), false),
  ('typescript generics', 18000, NOW(), false),
  ('node', 40000, NOW(), false),
  ('nodejs', 38000, NOW(), false),
  ('nodejs tutorial', 30000, NOW(), false),
  ('nodejs express', 28000, NOW(), false),
  ('docker', 35000, NOW(), false),
  ('docker tutorial', 28000, NOW(), false),
  ('docker compose', 25000, NOW(), false),
  ('kubernetes', 30000, NOW(), false),
  ('kubernetes tutorial', 22000, NOW(), false),
  ('git', 45000, NOW(), false),
  ('git commands', 38000, NOW(), false),
  ('github', 60000, NOW(), false),
  ('github actions', 35000, NOW(), false),

  -- General searches
  ('weather today', 100000, NOW(), false),
  ('weather forecast', 85000, NOW(), false),
  ('weather tomorrow', 70000, NOW(), false),
  ('what time is it', 60000, NOW(), false),
  ('what is my ip', 55000, NOW(), false),
  ('why is the sky blue', 45000, NOW(), false),
  ('how to', 200000, NOW(), false),
  ('how to cook rice', 50000, NOW(), false),
  ('how to tie a tie', 45000, NOW(), false),
  ('how to lose weight', 80000, NOW(), false),
  ('how to learn programming', 35000, NOW(), false),
  ('best restaurants near me', 90000, NOW(), false),
  ('best pizza near me', 75000, NOW(), false),
  ('best coffee near me', 65000, NOW(), false),
  ('news', 150000, NOW(), false),
  ('news today', 120000, NOW(), false),
  ('news politics', 80000, NOW(), false),

  -- Entertainment
  ('netflix', 180000, NOW(), false),
  ('netflix movies', 100000, NOW(), false),
  ('netflix shows', 95000, NOW(), false),
  ('new movies', 85000, NOW(), false),
  ('new music', 70000, NOW(), false),
  ('youtube', 280000, NOW(), false),
  ('youtube music', 150000, NOW(), false),
  ('youtube download', 100000, NOW(), false),

  -- Shopping
  ('amazon', 200000, NOW(), false),
  ('amazon prime', 150000, NOW(), false),
  ('amazon delivery', 90000, NOW(), false),
  ('apple', 180000, NOW(), false),
  ('apple iphone', 120000, NOW(), false),
  ('apple macbook', 80000, NOW(), false),

  -- Social
  ('facebook', 250000, NOW(), false),
  ('facebook login', 180000, NOW(), false),
  ('facebook marketplace', 100000, NOW(), false),
  ('instagram', 220000, NOW(), false),
  ('instagram reels', 120000, NOW(), false),
  ('instagram stories', 100000, NOW(), false),
  ('twitter', 180000, NOW(), false),
  ('tiktok', 200000, NOW(), false),
  ('tiktok trends', 90000, NOW(), false),

  -- Food
  ('recipe', 120000, NOW(), false),
  ('recipe chicken', 80000, NOW(), false),
  ('recipe pasta', 75000, NOW(), false),
  ('recipe cookies', 60000, NOW(), false),
  ('restaurant', 150000, NOW(), false),
  ('restaurants near me', 130000, NOW(), false),

  -- Travel
  ('flights', 140000, NOW(), false),
  ('flights to new york', 60000, NOW(), false),
  ('flights to los angeles', 55000, NOW(), false),
  ('flights cheap', 90000, NOW(), false),
  ('hotel', 130000, NOW(), false),
  ('hotels near me', 100000, NOW(), false),
  ('hotels in vegas', 70000, NOW(), false),

  -- Google services
  ('google', 300000, NOW(), false),
  ('google maps', 200000, NOW(), false),
  ('google translate', 180000, NOW(), false),
  ('gmail', 220000, NOW(), false),
  ('google drive', 150000, NOW(), false),

  -- Other popular
  ('zoom', 180000, NOW(), false),
  ('zoom meeting', 120000, NOW(), false),
  ('zara', 80000, NOW(), false),
  ('zelle', 70000, NOW(), false),
  ('zillow', 90000, NOW(), false),
  ('xbox', 100000, NOW(), false)
ON CONFLICT (phrase) DO UPDATE SET count = EXCLUDED.count, last_updated = NOW();

-- Sample filtered phrases (inappropriate content)
INSERT INTO filtered_phrases (phrase, reason)
VALUES
  ('badword1', 'profanity'),
  ('badword2', 'profanity'),
  ('spam123', 'spam'),
  ('scam offer', 'scam')
ON CONFLICT (phrase) DO NOTHING;

-- Sample analytics summary
INSERT INTO analytics_summary (date, total_queries, unique_queries, unique_users, avg_query_length)
VALUES
  (CURRENT_DATE - 6, 1250000, 45000, 125000, 12.5),
  (CURRENT_DATE - 5, 1180000, 42000, 118000, 11.8),
  (CURRENT_DATE - 4, 1320000, 48000, 132000, 13.2),
  (CURRENT_DATE - 3, 1450000, 52000, 145000, 12.1),
  (CURRENT_DATE - 2, 1380000, 49000, 138000, 12.8),
  (CURRENT_DATE - 1, 1520000, 55000, 152000, 11.9),
  (CURRENT_DATE, 890000, 32000, 89000, 12.3)
ON CONFLICT (date) DO UPDATE SET
  total_queries = EXCLUDED.total_queries,
  unique_queries = EXCLUDED.unique_queries,
  unique_users = EXCLUDED.unique_users,
  avg_query_length = EXCLUDED.avg_query_length;

-- Sample trending snapshots
INSERT INTO trending_snapshots (phrase, score, snapshot_time)
VALUES
  ('react 19', 9850.50, NOW() - INTERVAL '1 hour'),
  ('taylor swift', 9520.25, NOW() - INTERVAL '1 hour'),
  ('world cup', 9200.00, NOW() - INTERVAL '1 hour'),
  ('ai news', 8950.75, NOW() - INTERVAL '1 hour'),
  ('new iphone', 8700.50, NOW() - INTERVAL '1 hour'),
  ('stock market', 8450.25, NOW() - INTERVAL '1 hour'),
  ('election results', 8200.00, NOW() - INTERVAL '1 hour'),
  ('weather alert', 7950.50, NOW() - INTERVAL '1 hour'),
  ('breaking news', 7700.25, NOW() - INTERVAL '1 hour'),
  ('movie release', 7450.00, NOW() - INTERVAL '1 hour')
ON CONFLICT DO NOTHING;
