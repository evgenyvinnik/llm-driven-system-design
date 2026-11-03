/**
 * Conversation history (keyset pagination over filters kept in the URL),
 * one conversation's transcript, and analytics. The cost metric is removed
 * server-side for roles without analytics.cost, not hidden in the UI.
 */
import { z } from 'zod'
import {
  buildConversationWhere,
  CONVERSATION_COLUMNS,
  CONVERSATION_FROM,
  conversationFiltersSchema,
  decodeCursor,
  encodeCursor,
} from '../../shared/conversation-query.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, notFound } from '../../shared/errors.js'
import { uuidParam } from '../../shared/ids.js'
import { accessOf, orgRoutes } from '../../shared/org-access.js'

export const conversationsRouter = orgRoutes()

/** Counting every match is the slow part of a filtered list; past this the UI says "10,000+". */
const COUNT_CAP = 10_000

export function mapConversation(r: Record<string, unknown>) {
  return {
    id: r.id,
    subject: r.subject,
    customerName: r.customer_name,
    channel: r.channel,
    status: r.status,
    csat: r.csat,
    messageCount: r.message_count,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    agentId: r.agent_id,
    agentName: r.agent_name,
    projectId: r.project_id,
    projectName: r.project_name,
  }
}

const listQuerySchema = conversationFiltersSchema.extend({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})

conversationsRouter.get(
  '/conversations',
  { permission: 'conversations.read' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const { cursor: rawCursor, limit, ...filters } = listQuerySchema.parse(req.query)
    const cursor = rawCursor ? decodeCursor(rawCursor) : undefined
    const { where, params } = buildConversationWhere(access.orgId, access.projectIds, filters, cursor)
    // The total is only computed for the first page, and capped.
    const counted = buildConversationWhere(access.orgId, access.projectIds, filters)
    const [{ rows }, countResult] = await Promise.all([
      pool.query(
        `SELECT ${CONVERSATION_COLUMNS} ${CONVERSATION_FROM}
          WHERE ${where}
          ORDER BY c.started_at DESC, c.id DESC
          LIMIT ${limit + 1}`,
        params,
      ),
      cursor
        ? null
        : pool.query(
            `SELECT count(*)::int AS n FROM (SELECT 1 FROM conversations c WHERE ${counted.where} LIMIT ${COUNT_CAP + 1}) t`,
            counted.params,
          ),
    ])
    const n: number | undefined = countResult?.rows[0]?.n
    const total = n === undefined ? undefined : { count: Math.min(n, COUNT_CAP), capped: n > COUNT_CAP }
    const page = rows.slice(0, limit)
    const last = page[page.length - 1]
    const nextCursor =
      rows.length > limit && last
        ? encodeCursor({ startedAt: (last.started_at as Date).toISOString(), id: last.id })
        : null
    res.json({ items: page.map(mapConversation), nextCursor, total })
  }),
)

conversationsRouter.get(
  '/conversations/:conversationId',
  { permission: 'conversations.read' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const id = uuidParam(req.params.conversationId, 'Conversation')
    const { rows } = await pool.query(
      `SELECT ${CONVERSATION_COLUMNS} ${CONVERSATION_FROM}
        WHERE c.id = $1 AND c.org_id = $2 AND c.project_id = ANY($3::uuid[])`,
      [id, access.orgId, access.projectIds],
    )
    if (!rows[0]) throw notFound('Conversation')
    const messages = await pool.query(
      `SELECT id, author, body, created_at FROM conversation_messages
        WHERE conversation_id = $1 AND org_id = $2 ORDER BY created_at, id`,
      [id, access.orgId],
    )
    const conversation = mapConversation(rows[0])
    res.json({
      conversation: {
        ...conversation,
        costCents: access.permissions.includes('analytics.cost') ? rows[0].cost_cents : undefined,
        messages: messages.rows.map((m) => ({ id: String(m.id), author: m.author, body: m.body, createdAt: m.created_at })),
      },
    })
  }),
)

const analyticsQuerySchema = z.object({ days: z.coerce.number().int().min(7).max(90).default(14) })

conversationsRouter.get(
  '/analytics',
  { permission: 'analytics.read' },
  asyncHandler(async (req, res) => {
    const access = accessOf(req)
    const { days } = analyticsQuerySchema.parse(req.query)
    const showCost = access.permissions.includes('analytics.cost') && access.entitlements.costAnalytics
    const { rows } = await pool.query(
      `SELECT date_trunc('day', started_at) AS day,
              count(*)::int AS total,
              count(*) FILTER (WHERE status = 'resolved')::int AS resolved,
              count(*) FILTER (WHERE status = 'escalated')::int AS escalated,
              round(avg(csat)::numeric, 2)::float AS csat,
              sum(cost_cents)::int AS cost_cents
         FROM conversations
        WHERE org_id = $1 AND project_id = ANY($2::uuid[])
          AND started_at >= date_trunc('day', now()) - make_interval(days => $3 - 1)
        GROUP BY 1 ORDER BY 1`,
      [access.orgId, access.projectIds, days],
    )
    res.json({
      days,
      // costCents is absent, not zero, when the role or plan doesn't allow it.
      costVisible: showCost,
      series: rows.map((r) => ({
        day: r.day,
        total: r.total,
        resolved: r.resolved,
        escalated: r.escalated,
        csat: r.csat,
        ...(showCost ? { costCents: r.cost_cents } : {}),
      })),
    })
  }),
)
