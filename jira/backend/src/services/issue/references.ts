import { PoolClient } from 'pg';
import { IssueInputError } from './types.js';

/**
 * Checks that the references on an issue write stay inside the issue's project.
 * Without this, an issue could be put into another project's sprint and then appear on
 * that project's board to people who cannot view the issue's own project.
 * Runs inside the write transaction; throws IssueInputError (answered with 422).
 */
export async function assertReferencesInProject(
  client: PoolClient,
  projectId: string,
  refs: {
    assigneeId?: string | null;
    sprintId?: number | null;
    epicId?: number | null;
    parentId?: number | null;
  }
): Promise<void> {
  if (refs.sprintId) {
    const { rowCount } = await client.query(
      'SELECT 1 FROM sprints WHERE id = $1 AND project_id = $2',
      [refs.sprintId, projectId]
    );
    if (!rowCount) throw new IssueInputError('sprintId', 'The sprint does not belong to this project');
  }
  if (refs.epicId) {
    const { rowCount } = await client.query(
      `SELECT 1 FROM issues WHERE id = $1 AND project_id = $2 AND issue_type = 'epic'`,
      [refs.epicId, projectId]
    );
    if (!rowCount) throw new IssueInputError('epicId', 'The epic must be an epic issue in this project');
  }
  if (refs.parentId) {
    const { rowCount } = await client.query(
      'SELECT 1 FROM issues WHERE id = $1 AND project_id = $2',
      [refs.parentId, projectId]
    );
    if (!rowCount) throw new IssueInputError('parentId', 'The parent issue must be in this project');
  }
  if (refs.assigneeId) {
    const { rowCount } = await client.query('SELECT 1 FROM users WHERE id = $1', [refs.assigneeId]);
    if (!rowCount) throw new IssueInputError('assigneeId', 'The assignee does not exist');
  }
}
