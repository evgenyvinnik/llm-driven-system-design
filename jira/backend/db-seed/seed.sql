-- Jira Seed Data
-- Run with: PGPASSWORD=jira_password psql -h localhost -U jira -d jira -f backend/db-seed/seed.sql

BEGIN;

-- ============================================================
-- Project Roles
-- ============================================================
INSERT INTO project_roles (name, description) VALUES
  ('Administrator', 'Full access to project settings and all issues'),
  ('Developer', 'Can create and edit issues'),
  ('Viewer', 'Read-only access to issues')
ON CONFLICT (name) DO NOTHING;

-- ============================================================
-- Default Permission Scheme
-- ============================================================
INSERT INTO permission_schemes (name, description, is_default)
VALUES ('Default Permission Scheme', 'Default permissions for new projects', true)
ON CONFLICT DO NOTHING;

-- Add permission grants to the default scheme
INSERT INTO permission_grants (scheme_id, permission, grantee_type, grantee_id)
SELECT ps.id, g.permission, g.grantee_type, g.grantee_id
FROM permission_schemes ps,
(VALUES
  ('create_issue',     'role',   'Developer'),
  ('create_issue',     'role',   'Administrator'),
  ('edit_issue',       'role',   'Developer'),
  ('edit_issue',       'role',   'Administrator'),
  ('delete_issue',     'role',   'Administrator'),
  ('transition_issue', 'role',   'Developer'),
  ('transition_issue', 'role',   'Administrator'),
  ('assign_issue',     'role',   'Developer'),
  ('assign_issue',     'role',   'Administrator'),
  ('manage_sprints',   'role',   'Administrator'),
  ('manage_sprints',   'role',   'Developer'),
  ('view_issue',       'anyone', NULL),
  ('add_comment',      'role',   'Developer'),
  ('add_comment',      'role',   'Administrator'),
  ('project_admin',    'role',   'Administrator')
) AS g(permission, grantee_type, grantee_id)
WHERE ps.is_default = true
ON CONFLICT DO NOTHING;

-- ============================================================
-- Default Workflow
-- ============================================================
INSERT INTO workflows (name, description, is_default)
VALUES ('Default Workflow', 'Standard workflow with To Do, In Progress, Done', true)
ON CONFLICT DO NOTHING;

-- ============================================================
-- Statuses
-- ============================================================
INSERT INTO statuses (workflow_id, name, category, color, position)
SELECT w.id, s.name, s.category::text, s.color, s.position
FROM workflows w,
(VALUES
  ('To Do',        'todo',        '#6B7280', 0),
  ('In Progress',  'in_progress', '#3B82F6', 1),
  ('In Review',    'in_progress', '#8B5CF6', 2),
  ('Done',         'done',        '#10B981', 3)
) AS s(name, category, color, position)
WHERE w.is_default = true
ON CONFLICT (workflow_id, name) DO NOTHING;

-- ============================================================
-- Transitions
-- ============================================================
INSERT INTO transitions (workflow_id, name, from_status_id, to_status_id, conditions, validators, post_functions)
SELECT
  w.id,
  t.name,
  fs.id,
  ts.id,
  t.conditions::jsonb,
  t.validators::jsonb,
  t.post_functions::jsonb
FROM workflows w
JOIN (VALUES
  ('Start Progress', 'To Do',       'In Progress', '[]', '[]', '[]'),
  ('Request Review', 'In Progress', 'In Review',   '[]', '[]', '[]'),
  ('Complete',       'In Review',   'Done',        '[]', '[]', '[]'),
  ('Back to Progress', 'In Review', 'In Progress', '[]', '[]', '[]'),
  ('Reopen',         'Done',        'To Do',       '[]', '[]', '[]')
) AS t(name, from_name, to_name, conditions, validators, post_functions) ON true
JOIN statuses fs ON fs.workflow_id = w.id AND fs.name = t.from_name
JOIN statuses ts ON ts.workflow_id = w.id AND ts.name = t.to_name
WHERE w.is_default = true
ON CONFLICT DO NOTHING;

-- Global transition: Start Work (from any status -> In Progress)
INSERT INTO transitions (workflow_id, name, from_status_id, to_status_id, conditions, validators, post_functions)
SELECT w.id, 'Start Work', NULL, ts.id, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
FROM workflows w
JOIN statuses ts ON ts.workflow_id = w.id AND ts.name = 'In Progress'
WHERE w.is_default = true
ON CONFLICT DO NOTHING;

-- ============================================================
-- Users
-- password123 => $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom
-- admin123   => $2a$10$Jwu.HnwmSQGc02Lr7mgZ.uRhHxwKb.KjaUcoz9PlnUfR0lAmhvJAq
-- ============================================================
INSERT INTO users (id, email, password_hash, name, role) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'admin@example.com',  '$2a$10$Jwu.HnwmSQGc02Lr7mgZ.uRhHxwKb.KjaUcoz9PlnUfR0lAmhvJAq', 'Admin User',      'admin'),
  ('a0000000-0000-4000-8000-000000000002', 'alice@example.com',  '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Alice Developer',  'user'),
  ('a0000000-0000-4000-8000-000000000003', 'bob@example.com',    '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Bob Engineer',     'user'),
  ('a0000000-0000-4000-8000-000000000004', 'carol@example.com',  '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Carol Manager',    'user')
ON CONFLICT (email) DO NOTHING;

-- ============================================================
-- Demo Project
-- ============================================================
INSERT INTO projects (id, key, name, description, lead_id, workflow_id, permission_scheme_id, issue_counter)
SELECT
  'b0000000-0000-4000-8000-000000000001',
  'DEMO',
  'Demo Project',
  'A demonstration project for testing issue tracking, workflows, and sprints.',
  u.id,
  w.id,
  ps.id,
  6
FROM users u, workflows w, permission_schemes ps
WHERE u.email = 'admin@example.com'
  AND w.is_default = true
  AND ps.is_default = true
ON CONFLICT (key) DO NOTHING;

-- Second project for multi-project testing
INSERT INTO projects (id, key, name, description, lead_id, workflow_id, permission_scheme_id, issue_counter)
SELECT
  'b0000000-0000-4000-8000-000000000002',
  'INFRA',
  'Infrastructure',
  'DevOps and infrastructure tasks including CI/CD, monitoring, and deployment.',
  u.id,
  w.id,
  ps.id,
  3
FROM users u, workflows w, permission_schemes ps
WHERE u.email = 'bob@example.com'
  AND w.is_default = true
  AND ps.is_default = true
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- Project Members
-- ============================================================
INSERT INTO project_members (project_id, user_id, role_id)
SELECT p.id, u.id, r.id
FROM (VALUES
  -- DEMO project members
  ('DEMO', 'admin@example.com', 'Administrator'),
  ('DEMO', 'alice@example.com', 'Developer'),
  ('DEMO', 'bob@example.com',   'Developer'),
  ('DEMO', 'carol@example.com', 'Viewer'),
  -- INFRA project members
  ('INFRA', 'bob@example.com',   'Administrator'),
  ('INFRA', 'alice@example.com', 'Developer'),
  ('INFRA', 'admin@example.com', 'Developer')
) AS m(project_key, user_email, role_name)
JOIN projects p ON p.key = m.project_key
JOIN users u ON u.email = m.user_email
JOIN project_roles r ON r.name = m.role_name
ON CONFLICT DO NOTHING;

-- ============================================================
-- Sprints
-- ============================================================
INSERT INTO sprints (project_id, name, goal, status, start_date, end_date)
SELECT p.id, s.name, s.goal, s.status, s.start_date::timestamp, s.end_date::timestamp
FROM (VALUES
  ('DEMO', 'Sprint 1', 'Complete initial features and infrastructure setup', 'closed',
   '2025-01-06', '2025-01-17'),
  ('DEMO', 'Sprint 2', 'Implement authentication and issue CRUD', 'active',
   '2025-01-20', '2025-01-31'),
  ('DEMO', 'Sprint 3', 'Build search and reporting features', 'future',
   NULL, NULL),
  ('INFRA', 'Infra Sprint 1', 'Set up CI/CD pipeline and monitoring', 'active',
   '2025-01-20', '2025-02-07')
) AS s(project_key, name, goal, status, start_date, end_date)
JOIN projects p ON p.key = s.project_key
ON CONFLICT DO NOTHING;

-- ============================================================
-- Labels
-- ============================================================
INSERT INTO labels (project_id, name, color)
SELECT p.id, l.name, l.color
FROM (VALUES
  ('DEMO', 'frontend',      '#3B82F6'),
  ('DEMO', 'backend',       '#10B981'),
  ('DEMO', 'urgent',        '#EF4444'),
  ('DEMO', 'documentation', '#F59E0B'),
  ('DEMO', 'bug',           '#DC2626'),
  ('DEMO', 'enhancement',   '#7C3AED'),
  ('INFRA', 'ci-cd',        '#F59E0B'),
  ('INFRA', 'monitoring',   '#3B82F6'),
  ('INFRA', 'security',     '#EF4444')
) AS l(project_key, name, color)
JOIN projects p ON p.key = l.project_key
ON CONFLICT DO NOTHING;

-- ============================================================
-- Components
-- ============================================================
INSERT INTO components (project_id, name, description, lead_id)
SELECT p.id, c.name, c.description, u.id
FROM (VALUES
  ('DEMO', 'API',       'Backend API endpoints',               'alice@example.com'),
  ('DEMO', 'UI',        'Frontend user interface',             'bob@example.com'),
  ('DEMO', 'Database',  'Database schema and migrations',      'admin@example.com'),
  ('INFRA', 'Pipeline', 'CI/CD pipeline configuration',        'bob@example.com'),
  ('INFRA', 'Alerts',   'Monitoring and alerting',             'bob@example.com')
) AS c(project_key, name, description, lead_email)
JOIN projects p ON p.key = c.project_key
LEFT JOIN users u ON u.email = c.lead_email
ON CONFLICT DO NOTHING;

-- ============================================================
-- Issues – DEMO project
-- ============================================================
INSERT INTO issues (project_id, key, summary, description, issue_type, status_id, priority, reporter_id, assignee_id, sprint_id, story_points, labels, components)
SELECT
  p.id,
  i.key,
  i.summary,
  i.description,
  i.issue_type,
  st.id,
  i.priority,
  rep.id,
  asgn.id,
  sp.id,
  i.story_points,
  i.labels::text[],
  i.components::text[]
FROM (VALUES
  -- Completed issues (Sprint 1)
  ('DEMO', 'DEMO-1', 'Set up project infrastructure',
   'Configure PostgreSQL, Redis, and Elasticsearch for local development. Create docker-compose.yml with all required services.',
   'task', 'Done', 'high',
   'admin@example.com', 'alice@example.com', 'Sprint 1', 3, '{backend}', '{Database}'),

  ('DEMO', 'DEMO-2', 'Design database schema',
   'Create the initial database schema with tables for users, projects, issues, workflows, statuses, and transitions.',
   'task', 'Done', 'high',
   'admin@example.com', 'alice@example.com', 'Sprint 1', 5, '{backend,documentation}', '{Database}'),

  -- In-progress issues (Sprint 2)
  ('DEMO', 'DEMO-3', 'Implement user authentication',
   'Add session-based authentication with login, logout, and registration. Use bcrypt for password hashing and Redis for session storage.',
   'story', 'In Progress', 'highest',
   'admin@example.com', 'alice@example.com', 'Sprint 2', 8, '{backend}', '{API}'),

  ('DEMO', 'DEMO-4', 'Create issue CRUD endpoints',
   'Build REST endpoints for creating, reading, updating, and deleting issues. Support all standard fields including assignee, priority, and labels.',
   'story', 'In Progress', 'high',
   'carol@example.com', 'bob@example.com', 'Sprint 2', 8, '{backend}', '{API}'),

  -- To-do issues (Sprint 2)
  ('DEMO', 'DEMO-5', 'Fix login redirect bug',
   'After successful login, users are not redirected to their previous page. They always land on the dashboard instead.',
   'bug', 'To Do', 'medium',
   'carol@example.com', 'alice@example.com', 'Sprint 2', 2, '{frontend,bug}', '{UI}'),

  -- Epic
  ('DEMO', 'DEMO-6', 'User Management Epic',
   'Epic for all user management features including authentication, profiles, avatars, and role management.',
   'epic', 'To Do', 'high',
   'admin@example.com', NULL, NULL, NULL, '{}', '{}')
) AS i(project_key, key, summary, description, issue_type, status_name, priority, reporter_email, assignee_email, sprint_name, story_points, labels, components)
JOIN projects p ON p.key = i.project_key
JOIN statuses st ON st.name = i.status_name AND st.workflow_id = p.workflow_id
JOIN users rep ON rep.email = i.reporter_email
LEFT JOIN users asgn ON asgn.email = i.assignee_email
LEFT JOIN sprints sp ON sp.name = i.sprint_name AND sp.project_id = p.id
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- Issues – INFRA project
-- ============================================================
INSERT INTO issues (project_id, key, summary, description, issue_type, status_id, priority, reporter_id, assignee_id, sprint_id, story_points, labels, components)
SELECT
  p.id,
  i.key,
  i.summary,
  i.description,
  i.issue_type,
  st.id,
  i.priority,
  rep.id,
  asgn.id,
  sp.id,
  i.story_points,
  i.labels::text[],
  i.components::text[]
FROM (VALUES
  ('INFRA', 'INFRA-1', 'Set up GitHub Actions CI pipeline',
   'Configure GitHub Actions with lint, test, and build stages. Add branch protection rules for main.',
   'task', 'In Progress', 'highest',
   'bob@example.com', 'bob@example.com', 'Infra Sprint 1', 5, '{ci-cd}', '{Pipeline}'),

  ('INFRA', 'INFRA-2', 'Add Prometheus metrics and Grafana dashboards',
   'Instrument the backend with prom-client for request latency, error rates, and database connection metrics. Create Grafana dashboards.',
   'story', 'To Do', 'high',
   'bob@example.com', 'alice@example.com', 'Infra Sprint 1', 8, '{monitoring}', '{Alerts}'),

  ('INFRA', 'INFRA-3', 'Implement rate limiting middleware',
   'Add Redis-backed rate limiting to all API endpoints. Configure different limits for authenticated and unauthenticated users.',
   'task', 'To Do', 'medium',
   'admin@example.com', 'bob@example.com', 'Infra Sprint 1', 3, '{security}', '{Pipeline}')
) AS i(project_key, key, summary, description, issue_type, status_name, priority, reporter_email, assignee_email, sprint_name, story_points, labels, components)
JOIN projects p ON p.key = i.project_key
JOIN statuses st ON st.name = i.status_name AND st.workflow_id = p.workflow_id
JOIN users rep ON rep.email = i.reporter_email
LEFT JOIN users asgn ON asgn.email = i.assignee_email
LEFT JOIN sprints sp ON sp.name = i.sprint_name AND sp.project_id = p.id
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- Boards
-- ============================================================
INSERT INTO boards (project_id, name, type, column_config)
SELECT
  p.id,
  b.name,
  b.type,
  (
    SELECT json_agg(json_build_object(
      'name', col.col_name,
      'status_ids', (
        SELECT COALESCE(json_agg(s.id), '[]'::json)
        FROM statuses s
        WHERE s.workflow_id = p.workflow_id
          AND s.name = ANY(col.status_names)
      )
    ))
    FROM (VALUES
      ('To Do',        ARRAY['To Do']),
      ('In Progress',  ARRAY['In Progress', 'In Review']),
      ('Done',         ARRAY['Done'])
    ) AS col(col_name, status_names)
  )::jsonb
FROM (VALUES
  ('DEMO',  'DEMO Board',  'kanban'),
  ('INFRA', 'INFRA Board', 'scrum')
) AS b(project_key, name, type)
JOIN projects p ON p.key = b.project_key
ON CONFLICT DO NOTHING;

-- ============================================================
-- Issue History (audit trail for completed issues)
-- ============================================================
INSERT INTO issue_history (issue_id, user_id, field, new_value)
SELECT i.id, u.id, 'created', i.key
FROM issues i
JOIN users u ON u.email = 'admin@example.com'
WHERE i.key IN ('DEMO-1', 'DEMO-2', 'DEMO-3', 'DEMO-4', 'DEMO-5', 'DEMO-6')
ON CONFLICT DO NOTHING;

INSERT INTO issue_history (issue_id, user_id, field, new_value)
SELECT i.id, u.id, 'created', i.key
FROM issues i
JOIN users u ON u.email = 'bob@example.com'
WHERE i.key IN ('INFRA-1', 'INFRA-2', 'INFRA-3')
ON CONFLICT DO NOTHING;

-- Status transitions for completed items
INSERT INTO issue_history (issue_id, user_id, field, old_value, new_value)
SELECT i.id, u.id, 'status', h.old_value, h.new_value
FROM (VALUES
  ('DEMO-1', 'alice@example.com', 'To Do',       'In Progress'),
  ('DEMO-1', 'alice@example.com', 'In Progress', 'Done'),
  ('DEMO-2', 'alice@example.com', 'To Do',       'In Progress'),
  ('DEMO-2', 'alice@example.com', 'In Progress', 'In Review'),
  ('DEMO-2', 'admin@example.com', 'In Review',   'Done'),
  ('DEMO-3', 'alice@example.com', 'To Do',       'In Progress'),
  ('DEMO-4', 'bob@example.com',   'To Do',       'In Progress'),
  ('INFRA-1', 'bob@example.com',  'To Do',       'In Progress')
) AS h(issue_key, user_email, old_value, new_value)
JOIN issues i ON i.key = h.issue_key
JOIN users u ON u.email = h.user_email
ON CONFLICT DO NOTHING;

-- ============================================================
-- Comments
-- ============================================================
INSERT INTO comments (issue_id, author_id, body)
SELECT i.id, u.id, c.body
FROM (VALUES
  ('DEMO-1', 'alice@example.com',
   'Infrastructure is set up. PostgreSQL, Redis, and Elasticsearch are all running via docker-compose.'),
  ('DEMO-2', 'alice@example.com',
   'Schema design is complete. Added tables for issues, workflows, statuses, transitions, and permissions.'),
  ('DEMO-2', 'admin@example.com',
   'Looks good! The JSONB custom_fields column with GIN index should handle our custom field requirements well.'),
  ('DEMO-3', 'alice@example.com',
   'Working on session-based auth with Redis store. Using bcrypt for password hashing.'),
  ('DEMO-4', 'bob@example.com',
   'Implementing the full CRUD with proper validation. Supporting all issue types: bug, story, task, epic, subtask.'),
  ('DEMO-5', 'carol@example.com',
   'Noticed this bug when testing the login flow. After logging in, I always end up on the dashboard instead of where I was before.'),
  ('INFRA-1', 'bob@example.com',
   'Setting up GitHub Actions with three stages: lint, test, and build. Will add branch protection rules once CI is green.')
) AS c(issue_key, author_email, body)
JOIN issues i ON i.key = c.issue_key
JOIN users u ON u.email = c.author_email
ON CONFLICT DO NOTHING;

COMMIT;
