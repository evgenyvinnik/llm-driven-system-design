/** The user's assistant settings, read by the policy engine and the tool filter on every turn. */
import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../../shared/auth.js'
import { pool } from '../../shared/db.js'
import { asyncHandler } from '../../shared/errors.js'

export const settingsRouter = Router()
settingsRouter.use(requireAuth)

interface Row {
  confirm_writes: boolean
  block_external_after_untrusted: boolean
  allow_send: boolean
  allow_doc_edits: boolean
  prefetch: boolean
  max_steps: number
}

const dto = (r: Row) => ({
  confirmWrites: r.confirm_writes,
  blockExternalAfterUntrusted: r.block_external_after_untrusted,
  allowSend: r.allow_send,
  allowDocEdits: r.allow_doc_edits,
  prefetch: r.prefetch,
  maxSteps: r.max_steps,
})

settingsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query<Row>(
      `INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET user_id = EXCLUDED.user_id
       RETURNING confirm_writes, block_external_after_untrusted, allow_send, allow_doc_edits, prefetch, max_steps`,
      [req.user!.id],
    )
    res.json({ settings: dto(rows[0]) })
  }),
)

const patchSchema = z
  .object({
    confirmWrites: z.boolean(),
    blockExternalAfterUntrusted: z.boolean(),
    allowSend: z.boolean(),
    allowDocEdits: z.boolean(),
    prefetch: z.boolean(),
    maxSteps: z.number().int().min(1).max(30),
  })
  .partial()

const COLUMNS: Record<string, string> = {
  confirmWrites: 'confirm_writes',
  blockExternalAfterUntrusted: 'block_external_after_untrusted',
  allowSend: 'allow_send',
  allowDocEdits: 'allow_doc_edits',
  prefetch: 'prefetch',
  maxSteps: 'max_steps',
}

settingsRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    const patch = patchSchema.parse(req.body)
    const entries = Object.entries(patch)
    const sets = entries.map(([key], i) => `${COLUMNS[key]} = $${i + 2}`)
    const { rows } = await pool.query<Row>(
      `UPDATE user_settings SET ${[...sets, 'updated_at = now()'].join(', ')} WHERE user_id = $1
       RETURNING confirm_writes, block_external_after_untrusted, allow_send, allow_doc_edits, prefetch, max_steps`,
      [req.user!.id, ...entries.map(([, v]) => v)],
    )
    res.json({ settings: dto(rows[0]) })
  }),
)
