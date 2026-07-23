-- Seed data for Confluence Wiki
-- Users: alice/password123, bob/password123
-- Password hash is for 'password123' using bcrypt with 12 rounds

-- Users
INSERT INTO users (id, username, email, password_hash, display_name, role)
VALUES
  ('a0000000-0000-0000-0000-000000000001', 'alice', 'alice@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Alice Johnson', 'admin'),
  ('b0000000-0000-0000-0000-000000000002', 'bob', 'bob@example.com', '$2b$10$BdLsE.kQm5ryFusMBZ8QjOO.qRkLW/.iX7Wt7G3ZP3tGtFhtO1Rpi', 'Bob Smith', 'user')
ON CONFLICT (username) DO NOTHING;

-- Spaces
INSERT INTO spaces (id, key, name, description, is_public, created_by)
VALUES
  ('c0000000-0000-0000-0000-000000000001', 'ENG', 'Engineering', 'Engineering team documentation, architecture decisions, and technical guides.', true, 'a0000000-0000-0000-0000-000000000001'),
  ('c0000000-0000-0000-0000-000000000002', 'PROD', 'Product', 'Product requirements, roadmap, and feature specifications.', true, 'b0000000-0000-0000-0000-000000000002')
ON CONFLICT (key) DO NOTHING;

-- Space members
INSERT INTO space_members (space_id, user_id, role)
VALUES
  ('c0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'admin'),
  ('c0000000-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-000000000002', 'member'),
  ('c0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002', 'admin'),
  ('c0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001', 'member')
ON CONFLICT (space_id, user_id) DO NOTHING;

-- Engineering Space Pages
INSERT INTO pages (id, space_id, parent_id, title, slug, content_html, content_text, version, status, position, created_by, updated_by)
VALUES
  -- Root pages
  ('90000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000001', NULL,
   'Engineering Home', 'engineering-home',
   '<h1>Engineering Home</h1><p>Welcome to the Engineering space. This is the central hub for all engineering documentation.</p><h2>Quick Links</h2><ul><li>Architecture Decisions</li><li>Getting Started Guide</li><li>API Documentation</li></ul><div class="macro-info" style="background:#DEEBFF;border-left:4px solid #0052CC;padding:12px 16px;border-radius:4px;margin:8px 0;"><strong style="color:#0052CC;">Info</strong><div style="margin-top:4px;">This space is maintained by the Engineering team. For access requests, contact Alice.</div></div>',
   'Engineering Home Welcome to the Engineering space. This is the central hub for all engineering documentation. Quick Links Architecture Decisions Getting Started Guide API Documentation This space is maintained by the Engineering team. For access requests, contact Alice.',
   1, 'published', 0,
   'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001'),

  ('90000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001', NULL,
   'Architecture Decisions', 'architecture-decisions',
   '<h1>Architecture Decisions</h1><p>This section documents key architectural decisions made by the engineering team.</p><h2>Decision Records</h2><p>We use Architecture Decision Records (ADRs) to track important decisions.</p><div class="macro-warning" style="background:#FFFAE6;border-left:4px solid #FF8B00;padding:12px 16px;border-radius:4px;margin:8px 0;"><strong style="color:#FF8B00;">Warning</strong><div style="margin-top:4px;">All architecture changes must be reviewed by at least two senior engineers before implementation.</div></div>',
   'Architecture Decisions This section documents key architectural decisions made by the engineering team. Decision Records We use Architecture Decision Records (ADRs) to track important decisions. All architecture changes must be reviewed by at least two senior engineers before implementation.',
   1, 'published', 1,
   'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001'),

  ('90000000-0000-0000-0000-000000000003', 'c0000000-0000-0000-0000-000000000001', NULL,
   'Getting Started', 'getting-started',
   '<h1>Getting Started</h1><p>Welcome to the team! This guide will help you set up your development environment.</p><h2>Prerequisites</h2><ul><li>Node.js >= 20</li><li>Docker Desktop</li><li>Git</li></ul><h2>Setup Steps</h2><ol><li>Clone the repository</li><li>Install dependencies with npm install</li><li>Start Docker services</li><li>Run database migrations</li></ol><div class="macro-note" style="background:#EAE6FF;border-left:4px solid #6554C0;padding:12px 16px;border-radius:4px;margin:8px 0;"><strong style="color:#6554C0;">Note</strong><div style="margin-top:4px;">If you encounter issues during setup, check the Troubleshooting page or ask in #eng-help.</div></div>',
   'Getting Started Welcome to the team! This guide will help you set up your development environment. Prerequisites Node.js >= 20 Docker Desktop Git Setup Steps Clone the repository Install dependencies with npm install Start Docker services Run database migrations If you encounter issues during setup, check the Troubleshooting page or ask in #eng-help.',
   2, 'published', 2,
   'b0000000-0000-0000-0000-000000000002', 'a0000000-0000-0000-0000-000000000001'),

  -- Child pages under Architecture Decisions
  ('90000000-0000-0000-0000-000000000004', 'c0000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000002',
   'ADR-001: Use PostgreSQL', 'adr-001-use-postgresql',
   '<h1>ADR-001: Use PostgreSQL</h1><h2>Status</h2><p>Accepted</p><h2>Context</h2><p>We need a relational database that supports ACID transactions, complex queries, and JSON data types.</p><h2>Decision</h2><p>We will use PostgreSQL 16 as our primary database.</p><h2>Consequences</h2><ul><li>Strong consistency guarantees</li><li>Excellent JSON/JSONB support</li><li>Mature ecosystem and tooling</li><li>Requires connection pooling at scale</li></ul>',
   'ADR-001: Use PostgreSQL Status Accepted Context We need a relational database that supports ACID transactions, complex queries, and JSON data types. Decision We will use PostgreSQL 16 as our primary database. Consequences Strong consistency guarantees Excellent JSON/JSONB support Mature ecosystem and tooling Requires connection pooling at scale',
   1, 'published', 0,
   'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001'),

  ('90000000-0000-0000-0000-000000000005', 'c0000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000002',
   'ADR-002: Microservices vs Monolith', 'adr-002-microservices-vs-monolith',
   '<h1>ADR-002: Microservices vs Monolith</h1><h2>Status</h2><p>Accepted</p><h2>Context</h2><p>We need to decide on the deployment architecture for our platform.</p><h2>Decision</h2><p>We will start with a modular monolith and extract services as needed.</p><h2>Rationale</h2><p>Starting with microservices introduces distributed system complexity too early. A modular monolith gives us the benefits of clean separation without the operational overhead.</p>',
   'ADR-002: Microservices vs Monolith Status Accepted Context We need to decide on the deployment architecture for our platform. Decision We will start with a modular monolith and extract services as needed. Rationale Starting with microservices introduces distributed system complexity too early. A modular monolith gives us the benefits of clean separation without the operational overhead.',
   1, 'published', 1,
   'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001'),

  -- Child pages under Getting Started
  ('90000000-0000-0000-0000-000000000006', 'c0000000-0000-0000-0000-000000000001', '90000000-0000-0000-0000-000000000003',
   'Troubleshooting', 'troubleshooting',
   '<h1>Troubleshooting</h1><h2>Common Issues</h2><h3>Docker not starting</h3><p>Make sure Docker Desktop is running and you have at least 4GB RAM allocated.</p><h3>Database connection failed</h3><p>Check that PostgreSQL is running on port 5432 and the credentials match your .env file.</p><h3>Node modules errors</h3><p>Try deleting node_modules and running npm install again.</p>',
   'Troubleshooting Common Issues Docker not starting Make sure Docker Desktop is running and you have at least 4GB RAM allocated. Database connection failed Check that PostgreSQL is running on port 5432 and the credentials match your .env file. Node modules errors Try deleting node_modules and running npm install again.',
   1, 'published', 0,
   'b0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002');

-- Product Space Pages
INSERT INTO pages (id, space_id, parent_id, title, slug, content_html, content_text, version, status, position, created_by, updated_by)
VALUES
  ('90000000-0000-0000-0000-000000000007', 'c0000000-0000-0000-0000-000000000002', NULL,
   'Product Home', 'product-home',
   '<h1>Product Home</h1><p>Welcome to the Product space. Here you will find product requirements, roadmaps, and feature specifications.</p><h2>Current Quarter</h2><p>Q1 2025 focus areas:</p><ul><li>User onboarding improvements</li><li>Search functionality</li><li>Mobile responsive design</li></ul>',
   'Product Home Welcome to the Product space. Here you will find product requirements, roadmaps, and feature specifications. Current Quarter Q1 2025 focus areas: User onboarding improvements Search functionality Mobile responsive design',
   1, 'published', 0,
   'b0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002'),

  ('90000000-0000-0000-0000-000000000008', 'c0000000-0000-0000-0000-000000000002', NULL,
   'Feature Specifications', 'feature-specifications',
   '<h1>Feature Specifications</h1><p>Detailed specifications for upcoming features.</p><h2>Template</h2><p>Each feature spec should include: Problem Statement, Proposed Solution, User Stories, Success Metrics, and Timeline.</p>',
   'Feature Specifications Detailed specifications for upcoming features. Template Each feature spec should include: Problem Statement, Proposed Solution, User Stories, Success Metrics, and Timeline.',
   1, 'published', 1,
   'b0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002'),

  ('90000000-0000-0000-0000-000000000009', 'c0000000-0000-0000-0000-000000000002', '90000000-0000-0000-0000-000000000008',
   'Search Feature Spec', 'search-feature-spec',
   '<h1>Search Feature Spec</h1><h2>Problem Statement</h2><p>Users cannot efficiently find content across spaces. The current browse-only navigation is insufficient for large knowledge bases.</p><h2>Proposed Solution</h2><p>Implement full-text search powered by Elasticsearch with support for filtering by space, labels, and date ranges.</p><h2>User Stories</h2><ul><li>As a user, I want to search for pages by keyword so I can quickly find relevant content</li><li>As a user, I want to filter search results by space</li><li>As a user, I want to see highlighted matches in search results</li></ul>',
   'Search Feature Spec Problem Statement Users cannot efficiently find content across spaces. The current browse-only navigation is insufficient for large knowledge bases. Proposed Solution Implement full-text search powered by Elasticsearch with support for filtering by space, labels, and date ranges. User Stories As a user, I want to search for pages by keyword so I can quickly find relevant content As a user, I want to filter search results by space As a user, I want to see highlighted matches in search results',
   1, 'published', 0,
   'b0000000-0000-0000-0000-000000000002', 'b0000000-0000-0000-0000-000000000002');

-- Set homepage for spaces
UPDATE spaces SET homepage_id = '90000000-0000-0000-0000-000000000001' WHERE id = 'c0000000-0000-0000-0000-000000000001';
UPDATE spaces SET homepage_id = '90000000-0000-0000-0000-000000000007' WHERE id = 'c0000000-0000-0000-0000-000000000002';

-- Page versions (for Getting Started page which is on version 2)
INSERT INTO page_versions (page_id, version_number, title, content_json, content_html, content_text, change_message, created_by)
VALUES
  ('90000000-0000-0000-0000-000000000003', 1, 'Getting Started', '{}',
   '<h1>Getting Started</h1><p>Welcome to the team! This guide will help you get set up.</p><h2>Prerequisites</h2><ul><li>Node.js >= 18</li><li>Docker</li></ul>',
   'Getting Started Welcome to the team! This guide will help you get set up. Prerequisites Node.js >= 18 Docker',
   'Initial version',
   'b0000000-0000-0000-0000-000000000002'),
  ('90000000-0000-0000-0000-000000000003', 2, 'Getting Started', '{}',
   '<h1>Getting Started</h1><p>Welcome to the team! This guide will help you set up your development environment.</p><h2>Prerequisites</h2><ul><li>Node.js >= 20</li><li>Docker Desktop</li><li>Git</li></ul><h2>Setup Steps</h2><ol><li>Clone the repository</li><li>Install dependencies with npm install</li><li>Start Docker services</li><li>Run database migrations</li></ol><div class="macro-note" style="background:#EAE6FF;border-left:4px solid #6554C0;padding:12px 16px;border-radius:4px;margin:8px 0;"><strong style="color:#6554C0;">Note</strong><div style="margin-top:4px;">If you encounter issues during setup, check the Troubleshooting page or ask in #eng-help.</div></div>',
   'Getting Started Welcome to the team! This guide will help you set up your development environment. Prerequisites Node.js >= 20 Docker Desktop Git Setup Steps Clone the repository Install dependencies with npm install Start Docker services Run database migrations If you encounter issues during setup, check the Troubleshooting page or ask in #eng-help.',
   'Updated prerequisites and added setup steps',
   'a0000000-0000-0000-0000-000000000001');

-- Also add version 1 records for other pages
INSERT INTO page_versions (page_id, version_number, title, content_json, content_html, content_text, change_message, created_by)
SELECT id, 1, title, COALESCE(content_json, '{}'), content_html, content_text, 'Initial version', created_by
FROM pages
WHERE id NOT IN (SELECT DISTINCT page_id FROM page_versions);

-- Labels
INSERT INTO page_labels (page_id, label) VALUES
  ('90000000-0000-0000-0000-000000000001', 'home'),
  ('90000000-0000-0000-0000-000000000002', 'architecture'),
  ('90000000-0000-0000-0000-000000000002', 'decisions'),
  ('90000000-0000-0000-0000-000000000003', 'onboarding'),
  ('90000000-0000-0000-0000-000000000003', 'getting-started'),
  ('90000000-0000-0000-0000-000000000004', 'adr'),
  ('90000000-0000-0000-0000-000000000004', 'database'),
  ('90000000-0000-0000-0000-000000000005', 'adr'),
  ('90000000-0000-0000-0000-000000000005', 'architecture'),
  ('90000000-0000-0000-0000-000000000006', 'troubleshooting'),
  ('90000000-0000-0000-0000-000000000009', 'feature-spec'),
  ('90000000-0000-0000-0000-000000000009', 'search')
ON CONFLICT (page_id, label) DO NOTHING;

-- Comments
INSERT INTO page_comments (page_id, user_id, content, created_at) VALUES
  ('90000000-0000-0000-0000-000000000003', 'b0000000-0000-0000-0000-000000000002', 'Should we also add instructions for setting up IDE extensions?', NOW() - INTERVAL '2 days'),
  ('90000000-0000-0000-0000-000000000003', 'a0000000-0000-0000-0000-000000000001', 'Good idea! I will add a section for recommended VS Code extensions.', NOW() - INTERVAL '1 day');

-- Templates
INSERT INTO templates (id, name, description, content_json, is_global, created_by) VALUES
  ('d0000000-0000-0000-0000-000000000001', 'Meeting Notes', 'Template for meeting notes with attendees, agenda, and action items.',
   '{"template": true, "sections": ["Date", "Attendees", "Agenda", "Discussion Notes", "Action Items", "Next Meeting"]}',
   true, 'a0000000-0000-0000-0000-000000000001'),
  ('d0000000-0000-0000-0000-000000000002', 'Architecture Decision Record', 'Template for documenting architecture decisions.',
   '{"template": true, "sections": ["Status", "Context", "Decision", "Consequences", "Alternatives Considered"]}',
   true, 'a0000000-0000-0000-0000-000000000001'),
  ('d0000000-0000-0000-0000-000000000003', 'Feature Specification', 'Template for product feature specifications.',
   '{"template": true, "sections": ["Problem Statement", "Proposed Solution", "User Stories", "Success Metrics", "Timeline", "Dependencies"]}',
   true, 'b0000000-0000-0000-0000-000000000002');
