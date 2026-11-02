import { escapeHtml, searchEmails, SearchFilters, SearchResult } from './elasticsearch.js';
import { query } from './db.js';
import { visibleMessageSql } from './threadService.js';
import { searchDuration, searchQueriesTotal } from './metrics.js';
import logger from './logger.js';

export interface ParsedSearchQuery {
  text: string;
  filters: SearchFilters;
}

/**
 * Parse Gmail-style search operators from a query string
 * Supports: from:, to:, has:attachment, before:, after:
 */
export const parseSearchQuery = (rawQuery: string): ParsedSearchQuery => {
  const filters: SearchFilters = {};
  let text = rawQuery;

  // Extract from: operator
  const fromMatch = text.match(/from:(\S+)/i);
  if (fromMatch) {
    filters.from = fromMatch[1];
    text = text.replace(fromMatch[0], '').trim();
  }

  // Extract to: operator
  const toMatch = text.match(/to:(\S+)/i);
  if (toMatch) {
    filters.to = toMatch[1];
    text = text.replace(toMatch[0], '').trim();
  }

  // Extract has:attachment
  const hasMatch = text.match(/has:attachment/i);
  if (hasMatch) {
    filters.hasAttachment = true;
    text = text.replace(hasMatch[0], '').trim();
  }

  // Extract before: operator
  const beforeMatch = text.match(/before:(\S+)/i);
  if (beforeMatch) {
    filters.dateBefore = beforeMatch[1];
    text = text.replace(beforeMatch[0], '').trim();
  }

  // Extract after: operator
  const afterMatch = text.match(/after:(\S+)/i);
  if (afterMatch) {
    filters.dateAfter = afterMatch[1];
    text = text.replace(afterMatch[0], '').trim();
  }

  return { text: text.trim(), filters };
};

/** Escapes LIKE metacharacters so user text matches literally. */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Keeps only results the user can still see in a searchable folder. The index
 * knows who a message was addressed to (`visible_to`) but not each user's
 * mailbox state, so a message the user has since trashed or marked spam used
 * to keep appearing in search.
 */
const filterByCurrentState = async (userId: string, results: SearchResult[]): Promise<SearchResult[]> => {
  if (results.length === 0) return results;
  const allowed = await query<{ id: string }>(
    `SELECT m.id
     FROM messages m
     JOIN thread_user_state tus ON tus.thread_id = m.thread_id AND tus.user_id = $1
     WHERE m.id = ANY($2::uuid[]) AND tus.is_trashed = false AND tus.is_spam = false
       AND ${visibleMessageSql()}`,
    [userId, results.map((r) => r.messageId)]
  );
  const ok = new Set(allowed.rows.map((r) => r.id));
  return results.filter((r) => ok.has(r.messageId));
};

/**
 * SQL fallback used only when Elasticsearch fails: substring match over the
 * user's visible, non-trashed messages, with the same operators where SQL can
 * express them. Unranked, and flagged `degraded` so the UI can say so.
 */
const fallbackSearch = async (
  userId: string,
  text: string,
  filters: SearchFilters,
  page: number,
  limit: number
): Promise<{ results: SearchResult[]; total: number }> => {
  const params: unknown[] = [userId];
  const where: string[] = [visibleMessageSql(), 'tus.is_trashed = false', 'tus.is_spam = false'];
  const add = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  const like = (column: string, p: string) => `${column} ILIKE ${p} ESCAPE '\\'`;
  if (text) {
    const p = add(`%${escapeLike(text)}%`);
    where.push(`(${like('t.subject', p)} OR ${like('m.body_text', p)})`);
  }
  if (filters.from) {
    const p = add(`%${escapeLike(filters.from)}%`);
    where.push(`(${like('su.email', p)} OR ${like('su.display_name', p)})`);
  }
  if (filters.to) {
    const p = add(`%${escapeLike(filters.to)}%`);
    where.push(`EXISTS (SELECT 1 FROM message_recipients r JOIN users ru ON ru.id = r.user_id
                WHERE r.message_id = m.id AND r.recipient_type <> 'bcc'
                  AND (${like('ru.email', p)} OR ${like('ru.display_name', p)}))`);
  }
  if (filters.hasAttachment) where.push('m.has_attachments = true');
  if (filters.dateAfter) where.push(`m.created_at >= ${add(filters.dateAfter)}::date`);
  if (filters.dateBefore) where.push(`m.created_at < (${add(filters.dateBefore)}::date + 1)`);

  const from = `FROM messages m
    JOIN threads t ON t.id = m.thread_id
    JOIN users su ON su.id = m.sender_id
    JOIN thread_user_state tus ON tus.thread_id = m.thread_id AND tus.user_id = $1
    WHERE ${where.join(' AND ')}`;

  const count = await query<{ total: string }>(`SELECT COUNT(*) AS total ${from}`, params);
  const rows = await query<{
    message_id: string;
    thread_id: string;
    subject: string;
    body_text: string;
    sender_name: string;
    sender_email: string;
    created_at: string;
    has_attachments: boolean;
  }>(
    `SELECT m.id AS message_id, m.thread_id, t.subject, m.body_text, su.display_name AS sender_name,
            su.email AS sender_email, m.created_at, m.has_attachments
     ${from}
     ORDER BY m.created_at DESC, m.id
     LIMIT ${add(limit)} OFFSET ${add((page - 1) * limit)}`,
    params
  );
  return {
    total: parseInt(count.rows[0]?.total || '0', 10),
    results: rows.rows.map((r) => ({
      threadId: r.thread_id,
      messageId: r.message_id,
      subject: escapeHtml(r.subject),
      snippet: escapeHtml(r.body_text.substring(0, 150)),
      senderName: r.sender_name,
      senderEmail: r.sender_email,
      createdAt: r.created_at,
      hasAttachments: r.has_attachments,
      score: 0,
    })),
  };
};

/**
 * Search emails for a user. Elasticsearch narrows by `visible_to`; results
 * are then re-checked against the user's current mailbox state.
 */
export const search = async (
  userId: string,
  rawQuery: string,
  page: number = 1,
  limit: number = 20
): Promise<{ results: SearchResult[]; total: number; degraded: boolean }> => {
  const startTime = process.hrtime.bigint();
  const { text, filters } = parseSearchQuery(rawQuery);
  searchQueriesTotal.inc();

  let result: { results: SearchResult[]; total: number };
  let degraded = false;
  try {
    const found = await searchEmails(userId, text, filters, page, limit);
    const kept = await filterByCurrentState(userId, found.results);
    // The index cannot filter per-user state, so the total is reduced by what
    // this page dropped; it is an estimate when trashed mail matches.
    result = { results: kept, total: Math.max(0, found.total - (found.results.length - kept.length)) };
  } catch (error) {
    logger.warn({ error: (error as Error).message, query: rawQuery }, 'Search falling back to SQL');
    result = await fallbackSearch(userId, text, filters, page, limit);
    degraded = true;
  }

  const duration = Number(process.hrtime.bigint() - startTime) / 1e9;
  searchDuration.labels({ type: degraded ? 'fallback' : 'email' }).observe(duration);
  logger.debug(
    { userId, query: rawQuery, resultCount: result.results.length, total: result.total, degraded },
    'Search completed'
  );
  return { ...result, degraded };
};
