/**
 * Runs the real system in one process, for the seed and for integration tests. The
 * host store, the webhook receiver (signatures included), the pipeline, the gate
 * and the poster are the same code the live stack runs. Only HTTP is replaced, and
 * the mock model is called directly, so its latency is computed rather than slept.
 * @module db/materialize
 */
import { processDelivery } from '../api/services/deliveries.js'
import * as store from '../githost/store.js'
import { HostError } from '../githost/store.js'
import { buildRequest, type DeliveryRow } from '../githost/webhooks.js'
import { createInProcessCaller } from '../model/in-process.js'
import { defaultSettings, type MockSettings } from '../model/settings.js'
import { claimNextIntent, processIntent, type PosterDeps } from '../poster/post.js'
import { config } from '../shared/config.js'
import { pool } from '../shared/db.js'
import { HostUnavailable, type HostReader, type HostWriter } from '../shared/host-types.js'
import type { ModelCaller } from '../shared/model-types.js'
import { executeRun, type PipelineDeps, type RunEnd } from '../worker/pipeline.js'
import { claimNextRun } from '../worker/runs.js'

const split = (fullName: string) => fullName.split('/') as [string, string]

export const inProcessReader: HostReader = {
  getPull: (f, n) => store.getPull(...split(f), n),
  listOpenPulls: (f) => store.listPulls(...split(f), 'open'),
  listReviews: (f, n) => store.listReviews(...split(f), n),
  mergeBlockers: (f, n) => store.mergeBlockers(...split(f), n),
  readFile: (f, path, sha) => store.readContent(...split(f), path, sha),
  async getSnapshot(f, n) {
    const [owner, name] = split(f)
    const pull = await store.getPull(owner, name, n)
    const page = await store.listFiles(owner, name, n, pull.head.sha)
    return {
      pull,
      files: page.files,
      filesTruncated: page.truncated,
      commits: await store.listCommits(owner, name, n),
      comments: await store.listComments(owner, name, n),
      reviews: await store.listReviews(owner, name, n),
      checks: await store.listChecks(owner, name, pull.head.sha),
    }
  },
}

export const inProcessWriter: HostWriter = {
  async postReview(f, n, args) {
    try {
      const r = await store.postReview(...split(f), n, { user: config.botLogin, event: args.event, commitId: args.commitId, body: args.body, idempotencyKey: args.idempotencyKey })
      return { ok: true, review: { id: r.id, commit_id: r.commit_id, state: r.state as 'APPROVED', replayed: r.replayed } }
    } catch (err) {
      if (err instanceof HostError) {
        if (err.code === 'STALE_COMMIT') return { ok: false, code: 'STALE_COMMIT', currentHead: String(err.details?.current_head ?? '') }
        if (err.code === 'PR_NOT_OPEN' || err.code === 'SELF_REVIEW') return { ok: false, code: err.code, message: err.message }
        throw new HostUnavailable(err.message, err.status)
      }
      throw err
    }
  },
  dismissReview: (f, n, id, message) => store.dismissReview(...split(f), n, id, config.botLogin, message),
}

export class World {
  readonly settings: MockSettings
  readonly caller: ModelCaller
  readonly runEnds: RunEnd[] = []
  reader: HostReader = inProcessReader
  writer: HostWriter = inProcessWriter

  constructor(settings: Partial<MockSettings> = {}) {
    this.settings = { ...defaultSettings(), ...settings, chaos: { ...defaultSettings().chaos, ...settings.chaos } }
    this.caller = createInProcessCaller(this.settings)
  }

  get pipeline(): PipelineDeps {
    return { reader: this.reader, caller: this.caller, actor: 'worker' }
  }

  get poster(): PosterDeps {
    return { reader: this.reader, writer: this.writer, actor: 'poster' }
  }

  /** Delivers the host's outbox through the real receiver, signature checks included. */
  async drainWebhooks(): Promise<number> {
    let n = 0
    for (;;) {
      const res = await pool.query<DeliveryRow>(`SELECT id, event, action, payload, attempts FROM githost.deliveries WHERE status = 'pending' ORDER BY seq LIMIT 50`)
      if (res.rows.length === 0) return n
      for (const row of res.rows) {
        const req = buildRequest(row)
        const out = await processDelivery({ deliveryId: row.id, event: row.event, signature: req.headers['X-Hook-Signature'], rawBody: req.body })
        if (out.status !== 200) throw new Error(`Delivery ${row.id} was refused: ${JSON.stringify(out.body)}`)
        await pool.query(`UPDATE githost.deliveries SET status = 'delivered', delivered_at = now(), attempts = attempts + 1, last_status = 200 WHERE id = $1`, [row.id])
        n++
      }
    }
  }

  async drainRuns(): Promise<number> {
    let n = 0
    for (;;) {
      const run = await claimNextRun('seed')
      if (!run) return n
      this.runEnds.push(await executeRun(this.pipeline, run, new AbortController().signal))
      n++
    }
  }

  async drainIntents(): Promise<number> {
    let n = 0
    for (;;) {
      const intent = await claimNextIntent('seed')
      if (!intent) return n
      await processIntent(this.poster, intent)
      n++
    }
  }

  /** Runs everything until the whole system is quiet. */
  async settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
      const moved = (await this.drainWebhooks()) + (await this.drainRuns()) + (await this.drainIntents())
      if (moved === 0) return
    }
    throw new Error('The system did not settle')
  }
}

export async function resetAll(): Promise<void> {
  await pool.query(`
    TRUNCATE githost.repos, githost.pull_requests, githost.commits, githost.checks, githost.reviews, githost.comments, githost.deliveries,
             evaluation_cases, evaluations, audit_log, audit_chains, escalations, post_intents, decisions, review_runs, webhook_deliveries,
             pull_requests, mode_changes, repositories, users, orgs CASCADE
  `)
}
