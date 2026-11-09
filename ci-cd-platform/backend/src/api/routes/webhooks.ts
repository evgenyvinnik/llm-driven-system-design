/**
 * The trigger intake. One URL per repository, so the signature can be checked before
 * the body is parsed: nothing unauthenticated reaches a JSON or YAML parser. An unknown
 * repository and a bad signature get the same 401, so the endpoint can't be used to
 * discover repository names.
 * @module api/routes/webhooks
 */
import express, { Router } from 'express'
import { decrypt } from '../../shared/crypto.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError } from '../../shared/errors.js'
import { webhookOutcomes } from '../../shared/metrics.js'
import { logger } from '../../shared/logger.js'
import { handleDelivery } from '../../intake/events.js'
import { verifySignature } from '../../intake/signature.js'

export const webhooksRouter = Router()

export const webhookAad = (repoId: string) => `webhook:${repoId}`

webhooksRouter.post(
  '/:owner/:repo',
  express.raw({ type: '*/*', limit: '1mb' }),
  asyncHandler(async (req, res) => {
    const fullName = `${req.params.owner}/${req.params.repo}`
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    const { rows } = await pool.query<{ id: string; webhook_secret_enc: string }>('SELECT id, webhook_secret_enc FROM repositories WHERE full_name = $1', [fullName])
    const repo = rows[0]
    const signature = req.get('X-Hub-Signature-256')
    if (!repo || !verifySignature(decrypt(repo.webhook_secret_enc, webhookAad(repo.id)), body, signature)) {
      webhookOutcomes.inc({ outcome: 'bad_signature' })
      logger.warn({ fullName, delivery: req.get('X-GitHub-Delivery') }, 'webhook rejected: bad signature')
      throw new HttpError(401, 'BAD_SIGNATURE', 'Webhook signature is missing or does not match')
    }
    const deliveryId = req.get('X-GitHub-Delivery')
    const eventType = req.get('X-GitHub-Event')
    if (!deliveryId || deliveryId.length > 128) throw new HttpError(400, 'MISSING_DELIVERY_ID', 'X-GitHub-Delivery is required')
    if (!eventType) throw new HttpError(400, 'MISSING_EVENT', 'X-GitHub-Event is required')

    let payload: unknown
    try {
      payload = JSON.parse(body.toString('utf8'))
    } catch {
      throw new HttpError(400, 'INVALID_JSON', 'The body is not valid JSON')
    }
    const result = await handleDelivery({ repoId: repo.id, repoFullName: fullName, deliveryId, eventType, payload, rawBody: body })
    res.status(result.duplicate || !result.runId ? 200 : 202).json(result)
  }),
)
