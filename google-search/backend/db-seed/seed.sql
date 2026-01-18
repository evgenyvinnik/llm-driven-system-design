-- Google Search Seed Data
-- This seeds the crawler database with sample URLs, documents, and search data

-- Sample URLs (websites to crawl)
INSERT INTO urls (id, url_hash, url, domain, last_crawl, last_modified, crawl_status, content_hash, page_rank, inlink_count, priority) VALUES
  (1, 1234567890123456, 'https://example.com/', 'example.com', NOW() - INTERVAL '1 day', NOW() - INTERVAL '2 days', 'completed', 9876543210987654, 0.85, 156, 0.9),
  (2, 2345678901234567, 'https://example.com/about', 'example.com', NOW() - INTERVAL '1 day', NOW() - INTERVAL '3 days', 'completed', 8765432109876543, 0.72, 89, 0.8),
  (3, 3456789012345678, 'https://example.com/products', 'example.com', NOW() - INTERVAL '2 days', NOW() - INTERVAL '5 days', 'completed', 7654321098765432, 0.68, 67, 0.75),
  (4, 4567890123456789, 'https://techblog.dev/', 'techblog.dev', NOW() - INTERVAL '12 hours', NOW() - INTERVAL '1 day', 'completed', 6543210987654321, 0.91, 234, 0.95),
  (5, 5678901234567890, 'https://techblog.dev/tutorials/javascript', 'techblog.dev', NOW() - INTERVAL '12 hours', NOW() - INTERVAL '2 days', 'completed', 5432109876543210, 0.78, 123, 0.85),
  (6, 6789012345678901, 'https://techblog.dev/tutorials/python', 'techblog.dev', NOW() - INTERVAL '12 hours', NOW() - INTERVAL '2 days', 'completed', 4321098765432109, 0.76, 118, 0.82),
  (7, 7890123456789012, 'https://docs.framework.io/', 'docs.framework.io', NOW() - INTERVAL '6 hours', NOW() - INTERVAL '12 hours', 'completed', 3210987654321098, 0.88, 456, 0.92),
  (8, 8901234567890123, 'https://docs.framework.io/getting-started', 'docs.framework.io', NOW() - INTERVAL '6 hours', NOW() - INTERVAL '1 day', 'completed', 2109876543210987, 0.82, 345, 0.88),
  (9, 9012345678901234, 'https://news.site.com/', 'news.site.com', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '2 hours', 'completed', 1098765432109876, 0.65, 78, 0.7),
  (10, 1023456789012345, 'https://news.site.com/tech/ai-advances', 'news.site.com', NOW() - INTERVAL '1 hour', NOW() - INTERVAL '3 hours', 'completed', 9876543210123456, 0.58, 45, 0.65),
  -- Pending URLs
  (11, 1123456789012345, 'https://newsite.org/', 'newsite.org', NULL, NULL, 'pending', NULL, 0.0, 0, 0.5),
  (12, 1223456789012345, 'https://blog.startup.com/', 'blog.startup.com', NULL, NULL, 'pending', NULL, 0.0, 0, 0.5)
ON CONFLICT (url_hash) DO NOTHING;

-- Sample Documents (indexed content)
INSERT INTO documents (id, url_id, url, title, description, content, content_length, language, fetch_time) VALUES
  (1, 1, 'https://example.com/', 'Example Domain - Home', 'This domain is for use in illustrative examples in documents.', 'Welcome to Example Domain. This domain is for use in illustrative examples in documents. You may use this domain in literature without prior coordination or asking for permission. Example Domain has been established as a safe and reliable resource for documentation and testing purposes across the internet.', 298, 'en', NOW() - INTERVAL '1 day'),

  (2, 2, 'https://example.com/about', 'About Us - Example Domain', 'Learn about Example Domain and its purpose.', 'About Example Domain. We provide a stable, reliable domain for use in documentation, tutorials, and examples. Our mission is to offer a predictable resource that developers and writers can reference without concerns about link rot or changing content. The domain has been reserved by IANA for special use in documentation.', 312, 'en', NOW() - INTERVAL '1 day'),

  (3, 3, 'https://example.com/products', 'Products - Example Domain', 'Example products and services overview.', 'Example Products and Services. This page demonstrates how a typical products page might be structured. Categories include: Software Development Tools, Cloud Computing Services, and Educational Resources. Each product comes with comprehensive documentation and support options.', 267, 'en', NOW() - INTERVAL '2 days'),

  (4, 4, 'https://techblog.dev/', 'TechBlog - Developer Tutorials and Guides', 'The best tutorials for modern web development.', 'Welcome to TechBlog, your source for high-quality developer tutorials. We cover JavaScript, Python, React, Node.js, and cloud technologies. Our tutorials are written by experienced developers and reviewed for accuracy. Whether you are a beginner or an experienced developer, we have content for you. Start learning today with our comprehensive guides.', 356, 'en', NOW() - INTERVAL '12 hours'),

  (5, 5, 'https://techblog.dev/tutorials/javascript', 'JavaScript Tutorial - Complete Guide', 'Learn JavaScript from basics to advanced concepts.', 'JavaScript Tutorial: The Complete Guide. JavaScript is a versatile programming language essential for web development. This tutorial covers variables, functions, objects, arrays, promises, async/await, and modern ES6+ features. Learn about DOM manipulation, event handling, and building interactive web applications. Perfect for beginners and intermediate developers looking to strengthen their JavaScript skills.', 423, 'en', NOW() - INTERVAL '12 hours'),

  (6, 6, 'https://techblog.dev/tutorials/python', 'Python Tutorial - From Beginner to Pro', 'Comprehensive Python programming tutorial.', 'Python Tutorial: From Beginner to Pro. Python is a powerful, readable programming language used in web development, data science, machine learning, and automation. This tutorial covers syntax basics, data structures, file handling, object-oriented programming, and popular libraries like NumPy, Pandas, and Flask. Build real projects while learning Python fundamentals.', 389, 'en', NOW() - INTERVAL '12 hours'),

  (7, 7, 'https://docs.framework.io/', 'Framework.io Documentation', 'Official documentation for Framework.io', 'Framework.io Documentation. Framework.io is a modern web application framework designed for performance and developer experience. Features include server-side rendering, static site generation, API routes, and built-in optimization. This documentation covers installation, configuration, deployment, and best practices for building production-ready applications.', 378, 'en', NOW() - INTERVAL '6 hours'),

  (8, 8, 'https://docs.framework.io/getting-started', 'Getting Started - Framework.io', 'Quick start guide for Framework.io', 'Getting Started with Framework.io. This guide will help you set up your first Framework.io project in minutes. Prerequisites: Node.js 18 or later. Steps: 1. Install the CLI with npm install -g framework-cli. 2. Create a new project with framework create my-app. 3. Start the development server with npm run dev. Your application will be running at http://localhost:3000.', 412, 'en', NOW() - INTERVAL '6 hours'),

  (9, 9, 'https://news.site.com/', 'Tech News Today', 'Latest technology news and updates.', 'Tech News Today - Your source for the latest technology news, reviews, and analysis. Stay informed about artificial intelligence, blockchain, cybersecurity, and emerging technologies. Our team of journalists covers breaking news from major tech companies, startups, and research institutions around the world.', 298, 'en', NOW() - INTERVAL '1 hour'),

  (10, 10, 'https://news.site.com/tech/ai-advances', 'Revolutionary AI Advances in 2024', 'How AI is transforming industries this year.', 'Revolutionary AI Advances in 2024. Artificial intelligence continues to reshape industries with breakthrough developments in large language models, computer vision, and autonomous systems. Key trends include multimodal AI that can process text, images, and audio simultaneously; AI agents that can take actions on behalf of users; and significant improvements in reasoning capabilities.', 389, 'en', NOW() - INTERVAL '1 hour')
ON CONFLICT DO NOTHING;

-- Sample Links (for PageRank)
INSERT INTO links (source_url_id, target_url_id, anchor_text) VALUES
  -- example.com internal links
  (1, 2, 'About Us'),
  (1, 3, 'Our Products'),
  (2, 1, 'Home'),
  (2, 3, 'Products'),
  (3, 1, 'Back to Home'),
  -- techblog.dev internal links
  (4, 5, 'JavaScript Tutorial'),
  (4, 6, 'Python Tutorial'),
  (5, 4, 'TechBlog Home'),
  (5, 6, 'Learn Python'),
  (6, 4, 'TechBlog Home'),
  (6, 5, 'Learn JavaScript'),
  -- docs.framework.io internal links
  (7, 8, 'Getting Started'),
  (8, 7, 'Documentation Home'),
  -- news.site.com internal links
  (9, 10, 'AI Advances'),
  (10, 9, 'News Home'),
  -- Cross-domain links
  (4, 7, 'Framework.io Docs'),
  (5, 7, 'Framework Documentation'),
  (9, 4, 'TechBlog'),
  (10, 5, 'JavaScript Resources')
ON CONFLICT (source_url_id, target_url_id) DO NOTHING;

-- Sample Query Logs
INSERT INTO query_logs (query, results_count, results_clicked, duration_ms, session_id) VALUES
  ('javascript tutorial', 15, '["https://techblog.dev/tutorials/javascript", "https://docs.framework.io/getting-started"]', 45, 'sess_001'),
  ('python programming', 12, '["https://techblog.dev/tutorials/python"]', 38, 'sess_001'),
  ('web development', 28, '["https://techblog.dev/", "https://docs.framework.io/"]', 52, 'sess_002'),
  ('framework getting started', 8, '["https://docs.framework.io/getting-started"]', 32, 'sess_003'),
  ('ai news 2024', 6, '["https://news.site.com/tech/ai-advances"]', 28, 'sess_004'),
  ('example domain', 3, '["https://example.com/"]', 21, 'sess_005'),
  ('react tutorial', 18, '[]', 42, 'sess_006'),
  ('machine learning python', 9, '["https://techblog.dev/tutorials/python"]', 35, 'sess_007'),
  ('api documentation', 14, '["https://docs.framework.io/"]', 41, 'sess_008'),
  ('technology trends', 11, '["https://news.site.com/", "https://news.site.com/tech/ai-advances"]', 48, 'sess_009')
ON CONFLICT DO NOTHING;

-- Search Suggestions (popular queries)
INSERT INTO search_suggestions (query, frequency, last_used) VALUES
  ('javascript tutorial', 1250, NOW() - INTERVAL '1 hour'),
  ('python programming', 980, NOW() - INTERVAL '2 hours'),
  ('react hooks', 875, NOW() - INTERVAL '3 hours'),
  ('machine learning', 820, NOW() - INTERVAL '4 hours'),
  ('web development', 756, NOW() - INTERVAL '5 hours'),
  ('api design', 612, NOW() - INTERVAL '6 hours'),
  ('node.js express', 589, NOW() - INTERVAL '8 hours'),
  ('docker tutorial', 534, NOW() - INTERVAL '10 hours'),
  ('kubernetes basics', 478, NOW() - INTERVAL '12 hours'),
  ('typescript guide', 423, NOW() - INTERVAL '1 day'),
  ('graphql api', 389, NOW() - INTERVAL '1 day'),
  ('microservices architecture', 345, NOW() - INTERVAL '2 days'),
  ('database design', 312, NOW() - INTERVAL '2 days'),
  ('cloud computing', 289, NOW() - INTERVAL '3 days'),
  ('devops practices', 256, NOW() - INTERVAL '3 days')
ON CONFLICT (query) DO UPDATE SET
  frequency = search_suggestions.frequency + EXCLUDED.frequency,
  last_used = EXCLUDED.last_used;

-- Robots.txt Cache
INSERT INTO robots_cache (domain, content, expires_at) VALUES
  ('example.com', 'User-agent: *\nAllow: /\nDisallow: /private/', NOW() + INTERVAL '7 days'),
  ('techblog.dev', 'User-agent: *\nAllow: /\nCrawl-delay: 1', NOW() + INTERVAL '7 days'),
  ('docs.framework.io', 'User-agent: *\nAllow: /', NOW() + INTERVAL '7 days'),
  ('news.site.com', 'User-agent: *\nAllow: /\nDisallow: /admin/', NOW() + INTERVAL '7 days')
ON CONFLICT (domain) DO UPDATE SET
  content = EXCLUDED.content,
  expires_at = EXCLUDED.expires_at;
