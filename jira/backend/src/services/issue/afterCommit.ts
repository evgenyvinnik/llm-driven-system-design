import { query } from '../../config/database.js';
import { indexIssue, deleteIssueFromIndex } from '../../config/elasticsearch.js';
import { publishIssueEvent, IssueEventMessage } from '../../config/messageQueue.js';
import { logger } from '../../config/logger.js';

type IssueEvent = Omit<IssueEventMessage, 'event_id' | 'timestamp'>;

/**
 * Reads the committed issue with its denormalized names and writes it to the search
 * index. The document carries the issue's version and is indexed with external
 * versioning, so a late or duplicate event can never replace a newer document.
 * Shared by the request path and the search-index worker.
 */
export async function indexIssueById(issueId: number): Promise<void> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT
      i.id, i.key, i.project_id, p.key AS project_key, i.summary, i.description,
      i.issue_type, s.name AS status, s.category AS status_category, i.priority,
      i.assignee_id, a.name AS assignee_name, i.reporter_id, r.name AS reporter_name,
      i.sprint_id, sp.name AS sprint_name, i.epic_id, e.key AS epic_key,
      i.story_points, i.labels, i.components, i.custom_fields, i.version,
      i.created_at, i.updated_at
    FROM issues i
    JOIN projects p ON p.id = i.project_id
    JOIN statuses s ON s.id = i.status_id
    LEFT JOIN users a ON a.id = i.assignee_id
    LEFT JOIN users r ON r.id = i.reporter_id
    LEFT JOIN sprints sp ON sp.id = i.sprint_id
    LEFT JOIN issues e ON e.id = i.epic_id
    WHERE i.id = $1`,
    [issueId]
  );
  // Deleted after the change committed: nothing to index.
  if (rows.length === 0) return;
  await indexIssue(rows[0]);
}

/**
 * Side effects of an issue change that must only run after its transaction commits:
 * update the search index and publish the event that drives the workers (notifications,
 * webhooks, re-indexing). Both are best-effort. PostgreSQL is the source of truth, so a
 * failure here makes search or notifications lag; it never makes the issue wrong.
 */
export function afterIssueCommitted(event: IssueEvent): void {
  const log = logger.child({ issueId: event.issue_id, eventType: event.event_type });

  const indexing =
    event.event_type === 'deleted'
      ? deleteIssueFromIndex(event.issue_id)
      : indexIssueById(event.issue_id);
  indexing.catch((error) => {
    log.warn({ err: error }, 'Inline search indexing failed; the index worker retries from the event');
  });

  publishIssueEvent(event).catch((error) => {
    log.error({ err: error }, 'Failed to publish issue event');
  });
}
