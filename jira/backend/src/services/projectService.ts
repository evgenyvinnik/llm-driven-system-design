import { query } from '../config/database.js';
import { cacheGet, cacheSet, cacheDel } from '../config/redis.js';
import { logger } from '../config/logger.js';
import { cacheHitsCounter, cacheMissesCounter } from '../config/metrics.js';
import { Project, User, Sprint, Board, Label, Component, ProjectRole } from '../types/index.js';

/** Cache TTL for project data in seconds (15 minutes) */
const PROJECT_CACHE_TTL = 900;
/** Cache TTL for board data in seconds (5 minutes) */
const BOARD_CACHE_TTL = 300;
/** Cache TTL for workflow data in seconds (30 minutes, rarely changes) */
const WORKFLOW_CACHE_TTL = 1800;

/**
 * Retrieves a project by its UUID with caching.
 * Uses Redis cache to reduce database load for frequently accessed projects.
 *
 * WHY: Project metadata is read frequently (every issue view, board load, etc.)
 * but changes rarely. Caching reduces database load significantly.
 *
 * @param projectId - UUID of the project
 * @returns Project object or null if not found
 */
export async function getProjectById(projectId: string): Promise<Project | null> {
  const cacheKey = `project:${projectId}`;
  const cached = await cacheGet<Project>(cacheKey);

  if (cached) {
    cacheHitsCounter.inc({ cache_type: 'project' });
    return cached;
  }

  cacheMissesCounter.inc({ cache_type: 'project' });

  const { rows } = await query<Project>(
    'SELECT * FROM projects WHERE id = $1',
    [projectId]
  );

  if (rows[0]) {
    await cacheSet(cacheKey, rows[0], PROJECT_CACHE_TTL);
  }

  return rows[0] || null;
}

/**
 * Retrieves a project by its human-readable key (e.g., "PROJ").
 * Keys are stored uppercase and searched case-insensitively.
 *
 * @param key - Project key (2-10 letters)
 * @returns Project object or null if not found
 */
export async function getProjectByKey(key: string): Promise<Project | null> {
  const cacheKey = `project:key:${key.toUpperCase()}`;
  const cached = await cacheGet<Project>(cacheKey);

  if (cached) {
    cacheHitsCounter.inc({ cache_type: 'project' });
    return cached;
  }

  cacheMissesCounter.inc({ cache_type: 'project' });

  const { rows } = await query<Project>(
    'SELECT * FROM projects WHERE key = $1',
    [key.toUpperCase()]
  );

  if (rows[0]) {
    await cacheSet(cacheKey, rows[0], PROJECT_CACHE_TTL);
  }

  return rows[0] || null;
}

/**
 * Retrieves all projects ordered by name.
 *
 * @returns Array of all projects
 */
export async function getAllProjects(): Promise<Project[]> {
  const { rows } = await query<Project>(
    'SELECT * FROM projects ORDER BY name'
  );
  return rows;
}

/**
 * Retrieves projects that a user is a member of.
 *
 * @param userId - UUID of the user
 * @returns Array of projects the user belongs to
 */
export async function getProjectsForUser(userId: string): Promise<Project[]> {
  const { rows } = await query<Project>(
    `SELECT p.* FROM projects p
     JOIN project_members pm ON p.id = pm.project_id
     WHERE pm.user_id = $1
     ORDER BY p.name`,
    [userId]
  );
  return rows;
}

/**
 * Creates a new project with default workflow and permission scheme.
 * Automatically adds the project lead as Administrator.
 *
 * @param data - Project creation data including key, name, and lead
 * @returns Newly created project
 */
export async function createProject(data: {
  key: string;
  name: string;
  description?: string;
  leadId: string;
  workflowId?: number;
  permissionSchemeId?: number;
}): Promise<Project> {
  const log = logger.child({ operation: 'createProject', key: data.key });

  // Get defaults
  const { rows: defaults } = await query<{ workflow_id: number; permission_scheme_id: number }>(
    `SELECT
      (SELECT id FROM workflows WHERE is_default = true LIMIT 1) as workflow_id,
      (SELECT id FROM permission_schemes WHERE is_default = true LIMIT 1) as permission_scheme_id`
  );

  const workflowId = data.workflowId || defaults[0]?.workflow_id;
  const permissionSchemeId = data.permissionSchemeId || defaults[0]?.permission_scheme_id;

  const { rows } = await query<Project>(
    `INSERT INTO projects (key, name, description, lead_id, workflow_id, permission_scheme_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [data.key.toUpperCase(), data.name, data.description, data.leadId, workflowId, permissionSchemeId]
  );

  // Add lead as Administrator
  const { rows: roles } = await query<{ id: number }>('SELECT id FROM project_roles WHERE name = $1', ['Administrator']);
  if (roles[0]) {
    await query(
      'INSERT INTO project_members (project_id, user_id, role_id) VALUES ($1, $2, $3)',
      [rows[0].id, data.leadId, roles[0].id]
    );
  }

  log.info({ projectId: rows[0].id }, 'Project created');

  return rows[0];
}

/**
 * Updates an existing project's details.
 * Invalidates the project cache after update.
 *
 * @param projectId - UUID of the project to update
 * @param data - Partial project data to update
 * @returns Updated project or null if not found
 */
export async function updateProject(
  projectId: string,
  data: Partial<Pick<Project, 'name' | 'description' | 'lead_id' | 'workflow_id' | 'permission_scheme_id'>>
): Promise<Project | null> {
  const log = logger.child({ operation: 'updateProject', projectId });

  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (data.name !== undefined) {
    fields.push(`name = $${paramIndex++}`);
    values.push(data.name);
  }
  if (data.description !== undefined) {
    fields.push(`description = $${paramIndex++}`);
    values.push(data.description);
  }
  if (data.lead_id !== undefined) {
    fields.push(`lead_id = $${paramIndex++}`);
    values.push(data.lead_id);
  }
  if (data.workflow_id !== undefined) {
    fields.push(`workflow_id = $${paramIndex++}`);
    values.push(data.workflow_id);
  }
  if (data.permission_scheme_id !== undefined) {
    fields.push(`permission_scheme_id = $${paramIndex++}`);
    values.push(data.permission_scheme_id);
  }

  if (fields.length === 0) return null;

  fields.push('updated_at = NOW()');
  values.push(projectId);

  const { rows } = await query<Project>(
    `UPDATE projects SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );

  if (rows[0]) {
    // Invalidate all project-related caches
    await invalidateProjectCache(projectId, rows[0].key);
    log.info('Project updated');
  }

  return rows[0] || null;
}

/**
 * Deletes a project and all related data.
 * Invalidates the project cache after deletion.
 *
 * @param projectId - UUID of the project to delete
 * @returns True if deleted, false if not found
 */
export async function deleteProject(projectId: string): Promise<boolean> {
  const log = logger.child({ operation: 'deleteProject', projectId });

  // Get project key for cache invalidation
  const project = await getProjectById(projectId);

  const { rowCount } = await query('DELETE FROM projects WHERE id = $1', [projectId]);

  if (rowCount && rowCount > 0 && project) {
    await invalidateProjectCache(projectId, project.key);
    log.info('Project deleted');
    return true;
  }

  return false;
}

/**
 * Retrieves all members of a project with their roles.
 *
 * @param projectId - UUID of the project
 * @returns Array of users with their project roles
 */
export async function getProjectMembers(projectId: string): Promise<(User & { role: ProjectRole })[]> {
  const { rows } = await query<User & { role: ProjectRole }>(
    `SELECT u.*, json_build_object('id', r.id, 'name', r.name, 'description', r.description) as role
     FROM users u
     JOIN project_members pm ON u.id = pm.user_id
     JOIN project_roles r ON pm.role_id = r.id
     WHERE pm.project_id = $1
     ORDER BY u.name`,
    [projectId]
  );
  return rows;
}

/**
 * Adds a user to a project with a specific role.
 * If the user is already a member, updates their role.
 *
 * @param projectId - UUID of the project
 * @param userId - UUID of the user to add
 * @param roleId - ID of the project role to assign
 */
export async function addProjectMember(
  projectId: string,
  userId: string,
  roleId: number
): Promise<void> {
  await query(
    `INSERT INTO project_members (project_id, user_id, role_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (project_id, user_id) DO UPDATE SET role_id = $3`,
    [projectId, userId, roleId]
  );
}

/**
 * Removes a user from a project.
 *
 * @param projectId - UUID of the project
 * @param userId - UUID of the user to remove
 */
export async function removeProjectMember(projectId: string, userId: string): Promise<void> {
  await query(
    'DELETE FROM project_members WHERE project_id = $1 AND user_id = $2',
    [projectId, userId]
  );
}

/**
 * Gets all roles a user has in a specific project.
 * Used for permission checking.
 *
 * @param userId - UUID of the user
 * @param projectId - UUID of the project
 * @returns Array of role names
 */
export async function getUserRolesInProject(userId: string, projectId: string): Promise<string[]> {
  const { rows } = await query<{ name: string }>(
    `SELECT r.name
     FROM project_roles r
     JOIN project_members pm ON r.id = pm.role_id
     WHERE pm.project_id = $1 AND pm.user_id = $2`,
    [projectId, userId]
  );
  return rows.map(r => r.name);
}

/**
 * Retrieves all sprints for a project, newest first.
 *
 * @param projectId - UUID of the project
 * @returns Array of sprints
 */
export async function getSprintsByProject(projectId: string): Promise<Sprint[]> {
  const { rows } = await query<Sprint>(
    'SELECT * FROM sprints WHERE project_id = $1 ORDER BY created_at DESC',
    [projectId]
  );
  return rows;
}

/**
 * Retrieves a sprint by its ID.
 *
 * @param sprintId - ID of the sprint
 * @returns Sprint or null if not found
 */
export async function getSprintById(sprintId: number): Promise<Sprint | null> {
  const { rows } = await query<Sprint>(
    'SELECT * FROM sprints WHERE id = $1',
    [sprintId]
  );
  return rows[0] || null;
}

/**
 * Creates a new sprint in a project.
 *
 * @param data - Sprint creation data
 * @returns Newly created sprint
 */
export async function createSprint(data: {
  projectId: string;
  name: string;
  goal?: string;
  startDate?: Date;
  endDate?: Date;
}): Promise<Sprint> {
  const { rows } = await query<Sprint>(
    `INSERT INTO sprints (project_id, name, goal, start_date, end_date, status)
     VALUES ($1, $2, $3, $4, $5, 'future')
     RETURNING *`,
    [data.projectId, data.name, data.goal, data.startDate, data.endDate]
  );
  return rows[0];
}

/**
 * Updates sprint details.
 *
 * @param sprintId - ID of the sprint to update
 * @param data - Partial sprint data to update
 * @returns Updated sprint or null if not found
 */
export async function updateSprint(
  sprintId: number,
  data: Partial<Pick<Sprint, 'name' | 'goal' | 'start_date' | 'end_date' | 'status'>>
): Promise<Sprint | null> {
  const fields: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (data.name !== undefined) {
    fields.push(`name = $${paramIndex++}`);
    values.push(data.name);
  }
  if (data.goal !== undefined) {
    fields.push(`goal = $${paramIndex++}`);
    values.push(data.goal);
  }
  if (data.start_date !== undefined) {
    fields.push(`start_date = $${paramIndex++}`);
    values.push(data.start_date);
  }
  if (data.end_date !== undefined) {
    fields.push(`end_date = $${paramIndex++}`);
    values.push(data.end_date);
  }
  if (data.status !== undefined) {
    fields.push(`status = $${paramIndex++}`);
    values.push(data.status);
  }

  if (fields.length === 0) return null;

  fields.push('updated_at = NOW()');
  values.push(sprintId);

  const { rows } = await query<Sprint>(
    `UPDATE sprints SET ${fields.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );

  return rows[0] || null;
}

/**
 * Starts a sprint, closing any currently active sprint in the project.
 * Sets the start date to now.
 *
 * @param sprintId - ID of the sprint to start
 * @returns Updated sprint or null if not found
 */
export async function startSprint(sprintId: number): Promise<Sprint | null> {
  // First, close any active sprint in the same project
  const sprint = await getSprintById(sprintId);
  if (!sprint) return null;

  await query(
    `UPDATE sprints SET status = 'closed', updated_at = NOW()
     WHERE project_id = $1 AND status = 'active'`,
    [sprint.project_id]
  );

  return updateSprint(sprintId, {
    status: 'active',
    start_date: new Date(),
  });
}

/**
 * Completes a sprint, setting its end date to now.
 *
 * @param sprintId - ID of the sprint to complete
 * @returns Updated sprint or null if not found
 */
export async function completeSprint(sprintId: number): Promise<Sprint | null> {
  return updateSprint(sprintId, {
    status: 'closed',
    end_date: new Date(),
  });
}

/**
 * Retrieves all boards for a project with caching.
 *
 * WHY: Board configurations are read on every board view but rarely change.
 * Caching reduces database load for frequently accessed boards.
 *
 * @param projectId - UUID of the project
 * @returns Array of boards
 */
export async function getBoardsByProject(projectId: string): Promise<Board[]> {
  const cacheKey = `boards:project:${projectId}`;
  const cached = await cacheGet<Board[]>(cacheKey);

  if (cached) {
    cacheHitsCounter.inc({ cache_type: 'board' });
    return cached;
  }

  cacheMissesCounter.inc({ cache_type: 'board' });

  const { rows } = await query<Board>(
    'SELECT * FROM boards WHERE project_id = $1 ORDER BY name',
    [projectId]
  );

  if (rows.length > 0) {
    await cacheSet(cacheKey, rows, BOARD_CACHE_TTL);
  }

  return rows;
}

/**
 * Retrieves a board by its ID with caching.
 *
 * @param boardId - ID of the board
 * @returns Board or null if not found
 */
export async function getBoardById(boardId: number): Promise<Board | null> {
  const cacheKey = `board:${boardId}`;
  const cached = await cacheGet<Board>(cacheKey);

  if (cached) {
    cacheHitsCounter.inc({ cache_type: 'board' });
    return cached;
  }

  cacheMissesCounter.inc({ cache_type: 'board' });

  const { rows } = await query<Board>(
    'SELECT * FROM boards WHERE id = $1',
    [boardId]
  );

  if (rows[0]) {
    await cacheSet(cacheKey, rows[0], BOARD_CACHE_TTL);
  }

  return rows[0] || null;
}

/**
 * Creates a new board for a project.
 * Invalidates the project's board list cache.
 *
 * @param data - Board creation data
 * @returns Newly created board
 */
export async function createBoard(data: {
  projectId: string;
  name: string;
  type: 'kanban' | 'scrum';
  filterJql?: string;
  columnConfig?: unknown[];
}): Promise<Board> {
  const { rows } = await query<Board>(
    `INSERT INTO boards (project_id, name, type, filter_jql, column_config)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [data.projectId, data.name, data.type, data.filterJql, JSON.stringify(data.columnConfig || [])]
  );

  // Invalidate board list cache for this project
  await cacheDel(`boards:project:${data.projectId}`);

  return rows[0];
}

/**
 * Retrieves all labels for a project.
 *
 * @param projectId - UUID of the project
 * @returns Array of labels
 */
export async function getLabelsByProject(projectId: string): Promise<Label[]> {
  const { rows } = await query<Label>(
    'SELECT * FROM labels WHERE project_id = $1 ORDER BY name',
    [projectId]
  );
  return rows;
}

/**
 * Creates or updates a label in a project.
 *
 * @param projectId - UUID of the project
 * @param name - Label name
 * @param color - Hex color code (e.g., "#FF0000")
 * @returns Created or updated label
 */
export async function createLabel(projectId: string, name: string, color: string): Promise<Label> {
  const { rows } = await query<Label>(
    `INSERT INTO labels (project_id, name, color) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, name) DO UPDATE SET color = $3
     RETURNING *`,
    [projectId, name, color]
  );
  return rows[0];
}

/**
 * Retrieves all components for a project.
 *
 * @param projectId - UUID of the project
 * @returns Array of components
 */
export async function getComponentsByProject(projectId: string): Promise<Component[]> {
  const { rows } = await query<Component>(
    'SELECT * FROM components WHERE project_id = $1 ORDER BY name',
    [projectId]
  );
  return rows;
}

/**
 * Creates a new component in a project.
 *
 * @param data - Component creation data
 * @returns Newly created component
 */
export async function createComponent(data: {
  projectId: string;
  name: string;
  description?: string;
  leadId?: string;
}): Promise<Component> {
  const { rows } = await query<Component>(
    `INSERT INTO components (project_id, name, description, lead_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [data.projectId, data.name, data.description, data.leadId]
  );
  return rows[0];
}

/**
 * Retrieves all available project roles.
 *
 * @returns Array of project roles
 */
export async function getProjectRoles(): Promise<ProjectRole[]> {
  const { rows } = await query<ProjectRole>('SELECT * FROM project_roles ORDER BY name');
  return rows;
}

/**
 * Invalidates all cache entries related to a project.
 *
 * @param projectId - Project UUID
 * @param projectKey - Project key
 */
async function invalidateProjectCache(projectId: string, projectKey: string): Promise<void> {
  await Promise.all([
    cacheDel(`project:${projectId}`),
    cacheDel(`project:key:${projectKey}`),
    cacheDel(`boards:project:${projectId}`),
  ]);
}
