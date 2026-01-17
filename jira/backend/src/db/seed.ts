import { pool } from '../config/database.js';
import bcrypt from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';

async function seed() {
  console.log('Seeding database...');

  try {
    // Create default project roles
    await pool.query(`
      INSERT INTO project_roles (name, description) VALUES
        ('Administrator', 'Full access to project settings and all issues'),
        ('Developer', 'Can create and edit issues'),
        ('Viewer', 'Read-only access to issues')
      ON CONFLICT (name) DO NOTHING
    `);

    // Create default permission scheme
    const { rows: schemeRows } = await pool.query(`
      INSERT INTO permission_schemes (name, description, is_default)
      VALUES ('Default Permission Scheme', 'Default permissions for new projects', true)
      ON CONFLICT DO NOTHING
      RETURNING id
    `);

    const schemeId = schemeRows[0]?.id || 1;

    // Add permission grants
    await pool.query(`
      INSERT INTO permission_grants (scheme_id, permission, grantee_type, grantee_id) VALUES
        ($1, 'create_issue', 'role', 'Developer'),
        ($1, 'create_issue', 'role', 'Administrator'),
        ($1, 'edit_issue', 'role', 'Developer'),
        ($1, 'edit_issue', 'role', 'Administrator'),
        ($1, 'delete_issue', 'role', 'Administrator'),
        ($1, 'transition_issue', 'role', 'Developer'),
        ($1, 'transition_issue', 'role', 'Administrator'),
        ($1, 'assign_issue', 'role', 'Developer'),
        ($1, 'assign_issue', 'role', 'Administrator'),
        ($1, 'manage_sprints', 'role', 'Administrator'),
        ($1, 'manage_sprints', 'role', 'Developer'),
        ($1, 'view_issue', 'anyone', NULL),
        ($1, 'add_comment', 'role', 'Developer'),
        ($1, 'add_comment', 'role', 'Administrator'),
        ($1, 'project_admin', 'role', 'Administrator')
      ON CONFLICT DO NOTHING
    `, [schemeId]);

    // Create default workflow
    const { rows: workflowRows } = await pool.query(`
      INSERT INTO workflows (name, description, is_default)
      VALUES ('Default Workflow', 'Standard workflow with To Do, In Progress, Done', true)
      ON CONFLICT DO NOTHING
      RETURNING id
    `);

    const workflowId = workflowRows[0]?.id || 1;

    // Create default statuses
    await pool.query(`
      INSERT INTO statuses (workflow_id, name, category, color, position) VALUES
        ($1, 'To Do', 'todo', '#6B7280', 0),
        ($1, 'In Progress', 'in_progress', '#3B82F6', 1),
        ($1, 'In Review', 'in_progress', '#8B5CF6', 2),
        ($1, 'Done', 'done', '#10B981', 3)
      ON CONFLICT (workflow_id, name) DO NOTHING
    `, [workflowId]);

    // Get status IDs
    const { rows: statusRows } = await pool.query(`
      SELECT id, name FROM statuses WHERE workflow_id = $1 ORDER BY position
    `, [workflowId]);

    const statusMap: Record<string, number> = {};
    for (const row of statusRows) {
      statusMap[row.name] = row.id;
    }

    // Create transitions
    if (Object.keys(statusMap).length > 0) {
      await pool.query(`
        INSERT INTO transitions (workflow_id, name, from_status_id, to_status_id, conditions, validators, post_functions) VALUES
          ($1, 'Start Progress', $2, $3, '[]', '[]', '[]'),
          ($1, 'Request Review', $3, $4, '[]', '[]', '[]'),
          ($1, 'Complete', $4, $5, '[]', '[]', '[]'),
          ($1, 'Back to Progress', $4, $3, '[]', '[]', '[]'),
          ($1, 'Reopen', $5, $2, '[]', '[]', '[]'),
          ($1, 'Start Work', NULL, $3, '[]', '[]', '[]')
        ON CONFLICT DO NOTHING
      `, [workflowId, statusMap['To Do'], statusMap['In Progress'], statusMap['In Review'], statusMap['Done']]);
    }

    // Create admin user
    const adminId = uuidv4();
    const adminPassword = await bcrypt.hash('admin123', 10);
    await pool.query(`
      INSERT INTO users (id, email, password_hash, name, role)
      VALUES ($1, 'admin@example.com', $2, 'Admin User', 'admin')
      ON CONFLICT (email) DO NOTHING
    `, [adminId, adminPassword]);

    // Create demo users
    const user1Id = uuidv4();
    const user2Id = uuidv4();
    const userPassword = await bcrypt.hash('password123', 10);

    await pool.query(`
      INSERT INTO users (id, email, password_hash, name, role)
      VALUES
        ($1, 'john@example.com', $3, 'John Developer', 'user'),
        ($2, 'jane@example.com', $3, 'Jane Manager', 'user')
      ON CONFLICT (email) DO NOTHING
    `, [user1Id, user2Id, userPassword]);

    // Get actual user IDs
    const { rows: users } = await pool.query(`
      SELECT id, email FROM users
    `);
    const userMap: Record<string, string> = {};
    for (const user of users) {
      userMap[user.email] = user.id;
    }

    // Create demo project
    const projectId = uuidv4();
    await pool.query(`
      INSERT INTO projects (id, key, name, description, lead_id, workflow_id, permission_scheme_id, issue_counter)
      VALUES ($1, 'DEMO', 'Demo Project', 'A demonstration project for testing', $2, $3, $4, 0)
      ON CONFLICT (key) DO NOTHING
    `, [projectId, userMap['admin@example.com'], workflowId, schemeId]);

    // Get actual project
    const { rows: projects } = await pool.query(`SELECT id FROM projects WHERE key = 'DEMO'`);
    const demoProjectId = projects[0]?.id;

    if (demoProjectId) {
      // Add project members
      const { rows: roles } = await pool.query(`SELECT id, name FROM project_roles`);
      const roleMap: Record<string, number> = {};
      for (const role of roles) {
        roleMap[role.name] = role.id;
      }

      await pool.query(`
        INSERT INTO project_members (project_id, user_id, role_id) VALUES
          ($1, $2, $5),
          ($1, $3, $6),
          ($1, $4, $6)
        ON CONFLICT DO NOTHING
      `, [demoProjectId, userMap['admin@example.com'], userMap['john@example.com'], userMap['jane@example.com'], roleMap['Administrator'], roleMap['Developer']]);

      // Create a sprint
      await pool.query(`
        INSERT INTO sprints (project_id, name, goal, status)
        VALUES ($1, 'Sprint 1', 'Complete initial features', 'active')
        ON CONFLICT DO NOTHING
      `, [demoProjectId]);

      const { rows: sprints } = await pool.query(`SELECT id FROM sprints WHERE project_id = $1 LIMIT 1`, [demoProjectId]);
      const sprintId = sprints[0]?.id;

      // Create sample issues
      const { rows: statuses } = await pool.query(`SELECT id, name FROM statuses WHERE workflow_id = $1`, [workflowId]);
      const statusById: Record<string, number> = {};
      for (const s of statuses) {
        statusById[s.name] = s.id;
      }

      // Update project counter and create issues
      await pool.query(`UPDATE projects SET issue_counter = 5 WHERE id = $1`, [demoProjectId]);

      const issues = [
        { key: 'DEMO-1', summary: 'Set up project infrastructure', type: 'task', status: 'Done', priority: 'high' },
        { key: 'DEMO-2', summary: 'Design database schema', type: 'task', status: 'Done', priority: 'high' },
        { key: 'DEMO-3', summary: 'Implement user authentication', type: 'story', status: 'In Progress', priority: 'highest' },
        { key: 'DEMO-4', summary: 'Create issue CRUD endpoints', type: 'story', status: 'In Progress', priority: 'high' },
        { key: 'DEMO-5', summary: 'Fix login redirect bug', type: 'bug', status: 'To Do', priority: 'medium' },
      ];

      for (const issue of issues) {
        await pool.query(`
          INSERT INTO issues (project_id, key, summary, issue_type, status_id, priority, reporter_id, assignee_id, sprint_id)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (key) DO NOTHING
        `, [
          demoProjectId,
          issue.key,
          issue.summary,
          issue.type,
          statusById[issue.status],
          issue.priority,
          userMap['admin@example.com'],
          userMap['john@example.com'],
          sprintId
        ]);
      }

      // Create an epic
      await pool.query(`
        UPDATE projects SET issue_counter = 6 WHERE id = $1
      `, [demoProjectId]);

      await pool.query(`
        INSERT INTO issues (project_id, key, summary, description, issue_type, status_id, priority, reporter_id)
        VALUES ($1, 'DEMO-6', 'User Management Epic', 'Epic for all user management features', 'epic', $2, 'high', $3)
        ON CONFLICT (key) DO NOTHING
      `, [demoProjectId, statusById['To Do'], userMap['admin@example.com']]);

      // Create a board
      await pool.query(`
        INSERT INTO boards (project_id, name, type, column_config)
        VALUES ($1, 'DEMO Board', 'kanban', $2)
        ON CONFLICT DO NOTHING
      `, [demoProjectId, JSON.stringify([
        { name: 'To Do', status_ids: [statusById['To Do']] },
        { name: 'In Progress', status_ids: [statusById['In Progress'], statusById['In Review']] },
        { name: 'Done', status_ids: [statusById['Done']] }
      ])]);

      // Add some labels
      await pool.query(`
        INSERT INTO labels (project_id, name, color) VALUES
          ($1, 'frontend', '#3B82F6'),
          ($1, 'backend', '#10B981'),
          ($1, 'urgent', '#EF4444'),
          ($1, 'documentation', '#F59E0B')
        ON CONFLICT DO NOTHING
      `, [demoProjectId]);

      // Add components
      await pool.query(`
        INSERT INTO components (project_id, name, description) VALUES
          ($1, 'API', 'Backend API endpoints'),
          ($1, 'UI', 'Frontend user interface'),
          ($1, 'Database', 'Database schema and migrations')
        ON CONFLICT DO NOTHING
      `, [demoProjectId]);
    }

    console.log('Seeding completed successfully');
    console.log('Demo credentials:');
    console.log('  Admin: admin@example.com / admin123');
    console.log('  User: john@example.com / password123');
  } catch (error) {
    console.error('Seeding failed:', error);
    throw error;
  } finally {
    await pool.end();
  }
}

seed().catch(console.error);
