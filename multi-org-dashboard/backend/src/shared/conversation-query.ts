/**
 * The conversation-history query, shared by the list endpoint and the export
 * worker so that an export contains exactly what the table shows. The org and
 * the caller's accessible projects are always the first two conditions: there
 * is no code path that builds this query without them.
 * @module shared/conversation-query
 */
import { z } from 'zod'
import { HttpError } from './errors.js'
import { isUuid } from './ids.js'

export const conversationFiltersSchema = z
  .object({
    status: z.enum(['open', 'resolved', 'escalated']).optional(),
    channel: z.enum(['chat', 'email', 'voice']).optional(),
    agentId: z.string().refine(isUuid, 'must be a UUID').optional(),
    projectId: z.string().refine(isUuid, 'must be a UUID').optional(),
    q: z.string().trim().min(1).max(100).optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  })
  .strict()

export type ConversationFilters = z.infer<typeof conversationFiltersSchema>

export interface Cursor {
  startedAt: string
  id: string
}

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.startedAt, cursor.id])).toString('base64url')
}

export function decodeCursor(raw: string): Cursor {
  try {
    const [startedAt, id] = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
    if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt)) || !isUuid(id)) throw new Error('shape')
    return { startedAt, id }
  } catch {
    throw new HttpError(400, 'INVALID_CURSOR', 'The page cursor is invalid; start again from the first page')
  }
}

export interface BuiltQuery {
  where: string
  params: unknown[]
}

/** WHERE clause for conversations aliased `c`. `projectIds` is the caller's access, not a filter. */
export function buildConversationWhere(
  orgId: string,
  projectIds: string[],
  filters: ConversationFilters,
  cursor?: Cursor,
): BuiltQuery {
  const params: unknown[] = [orgId, projectIds]
  const conditions = ['c.org_id = $1', 'c.project_id = ANY($2::uuid[])']
  const add = (sql: (n: number) => string, value: unknown) => {
    params.push(value)
    conditions.push(sql(params.length))
  }
  if (filters.status) add((n) => `c.status = $${n}`, filters.status)
  if (filters.channel) add((n) => `c.channel = $${n}`, filters.channel)
  if (filters.agentId) add((n) => `c.agent_id = $${n}`, filters.agentId)
  if (filters.projectId) add((n) => `c.project_id = $${n}`, filters.projectId)
  if (filters.from) add((n) => `c.started_at >= $${n}::date`, filters.from)
  if (filters.to) add((n) => `c.started_at < ($${n}::date + 1)`, filters.to)
  if (filters.q) {
    const pattern = `%${filters.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`
    add((n) => `(c.subject ILIKE $${n} OR c.customer_name ILIKE $${n})`, pattern)
  }
  if (cursor) {
    params.push(cursor.startedAt, cursor.id)
    conditions.push(`(c.started_at, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`)
  }
  return { where: conditions.join(' AND '), params }
}

export const CONVERSATION_COLUMNS = `
  c.id, c.subject, c.customer_name, c.channel, c.status, c.csat, c.message_count, c.cost_cents,
  c.started_at, c.ended_at, c.agent_id, a.name AS agent_name, c.project_id, p.name AS project_name`

export const CONVERSATION_FROM = `
  FROM conversations c
  JOIN agents a ON a.id = c.agent_id
  JOIN projects p ON p.id = c.project_id`
