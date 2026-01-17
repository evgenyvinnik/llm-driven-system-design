import { query, withTransaction } from '../config/database.js';
import { indexIssue, deleteIssueFromIndex } from '../config/elasticsearch.js';
import { cacheDel } from '../config/redis.js';
import { Issue, IssueWithDetails, IssueType, Priority, User, Comment, CommentWithAuthor, IssueHistory, IssueHistoryWithUser } from '../types/index.js';

/**
 * Data required to create a new issue.
 */
export interface CreateIssueData {
  projectId: string;
  summary: string;
  description?: string;
  issueType: IssueType;
  priority?: Priority;
  assigneeId?: string;
  reporterId: string;
  parentId?: number;
  epicId?: number;
  sprintId?: number;
  storyPoints?: number;
  labels?: string[];
  components?: number[];
  customFields?: Record<string, unknown>;
}

/**
 * Data for updating an existing issue.
 * All fields are optional to allow partial updates.
 */
export interface UpdateIssueData {
  summary?: string;
  description?: string;
  issueType?: IssueType;
  priority?: Priority;
  assigneeId?: string | null;
  epicId?: number | null;
  sprintId?: number | null;
  storyPoints?: number | null;
  labels?: string[];
  components?: number[];
  customFields?: Record<string, unknown>;
}

/**
 * Creates a new issue within a project.
 * Generates a unique issue key (e.g., PROJ-123), sets initial status from workflow,
 * records creation history, and indexes the issue for search.
 *
 * @param data - Issue creation data
 * @param user - User creating the issue (for history tracking)
 * @returns Newly created issue
 */
export async function createIssue(data: CreateIssueData, user: User): Promise<Issue> {
  return withTransaction(async (client) => {
    // Get project and increment counter
    const { rows: projects } = await client.query(
      `UPDATE projects SET issue_counter = issue_counter + 1
       WHERE id = $1
       RETURNING key, issue_counter, workflow_id`,
      [data.projectId]
    );

    if (projects.length === 0) {
      throw new Error('Project not found');
    }

    const project = projects[0];
    const issueKey = `${project.key}-${project.issue_counter}`;

    // Get initial status (first 'todo' status in workflow)
    const { rows: statuses } = await client.query(
      `SELECT id FROM statuses
       WHERE workflow_id = $1 AND category = 'todo'
       ORDER BY position LIMIT 1`,
      [project.workflow_id]
    );

    if (statuses.length === 0) {
      throw new Error('No initial status found in workflow');
    }

    const statusId = statuses[0].id;

    // Create the issue
    const { rows } = await client.query<Issue>(
      `INSERT INTO issues (
        project_id, key, summary, description, issue_type, status_id,
        priority, assignee_id, reporter_id, parent_id, epic_id, sprint_id,
        story_points, labels, components, custom_fields
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING *`,
      [
        data.projectId,
        issueKey,
        data.summary,
        data.description || null,
        data.issueType,
        statusId,
        data.priority || 'medium',
        data.assigneeId || null,
        data.reporterId,
        data.parentId || null,
        data.epicId || null,
        data.sprintId || null,
        data.storyPoints || null,
        data.labels || [],
        data.components || [],
        JSON.stringify(data.customFields || {})
      ]
    );

    const issue = rows[0];

    // Record creation in history
    await client.query(
      `INSERT INTO issue_history (issue_id, user_id, field, new_value)
       VALUES ($1, $2, 'created', $3)`,
      [issue.id, user.id, issueKey]
    );

    // Index in Elasticsearch
    try {
      await indexIssueForSearch(issue);
    } catch (error) {
      console.error('Failed to index issue in Elasticsearch:', error);
    }

    return issue;
  });
}

/**
 * Retrieves an issue by its database ID with full details.
 * Joins related data including status, assignee, reporter, project, epic, and sprint.
 *
 * @param issueId - Numeric ID of the issue
 * @returns Issue with all related entities, or null if not found
 */
export async function getIssueById(issueId: number): Promise<IssueWithDetails | null> {
  const { rows } = await query<IssueWithDetails>(
    `SELECT
      i.*,
      json_build_object('id', s.id, 'name', s.name, 'category', s.category, 'color', s.color) as status,
      CASE WHEN a.id IS NOT NULL THEN json_build_object('id', a.id, 'name', a.name, 'email', a.email, 'avatar_url', a.avatar_url) ELSE NULL END as assignee,
      json_build_object('id', r.id, 'name', r.name, 'email', r.email, 'avatar_url', r.avatar_url) as reporter,
      json_build_object('id', p.id, 'key', p.key, 'name', p.name) as project,
      CASE WHEN e.id IS NOT NULL THEN json_build_object('id', e.id, 'key', e.key, 'summary', e.summary) ELSE NULL END as epic,
      CASE WHEN sp.id IS NOT NULL THEN json_build_object('id', sp.id, 'name', sp.name, 'status', sp.status) ELSE NULL END as sprint
    FROM issues i
    JOIN statuses s ON i.status_id = s.id
    LEFT JOIN users a ON i.assignee_id = a.id
    JOIN users r ON i.reporter_id = r.id
    JOIN projects p ON i.project_id = p.id
    LEFT JOIN issues e ON i.epic_id = e.id
    LEFT JOIN sprints sp ON i.sprint_id = sp.id
    WHERE i.id = $1`,
    [issueId]
  );

  return rows[0] || null;
}

/**
 * Retrieves an issue by its human-readable key (e.g., "PROJ-123").
 *
 * @param key - Issue key string
 * @returns Issue with full details, or null if not found
 */
export async function getIssueByKey(key: string): Promise<IssueWithDetails | null> {
  const { rows } = await query<{ id: number }>(
    'SELECT id FROM issues WHERE key = $1',
    [key]
  );

  if (rows.length === 0) return null;
  return getIssueById(rows[0].id);
}

/**
 * Updates an existing issue with partial data.
 * Records all field changes in issue history for audit trail.
 * Updates the Elasticsearch index after modification.
 *
 * @param issueId - ID of the issue to update
 * @param data - Partial issue data to update
 * @param user - User making the update (for history tracking)
 * @returns Updated issue, or null if not found
 */
export async function updateIssue(
  issueId: number,
  data: UpdateIssueData,
  user: User
): Promise<Issue | null> {
  // Get current issue for history
  const current = await getIssueById(issueId);
  if (!current) return null;

  const updates: string[] = [];
  const values: unknown[] = [];
  const historyRecords: { field: string; oldValue: string | null; newValue: string | null }[] = [];
  let paramIndex = 1;

  const addUpdate = (field: string, dbField: string, newValue: unknown, oldValue: unknown) => {
    updates.push(`${dbField} = $${paramIndex++}`);
    values.push(newValue);
    if (JSON.stringify(newValue) !== JSON.stringify(oldValue)) {
      historyRecords.push({
        field,
        oldValue: oldValue ? String(oldValue) : null,
        newValue: newValue ? String(newValue) : null,
      });
    }
  };

  if (data.summary !== undefined) addUpdate('summary', 'summary', data.summary, current.summary);
  if (data.description !== undefined) addUpdate('description', 'description', data.description, current.description);
  if (data.issueType !== undefined) addUpdate('issue_type', 'issue_type', data.issueType, current.issue_type);
  if (data.priority !== undefined) addUpdate('priority', 'priority', data.priority, current.priority);
  if (data.assigneeId !== undefined) addUpdate('assignee', 'assignee_id', data.assigneeId, current.assignee_id);
  if (data.epicId !== undefined) addUpdate('epic', 'epic_id', data.epicId, current.epic_id);
  if (data.sprintId !== undefined) addUpdate('sprint', 'sprint_id', data.sprintId, current.sprint_id);
  if (data.storyPoints !== undefined) addUpdate('story_points', 'story_points', data.storyPoints, current.story_points);
  if (data.labels !== undefined) addUpdate('labels', 'labels', data.labels, current.labels);
  if (data.components !== undefined) addUpdate('components', 'components', data.components, current.components);
  if (data.customFields !== undefined) addUpdate('custom_fields', 'custom_fields', JSON.stringify(data.customFields), JSON.stringify(current.custom_fields));

  if (updates.length === 0) return current;

  updates.push('updated_at = NOW()');
  values.push(issueId);

  const { rows } = await query<Issue>(
    `UPDATE issues SET ${updates.join(', ')} WHERE id = $${paramIndex} RETURNING *`,
    values
  );

  if (rows.length === 0) return null;

  // Record history
  for (const record of historyRecords) {
    await query(
      `INSERT INTO issue_history (issue_id, user_id, field, old_value, new_value)
       VALUES ($1, $2, $3, $4, $5)`,
      [issueId, user.id, record.field, record.oldValue, record.newValue]
    );
  }

  // Update Elasticsearch index
  try {
    await indexIssueForSearch(rows[0]);
  } catch (error) {
    console.error('Failed to update issue in Elasticsearch:', error);
  }

  return rows[0];
}

/**
 * Deletes an issue from the database and search index.
 *
 * @param issueId - ID of the issue to delete
 * @returns True if issue was deleted, false if not found
 */
export async function deleteIssue(issueId: number): Promise<boolean> {
  const { rowCount } = await query('DELETE FROM issues WHERE id = $1', [issueId]);

  if (rowCount && rowCount > 0) {
    try {
      await deleteIssueFromIndex(issueId);
    } catch (error) {
      console.error('Failed to delete issue from Elasticsearch:', error);
    }
    return true;
  }

  return false;
}

/**
 * Retrieves paginated issues for a project with optional filters.
 * Supports filtering by status, assignee, sprint, epic, and issue type.
 *
 * @param projectId - UUID of the project
 * @param options - Filter and pagination options
 * @returns Object containing issues array and total count
 */
export async function getIssuesByProject(
  projectId: string,
  options: {
    statusId?: number;
    assigneeId?: string;
    sprintId?: number;
    epicId?: number;
    issueType?: IssueType;
    limit?: number;
    offset?: number;
  } = {}
): Promise<{ issues: IssueWithDetails[]; total: number }> {
  const conditions: string[] = ['i.project_id = $1'];
  const values: unknown[] = [projectId];
  let paramIndex = 2;

  if (options.statusId) {
    conditions.push(`i.status_id = $${paramIndex++}`);
    values.push(options.statusId);
  }
  if (options.assigneeId) {
    conditions.push(`i.assignee_id = $${paramIndex++}`);
    values.push(options.assigneeId);
  }
  if (options.sprintId !== undefined) {
    if (options.sprintId === 0) {
      conditions.push('i.sprint_id IS NULL');
    } else {
      conditions.push(`i.sprint_id = $${paramIndex++}`);
      values.push(options.sprintId);
    }
  }
  if (options.epicId) {
    conditions.push(`i.epic_id = $${paramIndex++}`);
    values.push(options.epicId);
  }
  if (options.issueType) {
    conditions.push(`i.issue_type = $${paramIndex++}`);
    values.push(options.issueType);
  }

  const whereClause = conditions.join(' AND ');
  const limit = options.limit || 50;
  const offset = options.offset || 0;

  // Get total count
  const { rows: countRows } = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM issues i WHERE ${whereClause}`,
    values
  );
  const total = parseInt(countRows[0].count, 10);

  // Get issues
  const { rows } = await query<IssueWithDetails>(
    `SELECT
      i.*,
      json_build_object('id', s.id, 'name', s.name, 'category', s.category, 'color', s.color) as status,
      CASE WHEN a.id IS NOT NULL THEN json_build_object('id', a.id, 'name', a.name, 'email', a.email, 'avatar_url', a.avatar_url) ELSE NULL END as assignee,
      json_build_object('id', r.id, 'name', r.name, 'email', r.email, 'avatar_url', r.avatar_url) as reporter,
      json_build_object('id', p.id, 'key', p.key, 'name', p.name) as project,
      CASE WHEN e.id IS NOT NULL THEN json_build_object('id', e.id, 'key', e.key, 'summary', e.summary) ELSE NULL END as epic,
      CASE WHEN sp.id IS NOT NULL THEN json_build_object('id', sp.id, 'name', sp.name, 'status', sp.status) ELSE NULL END as sprint
    FROM issues i
    JOIN statuses s ON i.status_id = s.id
    LEFT JOIN users a ON i.assignee_id = a.id
    JOIN users r ON i.reporter_id = r.id
    JOIN projects p ON i.project_id = p.id
    LEFT JOIN issues e ON i.epic_id = e.id
    LEFT JOIN sprints sp ON i.sprint_id = sp.id
    WHERE ${whereClause}
    ORDER BY i.created_at DESC
    LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    [...values, limit, offset]
  );

  return { issues: rows, total };
}

/**
 * Retrieves all issues assigned to a specific sprint.
 * Used for sprint board views.
 *
 * @param sprintId - ID of the sprint
 * @returns Array of issues with full details
 */
export async function getIssuesBySprint(sprintId: number): Promise<IssueWithDetails[]> {
  const { rows } = await query<IssueWithDetails>(
    `SELECT
      i.*,
      json_build_object('id', s.id, 'name', s.name, 'category', s.category, 'color', s.color) as status,
      CASE WHEN a.id IS NOT NULL THEN json_build_object('id', a.id, 'name', a.name, 'email', a.email, 'avatar_url', a.avatar_url) ELSE NULL END as assignee,
      json_build_object('id', r.id, 'name', r.name, 'email', r.email, 'avatar_url', r.avatar_url) as reporter,
      json_build_object('id', p.id, 'key', p.key, 'name', p.name) as project,
      CASE WHEN e.id IS NOT NULL THEN json_build_object('id', e.id, 'key', e.key, 'summary', e.summary) ELSE NULL END as epic,
      CASE WHEN sp.id IS NOT NULL THEN json_build_object('id', sp.id, 'name', sp.name, 'status', sp.status) ELSE NULL END as sprint
    FROM issues i
    JOIN statuses s ON i.status_id = s.id
    LEFT JOIN users a ON i.assignee_id = a.id
    JOIN users r ON i.reporter_id = r.id
    JOIN projects p ON i.project_id = p.id
    LEFT JOIN issues e ON i.epic_id = e.id
    LEFT JOIN sprints sp ON i.sprint_id = sp.id
    WHERE i.sprint_id = $1
    ORDER BY i.created_at ASC`,
    [sprintId]
  );

  return rows;
}

/**
 * Retrieves issues not assigned to any sprint (backlog).
 *
 * @param projectId - UUID of the project
 * @returns Array of backlog issues
 */
export async function getBacklogIssues(projectId: string): Promise<IssueWithDetails[]> {
  const { issues } = await getIssuesByProject(projectId, { sprintId: 0 });
  return issues;
}

/**
 * Retrieves all comments for an issue with author details.
 *
 * @param issueId - ID of the issue
 * @returns Array of comments with author information
 */
export async function getIssueComments(issueId: number): Promise<CommentWithAuthor[]> {
  const { rows } = await query<CommentWithAuthor>(
    `SELECT
      c.*,
      json_build_object('id', u.id, 'name', u.name, 'email', u.email, 'avatar_url', u.avatar_url) as author
    FROM comments c
    JOIN users u ON c.author_id = u.id
    WHERE c.issue_id = $1
    ORDER BY c.created_at ASC`,
    [issueId]
  );

  return rows;
}

/**
 * Adds a comment to an issue.
 * Also updates the issue's updated_at timestamp.
 *
 * @param issueId - ID of the issue to comment on
 * @param authorId - UUID of the comment author
 * @param body - Comment text content
 * @returns Newly created comment
 */
export async function addComment(
  issueId: number,
  authorId: string,
  body: string
): Promise<Comment> {
  const { rows } = await query<Comment>(
    `INSERT INTO comments (issue_id, author_id, body)
     VALUES ($1, $2, $3) RETURNING *`,
    [issueId, authorId, body]
  );

  // Update issue updated_at
  await query('UPDATE issues SET updated_at = NOW() WHERE id = $1', [issueId]);

  return rows[0];
}

/**
 * Updates an existing comment.
 * Only the original author can update their comment.
 *
 * @param commentId - ID of the comment to update
 * @param body - New comment text
 * @param userId - ID of user attempting the update (must match author)
 * @returns Updated comment, or null if not found or unauthorized
 */
export async function updateComment(
  commentId: number,
  body: string,
  userId: string
): Promise<Comment | null> {
  const { rows } = await query<Comment>(
    `UPDATE comments SET body = $1, updated_at = NOW()
     WHERE id = $2 AND author_id = $3
     RETURNING *`,
    [body, commentId, userId]
  );

  return rows[0] || null;
}

/**
 * Deletes a comment.
 * Only the original author can delete their comment.
 *
 * @param commentId - ID of the comment to delete
 * @param userId - ID of user attempting deletion (must match author)
 * @returns True if deleted, false if not found or unauthorized
 */
export async function deleteComment(commentId: number, userId: string): Promise<boolean> {
  const { rowCount } = await query(
    'DELETE FROM comments WHERE id = $1 AND author_id = $2',
    [commentId, userId]
  );

  return (rowCount ?? 0) > 0;
}

/**
 * Retrieves the change history for an issue.
 * Includes user details for each history entry, ordered newest first.
 *
 * @param issueId - ID of the issue
 * @returns Array of history entries with user information
 */
export async function getIssueHistory(issueId: number): Promise<IssueHistoryWithUser[]> {
  const { rows } = await query<IssueHistoryWithUser>(
    `SELECT
      h.*,
      json_build_object('id', u.id, 'name', u.name, 'email', u.email, 'avatar_url', u.avatar_url) as user
    FROM issue_history h
    JOIN users u ON h.user_id = u.id
    WHERE h.issue_id = $1
    ORDER BY h.created_at DESC`,
    [issueId]
  );

  return rows;
}

/**
 * Indexes an issue document in Elasticsearch for search.
 * Denormalizes related data (status name, assignee name, etc.) for efficient search.
 *
 * @param issue - Issue to index
 */
async function indexIssueForSearch(issue: Issue): Promise<void> {
  // Get additional data for search
  const { rows: details } = await query<{
    status_name: string;
    status_category: string;
    project_key: string;
    assignee_name: string;
    reporter_name: string;
    sprint_name: string;
    epic_key: string;
  }>(
    `SELECT
      s.name as status_name,
      s.category as status_category,
      p.key as project_key,
      a.name as assignee_name,
      r.name as reporter_name,
      sp.name as sprint_name,
      e.key as epic_key
    FROM issues i
    JOIN statuses s ON i.status_id = s.id
    JOIN projects p ON i.project_id = p.id
    LEFT JOIN users a ON i.assignee_id = a.id
    JOIN users r ON i.reporter_id = r.id
    LEFT JOIN sprints sp ON i.sprint_id = sp.id
    LEFT JOIN issues e ON i.epic_id = e.id
    WHERE i.id = $1`,
    [issue.id]
  );

  const detail = details[0];
  if (!detail) return;

  await indexIssue({
    id: issue.id,
    key: issue.key,
    project_id: issue.project_id,
    project_key: detail.project_key,
    summary: issue.summary,
    description: issue.description,
    issue_type: issue.issue_type,
    status: detail.status_name,
    status_category: detail.status_category,
    priority: issue.priority,
    assignee_id: issue.assignee_id,
    assignee_name: detail.assignee_name,
    reporter_id: issue.reporter_id,
    reporter_name: detail.reporter_name,
    sprint_id: issue.sprint_id,
    sprint_name: detail.sprint_name,
    epic_id: issue.epic_id,
    epic_key: detail.epic_key,
    story_points: issue.story_points,
    labels: issue.labels,
    components: issue.components,
    custom_fields: issue.custom_fields,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  });
}
