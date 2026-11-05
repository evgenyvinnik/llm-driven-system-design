/**
 * Exceptions (risk acceptance): owners request, approvers decide, every
 * exception expires. Approval flips the finding to exempt in the same
 * transaction; expiry (scanner workflow) or revocation flips it back.
 */
import { Router } from 'express'
import { z } from 'zod'
import { getControl } from '../../domain/controls.js'
import { canDecide, validateExceptionRequest } from '../../domain/exceptions.js'
import type { Severity } from '../../domain/types.js'
import { ownerScope, requireAuth, requireRole } from '../../shared/auth.js'
import { pool, withTransaction } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { newId } from '../../shared/ids.js'
import { audit, notify } from '../../store/audit.js'
import { loadAccountForUser } from './accounts.js'

export const exceptionsRouter = Router()

exceptionsRouter.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const status = z.enum(['pending', 'approved', 'rejected', 'expired', 'revoked', 'all']).default('all').parse(req.query.status)
    const params: unknown[] = []
    const scope = ownerScope(req.user!, 'a', params)
    if (status !== 'all') params.push(status)
    const { rows } = await pool.query(
      `SELECT e.*, a.name AS account_name, a.owner, a.environment, f.severity, ru.display_name AS requested_by_name, du.display_name AS decided_by_name
         FROM exceptions e JOIN storage_accounts a ON a.id = e.account_id JOIN users ru ON ru.id = e.requested_by
         LEFT JOIN users du ON du.id = e.decided_by LEFT JOIN findings f ON f.account_id = e.account_id AND f.control_id = e.control_id
        WHERE ${scope} ${status !== 'all' ? `AND e.status = $${params.length}` : ''}
        ORDER BY CASE e.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, e.expires_at NULLS LAST, e.created_at DESC LIMIT 200`,
      params,
    )
    res.json({
      exceptions: rows.map((e) => ({
        id: e.id,
        accountId: e.account_id,
        accountName: e.account_name,
        owner: e.owner,
        environment: e.environment,
        controlId: e.control_id,
        controlTitle: getControl(e.control_id).title,
        severity: e.severity,
        status: e.status,
        justification: e.justification,
        requestedBy: e.requested_by,
        requestedByName: e.requested_by_name,
        requestedDays: e.requested_days,
        decidedByName: e.decided_by_name,
        decidedAt: e.decided_at,
        decisionNote: e.decision_note,
        expiresAt: e.expires_at,
        createdAt: e.created_at,
      })),
    })
  }),
)

const requestSchema = z.object({ accountName: z.string(), controlId: z.string(), justification: z.string().trim().min(20).max(2000), days: z.number().int() }).strict()

exceptionsRouter.post(
  '/',
  requireRole('owner', 'security'),
  asyncHandler(async (req, res) => {
    const body = requestSchema.parse(req.body)
    const user = req.user!
    getControl(body.controlId)
    const account = await loadAccountForUser(body.accountName, user)
    const { rows } = await pool.query<{ severity: Severity; status: string }>('SELECT severity, status FROM findings WHERE account_id = $1 AND control_id = $2', [account.id, body.controlId])
    if (!rows[0] || rows[0].status !== 'open') throw new HttpError(409, 'NO_OPEN_FINDING', 'Exceptions can only be requested for open findings')
    const invalid = validateExceptionRequest(rows[0].severity, body.days)
    if (invalid) throw new HttpError(422, 'INVALID_DURATION', invalid)
    const id = newId('exc')
    try {
      await withTransaction(async (c) => {
        await c.query(
          `INSERT INTO exceptions (id, account_id, control_id, status, justification, requested_by, requested_days) VALUES ($1, $2, $3, 'pending', $4, $5, $6)`,
          [id, account.id, body.controlId, body.justification, user.id, body.days],
        )
        await audit(c, { actor: `user:${user.username}`, action: 'exception.requested', accountId: account.id, controlId: body.controlId, details: { exceptionId: id, days: body.days, justification: body.justification } })
        await notify(c, { audience: 'approver', kind: 'exception_requested', accountId: account.id, controlId: body.controlId, message: `${user.displayName} requested a ${body.days}-day exception for ${body.controlId} on ${account.name}.`, dedupeKey: `requested:${id}` })
      })
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'EXCEPTION_EXISTS', 'A pending or approved exception already exists for this finding')
      throw err
    }
    res.status(201).json({ id })
  }),
)

const decisionSchema = z.object({ note: z.string().max(1000).optional() }).strict()

exceptionsRouter.post(
  '/:id/:decision(approve|reject)',
  requireRole('approver', 'security'),
  asyncHandler(async (req, res) => {
    const { note } = decisionSchema.parse(req.body ?? {})
    const user = req.user!
    const approve = req.params.decision === 'approve'
    const result = await withTransaction(async (c) => {
      const { rows } = await c.query(`SELECT e.*, a.owner, a.name FROM exceptions e JOIN storage_accounts a ON a.id = e.account_id WHERE e.id = $1 FOR UPDATE OF e`, [req.params.id])
      const e = rows[0]
      if (!e) throw notFound('Exception')
      const refusal = canDecide(user.id, user.role, { status: e.status, requestedBy: e.requested_by })
      if (refusal) throw new HttpError(e.status !== 'pending' ? 409 : 403, 'CANNOT_DECIDE', refusal)
      const { rows: updated } = await c.query(
        `UPDATE exceptions SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4,
                expires_at = CASE WHEN $2 = 'approved' THEN now() + make_interval(days => requested_days) ELSE NULL END
          WHERE id = $1 RETURNING status, expires_at`,
        [e.id, approve ? 'approved' : 'rejected', user.id, note ?? null],
      )
      if (approve) await c.query(`UPDATE findings SET status = 'exempt' WHERE account_id = $1 AND control_id = $2 AND status = 'open'`, [e.account_id, e.control_id])
      await audit(c, { actor: `user:${user.username}`, action: approve ? 'exception.approved' : 'exception.rejected', accountId: e.account_id, controlId: e.control_id, details: { exceptionId: e.id, note, expiresAt: updated[0].expires_at } })
      await notify(c, { audience: 'owner', team: e.owner, kind: approve ? 'exception_approved' : 'exception_rejected', accountId: e.account_id, controlId: e.control_id, message: `Exception for ${e.control_id} on ${e.name} was ${approve ? 'approved' : 'rejected'} by ${user.displayName}${note ? `: ${note}` : '.'}`, dedupeKey: `decided:${e.id}` })
      return updated[0]
    })
    res.json(result)
  }),
)

exceptionsRouter.post(
  '/:id/revoke',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!
    await withTransaction(async (c) => {
      const { rows } = await c.query(`SELECT * FROM exceptions WHERE id = $1 FOR UPDATE`, [req.params.id])
      const e = rows[0]
      if (!e) throw notFound('Exception')
      if (user.role !== 'security' && e.requested_by !== user.id) throw new HttpError(403, 'FORBIDDEN', 'Only security or the requester can revoke')
      if (!['pending', 'approved'].includes(e.status)) throw new HttpError(409, 'NOT_LIVE', `Exception is ${e.status}`)
      await c.query(`UPDATE exceptions SET status = 'revoked', decided_at = COALESCE(decided_at, now()) WHERE id = $1`, [e.id])
      await c.query(`UPDATE findings SET status = 'open' WHERE account_id = $1 AND control_id = $2 AND status = 'exempt'`, [e.account_id, e.control_id])
      await audit(c, { actor: `user:${user.username}`, action: 'exception.revoked', accountId: e.account_id, controlId: e.control_id, details: { exceptionId: e.id } })
    })
    res.json({ status: 'revoked' })
  }),
)
