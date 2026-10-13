import { withTransaction } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { issuesCreatedCounter } from '../../config/metrics.js';
import { Issue, User } from '../../types/index.js';
import { CreateIssueData } from './types.js';
import { assertReferencesInProject } from './references.js';
import { afterIssueCommitted } from './afterCommit.js';

/** Rank collisions are possible when a create races a board move; both sides retry. */
const MAX_ATTEMPTS = 3;

function isRankCollision(error: unknown): boolean {
  const pgError = error as { code?: string; constraint?: string };
  return pgError.code === '23505' && pgError.constraint === 'idx_issues_project_rank';
}

/**
 * Creates a new issue within a project.
 *
 * @description In one transaction:
 * 1. Increments the project's issue counter to allocate the key (e.g., PROJ-123). The
 *    UPDATE row-locks the project, so concurrent creates in a project serialize here.
 * 2. Picks the initial status (first 'todo' status of the project's workflow).
 * 3. Checks that sprint, epic, parent and assignee belong to the project.
 * 4. Inserts the issue (a trigger appends it to the bottom of the project's rank order)
 *    and the 'created' history row.
 *
 * Only after COMMIT does it index the issue and publish the 'created' event, so neither
 * search nor the workers can observe an issue that was rolled back.
 *
 * @param data - Issue creation data including project, summary, type, and reporter
 * @param user - User creating the issue (used for history tracking)
 * @returns Promise resolving to the newly created issue
 * @throws Error - If the project is not found or its workflow has no initial status
 * @throws IssueInputError - If a referenced sprint, epic, parent or user is invalid
 */
export async function createIssue(data: CreateIssueData, user: User): Promise<Issue> {
  const log = logger.child({ operation: 'createIssue', projectId: data.projectId, userId: user.id });

  for (let attempt = 1; ; attempt++) {
    try {
      const { issue, projectKey } = await insertIssue(data, user);

      issuesCreatedCounter.inc({ project_key: projectKey, issue_type: data.issueType });
      log.info({ issueId: issue.id, issueKey: issue.key }, 'Issue created');

      afterIssueCommitted({
        event_type: 'created',
        issue_id: issue.id,
        issue_key: issue.key,
        project_id: data.projectId,
        project_key: projectKey,
        actor_id: user.id,
      });

      return issue;
    } catch (error) {
      if (isRankCollision(error) && attempt < MAX_ATTEMPTS) {
        log.warn({ attempt }, 'Rank key collided with a concurrent move, retrying');
        continue;
      }
      throw error;
    }
  }
}

async function insertIssue(data: CreateIssueData, user: User): Promise<{ issue: Issue; projectKey: string }> {
  return withTransaction(async (client) => {
    const { rows: projects } = await client.query<{ key: string; issue_counter: number; workflow_id: number }>(
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

    const { rows: statuses } = await client.query<{ id: number }>(
      `SELECT id FROM statuses
       WHERE workflow_id = $1 AND category = 'todo'
       ORDER BY position LIMIT 1`,
      [project.workflow_id]
    );

    if (statuses.length === 0) {
      throw new Error('No initial status found in workflow');
    }

    await assertReferencesInProject(client, data.projectId, data);

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
        statuses[0].id,
        data.priority || 'medium',
        data.assigneeId || null,
        data.reporterId,
        data.parentId || null,
        data.epicId || null,
        data.sprintId || null,
        data.storyPoints ?? null,
        data.labels || [],
        data.components || [],
        JSON.stringify(data.customFields || {}),
      ]
    );

    const issue = rows[0];

    await client.query(
      `INSERT INTO issue_history (issue_id, user_id, field, new_value)
       VALUES ($1, $2, 'created', $3)`,
      [issue.id, user.id, issueKey]
    );

    return { issue, projectKey: project.key };
  });
}
