/**
 * The fixture Git host's HTTP API: GitHub-shaped reads and review writes, plus
 * an admin surface used by the fixture panel (push a commit, flip CI, open a
 * fixture pull request). The review system only ever talks to it over HTTP.
 * @module githost/app
 */
import express, { type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { requireScope } from './auth.js'
import { FIXTURE_NAMES, fixtureSpec } from './fixtures.js'
import * as store from './store.js'
import { HostError } from './store.js'
import { pool } from '../shared/db.js'
import { logger } from '../shared/logger.js'
import { metricsHandler } from '../shared/metrics.js'
import { send, webhookControls, type DeliveryRow } from './webhooks.js'

const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
  fn(req, res).catch(next)
}

const num = (req: Request) => Number.parseInt(req.params.number, 10)

const fileChange = z.object({
  path: z.string().min(1),
  previousPath: z.string().nullable().optional(),
  status: z.enum(['added', 'modified', 'removed', 'renamed']).optional(),
  add: z.array(z.string()).optional(),
  remove: z.array(z.string()).optional(),
  content: z.string().optional(),
  additions: z.number().int().optional(),
  deletions: z.number().int().optional(),
  binary: z.boolean().optional(),
  mode: z.string().optional(),
})
const ciSetting = z.enum(['success', 'failure', 'pending', 'none'])

const pullSpec = z.object({
  fixture: z.enum(FIXTURE_NAMES as [string, ...string[]]).optional(),
  title: z.string().optional(),
  body: z.string().optional(),
  author: z.string().optional(),
  baseRef: z.string().optional(),
  commitAuthor: z.string().optional(),
  message: z.string().optional(),
  files: z.array(fileChange).optional(),
  ci: ciSetting.optional(),
  comments: z.array(z.object({ user: z.string(), body: z.string() })).optional(),
})

const reviewBody = z.object({
  commit_id: z.string().optional(),
  event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']),
  body: z.string().optional(),
})

export function createHostApp(webhookUrls: string[]) {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '10mb' }))

  app.get('/health', (_req, res) => res.json({ status: 'ok' }))
  app.get('/metrics', metricsHandler)

  const r = express.Router({ mergeParams: true })

  r.get('/pulls', requireScope('read'), wrap(async (req, res) => res.json(await store.listPulls(req.params.owner, req.params.repo, req.query.state as string | undefined))))
  r.get('/pulls/:number', requireScope('read'), wrap(async (req, res) => res.json(await store.getPull(req.params.owner, req.params.repo, num(req)))))
  r.get('/pulls/:number/files', requireScope('read'), wrap(async (req, res) => res.json(await store.listFiles(req.params.owner, req.params.repo, num(req), req.query.ref as string | undefined))))
  r.get('/pulls/:number/commits', requireScope('read'), wrap(async (req, res) => res.json(await store.listCommits(req.params.owner, req.params.repo, num(req)))))
  r.get('/pulls/:number/comments', requireScope('read'), wrap(async (req, res) => res.json(await store.listComments(req.params.owner, req.params.repo, num(req)))))
  r.get('/pulls/:number/reviews', requireScope('read'), wrap(async (req, res) => res.json(await store.listReviews(req.params.owner, req.params.repo, num(req)))))
  r.get('/pulls/:number/merge', requireScope('read'), wrap(async (req, res) => res.json({ blockers: await store.mergeBlockers(req.params.owner, req.params.repo, num(req)) })))
  r.get('/commits/:sha/check-runs', requireScope('read'), wrap(async (req, res) => res.json(await store.listChecks(req.params.owner, req.params.repo, req.params.sha))))

  r.get(
    '/contents',
    requireScope('read'),
    wrap(async (req, res) => {
      const ref = req.query.ref as string | undefined
      const path = req.query.path as string | undefined
      if (!ref || !path) throw new HostError(422, 'REF_REQUIRED', 'Reads must name a path and a commit')
      const content = await store.readContent(req.params.owner, req.params.repo, path, ref)
      if (content === null) throw new HostError(404, 'NOT_FOUND', 'No such file at that commit')
      res.json({ path, ref, content })
    }),
  )

  r.post(
    '/pulls/:number/reviews',
    requireScope('reviews:write'),
    wrap(async (req, res) => {
      const body = reviewBody.parse(req.body)
      if (webhookControls.reviewDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, webhookControls.reviewDelayMs))
      const result = await store.postReview(req.params.owner, req.params.repo, num(req), {
        user: req.hostIdentity!,
        event: body.event,
        commitId: body.commit_id,
        body: body.body,
        idempotencyKey: req.headers['idempotency-key'] as string | undefined,
      })
      res.status(result.replayed ? 200 : 201).json(result)
    }),
  )

  r.put(
    '/pulls/:number/reviews/:reviewId/dismissals',
    requireScope('reviews:write'),
    wrap(async (req, res) => {
      await store.dismissReview(req.params.owner, req.params.repo, num(req), Number(req.params.reviewId), req.hostIdentity!, String(req.body?.message ?? ''))
      res.status(204).end()
    }),
  )

  app.use('/repos/:owner/:repo', r)

  // ── Fixture control: not part of what a real host would expose ───────────────

  const admin = express.Router({ mergeParams: true })
  admin.use(requireScope('admin'))

  admin.get('/fixtures', (_req, res) => res.json({ fixtures: FIXTURE_NAMES }))

  admin.post(
    '/repos',
    wrap(async (req, res) => {
      const { owner, name, tree } = z.object({ owner: z.string(), name: z.string(), tree: z.record(z.string()).optional() }).parse(req.body)
      await store.ensureRepo(owner, name, tree ?? {})
      res.status(201).json({ ok: true })
    }),
  )

  admin.post(
    '/repos/:owner/:repo/pulls',
    wrap(async (req, res) => {
      const body = pullSpec.parse(req.body)
      const spec = body.fixture ? { ...fixtureSpec(body.fixture), ...stripUndefined(body) } : body
      if (!spec.title || !spec.author || !spec.files) throw new HostError(422, 'INVALID_PULL', 'A pull request needs a title, an author and files')
      const result = await store.openPull(req.params.owner, req.params.repo, spec as store.PullSpec)
      res.status(201).json(result)
    }),
  )

  admin.post(
    '/repos/:owner/:repo/pulls/:number/push',
    wrap(async (req, res) => {
      const body = z.object({ author: z.string().optional(), message: z.string().optional(), files: z.array(fileChange), ci: ciSetting.optional() }).parse(req.body)
      res.status(201).json(await store.pushCommit(req.params.owner, req.params.repo, num(req), body))
    }),
  )

  admin.post(
    '/repos/:owner/:repo/pulls/:number/checks',
    wrap(async (req, res) => {
      const { ci } = z.object({ ci: ciSetting }).parse(req.body)
      res.json(await store.setChecks(req.params.owner, req.params.repo, num(req), ci))
    }),
  )

  admin.post(
    '/repos/:owner/:repo/pulls/:number/comments',
    wrap(async (req, res) => {
      const { user, body } = z.object({ user: z.string(), body: z.string() }).parse(req.body)
      res.status(201).json(await store.addComment(req.params.owner, req.params.repo, num(req), user, body))
    }),
  )

  admin.post(
    '/repos/:owner/:repo/pulls/:number/reviews',
    wrap(async (req, res) => {
      const body = z.object({ user: z.string(), event: z.enum(['APPROVE', 'REQUEST_CHANGES', 'COMMENT']), commit_id: z.string(), body: z.string().optional() }).parse(req.body)
      res.status(201).json(await store.postReview(req.params.owner, req.params.repo, num(req), { user: body.user, event: body.event, commitId: body.commit_id, body: body.body }))
    }),
  )

  admin.post(
    '/repos/:owner/:repo/pulls/:number/retarget',
    wrap(async (req, res) => {
      const { baseRef } = z.object({ baseRef: z.string() }).parse(req.body)
      await store.retargetBase(req.params.owner, req.params.repo, num(req), baseRef)
      res.json({ ok: true })
    }),
  )

  admin.post(
    '/repos/:owner/:repo/pulls/:number/close',
    wrap(async (req, res) => {
      await store.closePull(req.params.owner, req.params.repo, num(req))
      res.json({ ok: true })
    }),
  )

  admin.post(
    '/repos/:owner/:repo/pulls/:number/merge',
    wrap(async (req, res) => {
      await store.mergePull(req.params.owner, req.params.repo, num(req))
      res.json({ merged: true })
    }),
  )

  admin.get('/settings', (_req, res) => res.json(webhookControls))
  admin.patch(
    '/settings',
    wrap(async (req, res) => {
      const body = z.object({ dropNext: z.number().int().min(0), duplicateNext: z.number().int().min(0), reviewDelayMs: z.number().int().min(0).max(30_000) }).partial().parse(req.body)
      Object.assign(webhookControls, body)
      res.json(webhookControls)
    }),
  )

  admin.get(
    '/deliveries',
    wrap(async (req, res) => {
      const limit = Math.min(Number(req.query.limit ?? 50), 500)
      const rows = await pool.query(`SELECT id, event, action, status, attempts, last_status, last_error, created_at, delivered_at FROM githost.deliveries ORDER BY seq DESC LIMIT $1`, [limit])
      res.json({ deliveries: rows.rows })
    }),
  )

  admin.post(
    '/deliveries/:id/redeliver',
    wrap(async (req, res) => {
      const rows = await pool.query<DeliveryRow>(`SELECT id, event, action, payload, attempts FROM githost.deliveries WHERE id = $1`, [req.params.id])
      if (!rows.rows[0]) throw new HostError(404, 'NOT_FOUND', 'No such delivery')
      res.json(await send(webhookUrls[0], rows.rows[0]))
    }),
  )

  app.use('/admin', admin)

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } })
  })
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HostError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.details } })
      return
    }
    if (err instanceof z.ZodError) {
      res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: err.issues[0].message } })
      return
    }
    logger.error({ err }, 'host error')
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal error' } })
  })
  return app
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const { fixture: _fixture, ...rest } = obj
  return Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)) as Partial<T>
}
