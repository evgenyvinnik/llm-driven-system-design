-- Web Crawler Seed Data
-- Sample seed URLs, domains, and initial crawl data

-- Sample domains with robots.txt info
INSERT INTO domains (domain, robots_txt, robots_fetched_at, crawl_delay, page_count, is_allowed)
VALUES
  ('example.com', 'User-agent: *
Allow: /
Disallow: /private/
Disallow: /admin/', NOW(), 1.0, 0, true),
  ('wikipedia.org', 'User-agent: *
Allow: /
Crawl-delay: 1', NOW(), 1.0, 0, true),
  ('github.com', 'User-agent: *
Allow: /
Disallow: /*/tree/
Disallow: /*/blob/', NOW(), 2.0, 0, true),
  ('news.ycombinator.com', 'User-agent: *
Allow: /
Crawl-delay: 30', NOW(), 30.0, 0, true),
  ('stackoverflow.com', 'User-agent: *
Allow: /
Crawl-delay: 1', NOW(), 1.0, 0, true),
  ('medium.com', 'User-agent: *
Allow: /', NOW(), 1.0, 0, true),
  ('dev.to', 'User-agent: *
Allow: /', NOW(), 1.0, 0, true),
  ('reddit.com', 'User-agent: *
Allow: /
Disallow: /user/', NOW(), 2.0, 0, true)
ON CONFLICT (domain) DO NOTHING;

-- Seed URLs (starting points for crawling)
INSERT INTO seed_urls (url, priority, is_active)
VALUES
  ('https://example.com/', 3, true),
  ('https://en.wikipedia.org/wiki/Main_Page', 3, true),
  ('https://github.com/explore', 2, true),
  ('https://news.ycombinator.com/', 3, true),
  ('https://stackoverflow.com/questions', 2, true),
  ('https://medium.com/', 2, true),
  ('https://dev.to/', 2, true),
  ('https://reddit.com/r/programming', 2, true),
  ('https://www.nytimes.com/', 2, false),
  ('https://www.bbc.com/news', 2, false)
ON CONFLICT (url) DO NOTHING;

-- Sample URL frontier entries (URLs to be crawled)
INSERT INTO url_frontier (url, url_hash, domain, priority, depth, status, scheduled_at)
VALUES
  ('https://example.com/', '7a38b3c7d4f5e6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1', 'example.com', 3, 0, 'pending', NOW()),
  ('https://example.com/about', '1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2', 'example.com', 2, 1, 'pending', NOW()),
  ('https://example.com/products', '2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3', 'example.com', 2, 1, 'pending', NOW()),
  ('https://en.wikipedia.org/wiki/Main_Page', '3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4', 'wikipedia.org', 3, 0, 'pending', NOW()),
  ('https://en.wikipedia.org/wiki/Web_crawler', '4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5', 'wikipedia.org', 2, 1, 'pending', NOW()),
  ('https://github.com/explore', '5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6', 'github.com', 2, 0, 'pending', NOW()),
  ('https://news.ycombinator.com/', '6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7', 'news.ycombinator.com', 3, 0, 'pending', NOW()),
  ('https://stackoverflow.com/questions', '7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8', 'stackoverflow.com', 2, 0, 'pending', NOW())
ON CONFLICT (url_hash) DO NOTHING;

-- Sample crawled pages (already processed)
INSERT INTO crawled_pages (url, url_hash, domain, status_code, content_type, content_length, content_hash, title, description, links_count, crawled_at, crawl_duration_ms)
VALUES
  ('https://example.com/', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2', 'example.com', 200, 'text/html', 12450, 'hash_content_example_home', 'Example Domain', 'This domain is for use in illustrative examples in documents.', 15, NOW() - INTERVAL '1 hour', 245),
  ('https://example.com/contact', 'b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3', 'example.com', 200, 'text/html', 8920, 'hash_content_example_contact', 'Contact Us - Example Domain', 'Get in touch with Example Domain.', 8, NOW() - INTERVAL '50 minutes', 189),
  ('https://en.wikipedia.org/wiki/Computer_science', 'c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4', 'wikipedia.org', 200, 'text/html', 156780, 'hash_content_wiki_cs', 'Computer science - Wikipedia', 'Computer science is the study of computation, information, and automation.', 450, NOW() - INTERVAL '45 minutes', 1250),
  ('https://github.com/', 'd4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5', 'github.com', 200, 'text/html', 89450, 'hash_content_github_home', 'GitHub: Let''s build from here', 'GitHub is where over 100 million developers shape the future of software.', 125, NOW() - INTERVAL '30 minutes', 890),
  ('https://stackoverflow.com/', 'e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6', 'stackoverflow.com', 200, 'text/html', 67890, 'hash_content_so_home', 'Stack Overflow - Where Developers Learn, Share, & Build Careers', 'Stack Overflow is the largest, most trusted online community for developers.', 85, NOW() - INTERVAL '20 minutes', 567)
ON CONFLICT (url_hash) DO NOTHING;

-- Sample crawl stats (worker statistics)
INSERT INTO crawl_stats (worker_id, timestamp, pages_crawled, pages_failed, bytes_downloaded, links_discovered, duplicates_skipped)
VALUES
  ('worker-1', NOW() - INTERVAL '1 hour', 25, 2, 1250000, 450, 120),
  ('worker-1', NOW() - INTERVAL '30 minutes', 18, 1, 890000, 320, 85),
  ('worker-1', NOW(), 12, 0, 567000, 215, 45),
  ('worker-2', NOW() - INTERVAL '1 hour', 22, 3, 1120000, 410, 98),
  ('worker-2', NOW() - INTERVAL '30 minutes', 20, 2, 980000, 380, 110),
  ('worker-2', NOW(), 15, 1, 720000, 280, 72),
  ('worker-3', NOW() - INTERVAL '1 hour', 28, 1, 1380000, 520, 145),
  ('worker-3', NOW() - INTERVAL '30 minutes', 24, 2, 1150000, 445, 125),
  ('worker-3', NOW(), 10, 0, 480000, 175, 38)
ON CONFLICT DO NOTHING;

-- Update domain page counts based on crawled pages
UPDATE domains SET page_count = (
  SELECT COUNT(*) FROM crawled_pages WHERE crawled_pages.domain = domains.domain
);
