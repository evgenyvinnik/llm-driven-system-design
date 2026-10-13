import { PoolClient } from 'pg';
import { withTransaction } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { transitionsCounter, concurrencyConflictsCounter } from '../../config/metrics.js';
import { Issue, Transition, TransitionPostFunction, User } from '../../types/index.js';
import { getWorkflowByProject, evaluateConditions, evaluateValidators } from '../workflowService.js';
import { getIssueRow } from './queries.js';
import { insertHistory, describeValue } from './history.js';
import { HistoryRecord } from './types.js';
import { afterIssueCommitted } from './afterCommit.js';

/**
 * Records a status transition for Prometheus metrics.
 *
 * @param projectKey - Project key prefix (e.g., "PROJ")
 * @param fromStatus - Name of the previous status (e.g., "To Do")
 * @param toStatus - Name of the new status (e.g., "In Progress")
 */
export function recordTransitionMetric(projectKey: string, fromStatus: string, toStatus: string): void {
  transitionsCounter.inc({ project_key: projectKey, from_status: fromStatus, to_status: toStatus });
}

export type TransitionFailureCode =
  | 'issue_not_found'
  | 'transition_not_found'
  | 'invalid_from_status'
  | 'condition_failed'
  | 'validation_failed'
  | 'conflict';

export type TransitionResult =
  | { ok: true; issue: Issue; fromStatus: string; toStatus: string }
  | { ok: false; code: TransitionFailureCode; message: string; field?: string };

/** Attempts before giving up when the issue keeps changing under the transition. */
const MAX_ATTEMPTS = 3;

/** Columns the update_field and clear_field post-functions may touch. */
const POST_FUNCTION_FIELDS: Record<string, string> = {
  priority: 'priority',
  story_points: 'story_points',
  assignee_id: 'assignee',
};

/**
 * Applies post-functions inside the transition's transaction, writing a history row for
 * every field they change, so the status change and its side effects on the issue commit
 * together. Notifications are not sent here: the 'transitioned' event published after
 * commit drives the notification worker.
 */
async function applyPostFunctions(
  client: PoolClient,
  postFunctions: TransitionPostFunction[],
  issue: Issue,
  user: User
): Promise<{ issue: Issue; history: HistoryRecord[] }> {
  let current = issue;
  const history: HistoryRecord[] = [];

  const setField = async (column: string, value: unknown) => {
    const label = POST_FUNCTION_FIELDS[column];
    const oldValue = (current as unknown as Record<string, unknown>)[column] ?? null;
    if (!label || JSON.stringify(oldValue) === JSON.stringify(value)) return;
    const { rows } = await client.query<Issue>(
      `UPDATE issues SET ${column} = $1 WHERE id = $2 RETURNING *`,
      [value, current.id]
    );
    current = rows[0];
    history.push({
      field: label,
      oldValue: await describeValue(client, label, oldValue),
      newValue: await describeValue(client, label, value),
    });
  };

  for (const postFunction of postFunctions) {
    const field = String(postFunction.config?.field ?? '');
    switch (postFunction.type) {
      case 'assign_to_current_user':
        await setField('assignee_id', user.id);
        break;
      case 'clear_field':
        await setField(field, null);
        break;
      case 'update_field':
        await setField(field, postFunction.config?.value ?? null);
        break;
      case 'send_notification':
        break;
      default:
        logger.warn({ type: (postFunction as { type: string }).type }, 'Skipping unknown post-function');
    }
  }
  return { issue: current, history };
}

/**
 * Executes a workflow transition on an issue.
 *
 * 1. Read the issue and its project's workflow (cached).
 * 2. The transition must start from the issue's current status (409 otherwise).
 * 3. Conditions: may this user attempt it? (403)
 * 4. Validators: is the issue fit to move? (422 with the field)
 * 5. One transaction: compare-and-swap the status on the version that steps 2-4 read,
 *    write the status history row, run post-functions with their history rows.
 * 6. After COMMIT: index, publish 'transitioned', count the transition.
 *
 * The rules are evaluated without holding a lock. If the compare-and-swap matches zero
 * rows, someone changed the issue in between (status, assignee, any field), so the whole
 * evaluation runs again on the fresh row, up to MAX_ATTEMPTS times. A retry whose
 * transition no longer starts from the current status ends in 409.
 *
 * @param issueId - ID of the issue to transition
 * @param transitionId - ID of a transition in the issue's workflow
 * @param user - User executing the transition
 * @param projectRoles - User's roles in the project (for user_in_role conditions)
 */
export async function transitionIssue(
  issueId: number,
  transitionId: number,
  user: User,
  projectRoles: string[]
): Promise<TransitionResult> {
  const log = logger.child({ operation: 'transitionIssue', issueId, transitionId, userId: user.id });

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const issue = await getIssueRow(issueId);
    if (!issue) return { ok: false, code: 'issue_not_found', message: 'Issue not found' };

    const workflow = await getWorkflowByProject(issue.project_id);
    const transition: Transition | undefined = workflow?.transitions.find((t) => t.id === transitionId);
    if (!workflow || !transition) {
      return { ok: false, code: 'transition_not_found', message: "Transition is not part of this issue's workflow" };
    }

    const statusName = (id: number | null) => workflow.statuses.find((s) => s.id === id)?.name ?? 'Unknown';
    const fromStatus = statusName(issue.status_id);
    const toStatus = statusName(transition.to_status_id);

    if (transition.from_status_id !== null && transition.from_status_id !== issue.status_id) {
      return {
        ok: false,
        code: 'invalid_from_status',
        message: `${issue.key} is now in "${fromStatus}"; "${transition.name}" starts from "${statusName(transition.from_status_id)}"`,
      };
    }

    const blocked = evaluateConditions(transition.conditions, issue, user, projectRoles);
    if (blocked) return { ok: false, code: 'condition_failed', message: blocked };

    const invalid = evaluateValidators(transition.validators, issue);
    if (invalid) return { ok: false, code: 'validation_failed', message: invalid.message, field: invalid.field };

    const committed = await withTransaction(async (client) => {
      const { rows } = await client.query<Issue>(
        `UPDATE issues SET status_id = $1, version = version + 1, updated_at = NOW()
         WHERE id = $2 AND version = $3
         RETURNING *`,
        [transition.to_status_id, issue.id, issue.version]
      );
      if (rows.length === 0) return null;

      const applied = await applyPostFunctions(client, transition.post_functions, rows[0], user);
      await insertHistory(client, issue.id, user.id, [
        { field: 'status', oldValue: fromStatus, newValue: toStatus },
        ...applied.history,
      ]);
      const { rows: project } = await client.query<{ key: string }>('SELECT key FROM projects WHERE id = $1', [
        issue.project_id,
      ]);
      return { issue: applied.issue, projectKey: project[0]?.key ?? '' };
    });

    if (!committed) {
      concurrencyConflictsCounter.inc({ operation: 'transition' });
      log.info({ attempt, readVersion: issue.version }, 'Issue changed during transition, re-evaluating');
      continue;
    }

    recordTransitionMetric(committed.projectKey, fromStatus, toStatus);
    log.info({ from: fromStatus, to: toStatus, version: committed.issue.version }, 'Issue transitioned');
    afterIssueCommitted({
      event_type: 'transitioned',
      issue_id: issue.id,
      issue_key: issue.key,
      project_id: issue.project_id,
      project_key: committed.projectKey,
      changes: { status: { old: fromStatus, new: toStatus } },
      actor_id: user.id,
    });

    return { ok: true, issue: committed.issue, fromStatus, toStatus };
  }

  return {
    ok: false,
    code: 'conflict',
    message: 'The issue kept changing while the transition was applied; reload it and try again',
  };
}
