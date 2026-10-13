import { query } from '../../config/database.js';
import { Issue, IssueWithDetails, IssueType, IssueHistoryWithUser } from '../../types/index.js';

/**
 * Issue columns plus the related entities the UI renders (status, people, project, epic,
 * sprint) as JSON objects. Shared by every query that returns IssueWithDetails.
 */
const ISSUE_DETAILS_SELECT = `
  SELECT
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
  LEFT JOIN sprints sp ON i.sprint_id = sp.id`;

/**
 * Retrieves an issue by its database ID with full details.
 *
 * @param issueId - Numeric ID of the issue in the database
 * @returns Promise resolving to the issue with all related entities, or null if not found
 */
export async function getIssueById(issueId: number): Promise<IssueWithDetails | null> {
  const { rows } = await query<IssueWithDetails>(`${ISSUE_DETAILS_SELECT} WHERE i.id = $1`, [issueId]);
  return rows[0] || null;
}

/**
 * Retrieves an issue by its human-readable key (e.g., "PROJ-123").
 *
 * @param key - Issue key string in format "PROJECT-NUMBER" (e.g., "DEMO-42")
 * @returns Promise resolving to the issue with full details, or null if not found
 */
export async function getIssueByKey(key: string): Promise<IssueWithDetails | null> {
  const { rows } = await query<IssueWithDetails>(`${ISSUE_DETAILS_SELECT} WHERE i.key = $1`, [key]);
  return rows[0] || null;
}

/**
 * Retrieves the plain issue row (no joins), as the write paths read it before deciding.
 *
 * @param issueId - Numeric ID of the issue
 * @returns The issue row, or null if not found
 */
export async function getIssueRow(issueId: number): Promise<Issue | null> {
  const { rows } = await query<Issue>('SELECT * FROM issues WHERE id = $1', [issueId]);
  return rows[0] || null;
}

/**
 * Resolves the project an issue belongs to, for permission checks on routes that only
 * carry an issue id (comments, history).
 *
 * @param issueId - Numeric ID of the issue
 * @returns The project UUID, or null if the issue does not exist
 */
export async function getIssueProjectId(issueId: number): Promise<string | null> {
  const { rows } = await query<{ project_id: string }>('SELECT project_id FROM issues WHERE id = $1', [issueId]);
  return rows[0]?.project_id ?? null;
}

/**
 * Retrieves paginated issues for a project with optional filters, in board/backlog rank
 * order. Supports backlog queries by passing sprintId: 0 to find issues outside sprints.
 *
 * @param projectId - UUID of the project to fetch issues from
 * @param options - Optional filter and pagination parameters
 * @returns Promise resolving to object containing issues array and total count
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
  const limit = Math.min(Math.max(options.limit || 50, 1), 200);
  const offset = Math.max(options.offset || 0, 0);

  const { rows: countRows } = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM issues i WHERE ${whereClause}`,
    values
  );
  const total = parseInt(countRows[0].count, 10);

  const { rows } = await query<IssueWithDetails>(
    `${ISSUE_DETAILS_SELECT}
    WHERE ${whereClause}
    ORDER BY i.rank
    LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    [...values, limit, offset]
  );

  return { issues: rows, total };
}

/**
 * Retrieves all issues assigned to a specific sprint, in rank order.
 *
 * @param sprintId - Numeric ID of the sprint
 * @returns Promise resolving to an array of issues with full details
 */
export async function getIssuesBySprint(sprintId: number): Promise<IssueWithDetails[]> {
  const { rows } = await query<IssueWithDetails>(
    `${ISSUE_DETAILS_SELECT} WHERE i.sprint_id = $1 ORDER BY i.rank`,
    [sprintId]
  );
  return rows;
}

/**
 * Retrieves issues not assigned to any sprint (backlog), in rank order.
 *
 * @param projectId - UUID of the project
 * @returns Promise resolving to an array of backlog issues with full details
 */
export async function getBacklogIssues(projectId: string): Promise<IssueWithDetails[]> {
  const { issues } = await getIssuesByProject(projectId, { sprintId: 0 });
  return issues;
}

/**
 * Retrieves the change history for an issue, newest first.
 *
 * @param issueId - Numeric ID of the issue
 * @returns Promise resolving to an array of history entries with user information
 */
export async function getIssueHistory(issueId: number): Promise<IssueHistoryWithUser[]> {
  const { rows } = await query<IssueHistoryWithUser>(
    `SELECT
      h.*,
      json_build_object('id', u.id, 'name', u.name, 'email', u.email, 'avatar_url', u.avatar_url) as user
    FROM issue_history h
    JOIN users u ON h.user_id = u.id
    WHERE h.issue_id = $1
    ORDER BY h.created_at DESC, h.id DESC`,
    [issueId]
  );

  return rows;
}
