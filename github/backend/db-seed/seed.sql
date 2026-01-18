-- GitHub Clone Seed Data
-- Password for all users: password123
-- Hash: $2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom

-- Users
INSERT INTO users (id, username, email, password_hash, display_name, bio, avatar_url, location, company, website, role) VALUES
  (1, 'alice', 'alice@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Alice Johnson', 'Full-stack developer passionate about open source. Building tools that developers love.', 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150', 'San Francisco, CA', 'TechCorp', 'https://alice.dev', 'user'),
  (2, 'bob', 'bob@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Bob Smith', 'Backend engineer. Rust enthusiast. Coffee addict.', 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150', 'Seattle, WA', 'CloudScale', 'https://bobsmith.io', 'user'),
  (3, 'carol', 'carol@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Carol Williams', 'DevOps engineer. Kubernetes and cloud infrastructure specialist.', 'https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=150', 'Austin, TX', 'InfraWorks', NULL, 'user'),
  (4, 'david', 'david@example.com', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'David Chen', 'Open source maintainer. TypeScript and React ecosystem contributor.', 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150', 'New York, NY', NULL, 'https://davidchen.dev', 'user'),
  (5, 'admin', 'admin@github.local', '$2b$10$KvyL.xiSRBiXVY1iP4L7B.vghE/SDLNJX2gHIOjaS707KBZnUcIom', 'Admin User', 'System administrator', NULL, NULL, 'GitHub Local', NULL, 'admin')
ON CONFLICT (email) DO NOTHING;

-- Organizations
INSERT INTO organizations (id, name, display_name, description, avatar_url, website, location, created_by) VALUES
  (1, 'awesome-tools', 'Awesome Tools', 'Building developer productivity tools', 'https://images.unsplash.com/photo-1618401471353-b98afee0b2eb?w=150', 'https://awesome-tools.dev', 'Remote', 1),
  (2, 'open-source-community', 'Open Source Community', 'Collaborative open source projects for learning', 'https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=150', NULL, 'Global', 4)
ON CONFLICT DO NOTHING;

-- Organization members
INSERT INTO organization_members (org_id, user_id, role) VALUES
  (1, 1, 'owner'),
  (1, 2, 'member'),
  (1, 3, 'member'),
  (2, 4, 'owner'),
  (2, 1, 'member'),
  (2, 2, 'member')
ON CONFLICT (org_id, user_id) DO NOTHING;

-- Repositories
INSERT INTO repositories (id, owner_id, org_id, name, description, is_private, default_branch, language, stars_count, forks_count, watchers_count) VALUES
  -- Personal repos
  (1, 1, NULL, 'react-components', 'A collection of reusable React components with TypeScript support', false, 'main', 'TypeScript', 234, 45, 89),
  (2, 1, NULL, 'dotfiles', 'My personal dotfiles for macOS and Linux', false, 'main', 'Shell', 56, 12, 23),
  (3, 2, NULL, 'rust-cli-template', 'A template for building Rust CLI applications with clap and tokio', false, 'main', 'Rust', 189, 34, 67),
  (4, 2, NULL, 'private-notes', 'Personal notes and snippets', true, 'main', 'Markdown', 0, 0, 1),
  (5, 3, NULL, 'kubernetes-examples', 'Example Kubernetes configurations for various use cases', false, 'main', 'YAML', 312, 78, 156),
  (6, 4, NULL, 'typescript-utils', 'Utility functions for TypeScript projects', false, 'main', 'TypeScript', 145, 23, 45),
  -- Org repos
  (7, NULL, 1, 'cli-framework', 'A framework for building powerful CLI applications', false, 'main', 'TypeScript', 567, 89, 234),
  (8, NULL, 1, 'vscode-extension', 'VS Code extension for productivity', false, 'main', 'TypeScript', 1234, 156, 456),
  (9, NULL, 2, 'learning-algorithms', 'Algorithm implementations for learning purposes', false, 'main', 'Python', 890, 234, 345),
  (10, NULL, 2, 'system-design-examples', 'Real-world system design implementations', false, 'main', 'JavaScript', 456, 123, 234)
ON CONFLICT DO NOTHING;

-- Labels (for repos)
INSERT INTO labels (id, repo_id, name, color, description) VALUES
  (1, 1, 'bug', '#d73a4a', 'Something is not working'),
  (2, 1, 'enhancement', '#a2eeef', 'New feature or request'),
  (3, 1, 'documentation', '#0075ca', 'Improvements or additions to documentation'),
  (4, 1, 'good first issue', '#7057ff', 'Good for newcomers'),
  (5, 7, 'bug', '#d73a4a', 'Something is not working'),
  (6, 7, 'enhancement', '#a2eeef', 'New feature or request'),
  (7, 7, 'help wanted', '#008672', 'Extra attention is needed'),
  (8, 9, 'easy', '#7057ff', 'Easy difficulty'),
  (9, 9, 'medium', '#fbca04', 'Medium difficulty'),
  (10, 9, 'hard', '#b60205', 'Hard difficulty')
ON CONFLICT (repo_id, name) DO NOTHING;

-- Collaborators
INSERT INTO collaborators (repo_id, user_id, permission) VALUES
  (1, 2, 'write'),
  (1, 3, 'read'),
  (7, 2, 'write'),
  (7, 3, 'write'),
  (9, 1, 'write'),
  (9, 2, 'write')
ON CONFLICT (repo_id, user_id) DO NOTHING;

-- Stars
INSERT INTO stars (user_id, repo_id) VALUES
  (2, 1), (3, 1), (4, 1),
  (1, 3), (3, 3), (4, 3),
  (1, 5), (2, 5), (4, 5),
  (1, 7), (2, 7), (3, 7), (4, 7),
  (1, 8), (2, 8), (3, 8),
  (1, 9), (2, 9), (3, 9)
ON CONFLICT (user_id, repo_id) DO NOTHING;

-- Issues
INSERT INTO issues (id, repo_id, number, title, body, state, author_id, assignee_id, created_at, closed_at) VALUES
  (1, 1, 1, 'Button component does not support custom icons', 'The Button component should allow passing a custom icon as a prop. Currently only predefined icons are supported.\n\n**Expected behavior:**\nBe able to pass any React node as icon prop.\n\n**Current behavior:**\nOnly string icon names work.', 'open', 2, 1, NOW() - INTERVAL '5 days', NULL),
  (2, 1, 2, 'Add dark mode support', 'It would be great to have built-in dark mode support for all components.\n\n## Requirements\n- [ ] Add theme context\n- [ ] Update all components\n- [ ] Add documentation', 'open', 3, NULL, NOW() - INTERVAL '3 days', NULL),
  (3, 1, 3, 'Fix TypeScript types for Modal component', 'The Modal component has incorrect TypeScript types. The onClose callback should be optional.', 'closed', 4, 1, NOW() - INTERVAL '10 days', NOW() - INTERVAL '7 days'),
  (4, 7, 1, 'Add support for subcommands', 'The CLI framework should support nested subcommands like `cli command subcommand`.', 'open', 4, 2, NOW() - INTERVAL '7 days', NULL),
  (5, 7, 2, 'Improve error messages', 'Error messages should be more descriptive and include suggestions for fixing common mistakes.', 'open', 3, NULL, NOW() - INTERVAL '2 days', NULL),
  (6, 9, 1, 'Add binary search implementation', 'Please add a binary search implementation with detailed comments explaining the algorithm.', 'closed', 1, 4, NOW() - INTERVAL '14 days', NOW() - INTERVAL '10 days'),
  (7, 9, 2, 'Request: Graph algorithms', 'Would love to see implementations of common graph algorithms:\n- BFS\n- DFS\n- Dijkstra\n- A*', 'open', 2, NULL, NOW() - INTERVAL '4 days', NULL)
ON CONFLICT (repo_id, number) DO NOTHING;

-- Issue labels
INSERT INTO issue_labels (issue_id, label_id) VALUES
  (1, 2), -- enhancement
  (2, 2), -- enhancement
  (2, 4), -- good first issue
  (3, 1), -- bug
  (4, 6), -- enhancement
  (5, 5), -- bug
  (5, 7), -- help wanted
  (6, 8), -- easy
  (7, 9) -- medium
ON CONFLICT (issue_id, label_id) DO NOTHING;

-- Pull Requests
INSERT INTO pull_requests (id, repo_id, number, title, body, state, head_branch, head_sha, base_branch, base_sha, author_id, merged_by, merged_at, additions, deletions, changed_files, is_draft) VALUES
  (1, 1, 4, 'feat: Add icon prop to Button component', 'This PR adds support for custom icons in the Button component.\n\nCloses #1\n\n## Changes\n- Added icon prop to Button\n- Updated stories\n- Added tests', 'open', 'feature/button-icons', 'abc123def456', 'main', 'def789abc012', 2, NULL, NULL, 45, 12, 4, false),
  (2, 1, 5, 'docs: Update README with new examples', 'Added more examples to the README for better documentation.', 'merged', 'docs/readme-update', 'fed321cba654', 'main', 'def789abc012', 3, 1, NOW() - INTERVAL '2 days', 89, 23, 2, false),
  (3, 7, 3, 'feat: Implement subcommand support', 'This PR implements nested subcommand support for the CLI framework.\n\n## Implementation\n- Added SubcommandBuilder class\n- Updated parser to handle nested commands\n- Added comprehensive tests', 'open', 'feature/subcommands', 'cba987fed654', 'main', 'abc123def456', 4, NULL, NULL, 234, 56, 8, false),
  (4, 9, 3, 'feat: Add binary search with tests', 'Added binary search implementation with detailed comments and unit tests.\n\nCloses #6', 'merged', 'feature/binary-search', 'aaa111bbb222', 'main', 'ccc333ddd444', 1, 4, NOW() - INTERVAL '10 days', 78, 0, 2, false),
  (5, 9, 4, 'WIP: Graph algorithms', 'Work in progress implementation of graph algorithms.\n\n- [x] BFS\n- [x] DFS\n- [ ] Dijkstra\n- [ ] A*', 'open', 'feature/graph-algorithms', 'eee555fff666', 'main', 'ccc333ddd444', 2, NULL, NULL, 156, 12, 5, true)
ON CONFLICT (repo_id, number) DO NOTHING;

-- Reviews
INSERT INTO reviews (id, pr_id, reviewer_id, state, body, commit_sha) VALUES
  (1, 1, 1, 'COMMENTED', 'Looking good overall! Just a few minor suggestions.', 'abc123def456'),
  (2, 1, 3, 'APPROVED', 'LGTM! Great work on the implementation.', 'abc123def456'),
  (3, 3, 1, 'CHANGES_REQUESTED', 'The implementation looks solid but needs more error handling for edge cases.', 'cba987fed654'),
  (4, 4, 4, 'APPROVED', 'Clean implementation with good documentation. Merging!', 'aaa111bbb222')
ON CONFLICT DO NOTHING;

-- Comments on issues and PRs
INSERT INTO comments (id, issue_id, pr_id, user_id, body) VALUES
  (1, 1, NULL, 1, 'Thanks for reporting this! I will work on a fix this week.'),
  (2, 1, NULL, 2, 'Happy to help test once a PR is ready.'),
  (3, 2, NULL, 4, 'I can help with this. I have experience implementing theme systems.'),
  (4, NULL, 1, 1, 'Could you add a test for the edge case when icon is null?'),
  (5, NULL, 1, 2, 'Good point, I will add that test.'),
  (6, 4, NULL, 2, 'This would be really useful for complex CLI applications.'),
  (7, NULL, 3, 1, 'Great progress! The recursive approach looks clean.')
ON CONFLICT DO NOTHING;

-- Discussions
INSERT INTO discussions (id, repo_id, number, title, body, category, author_id, is_answered, answer_comment_id) VALUES
  (1, 1, 1, 'Best practices for component organization?', 'What is the recommended way to organize components in a large project? Should we use feature-based or type-based folder structure?', 'Q&A', 3, true, 1),
  (2, 7, 1, 'RFC: Plugin system architecture', 'I am thinking about adding a plugin system to the CLI framework. Here is my proposal for the architecture...', 'Ideas', 1, false, NULL),
  (3, 9, 1, 'Welcome! Introduce yourself', 'Hey everyone! This is a thread for new contributors to introduce themselves. Tell us about your background and what you want to learn!', 'General', 4, false, NULL)
ON CONFLICT (repo_id, number) DO NOTHING;

-- Discussion comments
INSERT INTO discussion_comments (id, discussion_id, user_id, parent_id, body, upvotes) VALUES
  (1, 1, 1, NULL, 'I recommend feature-based organization for larger projects. It keeps related code together and makes it easier to understand the codebase.', 15),
  (2, 1, 2, NULL, 'Agreed! We use feature-based at my company and it scales well.', 8),
  (3, 1, 3, 1, 'Thanks! This is really helpful. I will restructure my project this way.', 3),
  (4, 2, 2, NULL, 'Love the idea! A plugin system would make the framework much more extensible.', 12),
  (5, 2, 3, NULL, 'Have you considered using a hook-based approach? It might be more flexible than traditional plugins.', 7),
  (6, 3, 1, NULL, 'Hi everyone! I am Alice, a full-stack developer. Excited to contribute to algorithm implementations!', 5),
  (7, 3, 2, NULL, 'Hey! Bob here. Looking forward to learning and sharing knowledge with this community.', 4)
ON CONFLICT DO NOTHING;

-- Update discussion answer
UPDATE discussions SET answer_comment_id = 1 WHERE id = 1;

-- Webhooks
INSERT INTO webhooks (id, repo_id, url, secret, events, is_active) VALUES
  (1, 1, 'https://example.com/webhooks/github', 'webhook_secret_123', ARRAY['push', 'pull_request', 'issues'], true),
  (2, 7, 'https://ci.awesome-tools.dev/hooks/github', 'ci_webhook_secret', ARRAY['push', 'pull_request'], true)
ON CONFLICT DO NOTHING;

-- Notifications
INSERT INTO notifications (user_id, type, title, message, url, is_read) VALUES
  (1, 'issue_assigned', 'Issue assigned to you', 'Button component does not support custom icons', '/alice/react-components/issues/1', false),
  (1, 'pr_review_requested', 'Review requested', 'feat: Implement subcommand support', '/awesome-tools/cli-framework/pull/3', false),
  (2, 'pr_comment', 'New comment on your PR', 'Could you add a test for the edge case...', '/alice/react-components/pull/4', true),
  (4, 'mention', 'You were mentioned', 'I can help with this. I have experience...', '/alice/react-components/issues/2', false)
ON CONFLICT DO NOTHING;

-- Audit logs
INSERT INTO audit_logs (user_id, action, resource_type, resource_id, ip_address, details, outcome) VALUES
  (1, 'repo.create', 'repository', '1', '192.168.1.100', '{"name": "react-components", "visibility": "public"}', 'success'),
  (2, 'issue.create', 'issue', '1', '192.168.1.101', '{"repo": "react-components", "title": "Button component does not support custom icons"}', 'success'),
  (3, 'pr.create', 'pull_request', '2', '192.168.1.102', '{"repo": "react-components", "title": "docs: Update README with new examples"}', 'success'),
  (1, 'pr.merge', 'pull_request', '2', '192.168.1.100', '{"method": "merge"}', 'success')
ON CONFLICT DO NOTHING;
