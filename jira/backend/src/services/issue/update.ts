import { withTransaction } from '../../config/database.js';
import { logger } from '../../config/logger.js';
import { concurrencyConflictsCounter } from '../../config/metrics.js';
import { Issue, User } from '../../types/index.js';
import { UpdateIssueData, HistoryRecord } from './types.js';
import { assertReferencesInProject } from './references.js';
import { insertHistory, describeValue } from './history.js';
import { afterIssueCommitted } from './afterCommit.js';

/** API field, column it writes, and the name it gets in the audit trail. */
const UPDATABLE_FIELDS: { key: keyof UpdateIssueData; column: string; label: string }[] = [
  { key: 'summary', column: 'summary', label: 'summary' },
  { key: 'description', column: 'description', label: 'description' },
  { key: 'issueType', column: 'issue_type', label: 'issue_type' },
  { key: 'priority', column: 'priority', label: 'priority' },
  { key: 'assigneeId', column: 'assignee_id', label: 'assignee' },
  { key: 'epicId', column: 'epic_id', label: 'epic' },
  { key: 'sprintId', column: 'sprint_id', label: 'sprint' },
  { key: 'storyPoints', column: 'story_points', label: 'story_points' },
  { key: 'labels', column: 'labels', label: 'labels' },
  { key: 'components', column: 'components', label: 'components' },
  { key: 'customFields', column: 'custom_fields', label: 'custom_fields' },
];

/** One field whose value an update actually changes. */
export interface FieldChange {
  column: string;
  label: string;
  oldValue: unknown;
  newValue: unknown;
}

/**
 * Lists the fields of an update that differ from the current row. Fields that are absent
 * or unchanged are skipped, so a no-op save writes nothing and bumps no version.
 * Custom fields are shallow-merged into the existing object.
 */
export function diffIssue(current: Issue, data: UpdateIssueData): FieldChange[] {
  const row = current as unknown as Record<string, unknown>;
  const changes: FieldChange[] = [];
  for (const { key, column, label } of UPDATABLE_FIELDS) {
    const incoming = data[key];
    if (incoming === undefined) continue;
    const oldValue = row[column] ?? null;
    const newValue =
      key === 'customFields'
        ? { ...(current.custom_fields ?? {}), ...(incoming as Record<string, unknown>) }
        : incoming ?? null;
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
    changes.push({ column, label, oldValue, newValue });
  }
  return changes;
}

export type UpdateIssueResult =
  | { ok: true; issue: Issue; changed: string[] }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'version_conflict'; currentVersion: number };

/**
 * Updates an issue's fields.
 *
 * Concurrency: the caller may pass the version the user edited (from If-Match). The row
 * is locked with SELECT ... FOR UPDATE for the length of this short transaction; if its
 * version differs from the expected one, nothing is written and the caller answers 412.
 * Optimistic across the user's think time, pessimistic for the few milliseconds of the
 * write, which keeps the audit trail's old values exact.
 *
 * In the same transaction: the UPDATE (version + 1) and one history row per changed
 * field. After COMMIT: search indexing and the 'updated' event.
 *
 * @param issueId - Numeric ID of the issue to update
 * @param data - Partial issue data with fields to update
 * @param user - User making the update (recorded in history)
 * @param expectedVersion - Version from If-Match; omit to skip the precondition
 */
export async function updateIssue(
  issueId: number,
  data: UpdateIssueData,
  user: User,
  expectedVersion?: number
): Promise<UpdateIssueResult> {
  const log = logger.child({ operation: 'updateIssue', issueId, userId: user.id });

  const outcome = await withTransaction(async (client) => {
    const { rows } = await client.query<Issue>('SELECT * FROM issues WHERE id = $1 FOR UPDATE', [issueId]);
    const current = rows[0];
    if (!current) return { result: { ok: false, reason: 'not_found' } as UpdateIssueResult };

    if (expectedVersion !== undefined && current.version !== expectedVersion) {
      return {
        result: { ok: false, reason: 'version_conflict', currentVersion: current.version } as UpdateIssueResult,
      };
    }

    const changes = diffIssue(current, data);
    if (changes.length === 0) {
      return { result: { ok: true, issue: current, changed: [] } as UpdateIssueResult };
    }

    const changedKeys = new Set(changes.map((c) => c.column));
    await assertReferencesInProject(client, current.project_id, {
      assigneeId: changedKeys.has('assignee_id') ? data.assigneeId : undefined,
      sprintId: changedKeys.has('sprint_id') ? data.sprintId : undefined,
      epicId: changedKeys.has('epic_id') ? data.epicId : undefined,
    });

    // Column names come from UPDATABLE_FIELDS, never from the request.
    const assignments = changes.map((change, i) => `${change.column} = $${i + 1}`);
    const values = changes.map((change) =>
      change.column === 'custom_fields' ? JSON.stringify(change.newValue) : change.newValue
    );
    const { rows: updatedRows } = await client.query<Issue>(
      `UPDATE issues SET ${assignments.join(', ')}, version = version + 1, updated_at = NOW()
       WHERE id = $${changes.length + 1}
       RETURNING *`,
      [...values, issueId]
    );

    const history: HistoryRecord[] = [];
    for (const change of changes) {
      history.push({
        field: change.label,
        oldValue: await describeValue(client, change.label, change.oldValue),
        newValue: await describeValue(client, change.label, change.newValue),
      });
    }
    await insertHistory(client, issueId, user.id, history);

    const { rows: projectRows } = await client.query<{ key: string }>(
      'SELECT key FROM projects WHERE id = $1',
      [current.project_id]
    );

    return {
      result: { ok: true, issue: updatedRows[0], changed: changes.map((c) => c.label) } as UpdateIssueResult,
      event: {
        projectKey: projectRows[0]?.key ?? '',
        changes: Object.fromEntries(history.map((h) => [h.field, { old: h.oldValue, new: h.newValue }])),
      },
    };
  });

  const { result } = outcome;
  if (!result.ok) {
    if (result.reason === 'version_conflict') {
      concurrencyConflictsCounter.inc({ operation: 'edit' });
      log.info({ expectedVersion, currentVersion: result.currentVersion }, 'Rejected stale issue update');
    }
    return result;
  }

  if (outcome.event) {
    log.info({ changedFields: result.changed, version: result.issue.version }, 'Issue updated');
    afterIssueCommitted({
      event_type: 'updated',
      issue_id: issueId,
      issue_key: result.issue.key,
      project_id: result.issue.project_id,
      project_key: outcome.event.projectKey,
      changes: outcome.event.changes,
      actor_id: user.id,
    });
  }

  return result;
}

/**
 * Deletes an issue (cascading to its history and comments), then removes it from the
 * search index and publishes the 'deleted' event.
 *
 * @param issueId - Numeric ID of the issue to delete
 * @param user - User deleting the issue (recorded as the event's actor)
 * @returns True if the issue was deleted, false if it did not exist
 */
export async function deleteIssue(issueId: number, user: User): Promise<boolean> {
  const log = logger.child({ operation: 'deleteIssue', issueId, userId: user.id });

  const deleted = await withTransaction(async (client) => {
    const { rows } = await client.query<{ key: string; project_id: string; project_key: string }>(
      `DELETE FROM issues i
       USING projects p
       WHERE i.id = $1 AND p.id = i.project_id
       RETURNING i.key, i.project_id, p.key AS project_key`,
      [issueId]
    );
    return rows[0] ?? null;
  });

  if (!deleted) return false;

  log.info({ issueKey: deleted.key }, 'Issue deleted');
  afterIssueCommitted({
    event_type: 'deleted',
    issue_id: issueId,
    issue_key: deleted.key,
    project_id: deleted.project_id,
    project_key: deleted.project_key,
    actor_id: user.id,
  });
  return true;
}
