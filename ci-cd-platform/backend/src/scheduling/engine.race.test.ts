/**
 * The hard guarantees against a real PostgreSQL, where the races actually exist: the fan-in
 * race, exact per-repository limits, fairness, the step-start versus lease-expiry race, fencing,
 * the fork path through the claim, attempt numbering, concurrent duplicate deliveries, and log
 * assembly. Runs only when TEST_DATABASE_URL points at a migrated database, e.g.
 *   TEST_DATABASE_URL=postgresql://cicd:cicd_password@localhost:5432/ci_cd_platform npm test
 * Uses its own repositories; it doesn't touch seeded data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const url = process.env.TEST_DATABASE_URL

describe.skipIf(!url)('engine (PostgreSQL)', () => {
  let db: typeof import('../shared/db.js')
  let engine: typeof import('./engine.js')
  let claim: typeof import('./claim.js')
  let ops: typeof import('./runner-ops.js')
  let intake: typeof import('../intake/events.js')
  let ingest: typeof import('../logs/ingest.js')
  let read: typeof import('../logs/read.js')
  let store: typeof import('../secrets/store.js')
  let crypto: typeof import('../shared/crypto.js')

  const tag = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
  const orgId = `org_${tag}`
  const runner1 = { id: `rnr_${tag}_1`, name: `race-1-${tag}`, labels: [`lbl-${tag}`] }
  const runner2 = { id: `rnr_${tag}_2`, name: `race-2-${tag}`, labels: [`lbl-${tag}`] }
  let repoSeq = 0
  let commitSeq = 0

  async function makeRepo(limit = 8): Promise<{ id: string; fullName: string }> {
    const id = `repo_${tag}_${++repoSeq}`
    const fullName = `${tag}/repo-${repoSeq}`
    await db.pool.query(`INSERT INTO repositories (id, org_id, full_name, webhook_secret_enc, max_concurrent_jobs) VALUES ($1, $2, $3, 'x', $4)`, [id, orgId, fullName, limit])
    return { id, fullName }
  }

  const stepYaml = (name: string, idempotent = true) => `{ name: ${name}, run: "echo ${name}", idempotent: ${idempotent} }`

  /** Commits a workflow to the fixture store and delivers a push for it. Returns the run id. */
  async function pushWorkflow(repo: { id: string; fullName: string }, jobsYaml: string, opts: { fork?: boolean; deliveryId?: string; branch?: string } = {}) {
    const sha = `sha${tag}${String(++commitSeq).padStart(8, '0')}`.padEnd(40, 'f')
    const workflow = `on: [push, pull_request]\njobs:\n${jobsYaml}`
    const branch = opts.branch ?? 'main'
    await db.pool.query(`INSERT INTO fixture_commits (repo_id, sha, branch, message, author, scenario, tree) VALUES ($1, $2, $3, 'm', 'a', 'race', $4)`, [repo.id, sha, branch, JSON.stringify({ '.ci/workflow.yml': workflow })])
    const payload = opts.fork
      ? { action: 'opened', repository: { full_name: repo.fullName }, sender: { login: 'mallory' }, pull_request: { number: 9, head: { sha, ref: 'main', repo: { full_name: 'mallory/x', fork: true } }, base: { ref: 'main' } } }
      : { ref: `refs/heads/${branch}`, after: sha, repository: { full_name: repo.fullName }, sender: { login: 'alice' } }
    const delivery = await intake.handleDelivery({
      repoId: repo.id,
      repoFullName: repo.fullName,
      deliveryId: opts.deliveryId ?? `d-${sha}`,
      eventType: opts.fork ? 'pull_request' : 'push',
      payload,
      rawBody: Buffer.from(JSON.stringify(payload)),
    })
    return delivery.runId as string
  }

  const label = `lbl-${tag}`
  const job = (name: string, needs: string[] = [], steps: string[] = [stepYaml('s')], extra = '') => `  ${name}: { runs-on: [${label}], needs: [${needs.join(', ')}], steps: [${steps.join(', ')}]${extra} }\n`

  async function claimFor(runId: string, key: string, runner = runner1) {
    const { rows } = await db.pool.query<{ id: string }>('SELECT id FROM jobs WHERE run_id = $1 AND job_key = $2', [runId, key])
    const claimed = await claim.claimJob(runner, { onlyJobId: rows[0].id })
    if (!claimed) throw new Error(`could not claim ${key}`)
    return claimed
  }

  const jobRow = async (runId: string, key: string) => (await db.pool.query<{ id: string; status: string; attempt: number; status_reason: string | null; fencing_token: number | null }>('SELECT id, status, attempt, status_reason, fencing_token FROM jobs WHERE run_id = $1 AND job_key = $2', [runId, key])).rows[0]
  const runStatus = async (runId: string) => (await db.pool.query<{ status: string }>('SELECT status FROM workflow_runs WHERE id = $1', [runId])).rows[0].status
  const expireNow = (jobId: string) => db.pool.query(`UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1`, [jobId])
  const fenceOf = (c: { jobId: string; attempt: number; fencingToken: number }, runner = runner1) => ({ jobId: c.jobId, attempt: c.attempt, fencingToken: c.fencingToken, runnerId: runner.id })

  async function succeed(runId: string, key: string, runner = runner1) {
    const c = await claimFor(runId, key, runner)
    await engine.completeAttempt(c.jobId, c.attempt, c.fencingToken, { conclusion: 'success' })
    return c
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url
    db = await import('../shared/db.js')
    engine = await import('./engine.js')
    claim = await import('./claim.js')
    ops = await import('./runner-ops.js')
    intake = await import('../intake/events.js')
    ingest = await import('../logs/ingest.js')
    read = await import('../logs/read.js')
    store = await import('../secrets/store.js')
    crypto = await import('../shared/crypto.js')
    await db.pool.query('INSERT INTO orgs (id, name) VALUES ($1, $1)', [orgId])
    for (const r of [runner1, runner2]) await db.pool.query(`INSERT INTO runners (id, name, labels, token_hash) VALUES ($1, $2, $3, $1)`, [r.id, r.name, r.labels])
  })

  afterAll(async () => {
    await db.pool.query('DELETE FROM orgs WHERE id = $1', [orgId])
    await db.pool.query('DELETE FROM runners WHERE id = ANY($1::text[])', [[runner1.id, runner2.id]])
    await db.pool.end()
    ;(await import('../shared/cache.js')).redis.disconnect()
  })

  it('fan-in: prerequisites finishing at the same instant enqueue the dependent exactly once, every time', async () => {
    const repo = await makeRepo(16)
    for (let round = 0; round < 25; round++) {
      const runId = await pushWorkflow(repo, job('a') + job('b') + job('c') + job('d', ['a', 'b', 'c']))
      const claims = [await claimFor(runId, 'a'), await claimFor(runId, 'b'), await claimFor(runId, 'c')]
      await Promise.all(claims.map((c) => engine.completeAttempt(c.jobId, c.attempt, c.fencingToken, { conclusion: 'success' })))
      const d = await jobRow(runId, 'd')
      expect(d.status, `round ${round}: dependent must not be missed`).toBe('queued')
      const queued = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM job_transitions WHERE job_id = $1 AND to_status = 'queued'`, [d.id])
      expect(queued.rows[0].n, `round ${round}: dependent must not be enqueued twice`).toBe(1)
    }
  })

  it('fan-in: a success and a failure at the same instant skip the dependent, once', async () => {
    const repo = await makeRepo(16)
    for (let round = 0; round < 15; round++) {
      const runId = await pushWorkflow(repo, job('a') + job('b') + job('d', ['a', 'b']) + job('e', ['d']))
      const a = await claimFor(runId, 'a')
      const b = await claimFor(runId, 'b')
      await Promise.all([engine.completeAttempt(a.jobId, a.attempt, a.fencingToken, { conclusion: 'success' }), engine.completeAttempt(b.jobId, b.attempt, b.fencingToken, { conclusion: 'failure', reason: 'boom' })])
      const d = await jobRow(runId, 'd')
      expect(d.status).toBe('skipped')
      expect(d.status_reason).toContain('"b"')
      expect((await jobRow(runId, 'e')).status).toBe('skipped')
      const skips = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM job_transitions WHERE job_id = $1 AND to_status = 'skipped'`, [d.id])
      expect(skips.rows[0].n).toBe(1)
      expect(await runStatus(runId)).toBe('failure')
    }
  })

  it('a job with no prerequisites is queued by intake; a failure leaves an unrelated branch running', async () => {
    const repo = await makeRepo()
    const runId = await pushWorkflow(repo, job('a') + job('b') + job('c', ['a']))
    expect((await jobRow(runId, 'a')).status).toBe('queued')
    expect((await jobRow(runId, 'c')).status).toBe('blocked')
    const a = await claimFor(runId, 'a')
    await engine.completeAttempt(a.jobId, a.attempt, a.fencingToken, { conclusion: 'failure' })
    expect((await jobRow(runId, 'b')).status).toBe('queued')
    expect((await jobRow(runId, 'c')).status).toBe('skipped')
    expect(await runStatus(runId)).toBe('running')
  })

  it('the per-repository limit is exact under concurrent claims', async () => {
    const repo = await makeRepo(2)
    const runId = await pushWorkflow(repo, ['a', 'b', 'c', 'd', 'e', 'f'].map((k) => job(k)).join(''))
    const results = await Promise.all(Array.from({ length: 12 }, () => claim.claimJob(runner1)))
    const mine = results.filter((r) => r?.runId === runId)
    expect(mine.length).toBe(2)
    const running = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM jobs WHERE repo_id = $1 AND status = 'running'`, [repo.id])
    expect(running.rows[0].n).toBe(2)
    await db.pool.query(`UPDATE jobs SET status = 'cancelled' WHERE run_id = $1`, [runId])
  })

  it('concurrent claims never hand one job to two runners', async () => {
    const repo = await makeRepo(30)
    const runId = await pushWorkflow(repo, Array.from({ length: 20 }, (_, i) => job(`j${i}`)).join(''))
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => claim.claimJob(i % 2 ? runner1 : runner2)))
    const mine = results.filter((r) => r?.runId === runId).map((r) => r?.jobId)
    expect(new Set(mine).size).toBe(mine.length)
    expect(mine.length).toBe(20)
    await db.pool.query(`UPDATE jobs SET status = 'cancelled' WHERE run_id = $1`, [runId])
  })

  it('a burst on one repository does not starve another: claims alternate', async () => {
    const big = await makeRepo(50)
    const small = await makeRepo(50)
    const label2 = `fair-${tag}`
    const fair = { id: runner1.id, name: runner1.name, labels: [label2] }
    const j = (k: string) => `  ${k}: { runs-on: [${label2}], steps: [${stepYaml('s')}] }\n`
    const bigRun = await pushWorkflow(big, Array.from({ length: 10 }, (_, i) => j(`b${i}`)).join(''))
    const smallRun = await pushWorkflow(small, j('s1') + j('s2'))
    const order: string[] = []
    for (let i = 0; i < 12; i++) {
      const c = await claim.claimJob(fair)
      if (c) order.push(c.runId === smallRun ? 'small' : 'big')
    }
    expect(order.slice(0, 4).filter((o) => o === 'small').length).toBe(2)
    expect(order.length).toBe(12)
    await db.pool.query(`UPDATE jobs SET status = 'cancelled' WHERE run_id = ANY($1::text[])`, [[bigRun, smallRun]])
  })

  it('claims only what the labels allow', async () => {
    const repo = await makeRepo()
    const runId = await pushWorkflow(repo, `  gpu: { runs-on: [${label}, gpu-${tag}], steps: [${stepYaml('s')}] }\n`)
    const none = await claim.claimJob(runner1, { onlyJobId: (await jobRow(runId, 'gpu')).id })
    expect(none).toBeNull()
    const yes = await claim.claimJob({ ...runner2, labels: [label, `gpu-${tag}`, 'extra'] }, { onlyJobId: (await jobRow(runId, 'gpu')).id })
    expect(yes?.jobKey).toBe('gpu')
    await engine.completeAttempt(yes!.jobId, yes!.attempt, yes!.fencingToken, { conclusion: 'success' })
  })

  describe('lease expiry', () => {
    it('re-queues when only idempotent steps started; the stale runner is fenced out of everything', async () => {
      const repo = await makeRepo()
      const runId = await pushWorkflow(repo, job('a', [], [stepYaml('one'), stepYaml('two')]) + job('b', ['a']))
      const stale = await claimFor(runId, 'a')
      await ops.startStep(fenceOf(stale), 0)
      await expireNow(stale.jobId)
      expect(await engine.expireLease(stale.jobId)).toBe('requeue')
      const after = await jobRow(runId, 'a')
      expect(after.status).toBe('queued')
      expect(after.attempt).toBe(2)

      const fresh = await claimFor(runId, 'a', runner2)
      expect(fresh.attempt).toBe(2)
      expect(fresh.fencingToken).toBeGreaterThan(stale.fencingToken)

      // Everything the stale runner tries now is rejected.
      await expect(ops.startStep(fenceOf(stale), 1)).rejects.toMatchObject({ code: 'LEASE_LOST' })
      await expect(ops.finishStep(fenceOf(stale), 0, 'success', 0)).rejects.toMatchObject({ code: 'LEASE_LOST' })
      await expect(ingest.ingestChunks(fenceOf(stale), [{ seq: 99, stepIndex: 0, text: 'stale\n' }])).rejects.toMatchObject({ code: 'LEASE_LOST' })
      await expect(engine.completeAttempt(stale.jobId, stale.attempt, stale.fencingToken, { conclusion: 'success' })).rejects.toMatchObject({ code: 'LEASE_LOST' })
      const hb = await ops.heartbeat(runner1.id, [{ jobId: stale.jobId, attempt: stale.attempt, fencingToken: stale.fencingToken }])
      expect(hb.jobs[0].ok).toBe(false)

      // The stale attempt's log is closed with a note, and the new attempt is untouched.
      const log = await read.readLines(stale.jobId, 1, 0)
      expect(log.complete).toBe(true)
      expect(log.lines.at(-1)?.text).toContain('Lease expired')
      expect((await jobRow(runId, 'a')).status).toBe('running')

      await engine.completeAttempt(fresh.jobId, fresh.attempt, fresh.fencingToken, { conclusion: 'success' })
      expect((await jobRow(runId, 'b')).status).toBe('queued')
    })

    it('a runner holding another job cannot write to this one by guessing its token', async () => {
      const repo = await makeRepo()
      const runId = await pushWorkflow(repo, job('a'))
      const c = await claimFor(runId, 'a', runner1)
      await expect(ops.startStep(fenceOf(c, runner2), 0)).rejects.toMatchObject({ code: 'LEASE_LOST' })
      await expect(ops.assertFence(db.pool, fenceOf(c, runner2), 'test')).rejects.toMatchObject({ code: 'LEASE_LOST' })
      await expect(ingest.ingestChunks(fenceOf(c, runner2), [{ seq: 1, stepIndex: 0, text: 'x\n' }])).rejects.toMatchObject({ code: 'LEASE_LOST' })
      await engine.completeAttempt(c.jobId, c.attempt, c.fencingToken, { conclusion: 'success' })
    })

    it('goes to needs_attention when a non-idempotent step started, never retries, and keeps a late report as evidence', async () => {
      const repo = await makeRepo()
      const runId = await pushWorkflow(repo, job('deploy', [], [stepYaml('prep'), stepYaml('Deploy', false)]) + job('smoke', ['deploy']))
      const c = await claimFor(runId, 'deploy')
      await ops.startStep(fenceOf(c), 0)
      await ops.finishStep(fenceOf(c), 0, 'success', 0)
      await ops.startStep(fenceOf(c), 1)
      await expireNow(c.jobId)
      expect(await engine.expireLease(c.jobId)).toBe('needs_attention')
      const row = await jobRow(runId, 'deploy')
      expect(row.status).toBe('needs_attention')
      expect(row.attempt).toBe(1)
      expect(row.status_reason).toContain('may have succeeded')
      expect((await jobRow(runId, 'smoke')).status).toBe('blocked')
      expect(await runStatus(runId)).toBe('needs_attention')

      // Nothing can claim it, however long it waits.
      expect(await claim.claimJob(runner1, { onlyJobId: c.jobId })).toBeNull()

      // The stale runner finally reports: rejected, but kept.
      await expect(engine.completeAttempt(c.jobId, c.attempt, c.fencingToken, { conclusion: 'success', reason: 'deploy exited 0' })).rejects.toMatchObject({ code: 'LEASE_LOST' })
      const attempt = await db.pool.query<{ late_report: { conclusion: string }; status: string }>('SELECT late_report, status FROM job_attempts WHERE job_id = $1 AND attempt = 1', [c.jobId])
      expect(attempt.rows[0].late_report.conclusion).toBe('success')
      expect(attempt.rows[0].status).toBe('needs_attention')

      // A generic re-run can't paper over it.
      await expect(engine.rerun({ runId, mode: 'all', actor: 'alice', confirmNonIdempotent: true })).rejects.toMatchObject({ code: 'ATTENTION_UNRESOLVED' })
      await expect(engine.rerun({ runId, mode: 'job', jobKey: 'deploy', actor: 'alice', confirmNonIdempotent: true })).rejects.toMatchObject({ code: 'ATTENTION_UNRESOLVED' })

      // A person says it landed: downstream continues.
      await engine.resolveAttention({ jobId: c.jobId, decision: 'succeeded', note: 'checked', actor: 'alice', confirmRetry: false })
      expect((await jobRow(runId, 'deploy')).status).toBe('success')
      expect((await jobRow(runId, 'smoke')).status).toBe('queued')
    })

    it('resolving as failed skips downstream; retry needs confirmation and makes a new attempt', async () => {
      const repo = await makeRepo()
      const failedRun = await pushWorkflow(repo, job('deploy', [], [stepYaml('Deploy', false)]) + job('smoke', ['deploy']))
      const c1 = await claimFor(failedRun, 'deploy')
      await ops.startStep(fenceOf(c1), 0)
      await expireNow(c1.jobId)
      await engine.expireLease(c1.jobId)
      await engine.resolveAttention({ jobId: c1.jobId, decision: 'failed', note: null, actor: 'alice', confirmRetry: false })
      expect((await jobRow(failedRun, 'smoke')).status).toBe('skipped')

      const retryRun = await pushWorkflow(repo, job('deploy', [], [stepYaml('Deploy', false)]) + job('smoke', ['deploy']))
      const c2 = await claimFor(retryRun, 'deploy')
      await ops.startStep(fenceOf(c2), 0)
      await expireNow(c2.jobId)
      await engine.expireLease(c2.jobId)
      await expect(engine.resolveAttention({ jobId: c2.jobId, decision: 'retry', note: null, actor: 'alice', confirmRetry: false })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' })
      const retried = await engine.resolveAttention({ jobId: c2.jobId, decision: 'retry', note: 'rolled back by hand', actor: 'alice', confirmRetry: true })
      expect(retried).toEqual({ status: 'queued', attempt: 2 })
    })

    it('stops at the retry budget for a job that keeps losing its runner', async () => {
      const repo = await makeRepo()
      const runId = await pushWorkflow(repo, job('poison', [], [stepYaml('s')]))
      const decisions: (string | null)[] = []
      for (let i = 0; i < 3; i++) {
        const c = await claimFor(runId, 'poison')
        await ops.startStep(fenceOf(c), 0)
        await expireNow(c.jobId)
        decisions.push(await engine.expireLease(c.jobId))
      }
      expect(decisions).toEqual(['requeue', 'requeue', 'fail'])
      expect((await jobRow(runId, 'poison')).status).toBe('failure')
    })

    it('a renewed lease is not expired by a sweep that read it earlier', async () => {
      const repo = await makeRepo()
      const runId = await pushWorkflow(repo, job('a'))
      const c = await claimFor(runId, 'a')
      expect(await engine.expireLease(c.jobId)).toBeNull()
      expect((await jobRow(runId, 'a')).status).toBe('running')
      await engine.completeAttempt(c.jobId, c.attempt, c.fencingToken, { conclusion: 'success' })
    })

    it('the step-start intent and lease expiry cannot miss each other', async () => {
      const repo = await makeRepo(30)
      for (let round = 0; round < 30; round++) {
        const runId = await pushWorkflow(repo, job('d', [], [stepYaml('Deploy', false)]))
        const c = await claimFor(runId, 'd')
        await expireNow(c.jobId)
        const [start, expiry] = await Promise.allSettled([ops.startStep(fenceOf(c), 0), engine.expireLease(c.jobId)])
        const startedOk = start.status === 'fulfilled'
        const decision = expiry.status === 'fulfilled' ? expiry.value : 'error'
        if (startedOk && decision === null) {
          // The start renewed the lease first, so the sweep correctly backed off.
          expect((await jobRow(runId, 'd')).status).toBe('running')
          continue
        }
        // Whichever got the row first, the outcome has to be consistent with it.
        if (startedOk) {
          expect(decision).toBe('needs_attention')
        } else {
          expect(decision).toBe('requeue')
          // A rejected start means the process was never spawned: re-queueing is safe.
          const step = await db.pool.query<{ started_at: Date | null }>('SELECT started_at FROM step_executions WHERE job_id = $1 AND attempt = 1', [c.jobId])
          expect(step.rows[0].started_at).toBeNull()
        }
      }
    })
  })

  describe('completion', () => {
    it('a retried completion after a lost response gets the same answer and changes nothing', async () => {
      const repo = await makeRepo()
      const runId = await pushWorkflow(repo, job('a') + job('b', ['a']))
      const c = await claimFor(runId, 'a')
      const first = await engine.completeAttempt(c.jobId, c.attempt, c.fencingToken, { conclusion: 'success' })
      const again = await engine.completeAttempt(c.jobId, c.attempt, c.fencingToken, { conclusion: 'success' })
      expect(first).toEqual({ status: 'success', replay: false })
      expect(again).toEqual({ status: 'success', replay: true })
      const queued = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM job_transitions t JOIN jobs j ON j.id = t.job_id WHERE j.run_id = $1 AND j.job_key = 'b' AND t.to_status = 'queued'`, [runId])
      expect(queued.rows[0].n).toBe(1)
    })

    it('a killed non-idempotent step is an unknown outcome even when the runner says cancelled', async () => {
      const repo = await makeRepo()
      const runId = await pushWorkflow(repo, job('d', [], [stepYaml('Deploy', false)]) + job('after', ['d']))
      const c = await claimFor(runId, 'd')
      await ops.startStep(fenceOf(c), 0)
      await engine.cancelRun(runId, 'alice')
      const hb = await ops.heartbeat(runner1.id, [{ jobId: c.jobId, attempt: 1, fencingToken: c.fencingToken }])
      expect(hb.jobs[0].cancel).toBe(true)
      await ops.finishStep(fenceOf(c), 0, 'killed', null)
      const done = await engine.completeAttempt(c.jobId, c.attempt, c.fencingToken, { conclusion: 'cancelled' })
      expect(done.status).toBe('needs_attention')
    })
  })

  describe('re-runs', () => {
    it('numbers attempts per job, keeps history, leaves successes alone and re-evaluates dependents', async () => {
      const repo = await makeRepo()
      const runId = await pushWorkflow(repo, job('a') + job('b', ['a']) + job('c', ['b']) + job('d', ['a']))
      await succeed(runId, 'a')
      const b = await claimFor(runId, 'b')
      await engine.completeAttempt(b.jobId, b.attempt, b.fencingToken, { conclusion: 'failure' })
      await succeed(runId, 'd')
      expect((await jobRow(runId, 'c')).status).toBe('skipped')
      expect(await runStatus(runId)).toBe('failure')

      const result = await engine.rerun({ runId, mode: 'failed', actor: 'alice', confirmNonIdempotent: false })
      expect(result.runAttempt).toBe(2)
      expect((await jobRow(runId, 'a')).attempt).toBe(1)
      expect((await jobRow(runId, 'd')).attempt).toBe(1)
      expect(await jobRow(runId, 'b')).toMatchObject({ attempt: 2, status: 'queued' })
      expect(await jobRow(runId, 'c')).toMatchObject({ attempt: 2, status: 'blocked' })

      await succeed(runId, 'b')
      expect((await jobRow(runId, 'c')).status).toBe('queued')
      await succeed(runId, 'c')
      expect(await runStatus(runId)).toBe('success')

      await engine.rerun({ runId, mode: 'job', jobKey: 'b', actor: 'alice', confirmNonIdempotent: false })
      expect(await jobRow(runId, 'b')).toMatchObject({ attempt: 3, status: 'queued' })
      expect(await jobRow(runId, 'c')).toMatchObject({ attempt: 3, status: 'blocked' })
      expect((await jobRow(runId, 'd')).attempt).toBe(1)
      await succeed(runId, 'b')
      await succeed(runId, 'c')

      await engine.rerun({ runId, mode: 'all', actor: 'alice', confirmNonIdempotent: false })
      expect((await jobRow(runId, 'a')).attempt).toBe(2)
      expect((await jobRow(runId, 'b')).attempt).toBe(4)
      expect((await jobRow(runId, 'c')).attempt).toBe(4)
      expect((await jobRow(runId, 'd')).attempt).toBe(2)

      const history = await db.pool.query<{ attempt: number; trigger: string }>(`SELECT a.attempt, a.trigger FROM job_attempts a JOIN jobs j ON j.id = a.job_id WHERE j.run_id = $1 AND j.job_key = 'b' ORDER BY a.attempt`, [runId])
      expect(history.rows).toEqual([
        { attempt: 1, trigger: 'initial' },
        { attempt: 2, trigger: 'rerun_failed' },
        { attempt: 3, trigger: 'rerun_job' },
        { attempt: 4, trigger: 'rerun_all' },
      ])
    })

    it('needs confirmation for a non-idempotent step, whichever button got there', async () => {
      const repo = await makeRepo()
      const runId = await pushWorkflow(repo, job('deploy', [], [stepYaml('Deploy', false)]))
      const c = await claimFor(runId, 'deploy')
      await ops.startStep(fenceOf(c), 0)
      await ops.finishStep(fenceOf(c), 0, 'success', 0)
      await engine.completeAttempt(c.jobId, c.attempt, c.fencingToken, { conclusion: 'success' })
      await expect(engine.rerun({ runId, mode: 'job', jobKey: 'deploy', actor: 'alice', confirmNonIdempotent: false })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' })
      await expect(engine.rerun({ runId, mode: 'all', actor: 'alice', confirmNonIdempotent: false })).rejects.toMatchObject({ code: 'CONFIRM_REQUIRED' })
      expect((await jobRow(runId, 'deploy')).attempt).toBe(1)
      await engine.rerun({ runId, mode: 'job', jobKey: 'deploy', actor: 'alice', confirmNonIdempotent: true })
      expect((await jobRow(runId, 'deploy')).attempt).toBe(2)
      const a = await db.pool.query<{ confirmed_non_idempotent: boolean; triggered_by: string }>('SELECT confirmed_non_idempotent, triggered_by FROM job_attempts WHERE job_id = $1 AND attempt = 2', [c.jobId])
      expect(a.rows[0]).toEqual({ confirmed_non_idempotent: true, triggered_by: 'alice' })
    })

    it('refuses while jobs are still active', async () => {
      const repo = await makeRepo()
      const runId = await pushWorkflow(repo, job('a'))
      await expect(engine.rerun({ runId, mode: 'all', actor: 'alice', confirmNonIdempotent: false })).rejects.toMatchObject({ code: 'RUN_NOT_FINISHED' })
    })

    it('keeps the pinned definition: the immutability triggers hold', async () => {
      const repo = await makeRepo()
      const runId = await pushWorkflow(repo, job('a'))
      await expect(db.pool.query(`UPDATE workflow_runs SET commit_sha = 'other' WHERE id = $1`, [runId])).rejects.toThrow(/immutable/)
      await expect(db.pool.query(`UPDATE workflow_runs SET workflow_sha = 'other' WHERE id = $1`, [runId])).rejects.toThrow(/immutable/)
      await expect(db.pool.query(`UPDATE jobs SET steps = '[]' WHERE run_id = $1`, [runId])).rejects.toThrow(/immutable/)
    })
  })

  describe('intake', () => {
    it('concurrent duplicates of one delivery make one run and all return it', async () => {
      const repo = await makeRepo()
      const sha = `dup${tag}`.padEnd(40, '0')
      await db.pool.query(`INSERT INTO fixture_commits (repo_id, sha, branch, message, author, scenario, tree) VALUES ($1, $2, 'main', 'm', 'a', 'race', $3)`, [repo.id, sha, JSON.stringify({ '.ci/workflow.yml': `on: [push]\njobs:\n${job('a')}` })])
      const payload = { ref: 'refs/heads/main', after: sha, repository: { full_name: repo.fullName }, sender: { login: 'alice' } }
      const results = await Promise.all(Array.from({ length: 8 }, () => intake.handleDelivery({ repoId: repo.id, repoFullName: repo.fullName, deliveryId: 'same-delivery', eventType: 'push', payload, rawBody: Buffer.from('x') })))
      expect(new Set(results.map((r) => r.runId)).size).toBe(1)
      expect(results.filter((r) => !r.duplicate).length).toBe(1)
      const runs = await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM workflow_runs WHERE repo_id = $1', [repo.id])
      expect(runs.rows[0].n).toBe(1)
      const event = await db.pool.query<{ redeliveries: number }>(`SELECT redeliveries FROM trigger_events WHERE repo_id = $1 AND delivery_id = 'same-delivery'`, [repo.id])
      expect(event.rows[0].redeliveries).toBe(7)
    })

    it('records a rejected workflow on the run, with no jobs', async () => {
      const repo = await makeRepo()
      const runId = await pushWorkflow(repo, job('a', ['b']) + job('b', ['a']))
      const run = await db.pool.query<{ status: string; error_code: string; error_message: string; finished_at: Date | null }>('SELECT status, error_code, error_message, finished_at FROM workflow_runs WHERE id = $1', [runId])
      expect(run.rows[0]).toMatchObject({ status: 'invalid', error_code: 'DEPENDENCY_CYCLE' })
      expect(run.rows[0].error_message).toContain('a -> b -> a')
      expect(run.rows[0].finished_at).not.toBeNull()
    })
  })

  describe('secrets at the claim path', () => {
    async function repoWithSecrets() {
      const repo = await makeRepo()
      await db.pool.query(`INSERT INTO environments (id, repo_id, name, required_approval, allowed_branches) VALUES ($1, $2, 'production', true, '{main}')`, [`env_${repo.id}`, repo.id])
      await store.putSecret(db.pool, repo.id, 'REPO_TOKEN', 'repo-token-value-123', null, 'alice')
      await store.putSecret(db.pool, repo.id, 'DEPLOY_TOKEN', 'deploy-token-value-456', 'production', 'alice')
      return repo
    }
    const secretJob = (key: string, needs: string[], secrets: string[], env?: string) => `  ${key}: { runs-on: [${label}], needs: [${needs.join(', ')}], secrets: [${secrets.join(', ')}], ${env ? `environment: ${env}, ` : ''}steps: [${stepYaml('s')}] }\n`
    const auditCount = async (jobId: string) => (await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM secret_releases WHERE job_id = $1', [jobId])).rows[0].n

    it('a same-repository push receives what it names, and the release is audited', async () => {
      const repo = await repoWithSecrets()
      const runId = await pushWorkflow(repo, secretJob('a', [], ['REPO_TOKEN', 'DEPLOY_TOKEN']))
      const c = await claimFor(runId, 'a')
      expect(c.secrets).toEqual({ REPO_TOKEN: 'repo-token-value-123' })
      expect(c.secretsWithheld.map((w) => w.name)).toEqual(['DEPLOY_TOKEN'])
      const audit = await db.pool.query<{ secret_name: string; attempt: number; runner_name: string; run_id: string; scope: string }>('SELECT secret_name, attempt, runner_name, run_id, scope FROM secret_releases WHERE job_id = $1', [c.jobId])
      expect(audit.rows).toEqual([{ secret_name: 'REPO_TOKEN', attempt: 1, runner_name: runner1.name, run_id: runId, scope: 'repository' }])
    })

    it('a fork pull request gets no secret from the claim, and no audit row', async () => {
      const repo = await repoWithSecrets()
      const runId = await pushWorkflow(repo, secretJob('a', [], ['REPO_TOKEN']), { fork: true })
      const c = await claimFor(runId, 'a')
      expect(c.isFork).toBe(true)
      expect(c.secrets).toEqual({})
      expect(c.secretsWithheld[0].reason).toContain('forks')
      expect(await auditCount(c.jobId)).toBe(0)
    })

    it('a fork job is denied a protected environment when it becomes ready, and downstream is skipped', async () => {
      const repo = await repoWithSecrets()
      const runId = await pushWorkflow(repo, secretJob('deploy', [], ['DEPLOY_TOKEN'], 'production') + job('after', ['deploy']), { fork: true })
      const deploy = await jobRow(runId, 'deploy')
      expect(deploy.status).toBe('failure')
      expect(deploy.status_reason).toContain('fork')
      expect((await jobRow(runId, 'after')).status).toBe('skipped')
    })

    it('even a forged row cannot get a fork job past the claim: approved, queued, and still nothing', async () => {
      const repo = await repoWithSecrets()
      const runId = await pushWorkflow(repo, secretJob('deploy', [], ['DEPLOY_TOKEN'], 'production'), { fork: true })
      const { id } = await jobRow(runId, 'deploy')
      // Simulate a bug or a tampered row: the job reaches the queue with an approval attached.
      await db.pool.query(`UPDATE jobs SET status = 'queued', queued_at = now() WHERE id = $1`, [id])
      await db.pool.query(`INSERT INTO environment_approvals (job_id, attempt, decision, decided_by) VALUES ($1, 1, 'approved', 'forged') ON CONFLICT DO NOTHING`, [id])
      const claimed = await claim.claimJob(runner1, { onlyJobId: id })
      expect(claimed).toBeNull()
      expect((await jobRow(runId, 'deploy')).status).toBe('failure')
      expect(await auditCount(id)).toBe(0)
    })

    it('a queued job that lost its approval goes back to waiting at the claim, with no secrets released', async () => {
      const repo = await repoWithSecrets()
      const runId = await pushWorkflow(repo, secretJob('deploy', [], ['DEPLOY_TOKEN'], 'production'))
      const row = await jobRow(runId, 'deploy')
      expect(row.status).toBe('waiting')
      await db.pool.query(`UPDATE jobs SET status = 'queued', queued_at = now() WHERE id = $1`, [row.id])
      expect(await claim.claimJob(runner1, { onlyJobId: row.id })).toBeNull()
      expect((await jobRow(runId, 'deploy')).status).toBe('waiting')
      expect(await auditCount(row.id)).toBe(0)
    })

    it('approval holds, then releases, and the secret goes only to the approved job; a re-run must be approved again', async () => {
      const repo = await repoWithSecrets()
      const runId = await pushWorkflow(repo, secretJob('deploy', [], ['DEPLOY_TOKEN'], 'production'))
      const row = await jobRow(runId, 'deploy')
      expect(row.status).toBe('waiting')
      expect(await claim.claimJob(runner1, { onlyJobId: row.id })).toBeNull()
      await engine.decideApproval(row.id, 'approved', 'alice', 'ok')
      const c = await claimFor(runId, 'deploy')
      expect(c.secrets).toEqual({ DEPLOY_TOKEN: 'deploy-token-value-456' })
      await engine.completeAttempt(c.jobId, c.attempt, c.fencingToken, { conclusion: 'success' })
      await engine.rerun({ runId, mode: 'job', jobKey: 'deploy', actor: 'alice', confirmNonIdempotent: false })
      expect(await jobRow(runId, 'deploy')).toMatchObject({ status: 'waiting', attempt: 2 })
    })

    it('a rejection fails the job and skips downstream', async () => {
      const repo = await repoWithSecrets()
      const runId = await pushWorkflow(repo, secretJob('deploy', [], ['DEPLOY_TOKEN'], 'production') + job('after', ['deploy']))
      await engine.decideApproval((await jobRow(runId, 'deploy')).id, 'rejected', 'alice', 'not today')
      expect(await jobRow(runId, 'deploy')).toMatchObject({ status: 'failure' })
      expect((await jobRow(runId, 'after')).status).toBe('skipped')
    })

    it('a branch the environment does not allow is denied without bothering anyone', async () => {
      const repo = await repoWithSecrets()
      const runId = await pushWorkflow(repo, secretJob('deploy', [], ['DEPLOY_TOKEN'], 'production'), { branch: 'feature/x' })
      const row = await jobRow(runId, 'deploy')
      expect(row.status).toBe('failure')
      expect(row.status_reason).toContain('feature/x')
    })

    it('stores only ciphertext, and a ciphertext moved to another scope does not decrypt', async () => {
      const repo = await repoWithSecrets()
      const { rows } = await db.pool.query<{ ciphertext: string }>(`SELECT ciphertext FROM secrets WHERE repo_id = $1 AND name = 'REPO_TOKEN'`, [repo.id])
      expect(rows[0].ciphertext).not.toContain('repo-token-value')
      expect(crypto.decrypt(rows[0].ciphertext, store.secretAad(repo.id, null, 'REPO_TOKEN'))).toBe('repo-token-value-123')
      expect(() => crypto.decrypt(rows[0].ciphertext, store.secretAad('other-repo', null, 'REPO_TOKEN'))).toThrow()
    })
  })

  describe('log assembly', () => {
    async function logRun(secret?: string) {
      const repo = await makeRepo()
      if (secret) await store.putSecret(db.pool, repo.id, 'TOKEN', secret, null, 'alice')
      const runId = await pushWorkflow(repo, secret ? `  a: { runs-on: [${label}], secrets: [TOKEN], steps: [${stepYaml('s')}] }\n` : job('a'))
      const c = await claimFor(runId, 'a')
      return { runId, c, fence: fenceOf(c) }
    }
    const texts = async (jobId: string, after = 0) => (await read.readLines(jobId, 1, after)).lines.map((l) => l.text)

    it('takes chunks out of order and shows nothing past a gap until it fills', async () => {
      const { c, fence } = await logRun()
      await ingest.ingestChunks(fence, [{ seq: 3, stepIndex: 0, text: 'three\n' }])
      await ingest.ingestChunks(fence, [{ seq: 1, stepIndex: 0, text: 'one\n' }])
      expect(await texts(c.jobId)).toEqual(['one'])
      await ingest.ingestChunks(fence, [{ seq: 2, stepIndex: 0, text: 'two\n' }])
      expect(await texts(c.jobId)).toEqual(['one', 'two', 'three'])
    })

    it('is idempotent by (job, attempt, seq): a retry changes nothing', async () => {
      const { c, fence } = await logRun()
      await ingest.ingestChunks(fence, [{ seq: 1, stepIndex: 0, text: 'one\n' }])
      const retry = await ingest.ingestChunks(fence, [{ seq: 1, stepIndex: 0, text: 'one\n' }])
      expect(retry.accepted).toBe(0)
      await ingest.ingestChunks(fence, [{ seq: 2, stepIndex: 0, text: 'two\n' }, { seq: 2, stepIndex: 0, text: 'two\n' }])
      expect(await texts(c.jobId)).toEqual(['one', 'two'])
    })

    it('concurrent uploads, in any order, assemble to the same contiguous lines', async () => {
      const { c, fence } = await logRun()
      const chunks = Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, stepIndex: 0, text: `line ${i + 1}\n` }))
      const shuffled = [...chunks].sort((a, b) => ((a.seq * 7) % 31) - ((b.seq * 7) % 31))
      await Promise.all(shuffled.map((chunk) => ingest.ingestChunks(fence, [chunk])))
      const { lines } = await read.readLines(c.jobId, 1, 0)
      expect(lines.map((l) => l.n)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1))
      expect(lines.map((l) => l.text)).toEqual(chunks.map((x) => x.text.trim()))
    })

    it('reads from an offset: exactly the missing lines', async () => {
      const { c, fence } = await logRun()
      await ingest.ingestChunks(fence, [{ seq: 1, stepIndex: 0, text: 'a\nb\nc\nd\n' }])
      expect(await texts(c.jobId, 2)).toEqual(['c', 'd'])
      expect(await texts(c.jobId, 4)).toEqual([])
    })

    it('masks a value split across two chunks, even arriving out of order, and stores no plaintext', async () => {
      const secret = 'split-secret-value-789'
      const { c, fence } = await logRun(secret)
      await ingest.ingestChunks(fence, [{ seq: 2, stepIndex: 0, text: `${secret.slice(9)} tail\n` }])
      await ingest.ingestChunks(fence, [{ seq: 1, stepIndex: 0, text: `token=${secret.slice(0, 9)}` }])
      expect(await texts(c.jobId)).toEqual(['token=*** tail'])
      const stored = await db.pool.query(`SELECT text FROM log_lines WHERE job_id = $1`, [c.jobId])
      expect(JSON.stringify(stored.rows)).not.toContain('split-secret')
      const buffered = await db.pool.query(`SELECT content_enc FROM log_chunks WHERE job_id = $1`, [c.jobId])
      expect(buffered.rows.every((r) => r.content_enc === null)).toBe(true)
    })

    it('keeps a split value encrypted while it waits, and masks it when the stream closes', async () => {
      const secret = 'closing-secret-value-321'
      const { c, fence } = await logRun(secret)
      await ingest.ingestChunks(fence, [{ seq: 1, stepIndex: 0, text: `partial ${secret}` }])
      const state = await db.pool.query<{ partial_enc: string }>('SELECT partial_enc FROM log_streams WHERE job_id = $1', [c.jobId])
      expect(state.rows[0].partial_enc).not.toContain('closing-secret')
      await engine.completeAttempt(c.jobId, c.attempt, c.fencingToken, { conclusion: 'success' })
      const log = await read.readLines(c.jobId, 1, 0)
      expect(log.lines.map((l) => l.text)).toEqual(['partial ***'])
      expect(log.complete).toBe(true)
    })

    it('says so when chunks never arrived', async () => {
      const { c, fence } = await logRun()
      await ingest.ingestChunks(fence, [{ seq: 1, stepIndex: 0, text: 'one\n' }])
      await ingest.ingestChunks(fence, [{ seq: 4, stepIndex: 0, text: 'four\n' }])
      await engine.completeAttempt(c.jobId, c.attempt, c.fencingToken, { conclusion: 'success' })
      const lines = await texts(c.jobId)
      expect(lines[0]).toBe('one')
      expect(lines[1]).toContain('2 log chunk(s) never arrived')
      expect(lines[2]).toBe('four')
    })
  })
})
