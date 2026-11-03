/**
 * Host app: mail. Visibility is per message (a mailbox entry for this user),
 * never per thread.
 */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../../shared/auth.js'
import { pool, withTransaction } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { idParam, shortId } from '../../shared/ids.js'
import { cleanEmailBody } from '../../retrieval/clean.js'
import { principalsFor } from '../../retrieval/principals.js'
import { sendDraft } from '../../tools/mail.js'
import { ToolError, type ToolContext } from '../../tools/types.js'

export const mailRouter = Router()
mailRouter.use(requireAuth)

interface Row {
  id: string
  thread_id: string
  from_email: string
  from_name: string
  to_emails: string[]
  cc_emails: string[]
  subject: string
  body_text: string
  is_external: boolean
  sent_at: Date
  unread: boolean
  folder: string
}

function messageDto(r: Row, full = false) {
  const body = cleanEmailBody(r.body_text)
  return {
    id: r.id,
    threadId: r.thread_id,
    from: { name: r.from_name, email: r.from_email },
    to: r.to_emails,
    cc: r.cc_emails,
    subject: r.subject,
    snippet: body.replace(/\s+/g, ' ').slice(0, 140),
    sentAt: r.sent_at.toISOString(),
    unread: r.unread,
    external: r.is_external,
    folder: r.folder,
    ...(full ? { body: r.body_text } : {}),
  }
}

const SELECT = `SELECT m.id, m.thread_id, m.from_email, m.from_name, m.to_emails, m.cc_emails, m.subject, m.body_text, m.is_external,
                       m.sent_at, e.unread, e.folder
                  FROM mail_messages m JOIN mailbox_entries e ON e.message_id = m.id AND e.user_id = $1`

mailRouter.get(
  '/messages',
  asyncHandler(async (req, res) => {
    const folder = z.enum(['inbox', 'sent', 'archive']).default('inbox').parse(req.query.folder)
    const { rows } = await pool.query<Row>(`${SELECT} WHERE e.folder = $2 ORDER BY m.sent_at DESC LIMIT 100`, [req.user!.id, folder])
    res.json({ messages: rows.map((r) => messageDto(r)) })
  }),
)

mailRouter.get(
  '/messages/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id, 'm', 'Message')
    const { rows } = await pool.query<Row>(`${SELECT} WHERE m.id = $2`, [req.user!.id, id])
    if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Message not found')
    const { rows: thread } = await pool.query<Row>(`${SELECT} WHERE m.thread_id = $2 ORDER BY m.sent_at`, [req.user!.id, rows[0].thread_id])
    await pool.query('UPDATE mailbox_entries SET unread = false WHERE user_id = $1 AND message_id = $2', [req.user!.id, id])
    res.json({ message: messageDto(rows[0], true), thread: thread.map((r) => messageDto(r, true)) })
  }),
)

interface DraftRow {
  id: string
  to_emails: string[]
  cc_emails: string[]
  subject: string
  body: string
  in_reply_to: string | null
  created_by: string
  status: string
  updated_at: Date
}

const draftDto = (d: DraftRow) => ({
  id: d.id,
  to: d.to_emails,
  cc: d.cc_emails,
  subject: d.subject,
  body: d.body,
  inReplyTo: d.in_reply_to,
  createdBy: d.created_by,
  status: d.status,
  updatedAt: d.updated_at.toISOString(),
})

mailRouter.get(
  '/drafts',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query<DraftRow>(
      `SELECT id, to_emails, cc_emails, subject, body, in_reply_to, created_by, status, updated_at FROM mail_drafts
        WHERE user_id = $1 AND status = 'draft' ORDER BY updated_at DESC`,
      [req.user!.id],
    )
    res.json({ drafts: rows.map(draftDto) })
  }),
)

const draftSchema = z.object({
  to: z.array(z.string().email()).min(1).max(20),
  cc: z.array(z.string().email()).max(20).default([]),
  subject: z.string().max(200).default(''),
  body: z.string().max(10000).default(''),
})

async function userContext(user: NonNullable<Express.Request['user']>, db: ToolContext['db']): Promise<ToolContext> {
  const { rows } = await pool.query<{ domain: string }>('SELECT domain FROM orgs WHERE id = $1', [user.orgId])
  return {
    userId: user.id,
    orgId: user.orgId,
    email: user.email,
    timezone: user.timezone,
    turnId: '00000000-0000-0000-0000-000000000000',
    callId: 'manual',
    principals: await principalsFor(pool, user.id, user.orgId),
    orgDomain: rows[0].domain,
    db,
  }
}

/** Sends through the same code path the assistant's send_draft tool uses. */
async function sendAsUser(user: NonNullable<Express.Request['user']>, draftId: string) {
  return withTransaction(async (client) => {
    try {
      return await sendDraft.run!({ draft_id: draftId }, await userContext(user, client))
    } catch (err) {
      if (err instanceof ToolError) throw new HttpError(409, 'CANNOT_SEND', err.message)
      throw err
    }
  })
}

mailRouter.post(
  '/drafts',
  asyncHandler(async (req, res) => {
    const body = draftSchema.parse(req.body)
    const id = shortId('dr')
    const { rows } = await pool.query<DraftRow>(
      `INSERT INTO mail_drafts (id, user_id, to_emails, cc_emails, subject, body) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, to_emails, cc_emails, subject, body, in_reply_to, created_by, status, updated_at`,
      [id, req.user!.id, body.to, body.cc, body.subject, body.body],
    )
    res.status(201).json({ draft: draftDto(rows[0]) })
  }),
)

async function recordDraftOutcome(userId: string, draftId: string, kind: 'draft_sent' | 'draft_discarded') {
  await pool.query(
    `INSERT INTO assistant_feedback (user_id, turn_id, kind, subject)
     SELECT user_id, turn_id, $3, id FROM mail_drafts WHERE id = $1 AND user_id = $2 AND created_by = 'assistant'`,
    [draftId, userId, kind],
  )
}

mailRouter.post(
  '/drafts/:id/send',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id, 'dr', 'Draft')
    const output = await sendAsUser(req.user!, id)
    await recordDraftOutcome(req.user!.id, id, 'draft_sent')
    res.json({ sent: output.content })
  }),
)

mailRouter.delete(
  '/drafts/:id',
  asyncHandler(async (req, res) => {
    const id = idParam(req.params.id, 'dr', 'Draft')
    const { rowCount } = await pool.query(`UPDATE mail_drafts SET status = 'discarded', updated_at = now() WHERE id = $1 AND user_id = $2 AND status = 'draft'`, [
      id,
      req.user!.id,
    ])
    if (rowCount) await recordDraftOutcome(req.user!.id, id, 'draft_discarded')
    res.status(204).end()
  }),
)

/** Compose and send in one step (used to test freshness: mail that isn't indexed yet is still searchable). */
mailRouter.post(
  '/send',
  asyncHandler(async (req, res) => {
    const body = draftSchema.parse(req.body)
    const id = shortId('dr')
    await pool.query('INSERT INTO mail_drafts (id, user_id, to_emails, cc_emails, subject, body) VALUES ($1, $2, $3, $4, $5, $6)', [
      id,
      req.user!.id,
      body.to,
      body.cc,
      body.subject,
      body.body,
    ])
    const output = await sendAsUser(req.user!, id)
    res.status(201).json({ sent: output.content })
  }),
)
