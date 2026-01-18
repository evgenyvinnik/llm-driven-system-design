-- Google Docs Seed Data
-- Password for all users: password123
-- Hash: $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Users
INSERT INTO users (id, email, name, password_hash, avatar_color, role) VALUES
  ('11111111-1111-1111-1111-111111111111', 'alice@example.com', 'Alice Johnson', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', '#EF4444', 'user'),
  ('22222222-2222-2222-2222-222222222222', 'bob@example.com', 'Bob Smith', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', '#22C55E', 'user'),
  ('33333333-3333-3333-3333-333333333333', 'carol@example.com', 'Carol Williams', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', '#3B82F6', 'user'),
  ('44444444-4444-4444-4444-444444444444', 'david@example.com', 'David Chen', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', '#F59E0B', 'user'),
  ('55555555-5555-5555-5555-555555555555', 'admin@docs.local', 'Admin User', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', '#8B5CF6', 'admin')
ON CONFLICT (email) DO NOTHING;

-- Documents
INSERT INTO documents (id, title, owner_id, current_version, content, is_deleted, created_at, updated_at) VALUES
  -- Alice's documents
  ('aaaa1111-0001-0001-0001-000000000001', 'Project Proposal - Q1 2024', '11111111-1111-1111-1111-111111111111', 5,
   '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Project Proposal: Next-Gen Analytics Platform"}]},{"type":"paragraph","content":[{"type":"text","text":"This document outlines the proposed analytics platform for Q1 2024."}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Executive Summary"}]},{"type":"paragraph","content":[{"type":"text","text":"We propose building a real-time analytics platform that will provide actionable insights to our business teams. The platform will process millions of events per day and provide dashboards with sub-second query response times."}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Goals"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Process 10M+ events per day"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Sub-second query latency"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Self-service dashboard creation"}]}]}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Timeline"}]},{"type":"paragraph","content":[{"type":"text","text":"Phase 1 (Jan-Feb): Infrastructure setup and data pipeline"},{"type":"hardBreak"},{"type":"text","text":"Phase 2 (Feb-Mar): Dashboard development"},{"type":"hardBreak"},{"type":"text","text":"Phase 3 (Mar-Apr): User testing and launch"}]}]}',
   false, NOW() - INTERVAL '14 days', NOW() - INTERVAL '2 hours'),

  ('aaaa1111-0001-0001-0001-000000000002', 'Meeting Notes - Team Standup', '11111111-1111-1111-1111-111111111111', 12,
   '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Weekly Team Standup Notes"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"January 15, 2024"}]},{"type":"heading","attrs":{"level":3},"content":[{"type":"text","text":"Attendees"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Alice Johnson"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Bob Smith"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Carol Williams"}]}]}]},{"type":"heading","attrs":{"level":3},"content":[{"type":"text","text":"Updates"}]},{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"}],"text":"Alice:"},{"type":"text","text":" Completed API integration, starting on frontend components today."}]},{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"}],"text":"Bob:"},{"type":"text","text":" Working on database optimization. Found a way to reduce query time by 50%."}]},{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"}],"text":"Carol:"},{"type":"text","text":" Finished code review for the authentication module. Ready for deployment."}]},{"type":"heading","attrs":{"level":3},"content":[{"type":"text","text":"Action Items"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Schedule demo for stakeholders (Alice)"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Document database changes (Bob)"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Prepare deployment checklist (Carol)"}]}]}]}]}',
   false, NOW() - INTERVAL '7 days', NOW() - INTERVAL '1 day'),

  -- Bob's documents
  ('bbbb2222-0001-0001-0001-000000000001', 'Technical Design: Authentication System', '22222222-2222-2222-2222-222222222222', 8,
   '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Technical Design: Authentication System"}]},{"type":"paragraph","content":[{"type":"text","text":"This document describes the technical design for the new authentication system."}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Overview"}]},{"type":"paragraph","content":[{"type":"text","text":"We will implement a session-based authentication system with Redis for session storage. This provides a good balance between security and performance."}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Architecture"}]},{"type":"codeBlock","attrs":{"language":"text"},"content":[{"type":"text","text":"Client -> API Gateway -> Auth Service -> Redis (sessions)\n                                       -> PostgreSQL (users)"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Security Considerations"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Passwords hashed with bcrypt (cost factor 10)"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Session tokens are cryptographically random"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"HTTPS only for all endpoints"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Rate limiting on login attempts"}]}]}]}]}',
   false, NOW() - INTERVAL '10 days', NOW() - INTERVAL '3 days'),

  -- Carol's documents
  ('cccc3333-0001-0001-0001-000000000001', 'Team Onboarding Guide', '33333333-3333-3333-3333-333333333333', 15,
   '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Welcome to the Team!"}]},{"type":"paragraph","content":[{"type":"text","text":"This guide will help you get started with our development environment and processes."}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Day 1 Checklist"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Set up your development environment"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Clone the main repository"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Complete security training"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Meet with your buddy"}]}]}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Development Setup"}]},{"type":"paragraph","content":[{"type":"text","text":"Follow these steps to set up your local development environment:"}]},{"type":"orderedList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Install Node.js v20 or later"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Install Docker Desktop"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Run npm install in the project root"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Start services with docker-compose up -d"}]}]}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Useful Resources"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Internal Wiki: wiki.company.com"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Slack: #engineering channel"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Documentation: docs.company.com"}]}]}]}]}',
   false, NOW() - INTERVAL '30 days', NOW() - INTERVAL '5 days'),

  -- Shared document
  ('dddd4444-0001-0001-0001-000000000001', 'Sprint Planning - January', '44444444-4444-4444-4444-444444444444', 3,
   '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Sprint Planning - January 2024"}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Sprint Goals"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Complete authentication module"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Start analytics dashboard"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Fix critical bugs from last sprint"}]}]}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"User Stories"}]},{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"}],"text":"AUTH-101:"},{"type":"text","text":" As a user, I want to log in with my email and password (5 points)"}]},{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"}],"text":"AUTH-102:"},{"type":"text","text":" As a user, I want to reset my password (3 points)"}]},{"type":"paragraph","content":[{"type":"text","marks":[{"type":"bold"}],"text":"DASH-201:"},{"type":"text","text":" As an analyst, I want to see real-time metrics (8 points)"}]}]}',
   false, NOW() - INTERVAL '5 days', NOW() - INTERVAL '12 hours')
ON CONFLICT DO NOTHING;

-- Document permissions (sharing)
INSERT INTO document_permissions (id, document_id, user_id, email, permission_level) VALUES
  -- Project Proposal shared with team
  ('perm1111-0001-0001-0001-000000000001', 'aaaa1111-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222222', NULL, 'edit'),
  ('perm1111-0001-0001-0001-000000000002', 'aaaa1111-0001-0001-0001-000000000001', '33333333-3333-3333-3333-333333333333', NULL, 'comment'),
  ('perm1111-0001-0001-0001-000000000003', 'aaaa1111-0001-0001-0001-000000000001', '44444444-4444-4444-4444-444444444444', NULL, 'view'),
  -- Meeting notes shared with Bob
  ('perm1111-0001-0001-0001-000000000004', 'aaaa1111-0001-0001-0001-000000000002', '22222222-2222-2222-2222-222222222222', NULL, 'edit'),
  ('perm1111-0001-0001-0001-000000000005', 'aaaa1111-0001-0001-0001-000000000002', '33333333-3333-3333-3333-333333333333', NULL, 'edit'),
  -- Tech design shared with Alice
  ('perm1111-0001-0001-0001-000000000006', 'bbbb2222-0001-0001-0001-000000000001', '11111111-1111-1111-1111-111111111111', NULL, 'edit'),
  -- Onboarding guide shared with everyone via email
  ('perm1111-0001-0001-0001-000000000007', 'cccc3333-0001-0001-0001-000000000001', NULL, 'team@company.com', 'view'),
  -- Sprint planning shared with team
  ('perm1111-0001-0001-0001-000000000008', 'dddd4444-0001-0001-0001-000000000001', '11111111-1111-1111-1111-111111111111', NULL, 'edit'),
  ('perm1111-0001-0001-0001-000000000009', 'dddd4444-0001-0001-0001-000000000001', '22222222-2222-2222-2222-222222222222', NULL, 'edit'),
  ('perm1111-0001-0001-0001-000000000010', 'dddd4444-0001-0001-0001-000000000001', '33333333-3333-3333-3333-333333333333', NULL, 'edit')
ON CONFLICT DO NOTHING;

-- Document versions (snapshots)
INSERT INTO document_versions (id, document_id, version_number, content, created_by, is_named, name) VALUES
  ('ver11111-0001-0001-0001-000000000001', 'aaaa1111-0001-0001-0001-000000000001', 1, '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Project Proposal"}]},{"type":"paragraph","content":[{"type":"text","text":"Initial draft..."}]}]}', '11111111-1111-1111-1111-111111111111', true, 'Initial Draft'),
  ('ver11111-0001-0001-0001-000000000002', 'aaaa1111-0001-0001-0001-000000000001', 3, '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Project Proposal: Analytics Platform"}]},{"type":"paragraph","content":[{"type":"text","text":"Added executive summary and goals..."}]}]}', '11111111-1111-1111-1111-111111111111', true, 'After Review'),
  ('ver11111-0001-0001-0001-000000000003', 'aaaa1111-0001-0001-0001-000000000001', 5, '{"type":"doc","content":[]}', '11111111-1111-1111-1111-111111111111', false, NULL),
  ('ver11111-0001-0001-0001-000000000004', 'bbbb2222-0001-0001-0001-000000000001', 1, '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Tech Design Draft"}]}]}', '22222222-2222-2222-2222-222222222222', true, 'First Draft')
ON CONFLICT (document_id, version_number) DO NOTHING;

-- Comments
INSERT INTO comments (id, document_id, parent_id, anchor_start, anchor_end, anchor_version, content, author_id, resolved) VALUES
  ('com11111-0001-0001-0001-000000000001', 'aaaa1111-0001-0001-0001-000000000001', NULL, 150, 200, 5, 'Can we add more details about the technical architecture here?', '22222222-2222-2222-2222-222222222222', false),
  ('com11111-0001-0001-0001-000000000002', 'aaaa1111-0001-0001-0001-000000000001', 'com11111-0001-0001-0001-000000000001', NULL, NULL, NULL, 'Good point! I will add a section on the tech stack.', '11111111-1111-1111-1111-111111111111', false),
  ('com11111-0001-0001-0001-000000000003', 'aaaa1111-0001-0001-0001-000000000001', NULL, 300, 350, 5, 'The timeline looks aggressive. Should we add a buffer?', '33333333-3333-3333-3333-333333333333', true),
  ('com11111-0001-0001-0001-000000000004', 'bbbb2222-0001-0001-0001-000000000001', NULL, 100, 150, 8, 'Great security considerations! Maybe also mention CSRF protection?', '11111111-1111-1111-1111-111111111111', false)
ON CONFLICT DO NOTHING;

-- Suggestions (tracked changes)
INSERT INTO suggestions (id, document_id, suggestion_type, anchor_start, anchor_end, anchor_version, original_text, suggested_text, author_id, status) VALUES
  ('sug11111-0001-0001-0001-000000000001', 'aaaa1111-0001-0001-0001-000000000001', 'replace', 50, 70, 5, 'Q1 2024', 'Q1-Q2 2024', '22222222-2222-2222-2222-222222222222', 'pending'),
  ('sug11111-0001-0001-0001-000000000002', 'aaaa1111-0001-0001-0001-000000000001', 'insert', 250, 250, 5, NULL, ' This will require coordination with the data engineering team.', '33333333-3333-3333-3333-333333333333', 'pending'),
  ('sug11111-0001-0001-0001-000000000003', 'bbbb2222-0001-0001-0001-000000000001', 'delete', 200, 220, 8, 'This is optional', NULL, '11111111-1111-1111-1111-111111111111', 'accepted')
ON CONFLICT DO NOTHING;
