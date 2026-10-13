import { PoolClient } from 'pg';
import { HistoryRecord } from './types.js';

/**
 * Appends audit rows using the caller's transaction client, so the history commits or
 * rolls back together with the change it describes.
 */
export async function insertHistory(
  client: PoolClient,
  issueId: number,
  userId: string,
  records: HistoryRecord[]
): Promise<void> {
  if (records.length === 0) return;
  const values: unknown[] = [];
  const tuples = records.map((record, i) => {
    values.push(issueId, userId, record.field, record.oldValue, record.newValue);
    const base = i * 5;
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`;
  });
  await client.query(
    `INSERT INTO issue_history (issue_id, user_id, field, old_value, new_value) VALUES ${tuples.join(', ')}`,
    values
  );
}

/** Formats a stored value for the audit trail. */
export function formatHistoryValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Human-readable value for reference fields, so the history tab reads "Alice Developer"
 * or "Sprint 2" instead of an id. Falls back to the raw value if the row is gone.
 */
export async function describeValue(
  client: PoolClient,
  field: string,
  value: unknown
): Promise<string | null> {
  if (value === null || value === undefined) return null;
  const lookups: Record<string, string> = {
    assignee: 'SELECT name AS label FROM users WHERE id = $1',
    sprint: 'SELECT name AS label FROM sprints WHERE id = $1',
    epic: 'SELECT key AS label FROM issues WHERE id = $1',
  };
  const sql = lookups[field];
  if (!sql) return formatHistoryValue(value);
  const { rows } = await client.query<{ label: string }>(sql, [value]);
  return rows[0]?.label ?? formatHistoryValue(value);
}
