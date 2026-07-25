-- LinkedIn Seed Data
-- Populates the database with realistic sample data for development and demos
-- All inserts use ON CONFLICT DO NOTHING to be safely re-runnable

-- ============================================================================
-- COMPANIES
-- ============================================================================

INSERT INTO companies (id, name, slug, description, industry, size, location, website, logo_url)
VALUES
  (1, 'TechCorp', 'techcorp', 'A leading technology company building innovative solutions for enterprise clients.', 'Technology', '1001-5000', 'San Francisco, CA', 'https://techcorp.example.com', NULL),
  (2, 'DataFlow Inc.', 'dataflow-inc', 'Specializing in data pipeline infrastructure and real-time analytics platforms.', 'Technology', '201-500', 'Seattle, WA', 'https://dataflow.example.com', NULL),
  (3, 'GreenLeaf Studios', 'greenleaf-studios', 'A creative design studio focused on sustainable brands and environmental campaigns.', 'Design', '11-50', 'Portland, OR', 'https://greenleaf.example.com', NULL),
  (4, 'FinEdge Capital', 'finedge-capital', 'Fintech startup disrupting traditional banking with AI-driven investment tools.', 'Financial Services', '51-200', 'New York, NY', 'https://finedge.example.com', NULL),
  (5, 'MedVision Health', 'medvision-health', 'Healthcare technology company building diagnostic imaging solutions powered by machine learning.', 'Healthcare', '501-1000', 'Boston, MA', 'https://medvision.example.com', NULL),
  (6, 'CloudNine Systems', 'cloudnine-systems', 'Cloud infrastructure and DevOps tooling for modern engineering teams.', 'Technology', '201-500', 'Austin, TX', 'https://cloudnine.example.com', NULL)
ON CONFLICT DO NOTHING;

SELECT setval('companies_id_seq', (SELECT COALESCE(MAX(id), 0) FROM companies));

-- ============================================================================
-- USERS
-- ============================================================================

-- password123 = $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom
-- admin123   = $2a$10$Jwu.HnwmSQGc02Lr7mgZ.uRhHxwKb.KjaUcoz9PlnUfR0lAmhvJAq

INSERT INTO users (id, email, password_hash, first_name, last_name, headline, summary, location, industry, profile_image_url, connection_count, role)
VALUES
  (1, 'alice@example.com',
   '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi',
   'Alice', 'Johnson',
   'Senior Software Engineer at TechCorp',
   'Passionate full-stack engineer with 8+ years of experience building scalable distributed systems. Currently leading the platform team at TechCorp, where I focus on microservice architecture and developer productivity. Previously at DataFlow Inc. building real-time data pipelines. I love mentoring junior engineers and speaking at conferences about system design.',
   'San Francisco, CA', 'Technology', NULL, 3, 'user'),

  (2, 'bob@example.com',
   '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi',
   'Bob', 'Williams',
   'Product Manager at DataFlow Inc.',
   'Product leader with a technical background, bridging the gap between engineering and business. I spent 4 years as a software engineer before transitioning to product management. At DataFlow, I lead the analytics product line and drive roadmap decisions informed by customer research and data. Passionate about building products that developers love.',
   'Seattle, WA', 'Technology', NULL, 2, 'user'),

  (3, 'charlie@example.com',
   '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi',
   'Charlie', 'Davis',
   'UX Designer at GreenLeaf Studios',
   'User experience designer with a focus on accessibility and sustainable design practices. I believe great design should be inclusive by default. At GreenLeaf Studios, I lead UX for our flagship brand campaigns and have helped increase user engagement by 40% through research-driven redesigns. Previously freelanced for startups in the health and education space.',
   'Portland, OR', 'Design', NULL, 2, 'user'),

  (4, 'diana@example.com',
   '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi',
   'Diana', 'Martinez',
   'Data Scientist at FinEdge Capital',
   'Data scientist and machine learning engineer specializing in financial modeling and risk analysis. At FinEdge Capital, I build predictive models that power our AI-driven investment platform. My work combines quantitative finance with deep learning techniques. I hold a Ph.D. in Applied Mathematics from MIT and have published papers on stochastic optimization.',
   'New York, NY', 'Financial Services', NULL, 2, 'user'),

  (5, 'admin@example.com',
   '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi',
   'Admin', 'User',
   'Platform Administrator',
   'System administrator responsible for platform operations, user management, and content moderation. Ensuring the LinkedIn clone runs smoothly for all users.',
   'San Francisco, CA', 'Technology', NULL, 0, 'admin')
ON CONFLICT DO NOTHING;

SELECT setval('users_id_seq', (SELECT COALESCE(MAX(id), 0) FROM users));

-- ============================================================================
-- SKILLS
-- ============================================================================

INSERT INTO skills (id, name) VALUES
  (1, 'JavaScript'),
  (2, 'TypeScript'),
  (3, 'Python'),
  (4, 'React'),
  (5, 'Node.js'),
  (6, 'PostgreSQL'),
  (7, 'AWS'),
  (8, 'Docker'),
  (9, 'Kubernetes'),
  (10, 'Machine Learning'),
  (11, 'Data Analysis'),
  (12, 'Product Management'),
  (13, 'Agile'),
  (14, 'UX Design'),
  (15, 'Figma'),
  (16, 'User Research'),
  (17, 'SQL'),
  (18, 'GraphQL'),
  (19, 'System Design'),
  (20, 'Deep Learning'),
  (21, 'TensorFlow'),
  (22, 'Financial Modeling'),
  (23, 'Risk Analysis'),
  (24, 'Apache Kafka'),
  (25, 'Redis')
ON CONFLICT DO NOTHING;

SELECT setval('skills_id_seq', (SELECT COALESCE(MAX(id), 0) FROM skills));

-- ============================================================================
-- USER SKILLS
-- ============================================================================

-- Alice: full-stack engineer
INSERT INTO user_skills (user_id, skill_id, endorsement_count) VALUES
  (1, 1, 12),   -- JavaScript
  (1, 2, 9),    -- TypeScript
  (1, 4, 15),   -- React
  (1, 5, 11),   -- Node.js
  (1, 6, 7),    -- PostgreSQL
  (1, 7, 5),    -- AWS
  (1, 8, 8),    -- Docker
  (1, 9, 4),    -- Kubernetes
  (1, 19, 6),   -- System Design
  (1, 25, 3)    -- Redis
ON CONFLICT DO NOTHING;

-- Bob: product manager with tech background
INSERT INTO user_skills (user_id, skill_id, endorsement_count) VALUES
  (2, 12, 14),  -- Product Management
  (2, 13, 10),  -- Agile
  (2, 3, 5),    -- Python
  (2, 17, 7),   -- SQL
  (2, 11, 8),   -- Data Analysis
  (2, 1, 4)     -- JavaScript
ON CONFLICT DO NOTHING;

-- Charlie: UX designer
INSERT INTO user_skills (user_id, skill_id, endorsement_count) VALUES
  (3, 14, 18),  -- UX Design
  (3, 15, 15),  -- Figma
  (3, 16, 12),  -- User Research
  (3, 4, 6),    -- React
  (3, 1, 3),    -- JavaScript
  (3, 2, 2)     -- TypeScript
ON CONFLICT DO NOTHING;

-- Diana: data scientist
INSERT INTO user_skills (user_id, skill_id, endorsement_count) VALUES
  (4, 3, 20),   -- Python
  (4, 10, 16),  -- Machine Learning
  (4, 20, 13),  -- Deep Learning
  (4, 21, 11),  -- TensorFlow
  (4, 22, 9),   -- Financial Modeling
  (4, 23, 7),   -- Risk Analysis
  (4, 17, 8),   -- SQL
  (4, 11, 10)   -- Data Analysis
ON CONFLICT DO NOTHING;

-- ============================================================================
-- EXPERIENCES
-- ============================================================================

-- Alice's experience
INSERT INTO experiences (id, user_id, company_id, company_name, title, location, start_date, end_date, description, is_current)
VALUES
  (1, 1, 1, 'TechCorp', 'Senior Software Engineer', 'San Francisco, CA',
   '2021-03-01', NULL,
   'Leading the platform team building core microservice infrastructure. Designed and implemented a service mesh that reduced inter-service latency by 35%. Mentoring 4 junior engineers and driving architecture decisions for the engineering organization.',
   TRUE),
  (2, 1, 2, 'DataFlow Inc.', 'Software Engineer', 'Seattle, WA',
   '2018-06-01', '2021-02-28',
   'Built real-time data ingestion pipelines processing 2M+ events per second using Kafka and Flink. Designed the schema registry that standardized data contracts across 15 engineering teams.',
   FALSE),
  (3, 1, NULL, 'Startup Labs', 'Junior Developer', 'San Francisco, CA',
   '2016-01-15', '2018-05-31',
   'Full-stack development on a B2B SaaS platform. Built customer-facing dashboards using React and contributed to the Node.js API layer. First engineering hire, wore many hats.',
   FALSE)
ON CONFLICT DO NOTHING;

-- Bob's experience
INSERT INTO experiences (id, user_id, company_id, company_name, title, location, start_date, end_date, description, is_current)
VALUES
  (4, 2, 2, 'DataFlow Inc.', 'Senior Product Manager', 'Seattle, WA',
   '2022-01-01', NULL,
   'Leading the analytics product line with $12M ARR. Drove the launch of a self-serve analytics dashboard that increased customer adoption by 60%. Managing a cross-functional team of 8 engineers and 2 designers.',
   TRUE),
  (5, 2, 2, 'DataFlow Inc.', 'Product Manager', 'Seattle, WA',
   '2020-03-01', '2021-12-31',
   'Owned the data connector product, growing the integration catalog from 20 to 85+ connectors. Conducted extensive customer research to prioritize the roadmap.',
   FALSE),
  (6, 2, NULL, 'WebDev Co.', 'Software Engineer', 'San Francisco, CA',
   '2017-08-01', '2020-02-28',
   'Full-stack engineer building internal tools and customer-facing web applications. Transitioned to product management after identifying process improvements that reduced release cycles by 40%.',
   FALSE)
ON CONFLICT DO NOTHING;

-- Charlie's experience
INSERT INTO experiences (id, user_id, company_id, company_name, title, location, start_date, end_date, description, is_current)
VALUES
  (7, 3, 3, 'GreenLeaf Studios', 'Lead UX Designer', 'Portland, OR',
   '2020-09-01', NULL,
   'Leading UX for flagship brand campaigns serving Fortune 500 sustainability initiatives. Established the design system and accessibility guidelines adopted across all studio projects. Increased user engagement by 40% through research-driven redesigns.',
   TRUE),
  (8, 3, NULL, 'Freelance', 'UX/UI Designer', 'Portland, OR',
   '2018-01-01', '2020-08-31',
   'Freelance design work for startups in health tech and ed tech. Delivered end-to-end design for 8 products from user research through high-fidelity prototypes and developer handoff.',
   FALSE)
ON CONFLICT DO NOTHING;

-- Diana's experience
INSERT INTO experiences (id, user_id, company_id, company_name, title, location, start_date, end_date, description, is_current)
VALUES
  (9, 4, 4, 'FinEdge Capital', 'Senior Data Scientist', 'New York, NY',
   '2021-07-01', NULL,
   'Building predictive models for the AI-driven investment platform. Developed a portfolio optimization algorithm that outperformed the benchmark by 8% in backtesting. Leading a team of 3 data scientists working on risk modeling and market prediction.',
   TRUE),
  (10, 4, 5, 'MedVision Health', 'Data Scientist', 'Boston, MA',
   '2019-02-01', '2021-06-30',
   'Applied deep learning to medical imaging for early disease detection. Built a convolutional neural network that achieved 94% accuracy in detecting anomalies in chest X-rays, published results in a peer-reviewed journal.',
   FALSE)
ON CONFLICT DO NOTHING;

SELECT setval('experiences_id_seq', (SELECT COALESCE(MAX(id), 0) FROM experiences));

-- ============================================================================
-- EDUCATION
-- ============================================================================

INSERT INTO education (id, user_id, school_name, degree, field_of_study, start_year, end_year, description)
VALUES
  (1, 1, 'University of California, Berkeley', 'Bachelor of Science', 'Computer Science', 2012, 2016,
   'Focus on systems programming and distributed computing. Senior thesis on fault-tolerant distributed consensus algorithms. Dean''s List all semesters.'),
  (2, 2, 'University of Washington', 'Bachelor of Science', 'Computer Science', 2013, 2017,
   'Combined studies in computer science and business. Led the entrepreneurship club and participated in three hackathons.'),
  (3, 2, 'University of Washington', 'Master of Business Administration', 'Technology Management', 2019, 2021,
   'Part-time MBA while working at DataFlow. Capstone project on data-driven product strategy in B2B SaaS.'),
  (4, 3, 'Rhode Island School of Design', 'Bachelor of Fine Arts', 'Graphic Design', 2014, 2018,
   'Specialized in interaction design and human-computer interaction. Won the annual student design competition in 2017.'),
  (5, 4, 'Massachusetts Institute of Technology', 'Ph.D.', 'Applied Mathematics', 2014, 2019,
   'Dissertation on stochastic optimization methods for portfolio management. Published 5 papers in top-tier journals. Teaching assistant for graduate probability theory.'),
  (6, 4, 'Stanford University', 'Bachelor of Science', 'Mathematics', 2010, 2014,
   'Double major in Mathematics and Statistics. Summa cum laude. Research assistant in the computational finance lab.')
ON CONFLICT DO NOTHING;

SELECT setval('education_id_seq', (SELECT COALESCE(MAX(id), 0) FROM education));

-- ============================================================================
-- CONNECTIONS
-- ============================================================================
-- Constraint: user_id < connected_to

-- Alice (1) <-> Bob (2)
INSERT INTO connections (user_id, connected_to, connected_at)
VALUES (1, 2, NOW() - INTERVAL '6 months')
ON CONFLICT DO NOTHING;

-- Alice (1) <-> Charlie (3)
INSERT INTO connections (user_id, connected_to, connected_at)
VALUES (1, 3, NOW() - INTERVAL '4 months')
ON CONFLICT DO NOTHING;

-- Alice (1) <-> Diana (4)
INSERT INTO connections (user_id, connected_to, connected_at)
VALUES (1, 4, NOW() - INTERVAL '2 months')
ON CONFLICT DO NOTHING;

-- Bob (2) <-> Charlie (3)
INSERT INTO connections (user_id, connected_to, connected_at)
VALUES (2, 3, NOW() - INTERVAL '3 months')
ON CONFLICT DO NOTHING;

-- Bob (2) <-> Diana (4) -- via mutual connection with Alice
INSERT INTO connections (user_id, connected_to, connected_at)
VALUES (2, 4, NOW() - INTERVAL '1 month')
ON CONFLICT DO NOTHING;

-- Charlie (3) <-> Diana (4)
INSERT INTO connections (user_id, connected_to, connected_at)
VALUES (3, 4, NOW() - INTERVAL '2 weeks')
ON CONFLICT DO NOTHING;

-- Update denormalized connection counts
UPDATE users SET connection_count = 3 WHERE id = 1;  -- Alice: Bob, Charlie, Diana
UPDATE users SET connection_count = 3 WHERE id = 2;  -- Bob: Alice, Charlie, Diana
UPDATE users SET connection_count = 3 WHERE id = 3;  -- Charlie: Alice, Bob, Diana
UPDATE users SET connection_count = 3 WHERE id = 4;  -- Diana: Alice, Bob, Charlie

-- ============================================================================
-- CONNECTION REQUESTS (pending)
-- ============================================================================

-- Diana wants to connect with Admin
INSERT INTO connection_requests (id, from_user_id, to_user_id, message, status)
VALUES
  (1, 4, 5, 'Hi Admin, I''d love to connect and learn more about platform operations!', 'pending')
ON CONFLICT DO NOTHING;

SELECT setval('connection_requests_id_seq', (SELECT COALESCE(MAX(id), 0) FROM connection_requests));

-- ============================================================================
-- POSTS
-- ============================================================================

INSERT INTO posts (id, user_id, content, image_url, like_count, comment_count, share_count, created_at)
VALUES
  (1, 1,
   'Excited to share that we just shipped our new service mesh at TechCorp! After 6 months of work, we reduced inter-service latency by 35% and simplified our deployment pipeline. The key insight was moving from sidecar proxies to eBPF-based networking. Happy to answer questions about our journey!',
   NULL, 24, 5, 3, NOW() - INTERVAL '2 days'),

  (2, 2,
   'Hot take: The best product managers are the ones who can say "no" to 90% of feature requests while making stakeholders feel heard. It''s not about building everything — it''s about building the right thing. What''s the hardest "no" you''ve had to deliver?',
   NULL, 42, 8, 7, NOW() - INTERVAL '1 day'),

  (3, 3,
   'Just wrapped up a major accessibility audit for one of our clients. Findings: 73% of their user flows had at least one WCAG 2.1 AA violation. The most common issues? Missing alt text, insufficient color contrast, and keyboard navigation traps. Accessibility isn''t a nice-to-have — it''s a fundamental design requirement.',
   NULL, 31, 4, 5, NOW() - INTERVAL '3 days'),

  (4, 4,
   'Our latest research at FinEdge shows that transformer-based models outperform traditional LSTM architectures for financial time series prediction by 12% on our benchmark. The key advantage is the self-attention mechanism capturing long-range temporal dependencies that recurrent models struggle with. Paper coming soon!',
   NULL, 18, 3, 2, NOW() - INTERVAL '5 days'),

  (5, 1,
   'Thrilled to announce that I''ll be speaking at SystemsCon 2025 on "Designing for Failure: Lessons from Running 200 Microservices in Production." If you''re attending, come say hi! I''ll be covering circuit breakers, graceful degradation, and why chaos engineering saved us during last year''s Black Friday.',
   NULL, 56, 12, 9, NOW() - INTERVAL '12 hours'),

  (6, 2,
   'Just finished reading "Inspired" by Marty Cagan for the third time. Every re-read surfaces new insights. This time, the chapter on product discovery really hit differently — we''ve been doing too much delivery and not enough discovery. Time to rebalance.',
   NULL, 15, 2, 1, NOW() - INTERVAL '4 days'),

  (7, 4,
   'Excited to share that our portfolio optimization algorithm has been running in production for 3 months and outperforming the S&P 500 benchmark by 8.2%. The combination of transformer-based prediction with mean-variance optimization and real-time risk constraints is proving robust across market conditions.',
   NULL, 37, 6, 4, NOW() - INTERVAL '8 hours')
ON CONFLICT DO NOTHING;

SELECT setval('posts_id_seq', (SELECT COALESCE(MAX(id), 0) FROM posts));

-- ============================================================================
-- POST LIKES
-- ============================================================================

-- Likes on Alice's service mesh post (post 1)
INSERT INTO post_likes (user_id, post_id) VALUES (2, 1) ON CONFLICT DO NOTHING;
INSERT INTO post_likes (user_id, post_id) VALUES (3, 1) ON CONFLICT DO NOTHING;
INSERT INTO post_likes (user_id, post_id) VALUES (4, 1) ON CONFLICT DO NOTHING;

-- Likes on Bob's product management post (post 2)
INSERT INTO post_likes (user_id, post_id) VALUES (1, 2) ON CONFLICT DO NOTHING;
INSERT INTO post_likes (user_id, post_id) VALUES (3, 2) ON CONFLICT DO NOTHING;
INSERT INTO post_likes (user_id, post_id) VALUES (4, 2) ON CONFLICT DO NOTHING;

-- Likes on Charlie's accessibility post (post 3)
INSERT INTO post_likes (user_id, post_id) VALUES (1, 3) ON CONFLICT DO NOTHING;
INSERT INTO post_likes (user_id, post_id) VALUES (2, 3) ON CONFLICT DO NOTHING;

-- Likes on Diana's ML research post (post 4)
INSERT INTO post_likes (user_id, post_id) VALUES (1, 4) ON CONFLICT DO NOTHING;
INSERT INTO post_likes (user_id, post_id) VALUES (2, 4) ON CONFLICT DO NOTHING;

-- Likes on Alice's conference post (post 5)
INSERT INTO post_likes (user_id, post_id) VALUES (2, 5) ON CONFLICT DO NOTHING;
INSERT INTO post_likes (user_id, post_id) VALUES (3, 5) ON CONFLICT DO NOTHING;
INSERT INTO post_likes (user_id, post_id) VALUES (4, 5) ON CONFLICT DO NOTHING;

-- Likes on Diana's algo results post (post 7)
INSERT INTO post_likes (user_id, post_id) VALUES (1, 7) ON CONFLICT DO NOTHING;
INSERT INTO post_likes (user_id, post_id) VALUES (2, 7) ON CONFLICT DO NOTHING;

-- ============================================================================
-- POST COMMENTS
-- ============================================================================

INSERT INTO post_comments (id, post_id, user_id, content, created_at)
VALUES
  (1, 1, 2, 'This is amazing work, Alice! We''ve been looking at eBPF at DataFlow too. Would love to chat about the migration path from sidecar proxies.', NOW() - INTERVAL '1 day 18 hours'),
  (2, 1, 4, 'Impressive latency reduction! Did you see any impact on observability when moving away from sidecars? That''s been our biggest concern.', NOW() - INTERVAL '1 day 12 hours'),
  (3, 1, 3, 'Congrats on the launch! The 35% improvement is massive. How did you measure the baseline?', NOW() - INTERVAL '1 day 6 hours'),
  (4, 2, 1, 'So true. I''ve found that framing the "no" as "not yet" with a clear explanation of priorities helps a lot.', NOW() - INTERVAL '20 hours'),
  (5, 2, 4, 'The hardest no I ever delivered was killing a feature that we''d already spent 3 months building. The data showed nobody would use it. Pain.', NOW() - INTERVAL '18 hours'),
  (6, 2, 3, 'From a design perspective, I''d add that saying no to feature requests often means saying yes to better UX for existing features.', NOW() - INTERVAL '16 hours'),
  (7, 3, 1, 'This is so important. We recently did an accessibility audit at TechCorp and found similar issues. Any tools you recommend for automated testing?', NOW() - INTERVAL '2 days 12 hours'),
  (8, 3, 2, 'Would love to see a breakdown of those findings. We''re planning an audit at DataFlow next quarter.', NOW() - INTERVAL '2 days 6 hours'),
  (9, 4, 1, 'Fascinating results! Are you using vanilla transformers or some custom architecture? The financial time series domain has unique challenges with non-stationarity.', NOW() - INTERVAL '4 days 12 hours'),
  (10, 5, 2, 'Can''t wait for this talk! Chaos engineering is something we need to adopt at DataFlow. Any prereqs you''d recommend?', NOW() - INTERVAL '6 hours'),
  (11, 5, 4, 'Will this be recorded? I''m traveling that week but would love to watch it.', NOW() - INTERVAL '4 hours'),
  (12, 7, 1, '8.2% above benchmark is impressive! How does it handle drawdown during high volatility periods?', NOW() - INTERVAL '4 hours')
ON CONFLICT DO NOTHING;

SELECT setval('post_comments_id_seq', (SELECT COALESCE(MAX(id), 0) FROM post_comments));

-- ============================================================================
-- JOBS
-- ============================================================================

INSERT INTO jobs (id, company_id, posted_by_user_id, title, description, location, is_remote, employment_type, experience_level, years_required, salary_min, salary_max, status)
VALUES
  (1, 1, 1, 'Backend Engineer',
   'Join TechCorp''s platform team to build and scale our microservice infrastructure. You''ll work on service mesh, API gateway, and observability tooling used by 200+ engineers. We''re looking for someone who thrives in a fast-paced environment and is passionate about developer experience.\n\nResponsibilities:\n- Design and implement core platform services\n- Improve system reliability and performance\n- Mentor junior engineers on distributed systems best practices\n- Participate in on-call rotation',
   'San Francisco, CA', FALSE, 'full-time', 'mid-senior', 3, 150000, 220000, 'active'),

  (2, 1, 1, 'Frontend Engineer',
   'Build the next generation of TechCorp''s web applications using React and TypeScript. You''ll work closely with designers and product managers to deliver pixel-perfect, performant user interfaces.\n\nResponsibilities:\n- Develop new features and improve existing ones\n- Write clean, maintainable TypeScript code\n- Collaborate on design system components\n- Optimize application performance and accessibility',
   'San Francisco, CA', TRUE, 'full-time', 'associate', 1, 120000, 180000, 'active'),

  (3, 2, 2, 'Data Engineer',
   'DataFlow is hiring a data engineer to build and maintain our real-time data processing pipelines. You''ll work with Kafka, Flink, and our custom data orchestration framework to process billions of events daily.\n\nResponsibilities:\n- Build reliable data pipelines at scale\n- Design data models and schemas\n- Optimize pipeline performance and cost\n- Implement data quality monitoring',
   'Seattle, WA', TRUE, 'full-time', 'mid-senior', 4, 160000, 230000, 'active'),

  (4, 4, 4, 'Machine Learning Engineer',
   'FinEdge Capital is looking for an ML engineer to join our quantitative research team. You''ll develop and deploy machine learning models for financial prediction and risk management.\n\nResponsibilities:\n- Research and implement ML models for financial markets\n- Build and maintain model training and serving infrastructure\n- Collaborate with portfolio managers on strategy development\n- Monitor model performance and retrain as needed',
   'New York, NY', FALSE, 'full-time', 'mid-senior', 3, 180000, 280000, 'active'),

  (5, 3, NULL, 'Junior UX Designer',
   'GreenLeaf Studios is looking for a passionate junior designer to join our growing team. You''ll work on sustainability-focused brand campaigns for major clients under the mentorship of our senior design team.\n\nResponsibilities:\n- Create wireframes, prototypes, and high-fidelity designs\n- Conduct user research and usability testing\n- Contribute to our design system\n- Collaborate with developers on implementation',
   'Portland, OR', FALSE, 'full-time', 'entry', 0, 65000, 85000, 'active'),

  (6, 5, NULL, 'Senior Data Scientist',
   'MedVision Health is seeking a senior data scientist to advance our diagnostic imaging platform. You''ll apply deep learning to medical images to improve early disease detection.\n\nResponsibilities:\n- Develop and validate medical imaging ML models\n- Collaborate with clinicians on research design\n- Publish findings in peer-reviewed journals\n- Ensure models meet regulatory requirements',
   'Boston, MA', FALSE, 'full-time', 'mid-senior', 5, 170000, 250000, 'active'),

  (7, 6, NULL, 'DevOps Engineer',
   'CloudNine Systems is hiring a DevOps engineer to help build our next-generation cloud infrastructure tooling. You''ll work on CI/CD pipelines, Kubernetes orchestration, and infrastructure-as-code.\n\nResponsibilities:\n- Design and maintain CI/CD pipelines\n- Manage Kubernetes clusters and Helm charts\n- Implement infrastructure as code with Terraform\n- Improve system monitoring and alerting',
   'Austin, TX', TRUE, 'full-time', 'associate', 2, 130000, 190000, 'active')
ON CONFLICT DO NOTHING;

SELECT setval('jobs_id_seq', (SELECT COALESCE(MAX(id), 0) FROM jobs));

-- ============================================================================
-- JOB SKILLS
-- ============================================================================

-- Backend Engineer at TechCorp (job 1)
INSERT INTO job_skills (job_id, skill_id, is_required) VALUES
  (1, 2, TRUE),   -- TypeScript (required)
  (1, 5, TRUE),   -- Node.js (required)
  (1, 6, TRUE),   -- PostgreSQL (required)
  (1, 8, TRUE),   -- Docker (required)
  (1, 9, FALSE),  -- Kubernetes (nice-to-have)
  (1, 19, TRUE),  -- System Design (required)
  (1, 25, FALSE)  -- Redis (nice-to-have)
ON CONFLICT DO NOTHING;

-- Frontend Engineer at TechCorp (job 2)
INSERT INTO job_skills (job_id, skill_id, is_required) VALUES
  (2, 1, TRUE),   -- JavaScript (required)
  (2, 2, TRUE),   -- TypeScript (required)
  (2, 4, TRUE),   -- React (required)
  (2, 18, FALSE)  -- GraphQL (nice-to-have)
ON CONFLICT DO NOTHING;

-- Data Engineer at DataFlow (job 3)
INSERT INTO job_skills (job_id, skill_id, is_required) VALUES
  (3, 3, TRUE),   -- Python (required)
  (3, 17, TRUE),  -- SQL (required)
  (3, 24, TRUE),  -- Apache Kafka (required)
  (3, 7, FALSE),  -- AWS (nice-to-have)
  (3, 8, TRUE)    -- Docker (required)
ON CONFLICT DO NOTHING;

-- ML Engineer at FinEdge (job 4)
INSERT INTO job_skills (job_id, skill_id, is_required) VALUES
  (4, 3, TRUE),   -- Python (required)
  (4, 10, TRUE),  -- Machine Learning (required)
  (4, 20, TRUE),  -- Deep Learning (required)
  (4, 21, FALSE), -- TensorFlow (nice-to-have)
  (4, 22, TRUE)   -- Financial Modeling (required)
ON CONFLICT DO NOTHING;

-- Junior UX Designer at GreenLeaf (job 5)
INSERT INTO job_skills (job_id, skill_id, is_required) VALUES
  (5, 14, TRUE),  -- UX Design (required)
  (5, 15, TRUE),  -- Figma (required)
  (5, 16, FALSE)  -- User Research (nice-to-have)
ON CONFLICT DO NOTHING;

-- Senior Data Scientist at MedVision (job 6)
INSERT INTO job_skills (job_id, skill_id, is_required) VALUES
  (6, 3, TRUE),   -- Python (required)
  (6, 10, TRUE),  -- Machine Learning (required)
  (6, 20, TRUE),  -- Deep Learning (required)
  (6, 21, TRUE)   -- TensorFlow (required)
ON CONFLICT DO NOTHING;

-- DevOps Engineer at CloudNine (job 7)
INSERT INTO job_skills (job_id, skill_id, is_required) VALUES
  (7, 8, TRUE),   -- Docker (required)
  (7, 9, TRUE),   -- Kubernetes (required)
  (7, 7, TRUE),   -- AWS (required)
  (7, 3, FALSE)   -- Python (nice-to-have)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- JOB APPLICATIONS
-- ============================================================================

-- Bob applied to Backend Engineer at TechCorp
INSERT INTO job_applications (id, job_id, user_id, cover_letter, status, match_score)
VALUES
  (1, 1, 2, 'I''m excited to apply for the Backend Engineer role at TechCorp. While my recent career has been in product management, I have a strong engineering background and am looking to transition back to hands-on development. My experience building data pipelines and understanding of distributed systems makes me a strong candidate.', 'reviewed', 45)
ON CONFLICT DO NOTHING;

-- Diana applied to ML Engineer at FinEdge (internal transfer scenario)
INSERT INTO job_applications (id, job_id, user_id, cover_letter, status, match_score)
VALUES
  (2, 4, 4, 'As a current member of the data science team, I''d like to formally apply for the ML Engineer position. My work on the portfolio optimization algorithm and transformer-based prediction models directly aligns with this role''s requirements.', 'interviewing', 92)
ON CONFLICT DO NOTHING;

-- Charlie applied to Junior UX Designer at GreenLeaf (internal application)
INSERT INTO job_applications (id, job_id, user_id, cover_letter, status, match_score)
VALUES
  (3, 5, 3, 'I''d like to recommend this position to a mentee of mine. In the meantime, I''m flagging it for the team to review candidates against our design system standards.', 'reviewed', 88)
ON CONFLICT DO NOTHING;

-- Alice applied to DevOps Engineer at CloudNine
INSERT INTO job_applications (id, job_id, user_id, cover_letter, status, match_score)
VALUES
  (4, 7, 1, 'I''m interested in the DevOps Engineer role at CloudNine. My experience building and managing microservice infrastructure at TechCorp, including Docker and Kubernetes orchestration, aligns well with this position. I''m passionate about developer tooling and infrastructure automation.', 'pending', 78)
ON CONFLICT DO NOTHING;

SELECT setval('job_applications_id_seq', (SELECT COALESCE(MAX(id), 0) FROM job_applications));

-- ============================================================================
-- AUDIT LOGS (sample entries)
-- ============================================================================

INSERT INTO audit_logs (id, event_type, actor_id, actor_ip, target_type, target_id, action, details, created_at)
VALUES
  (1, 'auth.login.success', 1, '192.168.1.10', 'user', 1, 'login', '{"method": "password", "user_agent": "Mozilla/5.0"}', NOW() - INTERVAL '2 days'),
  (2, 'auth.login.success', 2, '192.168.1.11', 'user', 2, 'login', '{"method": "password", "user_agent": "Mozilla/5.0"}', NOW() - INTERVAL '1 day'),
  (3, 'profile.updated', 1, '192.168.1.10', 'user', 1, 'update_profile', '{"fields_changed": ["headline", "summary"]}', NOW() - INTERVAL '1 day 6 hours'),
  (4, 'connection.accepted', 1, '192.168.1.10', 'connection', 4, 'accept_connection', '{"from_user_id": 4, "to_user_id": 1}', NOW() - INTERVAL '2 months'),
  (5, 'post.created', 1, '192.168.1.10', 'post', 1, 'create_post', '{"content_length": 280}', NOW() - INTERVAL '2 days'),
  (6, 'auth.login.success', 5, '10.0.0.1', 'user', 5, 'login', '{"method": "password", "user_agent": "Mozilla/5.0", "role": "admin"}', NOW() - INTERVAL '12 hours'),
  (7, 'admin.user_list.viewed', 5, '10.0.0.1', 'user', NULL, 'view_users', '{"page": 1, "per_page": 20}', NOW() - INTERVAL '11 hours')
ON CONFLICT DO NOTHING;

SELECT setval('audit_logs_id_seq', (SELECT COALESCE(MAX(id), 0) FROM audit_logs));

-- ============================================================
-- Real avatars and company logos.
--
-- users.profile_image_url was NULL for every seeded user (so the UI fell back to
-- letter placeholders everywhere), and companies.logo_url pointed at
-- *.example.com hosts that don't resolve, so logos never loaded. Point both at
-- real image services so profiles, the feed, and job cards show actual imagery.
-- ============================================================
UPDATE users SET profile_image_url = 'https://i.pravatar.cc/300?u=linkedin-' || id
WHERE profile_image_url IS NULL;

UPDATE companies SET logo_url = 'https://ui-avatars.com/api/?background=0A66C2&color=fff&bold=true&size=200&name='
  || replace(name, ' ', '+')
WHERE logo_url IS NULL OR logo_url LIKE '%example.com%';
