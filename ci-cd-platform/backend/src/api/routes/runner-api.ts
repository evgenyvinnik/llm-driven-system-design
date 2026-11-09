/**
 * The API runners speak. Runners have no database access: this is the boundary, so
 * every write can be checked against the job's fencing token, and a compromised runner
 * can reach only the job it holds. Registration uses a shared token; after that a runner
 * has its own bearer token, stored hashed and rotated every time it registers.
 *
 * The claim response is the one place a secret value leaves the control plane.
 * @module api/routes/runner-api
 */
import { createHash, randomBytes } from 'node:crypto'
import express, { Router, type NextFunction, type Request, type Response } from 'express'
import { z } from 'zod'
import { config } from '../../shared/config.js'
import { sha256Hex } from '../../shared/crypto.js'
import { pool } from '../../shared/db.js'
import { asyncHandler, HttpError, notFound } from '../../shared/errors.js'
import { newId } from '../../shared/ids.js'
import { artifactKey, getBlob, putBlob } from '../../shared/storage.js'
import { getCommit } from '../../fixtures/store.js'
import { ingestChunks, validateChunks } from '../../logs/ingest.js'
import { claimJob, type RunnerIdentity } from '../../scheduling/claim.js'
import { completeAttempt, runIdOf } from '../../scheduling/engine.js'
import { assertFence, finishStep, heartbeat, startStep, type Fence } from '../../scheduling/runner-ops.js'

export const runnerRouter = Router()

declare global {
  namespace Express {
    interface Request {
      runner?: RunnerIdentity
    }
  }
}

const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')

const registerSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
    labels: z.array(z.string().regex(/^[A-Za-z0-9._-]{1,32}$/)).min(1).max(16),
    slots: z.number().int().min(1).max(16).default(1),
    pid: z.number().int().optional(),
  })
  .strict()

runnerRouter.post(
  '/register',
  express.json({ limit: '32kb' }),
  asyncHandler(async (req, res) => {
    if (req.get('Authorization') !== `Bearer ${config.runnerRegistrationToken}`) throw new HttpError(401, 'BAD_REGISTRATION_TOKEN', 'Registration token is missing or wrong')
    const body = registerSchema.parse(req.body)
    const token = randomBytes(32).toString('base64url')
    const { rows } = await pool.query<{ id: string; incarnation: number }>(
      `INSERT INTO runners (id, name, labels, slots, token_hash, pid) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (name) DO UPDATE SET labels = EXCLUDED.labels, slots = EXCLUDED.slots, token_hash = EXCLUDED.token_hash, pid = EXCLUDED.pid,
              incarnation = runners.incarnation + 1, kill_requested = false, registered_at = now(), last_seen_at = now()
       RETURNING id, incarnation`,
      [newId('rnr'), body.name, body.labels, body.slots, tokenHash(token), body.pid ?? null],
    )
    res.status(201).json({ runnerId: rows[0].id, incarnation: rows[0].incarnation, token, leaseMs: config.lease.ms, heartbeatMs: config.lease.heartbeatMs })
  }),
)

async function requireRunner(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.get('Authorization') ?? ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!token) return next(new HttpError(401, 'UNAUTHENTICATED', 'Runner token required'))
  try {
    const { rows } = await pool.query<{ id: string; name: string; labels: string[] }>('SELECT id, name, labels FROM runners WHERE token_hash = $1', [tokenHash(token)])
    if (!rows[0]) return next(new HttpError(401, 'UNAUTHENTICATED', 'Unknown runner token; register again'))
    req.runner = rows[0]
    next()
  } catch (err) {
    next(err)
  }
}

runnerRouter.use(requireRunner)

const me = (req: Request): RunnerIdentity => req.runner as RunnerIdentity
const json = express.json({ limit: '2mb' })
const fenceFields = { attempt: z.number().int().positive(), fencingToken: z.number().int().positive() }
const fenceOf = (req: Request, body: { attempt: number; fencingToken: number }): Fence => ({ jobId: req.params.jobId, attempt: body.attempt, fencingToken: body.fencingToken, runnerId: me(req).id })

runnerRouter.post(
  '/claim',
  asyncHandler(async (req, res) => {
    await pool.query('UPDATE runners SET last_seen_at = now() WHERE id = $1', [me(req).id])
    const job = await claimJob(me(req))
    if (!job) return res.status(204).end()
    return res.json({ job })
  }),
)

const heartbeatSchema = z.object({ jobs: z.array(z.object({ jobId: z.string(), attempt: z.number().int(), fencingToken: z.number().int() })).max(32) }).strict()

runnerRouter.post(
  '/heartbeat',
  json,
  asyncHandler(async (req, res) => {
    const body = heartbeatSchema.parse(req.body)
    res.json(await heartbeat(me(req).id, body.jobs))
  }),
)

const stepStartSchema = z.object(fenceFields).strict()
const stepFinishSchema = z.object({ ...fenceFields, status: z.enum(['success', 'failure', 'timed_out', 'killed']), exitCode: z.number().int().nullable() }).strict()

runnerRouter.post(
  '/jobs/:jobId/steps/:index/start',
  json,
  asyncHandler(async (req, res) => {
    const body = stepStartSchema.parse(req.body)
    await startStep(fenceOf(req, body), z.coerce.number().int().min(0).parse(req.params.index))
    res.json({ ok: true })
  }),
)

runnerRouter.post(
  '/jobs/:jobId/steps/:index/finish',
  json,
  asyncHandler(async (req, res) => {
    const body = stepFinishSchema.parse(req.body)
    await finishStep(fenceOf(req, body), z.coerce.number().int().min(0).parse(req.params.index), body.status, body.exitCode)
    res.json({ ok: true })
  }),
)

const logsSchema = z.object({ ...fenceFields, chunks: z.array(z.object({ seq: z.number().int().positive(), stepIndex: z.number().int().min(0), text: z.string() }).strict()).min(1).max(100) }).strict()

runnerRouter.post(
  '/jobs/:jobId/logs',
  json,
  asyncHandler(async (req, res) => {
    const body = logsSchema.parse(req.body)
    validateChunks(body.chunks, config.logs.maxChunkBytes)
    res.json(await ingestChunks(fenceOf(req, body), body.chunks))
  }),
)

const completeSchema = z.object({ ...fenceFields, conclusion: z.enum(['success', 'failure', 'cancelled']), reason: z.string().max(1000).nullable().optional() }).strict()

runnerRouter.post(
  '/jobs/:jobId/complete',
  json,
  asyncHandler(async (req, res) => {
    const body = completeSchema.parse(req.body)
    res.json(await completeAttempt(req.params.jobId, body.attempt, body.fencingToken, { conclusion: body.conclusion, reason: body.reason ?? null }))
  }),
)

function fenceFromHeaders(req: Request): Fence {
  const attempt = Number(req.get('X-Attempt'))
  const fencingToken = Number(req.get('X-Fencing-Token'))
  if (!Number.isInteger(attempt) || !Number.isInteger(fencingToken)) throw new HttpError(400, 'MISSING_FENCE', 'X-Attempt and X-Fencing-Token are required')
  return { jobId: req.params.jobId, attempt, fencingToken, runnerId: me(req).id }
}

/** The file tree at the run's pinned commit. Not the branch head: re-runs are repeatable because of this. */
runnerRouter.get(
  '/jobs/:jobId/checkout',
  asyncHandler(async (req, res) => {
    await assertFence(pool, fenceFromHeaders(req), 'checkout')
    const { rows } = await pool.query<{ repo_id: string; commit_sha: string }>('SELECT repo_id, commit_sha FROM workflow_runs WHERE id = $1', [await runIdOf(pool, req.params.jobId)])
    const commit = await getCommit(pool, rows[0].repo_id, rows[0].commit_sha)
    if (!commit) throw notFound('Commit')
    res.json({ sha: commit.sha, tree: commit.tree })
  }),
)

const ARTIFACT_NAME = z.string().regex(/^[A-Za-z0-9._-]{1,100}$/)

runnerRouter.put(
  '/jobs/:jobId/artifacts/:name',
  express.raw({ type: '*/*', limit: config.artifacts.maxBytes }),
  asyncHandler(async (req, res) => {
    const fence = fenceFromHeaders(req)
    await assertFence(pool, fence, 'artifact')
    const name = ARTIFACT_NAME.parse(req.params.name)
    const retention = z.coerce.number().int().min(1).max(365).default(config.artifacts.defaultRetentionDays).parse(req.query.retentionDays)
    const { rows } = await pool.query<{ repo_id: string; run_id: string; job_key: string }>('SELECT repo_id, run_id, job_key FROM jobs WHERE id = $1', [fence.jobId])
    const job = rows[0]
    const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)
    const key = artifactKey(job.repo_id, job.run_id, fence.jobId, fence.attempt, name)
    await putBlob(key, bytes, 'application/octet-stream')
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO artifacts (id, repo_id, run_id, job_id, job_key, attempt, name, object_key, size_bytes, sha256, retention_days, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(days => $11))
       ON CONFLICT (job_id, attempt, name) DO UPDATE SET size_bytes = EXCLUDED.size_bytes, sha256 = EXCLUDED.sha256
       RETURNING id`,
      [newId('art'), job.repo_id, job.run_id, fence.jobId, job.job_key, fence.attempt, name, key, bytes.length, sha256Hex(bytes), retention],
    )
    res.status(201).json({ id: inserted.rows[0].id, sizeBytes: bytes.length })
  }),
)

/** Artifacts this job may read: from the current attempt of each job in its `needs`, and nothing else. */
async function visibleArtifacts(jobId: string): Promise<{ id: string; name: string; job_key: string; object_key: string; size_bytes: number; sha256: string }[]> {
  const { rows } = await pool.query<{ id: string; name: string; job_key: string; object_key: string; size_bytes: number; sha256: string }>(
    `SELECT a.id, a.name, a.job_key, a.object_key, a.size_bytes, a.sha256
       FROM jobs me
       JOIN jobs dep ON dep.run_id = me.run_id AND dep.job_key = ANY(me.needs)
       JOIN artifacts a ON a.job_id = dep.id AND a.attempt = dep.attempt
      WHERE me.id = $1 AND a.deleted_at IS NULL ORDER BY a.job_key, a.name`,
    [jobId],
  )
  return rows
}

runnerRouter.get(
  '/jobs/:jobId/needs-artifacts',
  asyncHandler(async (req, res) => {
    await assertFence(pool, fenceFromHeaders(req), 'artifact_list')
    const list = await visibleArtifacts(req.params.jobId)
    res.json({ artifacts: list.map((a) => ({ id: a.id, name: a.name, jobKey: a.job_key, sizeBytes: a.size_bytes, sha256: a.sha256 })) })
  }),
)

runnerRouter.get(
  '/jobs/:jobId/needs-artifacts/:artifactId',
  asyncHandler(async (req, res) => {
    await assertFence(pool, fenceFromHeaders(req), 'artifact_read')
    const artifact = (await visibleArtifacts(req.params.jobId)).find((a) => a.id === req.params.artifactId)
    if (!artifact) throw new HttpError(403, 'ARTIFACT_NOT_IN_NEEDS', 'This job does not need the job that produced this artifact')
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('X-Content-SHA256', artifact.sha256)
    res.end(await getBlob(artifact.object_key))
  }),
)
